/**
 * Guard data contract. Pure module: types, limits, and strict parsers. No I/O.
 *
 * A guard is declarative deny data. A rule never holds code, SQL, or a regular expression. Every parser rejects unknown
 * fields, so a value that passes a parser has exactly the documented shape.
 *
 * Writers: only the TD-Plugin extension service writes the store (`GuardStore`). The backend plugin only reads it.
 * The backend writes `LifecycleFact` lines and `GuardRuntimeReport` files. The service reads both.
 */

export const GUARD_STORE_SCHEMA = "td-guards/1" as const
export const GUARD_RUNTIME_SCHEMA = "td-guards-runtime/1" as const

/** Bounds. Every array and every text in the contract has a bound. */
export const LIMITS = {
  /** Maximum items in any rule array (rules, subcommands, flags, resources). */
  array: 16,
  guards: 256,
  activations: 1024,
  operations: 256,
  sessions: 256,
  actions: 32,
  id: 128,
  label: 120,
  summary: 1_000,
  request: 4_000,
  message: 500,
  program: 128,
  subcommandWords: 8,
  token: 64,
  action: 64,
  resource: 512,
  storeBytes: 4 * 1024 * 1024,
} as const

export interface CommandRule {
  readonly kind: "command"
  /** Executable base name, for example `git`. No path. */
  readonly program: string
  /** Match when ANY entry is a prefix of the words after the program and its global options. Empty or absent: any. */
  readonly subcommands?: readonly (readonly string[])[]
  /** Match when ALL literal flags occur among the arguments. */
  readonly flags?: readonly string[]
}

export interface PermissionRule {
  readonly kind: "permission"
  /** Exact OpenCode permission action, for example `edit`. */
  readonly action: string
  /** Safe globs (`*`, `**`, `?`). Match when ANY resource matches ANY glob. Absent or empty: any resource. */
  readonly resources?: readonly string[]
}

export type Rule = CommandRule | PermissionRule

export interface GuardDraft {
  readonly label: string
  readonly summary: string
  readonly request: string
  readonly message: string
  readonly rules: readonly Rule[]
}

export interface Guard extends GuardDraft {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type ActivationScope = "session" | "request"

/** Frozen copy of the semantics that were active when the user enabled the guard. */
export interface ActivationSnapshot {
  readonly label: string
  readonly message: string
  readonly rules: readonly Rule[]
}

export interface Activation {
  readonly id: string
  readonly guardId: string
  /** Root session. The activation also covers every descendant session. */
  readonly sessionId: string
  readonly scope: ActivationScope
  readonly createdAt: string
  /** Explicit expiry. `null` never expires. */
  readonly expiresAt: string | null
  /** `updatedAt` of the guard when the user enabled it. Optional. */
  readonly guardUpdatedAt?: string
  /** If present, the backend enforces this snapshot and ignores later edits of the guard. Optional. */
  readonly snapshot?: ActivationSnapshot
}

export interface GuardOperation {
  readonly opId: string
  readonly result: unknown
}

export interface GuardStore {
  readonly schema: typeof GUARD_STORE_SCHEMA
  readonly revision: number
  readonly guards: readonly Guard[]
  readonly activations: readonly Activation[]
  readonly operations?: readonly GuardOperation[]
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime report (backend -> service) and lifecycle facts (backend -> service)

export type GuardStoreState = "missing" | "ready" | "invalid" | "unavailable"
export type SessionActivity = "running" | "idle" | "unknown"

export interface GuardRuntimeSession {
  readonly id: string
  readonly parentId: string | null
  readonly activity: SessionActivity
}

export interface GuardRuntimeReport {
  readonly schema: typeof GUARD_RUNTIME_SCHEMA
  /** Location directory. `null` is the global location. */
  readonly directory: string | null
  readonly instanceId: string
  /** `true` only when the hook is registered AND the plugin is not in a failed setup state. */
  readonly registered: boolean
  readonly recordedAt: string
  readonly storeState: GuardStoreState
  readonly revision: number | null
  /** Evaluations denied since this instance started. Counts only. No command or resource text. */
  readonly blockedCount: number
  /** Request activations in state `uncertain`. */
  readonly uncertainCount: number
  /** Permission actions that the hook can deny. */
  readonly coveredActions: readonly string[]
  readonly sessions: readonly GuardRuntimeSession[]
}

export type LifecycleFactKind = "bound" | "ended" | "uncertain"

/** Fixed reasons. A fact never carries free text. */
export const LIFECYCLE_REASONS = [
  "running-tracked",
  "observed-start",
  "request-completed",
  "plugin-restarted",
  "event-stream-lost",
  "run-start-unobserved",
  "shutdown",
  "descendant-never-started",
  "subagent-spawn-unobserved",
  "event-time-unknown",
] as const
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number]

export interface LifecycleFact {
  readonly activationId: string
  readonly fact: LifecycleFactKind
  readonly at: string
  readonly reason: LifecycleReason
  readonly instance: string
}

/** Actions that fail closed when the store is unreadable. */
export const MUTATING_ACTIONS = ["shell", "edit", "write", "patch", "subagent"] as const

/** Fixed texts. The model sees them. They contain no command, path, or key. */
export const FAIL_CLOSED_MESSAGE =
  "TD-Plugin guards could not be loaded, so this action is blocked until the guard store is repaired."
export const DEFAULT_DENY_MESSAGE = "A TD-Plugin guard blocks this action. Continue with other work."

// ---------------------------------------------------------------------------------------------------------------
// Result type

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] }

