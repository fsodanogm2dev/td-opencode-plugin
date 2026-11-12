/**
 * Rule matcher. Pure. The backend policy and the extension preview use these same exports.
 *
 * Command rules are a convenience matcher. They see the programs that `analyzeCommand` finds. They do not see what
 * a script file, a non-shell interpreter, or a tool outside the permission system would run.
 */

import { analyzeCommand, type CommandAnalysis, type Invocation } from "./command.ts"
import type { CommandRule, PermissionRule, Rule } from "./schema.ts"

/** Permission actions to which command rules apply. */
export const COMMAND_ACTIONS: readonly string[] = ["shell"]

export type MatchReason = "command" | "command-dynamic" | "command-fallback" | "permission"

export interface RuleMatch {
  readonly index: number
  readonly rule: Rule
  readonly reason: MatchReason
}

export interface ActionInput {
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------------------------
// Globs

const MAX_GLOB_TEXT = 4096

/**
 * Safe glob: `*` matches within one path segment, `**` matches across segments, `?` matches one character that is
 * not `/`. Everything else is literal. Runs in O(pattern x text) time. No regular expression is built.
 */
export function globMatches(glob: string, text: string): boolean {
  const target = text.length > MAX_GLOB_TEXT ? text.slice(0, MAX_GLOB_TEXT) : text
  type Token = { readonly kind: "literal"; readonly char: string } | { readonly kind: "one" } | { readonly kind: "star" } | { readonly kind: "globstar" }
  const tokens: Token[] = []
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        while (glob[i + 1] === "*") i++
        tokens.push({ kind: "globstar" })
      } else tokens.push({ kind: "star" })
    } else if (char === "?") tokens.push({ kind: "one" })
    else tokens.push({ kind: "literal", char })
  }
  // reachable[j] is true when the first j tokens match the consumed prefix.
  let reachable = new Array<boolean>(tokens.length + 1).fill(false)
  reachable[0] = true
  const spread = (row: boolean[]) => {
    for (let j = 0; j < tokens.length; j++) {
      const token = tokens[j]!
      if (row[j] && (token.kind === "star" || token.kind === "globstar")) row[j + 1] = true
    }
  }
  spread(reachable)
  for (const char of target) {
    const next = new Array<boolean>(tokens.length + 1).fill(false)
    for (let j = 0; j < tokens.length; j++) {
      if (!reachable[j]) continue
      const token = tokens[j]!
      if (token.kind === "literal") {
        if (token.char === char) next[j + 1] = true
      } else if (token.kind === "one") {
        if (char !== "/") next[j + 1] = true
      } else if (token.kind === "star") {
        if (char !== "/") next[j] = true
      } else next[j] = true
    }
    spread(next)
    reachable = next
  }
  return reachable[tokens.length]!
}

// ---------------------------------------------------------------------------------------------------------------
// Command rules

/** Global options that take a separate value, by program. Used to find the subcommand. */
const GLOBAL_VALUE_OPTIONS: Record<string, readonly string[]> = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"],
  docker: ["-H", "--host", "-c", "--context", "--config", "-l", "--log-level"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server"],
  gh: ["-R", "--repo"],
  npm: ["--prefix", "-C"],
  cargo: ["--manifest-path", "-C", "--config", "-Z"],
}

/** Options of these programs that take a value only in `--option=value` form. */
const EQUALS_ONLY = new Set(["--exec-path"])

function stripGlobalOptions(program: string, args: readonly string[]): string[] {
  const valueOptions = GLOBAL_VALUE_OPTIONS[program] ?? []
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (!arg.startsWith("-") || arg === "-") break
    if (arg === "--") {
      index++
      break
    }
    if (!EQUALS_ONLY.has(arg) && valueOptions.includes(arg)) index += 2
    else if (program === "git" && /^-c.+/.test(arg)) index += 1 // `-cname=value`
    else index += 1
  }
  return args.slice(index)
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, index) => words[index] === word)
}

function hasFlag(args: readonly string[], flag: string): boolean {
  for (const arg of args) {
    if (arg === "--") return false
    if (arg === flag || arg.startsWith(`${flag}=`)) return true
    if (!flag.startsWith("--") && flag.length === 2 && /^-[^-]/.test(arg)) {
      // `-am` and `-mtext` contain `-m`. Read the cluster up to its first non-alphanumeric character.
      const cluster = /^-([A-Za-z0-9]+)/.exec(arg)?.[1] ?? ""
      if (cluster.includes(flag[1]!)) return true
    }
  }
  return false
}

