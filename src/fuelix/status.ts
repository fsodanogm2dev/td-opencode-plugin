/**
 * Status report. The plugin records what it configured and the result of its latest model-discovery check as one
 * JSON file per location. An OpenChamber extension reads the file. The file is a recorded snapshot. It does not
 * prove that the plugin is running now.
 *
 * The report holds no key, header, raw configuration, or exception message. `sanitizeReport` rebuilds the report from
 * known fields and replaces known secrets. It keeps every model ID and every name in full. A report above
 * `MAX_REPORT_BYTES` is not written at all. The previous file stays in place.
 *
 * `lastChange` describes the current plugin run. It is not stored across a restart.
 */

import { createHash, randomBytes } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import { join } from "node:path"
import pkg from "../../package.json" with { type: "json" }
import { redact, type Logger } from "../log.ts"

export const STATUS_REPORT_VERSION = 1

export const PLUGIN_VERSION: string = typeof pkg.version === "string" ? pkg.version : "unknown"

export type AuthSource = "none" | "keychain" | "credential-store" | "environment"
export type ShellKeyScrubbing = "enabled" | "disabled" | "failed"
export type ModelSource = "cache" | "catalog" | "discovery"
export type CheckOutcome = "updated" | "unchanged" | "no-key" | "empty" | "rejected" | "failed"
export type ReloadResult = "not-needed" | "succeeded" | "failed"

/**
 * Fixed reason texts. A reason is never an exception message. `sanitizeReport` replaces any other text with
 * `REASONS.unexpected`.
 */
export const REASONS = {
  noKey: "No API key available",
  empty: "Discovery returned no models",
  dropShare: "Result would remove too many models",
  providerEmptied: "Result would remove every model of a provider",
  keyRejected: "The gateway rejected the API key",
  checkFailed: "Model discovery check failed",
  reloadFailed: "Provider reload failed",
  unexpected: "Unexpected status",
} as const

export type StatusReason = (typeof REASONS)[keyof typeof REASONS]

export interface StatusConfiguration {
  readonly refreshMinutes: number
  readonly includeNonChatModels: boolean
  readonly authSource: AuthSource
  readonly activation: "enabled" | "auto"
  readonly shellKeyScrubbing: ShellKeyScrubbing
  readonly batchTools: "registered" | "failed"
  readonly authHooks: { readonly sessionProviders: readonly string[]; readonly aiSdk: boolean }
}

export interface StatusProvider {
  readonly id: string
  /** Models that were eligible and built successfully. */
  readonly count: number
  readonly titleModel: string | null
}

export interface StatusCheck {
  readonly startedAt: string
  readonly finishedAt: string
  readonly outcome: CheckOutcome
  /** Eligible, successfully built chat models. Non-chat API IDs that the plugin ignores do not appear. */
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** One of `REASONS`, after scrubbing. */
  readonly reason: string | null
  readonly reload: ReloadResult
}

