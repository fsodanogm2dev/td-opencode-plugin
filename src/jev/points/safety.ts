/**
 * Shell safety point.
 *
 * Hooks, in the order that OpenCode runs them for one shell call:
 *
 * 1. `tool.execute.before` stores the FULL command by session and call ID. It is the only hook that sees the whole
 *    text. The permission request carries `resources`, which the scanner of OpenCode splits into subcommands and
 *    strips of redirections.
 * 2. `permission.evaluate` runs the checks below and only ever changes `allow` to `ask`.
 * 3. `tool.execute.after` removes the stored command.
 *
 * Checks of `permission.evaluate`, in order:
 *
 * 1. Deterministic destructive patterns on the full command and on every resource. A match asks. No API call.
 * 2. A very narrow read-only form of the full command skips the rest and keeps the existing decision. Without the
 *    full command nothing is skipped, because the resources can hide a redirection or a substitution.
 * 3. Without the full command, the command cannot be judged: nothing goes upstream, and the case counts as a failure
 *    (`invalid-request`). The resources are never treated as the command.
 * 4. TypeSafe (`is_destructive`, a `noul` question) on the full command. A probability above `riskThreshold` asks.
 *    An upstream failure or an invalid answer asks when `failClosed` is true. With no TypeSafe key, nothing is
 *    checked upstream, and the existing decision stays.
 *
 * `ask` and `deny` are never touched. No approval is remembered here, so each call is checked again. An error in
 * the hook never rejects, because OpenCode would turn a rejected promise into a defect.
 */

import type { SafetyPreCheckOptions } from "../options.ts"
import { SAFETY_QUESTION_ID, safetyQuestions } from "../questions.ts"
import { BoundedMap, failureFields, type JevPointRuntime } from "../runtime.ts"
import { noulProbability } from "../client.ts"

/** Longest command that goes upstream. A longer one is never cut. It counts as an upstream failure. */
export const MAX_COMMAND_CHARS = 16_000
const MAX_TRACKED_COMMANDS = 256
const MAX_NESTING = 5

// -- Shell scanning ----------------------------------------------------------------------------------------------

interface Scan {
  readonly commands: string[][]
  /** Text of `$(...)` and backtick substitutions inside double quotes. */
  readonly nested: string[]
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r"
const isSeparator = (c: string): boolean => ";&|\n()`{}".includes(c)

function findSubstitutionEnd(text: string, start: number, open: boolean): number {
  if (!open) return text.indexOf("`", start)
  let depth = 1
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) return i
  }
  return -1
}

/**
 * Splits a command into simple commands of words. Quotes and backslashes are resolved. `;`, `&`, `|`, newlines,
 * parentheses, braces, and backticks start a new simple command, so substitutions and subshells show their content.
 * It is not a full shell parser. It aims to over-detect.
 */
export function scanShell(command: string): Scan {
  const commands: string[][] = []
  const nested: string[] = []
  let tokens: string[] = []
  let current = ""
  let started = false
  let quote: "'" | '"' | undefined
  const endToken = (): void => {
    if (started) tokens.push(current)
    current = ""
    started = false
  }
  const endCommand = (): void => {
    endToken()
    if (tokens.length > 0) commands.push(tokens)
    tokens = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote === "'") {
      if (c === "'") quote = undefined
      else current += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === "\\" && i + 1 < command.length) current += command[++i]
      else {
        if (c === "`") {
          const end = findSubstitutionEnd(command, i + 1, false)
          if (end > i) nested.push(command.slice(i + 1, end))
        } else if (c === "$" && command[i + 1] === "(") {
          const end = findSubstitutionEnd(command, i + 2, true)
          nested.push(command.slice(i + 2, end > i ? end : command.length))
        }
        current += c
      }
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === "\\") {
      const next = command[i + 1]
      if (next === undefined) continue
      i++
      if (next !== "\n") {
        current += next
        started = true
      }
    } else if (isSpace(c)) endToken()
    else if (isSeparator(c)) endCommand()
    else {
      current += c
      started = true
    }
  }
  endCommand()
  return { commands, nested }
}