class Errors {
  readonly list: string[] = []
  add(path: string, message: string): void {
    if (this.list.length < 20) this.list.push(`${path}: ${message}`)
  }
}

function fail<T>(errors: Errors): ParseResult<T> {
  return { ok: false, errors: errors.list.length > 0 ? errors.list : ["invalid"] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Rejects unknown fields and missing required fields. */
function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: Errors,
): boolean {
  let ok = true
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.add(path, `unknown field ${JSON.stringify(key.slice(0, 40))}`)
      ok = false
    }
  }
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      errors.add(path, `missing field ${key}`)
      ok = false
    }
  }
  return ok
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/
// eslint-disable-next-line no-control-regex
const CONTROL_ANY = /[\u0000-\u001f\u007f\u2028\u2029]/

/** `multiline` allows tab and newline. */
function text(
  value: unknown,
  path: string,
  max: number,
  errors: Errors,
  options: { readonly multiline?: boolean; readonly allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") {
    errors.add(path, "must be a string")
    return undefined
  }
  if (!options.allowEmpty && value.trim() === "") {
    errors.add(path, "must not be empty")
    return undefined
  }
  if (value.length > max) {
    errors.add(path, `must be at most ${max} characters`)
    return undefined
  }
  if ((options.multiline ? CONTROL : CONTROL_ANY).test(value)) {
    errors.add(path, "contains control characters")
    return undefined
  }
  return value
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const SUBCOMMAND_WORD = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/
const ACTION = /^[a-z][a-z0-9_.:-]*$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function id(value: unknown, path: string, errors: Errors): string | undefined {
  const result = text(value, path, LIMITS.id, errors)
  if (result !== undefined && !ID.test(result)) {
    errors.add(path, "has unsupported characters")
    return undefined
  }
  return result
}

function iso(value: unknown, path: string, errors: Errors): string | undefined {
  if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    errors.add(path, "must be an ISO-8601 UTC timestamp")
    return undefined
  }
  return value
}

function bounded(value: unknown, path: string, max: number, errors: Errors): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.add(path, "must be an array")
    return undefined
  }
  if (value.length > max) {
    errors.add(path, `must have at most ${max} items`)
    return undefined
  }
  return value
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

/** Glob syntax: `*` (no `/`), `**` (any), `?` (one non-`/`). Everything else is literal. */
function validGlob(glob: string): boolean {
  return !/\*{3,}/.test(glob)
}