function matchInvocation(rule: CommandRule, invocation: Invocation): "command" | "command-dynamic" | undefined {
  if (invocation.dynamicProgram) {
    // Conservative: the executable is not literal. Match only when every guarded token occurs literally.
    const words = [invocation.program, ...invocation.args, ...invocation.hints]
    const names = words.map((word) => word.slice(word.lastIndexOf("/") + 1))
    const literal = names.includes(rule.program) || (rule.program === "git" && names.some((n) => n.startsWith("git-")))
    // Without the program name, only a rule that guards a subcommand or a flag can match by those tokens.
    if (!literal && !rule.subcommands && !rule.flags) return undefined
    const subcommandOk = !rule.subcommands || rule.subcommands.some((entry) => entry.every((word) => words.includes(word)))
    const flagsOk = !rule.flags || rule.flags.every((flag) => words.some((word) => word === flag || word.startsWith(`${flag}=`)))
    return subcommandOk && flagsOk ? "command-dynamic" : undefined
  }
  let program = invocation.program
  let args = invocation.args
  if (rule.program === "git" && program.startsWith("git-") && program.length > 4) {
    args = [program.slice(4), ...args]
    program = "git"
  }
  if (program !== rule.program) return undefined
  const words = stripGlobalOptions(program, args)
  if (rule.subcommands && !rule.subcommands.some((entry) => startsWith(words, entry))) return undefined
  if (rule.flags && !rule.flags.every((flag) => hasFlag(words, flag))) return undefined
  return "command"
}

/** Looks for the guarded tokens in raw text. Used only when the parser gave up. */
function matchFallback(rule: CommandRule, raw: string): boolean {
  const tokens = raw.split(/[\s;&|()<>`"'$\\]+/).filter((token) => token !== "")
  const names = tokens.map((token) => token.slice(token.lastIndexOf("/") + 1))
  if (!names.includes(rule.program)) return false
  const subcommandOk = !rule.subcommands || rule.subcommands.some((entry) => entry.every((word) => tokens.includes(word)))
  const flagsOk = !rule.flags || rule.flags.every((flag) => tokens.some((token) => token === flag || token.startsWith(`${flag}=`) || hasFlag([token], flag)))
  return subcommandOk && flagsOk
}

export function matchCommandRule(rule: CommandRule, analysis: CommandAnalysis): "command" | "command-dynamic" | "command-fallback" | undefined {
  if (analysis.fallback) return matchFallback(rule, analysis.raw) ? "command-fallback" : undefined
  let dynamic = false
  for (const invocation of analysis.invocations) {
    const result = matchInvocation(rule, invocation)
    if (result === "command") return "command"
    if (result) dynamic = true
  }
  return dynamic ? "command-dynamic" : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Permission rules

export function matchPermissionRule(rule: PermissionRule, input: ActionInput): boolean {
  if (rule.action !== input.action) return false
  if (!rule.resources || rule.resources.length === 0) return true
  return input.resources.some((resource) => rule.resources!.some((glob) => globMatches(glob, resource)))
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

/** Command texts to analyze for a shell action. Resources are command segments; `metadata.command` is a backup. */
export function commandTexts(input: ActionInput): string[] {
  const texts = [...input.resources.filter((resource) => typeof resource === "string")]
  const command = input.metadata?.command
  if (typeof command === "string" && !texts.includes(command)) texts.push(command)
  return texts
}

/** Returns the first rule that matches, or `undefined`. */
export function matchRules(rules: readonly Rule[], input: ActionInput): RuleMatch | undefined {
  let analyses: CommandAnalysis[] | undefined
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!
    if (rule.kind === "permission") {
      if (matchPermissionRule(rule, input)) return { index, rule, reason: "permission" }
      continue
    }
    if (!COMMAND_ACTIONS.includes(input.action)) continue
    analyses ??= commandTexts(input).map((text) => analyzeCommand(text))
    for (const analysis of analyses) {
      const reason = matchCommandRule(rule, analysis)
      if (reason) return { index, rule, reason }
    }
  }
  return undefined
}

/** UI-friendly result. `fallback` is true for a conservative match (non-literal program or unparseable text). */
export interface MatchResult {
  readonly matched: boolean
  readonly rule?: Rule
  readonly fallback?: boolean
  readonly reason?: MatchReason
}

function toResult(match: RuleMatch | undefined): MatchResult {
  if (!match) return { matched: false }
  return { matched: true, rule: match.rule, fallback: match.reason === "command-dynamic" || match.reason === "command-fallback", reason: match.reason }
}

/** Same matcher as enforcement, shaped for the UI. */
export function matchRequest(rules: readonly Rule[], request: { readonly action: string; readonly resources: readonly string[] }): MatchResult {
  return toResult(matchRules(rules, request))
}

/** Preview of one shell command, shaped for the UI. */
export function previewMatch(rules: readonly Rule[], command: string): MatchResult {
  return toResult(previewCommand(rules, command))
}

/** Preview of a shell command. Same matcher as enforcement. */
export function previewCommand(rules: readonly Rule[], command: string): RuleMatch | undefined {
  return matchRules(rules, { action: "shell", resources: [command] })
}

/** Preview of a permission action. Same matcher as enforcement. */
export function previewPermission(rules: readonly Rule[], action: string, resource?: string): RuleMatch | undefined {
  return matchRules(rules, { action, resources: resource === undefined ? [] : [resource] })
}