const baseName = (word: string): string => {
  const slash = word.lastIndexOf("/")
  return slash >= 0 ? word.slice(slash + 1) : word
}

/** Skips the options of a wrapper command. `argOptions` take one more word. Returns the index of the first other word. */
function skipOptions(words: readonly string[], from: number, argOptions: ReadonlySet<string>): number {
  let i = from
  while (i < words.length) {
    const word = words[i] as string
    if (word === "--") return i + 1
    if (!word.startsWith("-") || word === "-") return i
    i += argOptions.has(word) ? 2 : 1
  }
  return i
}

const SUDO_ARGS = new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-D", "-R", "-T"])
const ENV_ARGS = new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])
const NICE_ARGS = new Set(["-n", "-c", "-p", "-i", "-o", "-e", "-t"])
const TIMEOUT_ARGS = new Set(["-s", "-k", "--signal", "--kill-after"])
const XARGS_ARGS = new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Removes environment assignments and wrapper commands (`sudo`, `env`, `nice`, `xargs`, ...) from the front. */
function unwrap(words: readonly string[]): readonly string[] {
  let current = words
  for (let guard = 0; guard < 8 && current.length > 0; guard++) {
    let index = 0
    while (index < current.length && ASSIGNMENT.test(current[index] as string)) index++
    if (index > 0) {
      current = current.slice(index)
      continue
    }
    const name = baseName(current[0] as string)
    let next: number
    switch (name) {
      case "sudo":
      case "doas":
        next = skipOptions(current, 1, SUDO_ARGS)
        break
      case "env": {
        next = 1
        while (next < current.length) {
          const word = current[next] as string
          if (word === "--") {
            next++
            break
          }
          if (word.startsWith("-")) next += ENV_ARGS.has(word) ? 2 : 1
          else if (ASSIGNMENT.test(word)) next++
          else break
        }
        break
      }
      case "command":
      case "builtin":
      case "exec":
      case "nohup":
      case "time":
      case "noglob":
      case "nocorrect":
        next = skipOptions(current, 1, new Set())
        break
      case "nice":
      case "ionice":
      case "stdbuf":
        next = skipOptions(current, 1, NICE_ARGS)
        break
      case "timeout":
        next = skipOptions(current, 1, TIMEOUT_ARGS) + 1
        break
      case "xargs":
        next = skipOptions(current, 1, XARGS_ARGS)
        break
      default:
        return current
    }
    current = current.slice(next)
  }
  return current
}

// -- Deterministic destructive patterns --------------------------------------------------------------------------