function parseRuleInto(input: unknown, path: string, errors: Errors): Rule | undefined {
  if (!isRecord(input)) {
    errors.add(path, "must be an object")
    return undefined
  }
  if (input.kind === "command") {
    if (!exact(input, ["kind", "program"], ["subcommands", "flags"], path, errors)) return undefined
    const program = text(input.program, `${path}.program`, LIMITS.program, errors)
    if (program !== undefined && !PROGRAM.test(program)) errors.add(`${path}.program`, "must be an executable name without a path")
    let subcommands: string[][] | undefined
    if (input.subcommands !== undefined) {
      const list = bounded(input.subcommands, `${path}.subcommands`, LIMITS.array, errors)
      if (list) {
        subcommands = []
        list.forEach((entry, index) => {
          const words = bounded(entry, `${path}.subcommands[${index}]`, LIMITS.subcommandWords, errors)
          if (!words) return
          if (words.length === 0) errors.add(`${path}.subcommands[${index}]`, "must not be empty")
          const parsed: string[] = []
          words.forEach((word, wordIndex) => {
            const value = text(word, `${path}.subcommands[${index}][${wordIndex}]`, LIMITS.token, errors)
            if (value === undefined) return
            if (!SUBCOMMAND_WORD.test(value)) errors.add(`${path}.subcommands[${index}][${wordIndex}]`, "must be a literal word")
            parsed.push(value)
          })
          subcommands!.push(parsed)
        })
      }
    }
    let flags: string[] | undefined
    if (input.flags !== undefined) {
      const list = bounded(input.flags, `${path}.flags`, LIMITS.array, errors)
      if (list) {
        flags = []
        list.forEach((flag, index) => {
          const value = text(flag, `${path}.flags[${index}]`, LIMITS.token, errors)
          if (value === undefined) return
          if (!FLAG.test(value)) errors.add(`${path}.flags[${index}]`, "must be a literal flag such as --force or -m")
          flags!.push(value)
        })
      }
    }
    if (errors.list.length > 0 || program === undefined) return undefined
    return {
      kind: "command",
      program,
      ...(subcommands && subcommands.length > 0 ? { subcommands } : {}),
      ...(flags && flags.length > 0 ? { flags } : {}),
    }
  }
  if (input.kind === "permission") {
    if (!exact(input, ["kind", "action"], ["resources"], path, errors)) return undefined
    const action = text(input.action, `${path}.action`, LIMITS.action, errors)
    if (action !== undefined && !ACTION.test(action)) errors.add(`${path}.action`, "must be an exact action name")
    let resources: string[] | undefined
    if (input.resources !== undefined) {
      const list = bounded(input.resources, `${path}.resources`, LIMITS.array, errors)
      if (list) {
        resources = []
        list.forEach((resource, index) => {
          const value = text(resource, `${path}.resources[${index}]`, LIMITS.resource, errors)
          if (value === undefined) return
          if (!validGlob(value)) errors.add(`${path}.resources[${index}]`, "has an unsupported glob")
          resources!.push(value)
        })
      }
    }
    if (errors.list.length > 0 || action === undefined) return undefined
    return { kind: "permission", action, ...(resources && resources.length > 0 ? { resources } : {}) }
  }
  errors.add(`${path}.kind`, 'must be "command" or "permission"')
  return undefined
}

export function validateRule(input: unknown): ParseResult<Rule> {
  const errors = new Errors()
  const rule = parseRuleInto(input, "rule", errors)
  return rule && errors.list.length === 0 ? { ok: true, value: rule } : fail(errors)
}

