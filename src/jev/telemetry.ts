/**
 * Jev telemetry: one JSON object per line in `<root>/telemetry.jsonl`.
 *
 * Only allowlisted fields reach the file. Every value is validated by type, range, or fixed pattern, so no command,
 * prompt, output text, key, or arbitrary ID can enter a row. The session ID is stored as a SHA-256 name.
 *
 * The file has mode 0600 in a 0700 directory. At 5 MiB it rotates to `telemetry.jsonl.1`, so two files hold at
 * most 10 MiB. One writer per file path serves the whole process, and writes run one after the other.
 */

import { rename } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Logger } from "../log.ts"
import { ensureRoot, hashName, lstatOrUndefined, openPrivateAppend, JevArtifactError } from "./artifacts.ts"
import { redactText } from "./redact.ts"
import { JEV_ERROR_CODES, JEV_POINT_NAMES } from "./types.ts"

export const TELEMETRY_FILE = "telemetry.jsonl"
export const TELEMETRY_MAX_FILE_BYTES = 5 * 1024 * 1024
export const TELEMETRY_MAX_ROW_BYTES = 2048
/** Rows waiting for the writer. More rows are dropped. */
export const TELEMETRY_MAX_PENDING = 500

const MODES = ["off", "shadow", "enforce"] as const
/** Known Jev model names only: a version (`jev-1.14.0`, `jev-1.14`) or `jev-latest` or `jev-preview`. Anything else, including other upstream names, is dropped. */
const JEV_MODEL = /^jev-(?:\d{1,3}\.\d{1,3}(?:\.\d{1,3})?|latest|preview)$/

/** `hashName` output: exactly 32 lowercase hex characters. */
const SKILL_HASH = /^[0-9a-f]{32}$/

/** The only `choice` values a row can carry: the `error_type` options and the reasoning effort IDs. */
export const TELEMETRY_CHOICES = ["assertion", "syntax", "environment", "timeout", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * One telemetry event. The input is `unknown` on purpose: `sanitizeTelemetryEvent` copies only the fields below,
 * and drops a field whose value fails its check.
 */
export interface JevTelemetryEvent {
  readonly point: (typeof JEV_POINT_NAMES)[number]
  readonly mode: (typeof MODES)[number]
  /** Raw OpenCode session ID. The row stores its SHA-256 name. */
  readonly sessionID?: string
  /** Model that answered (`response.model`). Only known Jev versions and the `jev-latest` and `jev-preview` aliases are kept. */
  readonly model?: string
  readonly probability?: number
  /** One of `TELEMETRY_CHOICES`, for example `assertion`. */
  readonly choice?: string
  readonly score?: number
  readonly threshold?: number
  readonly applied?: boolean
  readonly latencyMs?: number
  readonly cached?: boolean
  readonly errorCode?: (typeof JEV_ERROR_CODES)[number]
  /** HTTP status of a failed call. */
  readonly status?: number
  readonly inputChars?: number
  readonly outputChars?: number
  readonly estimatedTokens?: number
  readonly estimatedSavedTokens?: number
  /** `hashName(skillID)`: exactly 32 lowercase hex characters. Anything else is dropped, so no plaintext enters a row. */
  readonly skillHash?: string
  /** Whether the kept skill set differs from the previous request (skill pruning, shadow). */
  readonly skillSetChanged?: boolean
}

type Row = Record<string, string | number | boolean>

function count(value: unknown, max = 1e9): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined
}

function unit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 10_000) / 10_000 : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

/** A Jev model name that no secret pattern changes. */
function modelName(value: unknown): string | undefined {
  return typeof value === "string" && JEV_MODEL.test(value) && redactText(value) === value ? value : undefined
}

/**
 * Builds the row for an event. Returns `undefined` when `point` or `mode` is invalid. Unknown fields are dropped.
 * `time` is an ISO timestamp from `nowMs`.
 */
export function sanitizeTelemetryEvent(event: unknown, nowMs: number): Row | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const source = event as Record<string, unknown>
  const point = oneOf(source.point, JEV_POINT_NAMES)
  const mode = oneOf(source.mode, MODES)
  if (!point || !mode) return undefined
  const row: Row = { time: new Date(nowMs).toISOString(), point, mode }
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) row[key] = value
  }
  if (typeof source.sessionID === "string" && source.sessionID.length > 0) put("session", hashName(source.sessionID))
  put("model", modelName(source.model))
  put("probability", unit(source.probability))
  put("choice", oneOf(source.choice, TELEMETRY_CHOICES))
  put(
    "score",
    typeof source.score === "number" && Number.isFinite(source.score) && Math.abs(source.score) <= 1000
      ? Math.round(source.score * 10_000) / 10_000
      : undefined,
  )
  put("threshold", unit(source.threshold))
  put("applied", typeof source.applied === "boolean" ? source.applied : undefined)
  put("latencyMs", count(source.latencyMs, 3_600_000))
  put("cached", typeof source.cached === "boolean" ? source.cached : undefined)
  put("errorCode", oneOf(source.errorCode, JEV_ERROR_CODES))
  put("status", typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599 ? source.status : undefined)
  put("inputChars", count(source.inputChars))
  put("outputChars", count(source.outputChars))
  put("estimatedTokens", count(source.estimatedTokens))
  put("estimatedSavedTokens", typeof source.estimatedSavedTokens === "number" && Number.isFinite(source.estimatedSavedTokens) && Math.abs(source.estimatedSavedTokens) <= 1e9 ? Math.round(source.estimatedSavedTokens) : undefined)
  put("skillHash", typeof source.skillHash === "string" && SKILL_HASH.test(source.skillHash) ? source.skillHash : undefined)
  put("skillSetChanged", typeof source.skillSetChanged === "boolean" ? source.skillSetChanged : undefined)
  return row
}