const SQL_DROP = /\b(?:drop|truncate)\s+(?:table|database|schema|index|view|materialized|trigger|function|procedure|sequence|user|role|tablespace|extension|column|constraint)\b|\bdrop\s+if\s+exists\b|\btruncate\s+(?!-)[\w`".[]+\s*(?:;|"|'|$)/i

const isShortGroup = (word: string): boolean => /^-[A-Za-z]+$/.test(word)

function rmDestructive(args: readonly string[]): boolean {
  let recursive = false
  let force = false
  for (const word of args) {
    if (word === "--") break
    if (word.startsWith("--")) {
      if (word === "--recursive") recursive = true
      else if (word === "--force") force = true
    } else if (isShortGroup(word)) {
      if (/[rR]/.test(word)) recursive = true
      if (word.includes("f")) force = true
    }
  }
  return recursive && force
}

const GIT_GLOBAL_ARGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"])

function gitDestructive(args: readonly string[]): boolean {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const word = args[i] as string
    i += GIT_GLOBAL_ARGS.has(word) ? 2 : 1
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  const shortHas = (letter: string): boolean => rest.some((word) => isShortGroup(word) && word.includes(letter))
  switch (sub) {
    case "push":
      return (
        rest.some(
          (word) =>
            word === "--force" ||
            word.startsWith("--force-with-lease") ||
            word === "--mirror" ||
            word === "--delete" ||
            word === "-d" ||
            (!word.startsWith("--") && word.length > 1 && (word.startsWith("+") || word.startsWith(":"))),
        ) || shortHas("f")
      )
    case "reset":
      return rest.includes("--hard")
    case "clean":
      return (rest.includes("--force") || shortHas("f")) && !rest.includes("--dry-run") && !shortHas("n")
    default:
      return false
  }
}

const isDevicePath = (path: string): boolean => path.startsWith("/dev/") && !/^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/.test(path)

function segmentDestructive(words: readonly string[], depth: number): boolean {
  const unwrapped = unwrap(words)
  if (unwrapped.length === 0) return false
  const name = baseName(unwrapped[0] as string)
  const args = unwrapped.slice(1)
  switch (name) {
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ksh":
    case "fish": {
      const flag = args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
      const script = flag >= 0 ? args[flag + 1] : undefined
      return script !== undefined && depth < MAX_NESTING && commandDestructive(script, depth + 1)
    }
    case "eval":
      return depth < MAX_NESTING && commandDestructive(args.join(" "), depth + 1)
    case "rm":
      return rmDestructive(args)
    case "shred":
    case "wipefs":
    case "mkswap":
    case "mke2fs":
    case "newfs":
      return true
    case "truncate":
      return args.some((word) => word === "--size" || word.startsWith("--size=") || word.startsWith("-s"))
    case "find": {
      if (args.includes("-delete")) return true
      const exec = args.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir")
      if (exec < 0) return false
      const tail = args.slice(exec + 1)
      const end = tail.findIndex((word) => word === ";" || word === "+")
      return segmentDestructive(end >= 0 ? tail.slice(0, end) : tail, depth + 1)
    }
    case "git":
      return gitDestructive(args)
    case "dd":
      return args.some((word) => word.startsWith("of=") && isDevicePath(word.slice(3)))
    case "terraform":
    case "tofu":
    case "terragrunt":
      return args.some((word) => word === "destroy" || word === "-destroy" || word === "--destroy")
    case "kubectl":
    case "oc":
      return args.includes("delete")
    case "diskutil":
      return args.some((word) => /^(?:erase|zero|random|secureErase|partition|reformat)/i.test(word))
    default:
      return /^mkfs(?:\..+)?$/.test(name)
  }
}

function commandDestructive(command: string, depth: number): boolean {
  const scan = scanShell(command)
  if (scan.commands.some((words) => segmentDestructive(words, depth))) return true
  return depth < MAX_NESTING && scan.nested.some((text) => commandDestructive(text, depth + 1))
}

/**
 * True when the command matches a deterministic destructive pattern: `rm` with recursive and force flags, `git`
 * force push, `reset --hard`, forced `clean`, SQL `DROP` and `TRUNCATE`, `mkfs`, `dd` to a device, `terraform destroy`,
 * `kubectl delete`, `find -delete`, `shred`, and `sh -c` or `eval` of such text. The check is conservative and is not
 * complete.
 */
export function isDestructiveCommand(command: string): boolean {
  try {
    if (SQL_DROP.test(command)) return true
    return commandDestructive(command, 0)
  } catch {
    // A scanner failure must not look safe.
    return true
  }
}

// -- Read-only skip ----------------------------------------------------------------------------------------------

const PLAIN_COMMAND = /^[A-Za-z0-9_@%+:,./= -]+$/
const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show"])
const GIT_READ_FLAGS = new Set([
  "-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--long", "--ignored",
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--oneline", "--graph", "--decorate",
  "--no-decorate", "--abbrev-commit", "--no-color", "-p", "--patch", "--no-patch", "--cached", "--staged", "--merges",
  "--no-merges", "--first-parent", "--reverse", "--all", "--check", "--compact-summary", "--raw", "--no-ext-diff", "-w",
  "--ignore-all-space", "--word-diff", "--patch-with-stat",
])
const GIT_PRETTY = /^--pretty=(?:oneline|short|medium|full|fuller|reference)$/

/**
 * True for a very narrow set of read-only commands: `ls`, `pwd`, and plain `git status|diff|log|show` with known
 * read-only flags. Quotes, redirections, pipelines, substitutions, compound commands, environment prefixes, and every
 * unknown option make it false. Options that write (`--output`) or run programs (`--pre`) are not on the list.
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim()
  if (text === "" || text.length > 300 || !PLAIN_COMMAND.test(text)) return false
  const words = text.split(/ +/)
  const name = words[0]
  const args = words.slice(1)
  if (name === "pwd") return args.every((word) => word === "-L" || word === "-P")
  if (name === "ls") return args.every((word) => /^-[A-Za-z1]{1,12}$/.test(word) || !word.startsWith("-"))
  if (name !== "git") return false
  const sub = args[0]
  if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return false
  const rest = args.slice(1)
  let afterDashes = false
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string
    if (afterDashes || !word.startsWith("-")) continue
    if (word === "--") afterDashes = true
    else if (word === "-n" || word === "--max-count") {
      if (!/^\d{1,4}$/.test(rest[i + 1] ?? "")) return false
      i++
    } else if (/^(?:-n|--max-count=)\d{1,4}$/.test(word) || /^-\d{1,3}$/.test(word)) continue
    else if (GIT_PRETTY.test(word) || GIT_READ_FLAGS.has(word) || /^-[sb]{1,2}$/.test(word)) continue
    else return false
  }
  return true
}

// -- Hooks ---------------------------------------------------------------------------------------------------------

export interface SafetyEvaluateEvent {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly source?: { readonly type?: string; readonly id?: string } | undefined
  effect: "allow" | "deny" | "ask"
  message?: string | undefined
}

export interface ToolBeforeEvent {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
}

export interface ToolAfterIdentity {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
}

export interface SafetyHandlers {
  before(event: ToolBeforeEvent): void
  after(event: ToolAfterIdentity): void
  evaluate(event: SafetyEvaluateEvent): Promise<void>
}

const callKey = (sessionID: string, callID: string): string => `${sessionID}\u0000${callID}`

export function createSafetyHandlers(runtime: JevPointRuntime, options: SafetyPreCheckOptions): SafetyHandlers {
  const commands = new BoundedMap<string, string>(MAX_TRACKED_COMMANDS)
  const enforce = options.mode === "enforce"

  const ask = (event: SafetyEvaluateEvent, message: string): void => {
    if (!enforce) return
    event.effect = "ask"
    if (event.message === undefined || event.message === "") event.message = message
  }

  const failClosed = (event: SafetyEvaluateEvent, message: string): void => {
    if (options.failClosed) ask(event, message)
  }

  return {
    before(event) {
      try {
        if (event.tool !== "shell" || runtime.disposed) return
        const command = (event.input as { command?: unknown } | null | undefined)?.command
        if (typeof command === "string") commands.set(callKey(event.sessionID, event.id), command)
      } catch {
        // Without the full command, the checks use the resources only.
      }
    },
    after(event) {
      try {
        if (event.tool === "shell") commands.delete(callKey(event.sessionID, event.id))
      } catch {
        // Nothing to do.
      }
    },
    async evaluate(event) {
      try {
        if (event.action !== "shell" || event.effect !== "allow" || runtime.disposed) return
        const source = event.source
        const full = source?.type === "tool" && typeof source.id === "string" ? commands.get(callKey(event.sessionID, source.id)) : undefined
        const resources = Array.isArray(event.resources) ? event.resources.filter((item): item is string => typeof item === "string") : []

        // 1. Deterministic patterns. Always ask. No upstream call.
        if ((full !== undefined && isDestructiveCommand(full)) || resources.some(isDestructiveCommand)) {
          ask(event, "This command matches a destructive-command pattern. Approval is required.")
          runtime.record({ point: "safetyPreCheck", mode: options.mode, sessionID: event.sessionID, applied: enforce })
          return
        }

        // 2. Read-only skip. Only the full command can establish it.
        if (full !== undefined && isReadOnlyCommand(full)) return

        // 3. Upstream. It needs the full command. The resources are subcommands that the scanner of OpenCode split and
        // stripped of redirections and substitutions, so they are not the command. Without the full command (no tool
        // source, an evicted entry, a direct shell call), the command cannot be judged. That counts as a failure.
        const base = { point: "safetyPreCheck", mode: options.mode, sessionID: event.sessionID } as const
        if (full === undefined) {
          if (resources.length === 0) return
          failClosed(event, "The full command is unknown, so it cannot be checked. Approval is required.")
          runtime.record({ ...base, applied: enforce && options.failClosed, errorCode: "invalid-request" })
          return
        }
        const text = full
        if (text.trim() === "") return
        if (text.length > MAX_COMMAND_CHARS) {
          failClosed(event, "This command is too long to check. Approval is required.")
          runtime.record({ ...base, applied: enforce && options.failClosed, errorCode: "invalid-request" })
          return
        }
        const outcome = await runtime.decide({ state: text, questions: safetyQuestions(), timeoutMs: options.timeoutMs })
        if (runtime.disposed) return
        if (!outcome.ok) {
          // With no TypeSafe key there is no upstream check. The existing decision stays.
          const missingKey = outcome.error.code === "no-key"
          if (!missingKey) failClosed(event, "The Jev safety check failed. Approval is required.")
          runtime.record({ ...base, applied: !missingKey && enforce && options.failClosed, ...failureFields(outcome.error) })
          return
        }
        const probability = noulProbability(outcome.value, SAFETY_QUESTION_ID)
        const risky = probability > options.riskThreshold
        if (risky) ask(event, `Jev rates this command as possibly destructive (probability ${probability.toFixed(2)}). Approval is required.`)
        runtime.record({
          ...base,
          model: outcome.value.model,
          probability,
          threshold: options.riskThreshold,
          applied: risky && enforce,
          latencyMs: outcome.value.latencyMs,
          cached: outcome.value.cached,
        })
      } catch {
        // A defect in the check must not allow a command that it cannot judge.
        try {
          if (options.failClosed && event.action === "shell" && event.effect === "allow") ask(event, "The Jev safety check failed. Approval is required.")
        } catch {
          // Nothing more to do.
        }
      }
    },
  }
}

export interface Registration {
  readonly dispose: () => Promise<void>
}

/** A hook host such as `ctx.permission` or `ctx.tool`. Loosely typed so that tests pass fakes. */
export interface HookHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly hook: (name: any, callback: any) => Promise<Registration>
}

/** Disposes registrations in reverse order. Never throws. */
export async function disposeAll(registrations: Registration[]): Promise<void> {
  for (const registration of registrations.splice(0).reverse()) await registration.dispose().catch(() => undefined)
}

/** Registers the three hooks. Every registration that succeeded is disposed when a later one throws. */
export async function registerSafety(
  ctx: { readonly permission: HookHost; readonly tool: HookHost },
  runtime: JevPointRuntime,
  options: SafetyPreCheckOptions,
): Promise<Registration[]> {
  const handlers = createSafetyHandlers(runtime, options)
  const registrations: Registration[] = []
  try {
    registrations.push(await ctx.tool.hook("execute.before", handlers.before))
    registrations.push(await ctx.permission.hook("evaluate", handlers.evaluate))
    registrations.push(await ctx.tool.hook("execute.after", handlers.after))
  } catch (error) {
    await disposeAll(registrations)
    throw error
  }
  return registrations
}