function parseRules(input: unknown, path: string, errors: Errors): Rule[] | undefined {
  const list = bounded(input, path, LIMITS.array, errors)
  if (!list) return undefined
  if (list.length === 0) {
    errors.add(path, "must have at least one rule")
    return undefined
  }
  const rules: Rule[] = []
  list.forEach((entry, index) => {
    const rule = parseRuleInto(entry, `${path}[${index}]`, errors)
    if (rule) rules.push(rule)
  })
  return rules
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts, guards, activations, store

function draftFields(input: Record<string, unknown>, path: string, errors: Errors): GuardDraft | undefined {
  const label = text(input.label, `${path}.label`, LIMITS.label, errors)
  const summary = text(input.summary, `${path}.summary`, LIMITS.summary, errors, { multiline: true })
  const request = text(input.request, `${path}.request`, LIMITS.request, errors, { multiline: true })
  const message = text(input.message, `${path}.message`, LIMITS.message, errors)
  const rules = parseRules(input.rules, `${path}.rules`, errors)
  if (label === undefined || summary === undefined || request === undefined || message === undefined || rules === undefined) return undefined
  return { label, summary, request, message, rules }
}

/** Validates a draft from any producer (plain-text drafting, a form, a file). */
export function validateGuardDraft(input: unknown): ParseResult<GuardDraft> {
  const errors = new Errors()
  if (!isRecord(input)) return { ok: false, errors: ["draft: must be an object"] }
  if (!exact(input, ["label", "summary", "request", "message", "rules"], [], "draft", errors)) return fail(errors)
  const draft = draftFields(input, "draft", errors)
  return draft && errors.list.length === 0 ? { ok: true, value: draft } : fail(errors)
}

function parseGuard(input: unknown, path: string, errors: Errors): Guard | undefined {
  if (!isRecord(input)) {
    errors.add(path, "must be an object")
    return undefined
  }
  if (!exact(input, ["id", "label", "summary", "request", "message", "rules", "createdAt", "updatedAt"], [], path, errors)) return undefined
  const guardId = id(input.id, `${path}.id`, errors)
  const draft = draftFields(input, path, errors)
  const createdAt = iso(input.createdAt, `${path}.createdAt`, errors)
  const updatedAt = iso(input.updatedAt, `${path}.updatedAt`, errors)
  if (!guardId || !draft || !createdAt || !updatedAt) return undefined
  return { id: guardId, ...draft, createdAt, updatedAt }
}

function parseActivation(input: unknown, path: string, errors: Errors): Activation | undefined {
  if (!isRecord(input)) {
    errors.add(path, "must be an object")
    return undefined
  }
  if (!exact(input, ["id", "guardId", "sessionId", "scope", "createdAt", "expiresAt"], ["guardUpdatedAt", "snapshot"], path, errors)) return undefined
  const activationId = id(input.id, `${path}.id`, errors)
  const guardId = id(input.guardId, `${path}.guardId`, errors)
  const sessionId = id(input.sessionId, `${path}.sessionId`, errors)
  let scope: ActivationScope | undefined
  if (input.scope === "session" || input.scope === "request") scope = input.scope
  else errors.add(`${path}.scope`, 'must be "session" or "request"')
  const createdAt = iso(input.createdAt, `${path}.createdAt`, errors)
  let expiresAt: string | null | undefined
  if (input.expiresAt === null) expiresAt = null
  else expiresAt = iso(input.expiresAt, `${path}.expiresAt`, errors)
  let guardUpdatedAt: string | undefined
  if (input.guardUpdatedAt !== undefined) guardUpdatedAt = iso(input.guardUpdatedAt, `${path}.guardUpdatedAt`, errors)
  let snapshot: ActivationSnapshot | undefined
  if (input.snapshot !== undefined) {
    const raw = input.snapshot
    if (!isRecord(raw)) errors.add(`${path}.snapshot`, "must be an object")
    else if (exact(raw, ["label", "message", "rules"], [], `${path}.snapshot`, errors)) {
      const label = text(raw.label, `${path}.snapshot.label`, LIMITS.label, errors)
      const message = text(raw.message, `${path}.snapshot.message`, LIMITS.message, errors)
      const rules = parseRules(raw.rules, `${path}.snapshot.rules`, errors)
      if (label !== undefined && message !== undefined && rules) snapshot = { label, message, rules }
    }
  }
  if (!activationId || !guardId || !sessionId || !scope || !createdAt || expiresAt === undefined) return undefined
  if (input.guardUpdatedAt !== undefined && guardUpdatedAt === undefined) return undefined
  if (input.snapshot !== undefined && snapshot === undefined) return undefined
  return {
    id: activationId,
    guardId,
    sessionId,
    scope,
    createdAt,
    expiresAt,
    ...(guardUpdatedAt ? { guardUpdatedAt } : {}),
    ...(snapshot ? { snapshot } : {}),
  }
}

export function parseGuardStore(input: unknown): ParseResult<GuardStore> {
  const errors = new Errors()
  if (!isRecord(input)) return { ok: false, errors: ["store: must be an object"] }
  if (!exact(input, ["schema", "revision", "guards", "activations"], ["operations"], "store", errors)) return fail(errors)
  if (input.schema !== GUARD_STORE_SCHEMA) errors.add("store.schema", `must be ${GUARD_STORE_SCHEMA}`)
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0) errors.add("store.revision", "must be a non-negative integer")
  const guardList = bounded(input.guards, "store.guards", LIMITS.guards, errors)
  const activationList = bounded(input.activations, "store.activations", LIMITS.activations, errors)
  const guards: Guard[] = []
  const guardIds = new Set<string>()
  guardList?.forEach((entry, index) => {
    const guard = parseGuard(entry, `store.guards[${index}]`, errors)
    if (!guard) return
    if (guardIds.has(guard.id)) errors.add(`store.guards[${index}].id`, "is duplicated")
    guardIds.add(guard.id)
    guards.push(guard)
  })
  const activations: Activation[] = []
  const activationIds = new Set<string>()
  activationList?.forEach((entry, index) => {
    const activation = parseActivation(entry, `store.activations[${index}]`, errors)
    if (!activation) return
    if (activationIds.has(activation.id)) errors.add(`store.activations[${index}].id`, "is duplicated")
    activationIds.add(activation.id)
    activations.push(activation)
  })
  let operations: GuardOperation[] | undefined
  if (input.operations !== undefined) {
    const list = bounded(input.operations, "store.operations", LIMITS.operations, errors)
    if (list) {
      operations = []
      list.forEach((entry, index) => {
        const path = `store.operations[${index}]`
        if (!isRecord(entry)) return errors.add(path, "must be an object")
        if (!exact(entry, ["opId"], ["result"], path, errors)) return
        const opId = id(entry.opId, `${path}.opId`, errors)
        if (opId) operations!.push({ opId, result: entry.result })
      })
    }
  }
  if (errors.list.length > 0) return fail(errors)
  return {
    ok: true,
    value: {
      schema: GUARD_STORE_SCHEMA,
      revision: input.revision as number,
      guards,
      activations,
      ...(operations ? { operations } : {}),
    },
  }
}