export interface JevTelemetryOptions {
  /** Absolute artifact root, see `defaultJevRoot`. */
  readonly root: string
  /** When false, `record` does nothing. */
  readonly enabled: boolean
  readonly log?: Logger
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
  /** Rotation size. Values above `TELEMETRY_MAX_FILE_BYTES` are lowered to it. */
  readonly maxFileBytes?: number
}

export interface JevTelemetry {
  /** Queues one event. Never throws. */
  record(event: JevTelemetryEvent): void
  /** Resolves when every queued row is written or dropped. */
  flush(): Promise<void>
  /** Flushes, then ignores later events from this handle. The shared writer stays open for other handles. */
  dispose(): Promise<void>
}

interface Writer {
  readonly path: string
  readonly root: string
  readonly maxFileBytes: number
  readonly queue: string[]
  /** True while the single drain task runs. */
  draining: boolean
  /** Promise of the current drain task. */
  idle: Promise<void>
  /** Loggers of the handles that use this writer and are not disposed, oldest first. One entry per handle. */
  readonly handles: Array<{ readonly log: Logger | undefined }>
  warned: boolean
}

const WRITERS_KEY = Symbol.for("td-opencode-plugin.jev.telemetry")

function writers(): Map<string, Writer> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Writer> | undefined>
  let map = holder[WRITERS_KEY]
  if (!map) {
    map = new Map()
    holder[WRITERS_KEY] = map
  }
  return map
}

/** Number of telemetry writers that are registered in this process. For tests. */
export function activeTelemetryWriters(): number {
  return writers().size
}

async function appendRow(writer: Writer, line: string): Promise<void> {
  const bytes = Buffer.byteLength(line, "utf8")
  await ensureRoot(writer.root)
  const stat = await lstatOrUndefined(writer.path)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new JevArtifactError("unsafe-path", "Telemetry file is a symlink or not a regular file.")
  if (stat && stat.size + bytes > writer.maxFileBytes) {
    // rename replaces an existing `.1`, including a symlink, without following it.
    await rename(writer.path, `${writer.path}.1`)
  }
  const handle = await openPrivateAppend(writer.path)
  try {
    await handle.write(line)
  } finally {
    await handle.close()
  }
}

/** Starts the one drain task of a writer. Does nothing while a task runs, which then picks up new rows itself. */
function startDrain(writer: Writer): void {
  if (writer.draining) return
  writer.draining = true
  writer.idle = (async () => {
    try {
      while (writer.queue.length > 0) {
        const line = writer.queue.shift() as string
        try {
          await appendRow(writer, line)
          writer.warned = false
        } catch (error) {
          if (!writer.warned) {
            writer.warned = true
            const code = error instanceof JevArtifactError ? error.code : "io"
            const log = [...writer.handles].reverse().find((handle) => handle.log)?.log
            log?.warn("Jev telemetry write failed; rows are dropped until it works again", { reason: code })
          }
        }
      }
    } finally {
      writer.draining = false
    }
  })()
}

async function flushWriter(writer: Writer): Promise<void> {
  while (writer.draining) await writer.idle
}

export function createJevTelemetry(options: JevTelemetryOptions): JevTelemetry {
  if (!options.enabled) return { record: () => undefined, flush: async () => undefined, dispose: async () => undefined }
  const root = resolve(options.root)
  const path = join(root, TELEMETRY_FILE)
  const now = options.now ?? Date.now
  const maxFileBytes = Math.min(TELEMETRY_MAX_FILE_BYTES, Math.max(1024, Math.floor(options.maxFileBytes ?? TELEMETRY_MAX_FILE_BYTES)))
  const map = writers()
  let writer = map.get(path)
  if (!writer) {
    writer = { path, root, maxFileBytes, queue: [], draining: false, idle: Promise.resolve(), handles: [], warned: false }
    map.set(path, writer)
  }
  const shared = writer
  // The writer logs through the newest live handle. A disposed handle's logger is released.
  const self = { log: options.log }
  shared.handles.push(self)
  let disposed = false

  return {
    record(event) {
      if (disposed) return
      try {
        const row = sanitizeTelemetryEvent(event, now())
        if (!row) return
        const line = `${JSON.stringify(row)}\n`
        if (Buffer.byteLength(line, "utf8") > TELEMETRY_MAX_ROW_BYTES) return
        if (shared.queue.length >= TELEMETRY_MAX_PENDING) return
        shared.queue.push(line)
        startDrain(shared)
      } catch {
        // Telemetry must never throw into plugin code.
      }
    },
    flush: () => flushWriter(shared),
    async dispose() {
      if (disposed) return
      disposed = true
      await flushWriter(shared)
      // The writer stays while another handle uses it. The last handle removes it from the registry.
      const index = shared.handles.indexOf(self)
      if (index >= 0) shared.handles.splice(index, 1)
      if (shared.handles.length === 0 && shared.queue.length === 0 && !shared.draining && map.get(path) === shared) map.delete(path)
    },
  }
}