export interface StatusChange {
  readonly at: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface FuelixStatusReport {
  readonly version: 1
  readonly pluginVersion: string
  /** Location that produced the report. `null` is the global location. */
  readonly directory: string | null
  readonly startedAt: string
  readonly recordedAt: string
  readonly checking: boolean
  readonly configuration: StatusConfiguration
  readonly models: {
    /** Where the list that the plugin last applied came from. */
    readonly source: ModelSource
    readonly providers: readonly StatusProvider[]
  }
  readonly lastCheck: StatusCheck | null
  /** Finish time of the latest check with outcome `updated` or `unchanged`. */
  readonly lastSuccessfulCheckAt: string | null
  /** Latest check that changed the applied list. An unchanged check does not clear it. */
  readonly lastChange: StatusChange | null
}

/**
 * Where a report goes. `directory` is the real location path. The report itself holds a scrubbed copy, so only the
 * real path gives the file name that the panel looks up.
 */
export interface StatusReportLocation {
  readonly directory: string | null
}

/** Writes one report. May reject; the recorder treats every failure as nonfatal. */
export type StatusReportWriter = (report: FuelixStatusReport, location?: StatusReportLocation) => Promise<void>

/** Serializes a sanitized report. Rejects a report above `MAX_REPORT_BYTES`. */
export function serializeReport(report: FuelixStatusReport): string {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (Buffer.byteLength(json, "utf8") > MAX_REPORT_BYTES) throw new ReportTooLargeError()
  return json
}

export class ReportTooLargeError extends Error {
  readonly code = "ETOOLARGE"
  constructor() {
    super("status report is too large")
    this.name = "ReportTooLargeError"
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitizing

/** Stays below the SDK text-file read limit. A larger report is rejected as a whole. */
export const MAX_REPORT_BYTES = 1_000_000
const EPOCH = "1970-01-01T00:00:00.000Z"

const AUTH_SOURCES: readonly string[] = ["none", "keychain", "credential-store", "environment"]
const SHELL_STATES: readonly string[] = ["enabled", "disabled", "failed"]
const MODEL_SOURCES: readonly string[] = ["cache", "catalog", "discovery"]
const OUTCOMES: readonly string[] = ["updated", "unchanged", "no-key", "empty", "rejected", "failed"]
const RELOADS: readonly string[] = ["not-needed", "succeeded", "failed"]
const REASON_TEXTS: readonly string[] = Object.values(REASONS)

const REPLACEMENTS = ["[redacted]", "[removed]", "[hidden]", "***", "#"]

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Replaces every known secret of any length in one pass, longest first. The replacement token is one that no
 * secret contains. Without such a token, the secret is removed.
 */
function scrub(value: string, secrets: readonly string[]): string {
  const known = [...new Set(secrets.filter((secret) => secret !== ""))].sort((a, b) => b.length - a.length)
  let text = value
  if (known.length > 0) {
    const replacement = REPLACEMENTS.find((candidate) => known.every((secret) => !candidate.includes(secret))) ?? ""
    const pattern = new RegExp(known.map(escapeRegExp).join("|"), "g")
    // A removal can join two pieces into a new match. Repeat until none is left.
    for (let pass = 0; pass < 32; pass++) {
      const next = text.replace(pattern, () => replacement)
      if (next === text) break
      text = next
    }
  }
  return redact(text)
}

function text(value: unknown, secrets: readonly string[]): string {
  return scrub(typeof value === "string" ? value : "", secrets)
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback
}

function iso(value: unknown): string {
  if (typeof value !== "string") return EPOCH
  const time = Date.parse(value)
  return Number.isNaN(time) ? EPOCH : new Date(time).toISOString()
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function ids(value: unknown, secrets: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  return value.map((id) => text(id, secrets))
}

/** A fixed reason text, scrubbed like every other string. Any other text becomes `REASONS.unexpected`. */
function scrubReason(reason: unknown, secrets: readonly string[]): string {
  const fixed = typeof reason === "string" && REASON_TEXTS.includes(reason) ? reason : REASONS.unexpected
  return scrub(fixed, secrets)
}

/** Rebuilds a report from known fields only. Strings lose known secrets and secret-like tokens. Nothing is cut short. */
export function sanitizeReport(report: FuelixStatusReport, secrets: readonly string[] = []): FuelixStatusReport {
  const config = report.configuration
  const check = report.lastCheck
  const change = report.lastChange
  const reason = check?.reason
  return {
    version: STATUS_REPORT_VERSION,
    pluginVersion: text(report.pluginVersion, secrets),
    directory: typeof report.directory === "string" ? text(report.directory, secrets) : null,
    startedAt: iso(report.startedAt),
    recordedAt: iso(report.recordedAt),
    checking: report.checking === true,
    configuration: {
      refreshMinutes: count(config?.refreshMinutes),
      includeNonChatModels: config?.includeNonChatModels === true,
      authSource: oneOf<AuthSource>(config?.authSource, AUTH_SOURCES, "none"),
      activation: config?.activation === "enabled" ? "enabled" : "auto",
      shellKeyScrubbing: oneOf<ShellKeyScrubbing>(config?.shellKeyScrubbing, SHELL_STATES, "failed"),
      batchTools: config?.batchTools === "registered" ? "registered" : "failed",
      authHooks: {
        sessionProviders: Array.isArray(config?.authHooks?.sessionProviders)
          ? config.authHooks.sessionProviders.map((id) => text(id, secrets))
          : [],
        aiSdk: config?.authHooks?.aiSdk === true,
      },
    },
    models: {
      source: oneOf<ModelSource>(report.models?.source, MODEL_SOURCES, "catalog"),
      providers: Array.isArray(report.models?.providers)
        ? report.models.providers.map((provider) => ({
            id: text(provider?.id, secrets),
            count: count(provider?.count),
            titleModel: typeof provider?.titleModel === "string" ? text(provider.titleModel, secrets) : null,
          }))
        : [],
    },
    lastCheck: check
      ? {
          startedAt: iso(check.startedAt),
          finishedAt: iso(check.finishedAt),
          outcome: oneOf<CheckOutcome>(check.outcome, OUTCOMES, "failed"),
          added: ids(check.added, secrets),
          removed: ids(check.removed, secrets),
          reason: reason === null || reason === undefined ? null : scrubReason(reason, secrets),
          reload: oneOf<ReloadResult>(check.reload, RELOADS, "not-needed"),
        }
      : null,
    lastSuccessfulCheckAt: isoOrNull(report.lastSuccessfulCheckAt),
    lastChange: change ? { at: iso(change.at), added: ids(change.added, secrets), removed: ids(change.removed, secrets) } : null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// File writer

/** File name of a location: the SHA-256 of its UTF-8 directory path as hex, or `global` without a directory. */
export function statusFileName(directory: string | null): string {
  if (directory === null) return "global.json"
  return `${createHash("sha256").update(Buffer.from(directory, "utf8")).digest("hex")}.json`
}

/** Report directory below a home directory. */
export function statusReportRoot(home: string): string {
  return join(home, ".td-opencode-plugin", "status")
}

export interface FileStatusWriterOptions {
  /** Absolute report directory. Overrides the home-based default. For tests. */
  readonly root?: string
  /** Home directory source. Called at each write. */
  readonly homedir?: () => string
}

/**
 * Writes `<root>/<file name>` atomically: a temporary file in the same directory, then a rename. The directory has
 * mode 0700 and the file has mode 0600. A failed write removes its temporary file and rejects.
 */
export function createFileStatusWriter(options: FileStatusWriterOptions = {}): StatusReportWriter {
  const homedir = options.homedir ?? osHomedir
  return async (report, location) => {
    const body = serializeReport(report)
    const root = options.root ?? statusReportRoot(homedir())
    const target = join(root, statusFileName(location ? location.directory : report.directory))
    const temporary = join(root, `.${randomBytes(8).toString("hex")}.tmp`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recorder

export interface StatusState {
  readonly checking: boolean
  readonly configuration: StatusConfiguration
  readonly models: FuelixStatusReport["models"]
  readonly lastCheck: StatusCheck | null
  readonly lastSuccessfulCheckAt: string | null
  readonly lastChange: StatusChange | null
}

export type StatusPatch = Partial<Omit<StatusState, "configuration">> & {
  readonly configuration?: Partial<StatusConfiguration>
}

export interface StatusRecorder {
  /** Applies a patch and schedules a write. Never throws. Ignored after `close`. */
  update(patch: StatusPatch): void
  /** Resolves when no write is pending. Never rejects. */
  flush(): Promise<void>
  /** Stops all later writes. A write in flight finishes. */
  close(): void
}

export interface StatusRecorderInput {
  readonly directory: string | null
  readonly startedAt: Date
  readonly now: () => Date
  readonly write: StatusReportWriter
  readonly log: Logger
  readonly initial: StatusState
  /** Secrets known now. The recorder also remembers earlier values, so a rotated key stays redacted. */
  readonly secrets: () => readonly (string | undefined)[]
  readonly pluginVersion?: string
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && /^E[A-Z0-9_]{1,20}$/.test(code) ? code : undefined
}

/**
 * Keeps the latest state and writes it in order. Writes run one at a time; updates that arrive during a write
 * merge into one following write. Callers never wait for I/O.
 *
 * The recorder remembers every secret that it has seen until `close`, so a rotated key stays redacted in state
 * that it kept from an earlier check.
 */
export function createStatusRecorder(input: StatusRecorderInput): StatusRecorder {
  let state = input.initial
  let dirty = false
  let closed = false
  let running = false
  let current: Promise<void> = Promise.resolve()
  let failing = false
  const seen = new Set<string>()

  const secrets = (): string[] => {
    try {
      for (const value of input.secrets()) {
        if (typeof value === "string" && value !== "") seen.add(value)
      }
    } catch {
      // Keep the secrets that the recorder already knows.
    }
    return [...seen]
  }

  const snapshot = (): FuelixStatusReport => {
    const report = sanitizeReport(
      {
        version: STATUS_REPORT_VERSION,
        pluginVersion: input.pluginVersion ?? PLUGIN_VERSION,
        directory: input.directory,
        startedAt: input.startedAt.toISOString(),
        recordedAt: input.now().toISOString(),
        ...state,
      },
      secrets(),
    )
    serializeReport(report) // Rejects an overlarge report before any writer sees it.
    return report
  }

  const drain = async (): Promise<void> => {
    try {
      while (dirty && !closed) {
        dirty = false
        try {
          await input.write(snapshot(), { directory: input.directory })
          failing = false
        } catch (error) {
          if (!failing) {
            failing = true
            const code = errorCode(error)
            input.log.warn("FueliX status report write failed", code ? { code } : undefined)
          }
        }
      }
    } finally {
      running = false
    }
  }

  return {
    update(patch) {
      if (closed) return
      secrets() // Remember the keys that exist now, even if a rotation happens before the write.
      const { configuration, ...rest } = patch
      state = { ...state, ...rest, configuration: { ...state.configuration, ...configuration } }
      dirty = true
      // `running` is the only scheduling flag. A writer that fails synchronously finishes `drain` before this
      // assignment, and the flag is already false by then.
      if (running) return
      running = true
      current = drain()
    },
    async flush() {
      while (running) await current
    },
    close() {
      closed = true
      seen.clear()
    },
  }
}
