/**
 * The status report td-opencode-plugin writes for this panel (schema version 1).
 * The panel only reads it. Every field is checked before use, so a damaged,
 * partial, or newer report never reaches the view as trusted data.
 */

export type AuthSource = "none" | "keychain" | "credential-store" | "environment"
export type Activation = "enabled" | "auto"
export type ShellKeyScrubbing = "enabled" | "disabled" | "failed"
export type BatchTools = "registered" | "failed"
export type ModelSource = "cache" | "catalog" | "discovery"
export type CheckOutcome = "updated" | "unchanged" | "no-key" | "empty" | "rejected" | "failed"
export type ReloadResult = "not-needed" | "succeeded" | "failed"

export type ProviderModels = { id: string; count: number; titleModel: string | null }

export type LastCheck = {
  startedAt: string
  finishedAt: string
  outcome: CheckOutcome
  added: string[]
  removed: string[]
  reason: string | null
  reload: ReloadResult
}

export type LastChange = { at: string; added: string[]; removed: string[] }

export type StatusReport = {
  version: 1
  pluginVersion: string
  directory: string | null
  startedAt: string
  recordedAt: string
  checking: boolean
  configuration: {
    refreshMinutes: number
    includeNonChatModels: boolean
    authSource: AuthSource
    activation: Activation
    shellKeyScrubbing: ShellKeyScrubbing
    batchTools: BatchTools
    authHooks: { sessionProviders: string[]; aiSdk: boolean }
  }
  models: { source: ModelSource; providers: ProviderModels[] }
  lastCheck: LastCheck | null
  lastSuccessfulCheckAt: string | null
  lastChange: LastChange | null
}

export type ParseResult =
  | { ok: true; report: StatusReport }
  | { ok: false; problem: "malformed" }
  | { ok: false; problem: "unsupported"; version: string }

export const REPORT_VERSION = 1

// No length caps: the plugin keeps every model ID and refuses to write a report
// over 1,000,000 bytes, which is below the host's 2 MB read limit.

class Invalid extends Error {}

type Raw = Record<string, unknown>

const fail = (field: string): never => {
  throw new Invalid(field)
}

const object = (value: unknown, field: string): Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : fail(field)

const text = (value: unknown, field: string): string => (typeof value === "string" ? value : fail(field))

const nullableText = (value: unknown, field: string): string | null => (value === null ? null : text(value, field))

const bool = (value: unknown, field: string): boolean => (typeof value === "boolean" ? value : fail(field))

const count = (value: unknown, field: string): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(field)

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fail(field)

const isoTime = (value: unknown, field: string): string => {
  const raw = text(value, field)
  return Number.isNaN(Date.parse(raw)) ? fail(field) : raw
}

const nullableIso = (value: unknown, field: string): string | null => (value === null ? null : isoTime(value, field))

const textList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) return fail(field)
  return value.map((entry, index) => text(entry, `${field}[${index}]`))
}

const OUTCOMES: readonly CheckOutcome[] = ["updated", "unchanged", "no-key", "empty", "rejected", "failed"]
const RELOADS: readonly ReloadResult[] = ["not-needed", "succeeded", "failed"]

const readLastCheck = (value: unknown): LastCheck | null => {
  if (value === null) return null
  const raw = object(value, "lastCheck")
  return {
    startedAt: isoTime(raw.startedAt, "lastCheck.startedAt"),
    finishedAt: isoTime(raw.finishedAt, "lastCheck.finishedAt"),
    outcome: oneOf(raw.outcome, OUTCOMES, "lastCheck.outcome"),
    added: textList(raw.added, "lastCheck.added"),
    removed: textList(raw.removed, "lastCheck.removed"),
    reason: nullableText(raw.reason, "lastCheck.reason"),
    reload: oneOf(raw.reload, RELOADS, "lastCheck.reload"),
  }
}

const readLastChange = (value: unknown): LastChange | null => {
  if (value === null) return null
  const raw = object(value, "lastChange")
  return {
    at: isoTime(raw.at, "lastChange.at"),
    added: textList(raw.added, "lastChange.added"),
    removed: textList(raw.removed, "lastChange.removed"),
  }
}

const readProviders = (value: unknown): ProviderModels[] => {
  if (!Array.isArray(value)) return fail("models.providers")
  return value.map((entry, index) => {
    const raw = object(entry, `models.providers[${index}]`)
    return {
      id: text(raw.id, "models.providers.id"),
      count: count(raw.count, "models.providers.count"),
      titleModel: nullableText(raw.titleModel, "models.providers.titleModel"),
    }
  })
}

const readReport = (raw: Raw): StatusReport => {
  const configuration = object(raw.configuration, "configuration")
  const authHooks = object(configuration.authHooks, "configuration.authHooks")
  const models = object(raw.models, "models")
  return {
    version: 1,
    pluginVersion: text(raw.pluginVersion, "pluginVersion"),
    directory: raw.directory === null ? null : text(raw.directory, "directory"),
    startedAt: isoTime(raw.startedAt, "startedAt"),
    recordedAt: isoTime(raw.recordedAt, "recordedAt"),
    checking: bool(raw.checking, "checking"),
    configuration: {
      refreshMinutes: count(configuration.refreshMinutes, "configuration.refreshMinutes"),
      includeNonChatModels: bool(configuration.includeNonChatModels, "configuration.includeNonChatModels"),
      authSource: oneOf(
        configuration.authSource,
        ["none", "keychain", "credential-store", "environment"] as const,
        "configuration.authSource",
      ),
      activation: oneOf(configuration.activation, ["enabled", "auto"] as const, "configuration.activation"),
      shellKeyScrubbing: oneOf(
        configuration.shellKeyScrubbing,
        ["enabled", "disabled", "failed"] as const,
        "configuration.shellKeyScrubbing",
      ),
      batchTools: oneOf(configuration.batchTools, ["registered", "failed"] as const, "configuration.batchTools"),
      authHooks: {
        sessionProviders: textList(authHooks.sessionProviders, "configuration.authHooks.sessionProviders"),
        aiSdk: bool(authHooks.aiSdk, "configuration.authHooks.aiSdk"),
      },
    },
    models: {
      source: oneOf(models.source, ["cache", "catalog", "discovery"] as const, "models.source"),
      providers: readProviders(models.providers),
    },
    lastCheck: readLastCheck(raw.lastCheck),
    lastSuccessfulCheckAt: nullableIso(raw.lastSuccessfulCheckAt, "lastSuccessfulCheckAt"),
    lastChange: readLastChange(raw.lastChange),
  }
}

const REDACTED = "[redacted]"

/**
 * Whether the report's `directory` describes the location the panel asked for.
 * The file name already comes from the hash of the real directory. The stored
 * directory is sanitized, so a `[redacted]` part matches any text there.
 */
export const matchesLocation = (reported: string | null, requested: string | null): boolean => {
  if (reported === requested) return true
  if (reported === null || requested === null) return false
  if (!reported.includes(REDACTED)) return false
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^${reported.split(REDACTED).map(escape).join("[\\s\\S]*")}$`)
  return pattern.test(requested)
}

/** Parses report text. Never throws. */
export const parseReport = (content: string): ParseResult => {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return { ok: false, problem: "malformed" }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "malformed" }
  const version = (raw as Raw).version
  if (version !== REPORT_VERSION) {
    if (typeof version === "number" || typeof version === "string") {
      return { ok: false, problem: "unsupported", version: String(version).slice(0, 20) }
    }
    return { ok: false, problem: "malformed" }
  }
  try {
    return { ok: true, report: readReport(raw as Raw) }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, problem: "malformed" }
    throw error
  }
}