/** Parses store file text. Rejects text above `LIMITS.storeBytes`. */
export function parseGuardStoreText(source: string): ParseResult<GuardStore> {
  if (new TextEncoder().encode(source).length > LIMITS.storeBytes) return { ok: false, errors: ["store: file is too large"] }
  let json: unknown
  try {
    json = JSON.parse(source)
  } catch {
    return { ok: false, errors: ["store: not valid JSON"] }
  }
  return parseGuardStore(json)
}

export function emptyGuardStore(): GuardStore {
  return { schema: GUARD_STORE_SCHEMA, revision: 0, guards: [], activations: [] }
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime report and lifecycle fact parsers (the service reads both)

const STORE_STATES: readonly string[] = ["missing", "ready", "invalid", "unavailable"]
const ACTIVITIES: readonly string[] = ["running", "idle", "unknown"]

export function parseRuntimeReport(input: unknown): ParseResult<GuardRuntimeReport> {
  const errors = new Errors()
  if (!isRecord(input)) return { ok: false, errors: ["report: must be an object"] }
  const keys = ["schema", "directory", "instanceId", "registered", "recordedAt", "storeState", "revision", "blockedCount", "uncertainCount", "coveredActions", "sessions"]
  if (!exact(input, keys, [], "report", errors)) return fail(errors)
  if (input.schema !== GUARD_RUNTIME_SCHEMA) errors.add("report.schema", `must be ${GUARD_RUNTIME_SCHEMA}`)
  const directory = input.directory === null ? null : text(input.directory, "report.directory", 4096, errors)
  const instanceId = id(input.instanceId, "report.instanceId", errors)
  if (typeof input.registered !== "boolean") errors.add("report.registered", "must be a boolean")
  const recordedAt = iso(input.recordedAt, "report.recordedAt", errors)
  if (typeof input.storeState !== "string" || !STORE_STATES.includes(input.storeState)) errors.add("report.storeState", "is not a known state")
  if (input.revision !== null && !(typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 0)) errors.add("report.revision", "must be null or a non-negative integer")
  for (const key of ["blockedCount", "uncertainCount"] as const) {
    const value = input[key]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) errors.add(`report.${key}`, "must be a non-negative integer")
  }
  const covered = bounded(input.coveredActions, "report.coveredActions", LIMITS.actions, errors)
  const coveredActions: string[] = []
  covered?.forEach((action, index) => {
    const value = text(action, `report.coveredActions[${index}]`, LIMITS.action, errors)
    if (value !== undefined) coveredActions.push(value)
  })
  const list = bounded(input.sessions, "report.sessions", LIMITS.sessions, errors)
  const sessions: GuardRuntimeSession[] = []
  list?.forEach((entry, index) => {
    const path = `report.sessions[${index}]`
    if (!isRecord(entry)) return errors.add(path, "must be an object")
    if (!exact(entry, ["id", "parentId", "activity"], [], path, errors)) return
    const sessionId = id(entry.id, `${path}.id`, errors)
    const parentId = entry.parentId === null ? null : id(entry.parentId, `${path}.parentId`, errors)
    if (typeof entry.activity !== "string" || !ACTIVITIES.includes(entry.activity)) errors.add(`${path}.activity`, "is not a known activity")
    if (sessionId && parentId !== undefined && typeof entry.activity === "string" && ACTIVITIES.includes(entry.activity)) {
      sessions.push({ id: sessionId, parentId, activity: entry.activity as SessionActivity })
    }
  })
  if (errors.list.length > 0 || directory === undefined || !instanceId || !recordedAt) return fail(errors)
  return {
    ok: true,
    value: {
      schema: GUARD_RUNTIME_SCHEMA,
      directory,
      instanceId,
      registered: input.registered as boolean,
      recordedAt,
      storeState: input.storeState as GuardStoreState,
      revision: input.revision as number | null,
      blockedCount: input.blockedCount as number,
      uncertainCount: input.uncertainCount as number,
      coveredActions,
      sessions,
    },
  }
}

export function parseLifecycleFact(input: unknown): ParseResult<LifecycleFact> {
  const errors = new Errors()
  if (!isRecord(input)) return { ok: false, errors: ["fact: must be an object"] }
  if (!exact(input, ["activationId", "fact", "at", "reason", "instance"], [], "fact", errors)) return fail(errors)
  const activationId = id(input.activationId, "fact.activationId", errors)
  if (input.fact !== "bound" && input.fact !== "ended" && input.fact !== "uncertain") errors.add("fact.fact", "is not a known fact")
  const at = iso(input.at, "fact.at", errors)
  if (typeof input.reason !== "string" || !(LIFECYCLE_REASONS as readonly string[]).includes(input.reason)) errors.add("fact.reason", "is not a known reason")
  const instance = id(input.instance, "fact.instance", errors)
  if (errors.list.length > 0 || !activationId || !at || !instance) return fail(errors)
  return {
    ok: true,
    value: { activationId, fact: input.fact as LifecycleFactKind, at, reason: input.reason as LifecycleReason, instance },
  }
}

/** Parses one lifecycle line. Returns `undefined` for a malformed line. Callers must skip it and keep reading. */
export function parseLifecycleLine(line: string): LifecycleFact | undefined {
  if (line.length === 0 || line.length > 2048) return undefined
  try {
    const result = parseLifecycleFact(JSON.parse(line))
    return result.ok ? result.value : undefined
  } catch {
    return undefined
  }
}

/** Bounded single-line message for the model. Strips control characters. */
export function sanitizeMessage(message: string | undefined): string {
  if (typeof message !== "string") return DEFAULT_DENY_MESSAGE
  const clean = message.replace(new RegExp(CONTROL_ANY.source, "g"), " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.message)
  return clean === "" ? DEFAULT_DENY_MESSAGE : clean
}

/** Expiry is an explicit timestamp, evaluated at each action. There is no timer. */
export function isExpired(activation: Pick<Activation, "expiresAt">, nowMs: number): boolean {
  return activation.expiresAt !== null && Date.parse(activation.expiresAt) <= nowMs
}
