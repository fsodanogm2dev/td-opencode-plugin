/**
 * Manual model check. The OpenChamber extension service cannot call the plugin, so it writes a small request file.
 * The plugin polls the file and starts one model check for each new request.
 *
 * File: `<home>/.td-opencode-plugin/requests/model-check.json`. Only the extension service writes it, atomically,
 * with mode 0600. Body: `{"version":1,"requestId":"<22 base64url characters>","requestedAt":"<ISO time>"}`. Maximum
 * size: 1 KiB. The file holds no secret. The plugin ignores every file that does not match this form.
 *
 * A stale request must not start a check: the plugin ignores a request older than `MAX_REQUEST_AGE_MS`, and a
 * request older than its own startup minus `STARTUP_SKEW_MS`. The plugin acts on a request ID once.
 */

import { open } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import { join } from "node:path"
import type { Logger } from "../log.ts"
import { REQUEST_ID_PATTERN } from "./status.ts"

export const MANUAL_CHECK_VERSION = 1
export const MANUAL_CHECK_POLL_MS = 2000
export const MAX_REQUEST_BYTES = 1024
export const MAX_REQUEST_AGE_MS = 5 * 60_000
export const STARTUP_SKEW_MS = 5000

export interface ManualCheckRequest {
  readonly requestId: string
  /** Canonical ISO time (`Date#toISOString`). */
  readonly requestedAt: string
}

/** Path of the request file below a home directory. */
export function manualCheckPath(home: string): string {
  return join(home, ".td-opencode-plugin", "requests", "model-check.json")
}

/**
 * Strict parser. Returns `undefined` for anything else than the exact form: unknown keys, a wrong version, a
 * request ID that is not 22 base64url characters, a time that is not canonical ISO, or a body above 1 KiB.
 */
export function parseManualCheckRequest(text: string): ManualCheckRequest | undefined {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const record = json as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !keys.includes("version") || !keys.includes("requestId") || !keys.includes("requestedAt")) return undefined
  if (record.version !== MANUAL_CHECK_VERSION) return undefined
  const { requestId, requestedAt } = record
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return undefined
  if (typeof requestedAt !== "string") return undefined
  const time = Date.parse(requestedAt)
  if (Number.isNaN(time) || new Date(time).toISOString() !== requestedAt) return undefined
  return { requestId, requestedAt }
}

/** Reads the request file. `null` when it does not exist. Reads at most 1 KiB + 1 byte. Rejects other failures. */
export async function readRequestFile(path: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, "r")
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null
    throw error
  }
  try {
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return buffer.subarray(0, total).toString("utf8")
  } finally {
    await handle.close()
  }
}

/** Where and how the plugin looks for requests. `src/index.ts` injects the production value. */
export interface ManualCheckSource {
  /** Resolves `null` for a missing file. A rejection counts as a read failure. */
  readonly readFile: () => Promise<string | null>
  readonly intervalMs?: number
}

/** The production source: the file below the home directory. The home directory is read at each poll. */
export function createFileManualCheckSource(homedir: () => string = osHomedir): ManualCheckSource {
  return { readFile: () => readRequestFile(manualCheckPath(homedir())) }
}

export interface ManualCheckWatcherInput {
  readonly source: ManualCheckSource
  readonly now: () => Date
  /** Start of this plugin instance. */
  readonly startedAt: Date
  readonly log: Logger
  readonly setInterval: (callback: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  /** Called once for each accepted request. A throw or a rejection is ignored. */
  readonly onRequest: (request: ManualCheckRequest) => void | Promise<void>
}

/** Starts the poller. Returns a function that stops it. Nothing here throws. */
export function startManualCheckWatcher(input: ManualCheckWatcherInput): () => void {
  const seen = new Set<string>()
  let stopped = false
  let polling = false
  let failing = false

  const accept = (request: ManualCheckRequest): boolean => {
    if (seen.has(request.requestId)) return false
    const requested = Date.parse(request.requestedAt)
    const current = input.now().getTime()
    if (current - requested > MAX_REQUEST_AGE_MS) return false
    if (requested < input.startedAt.getTime() - STARTUP_SKEW_MS) return false
    return true
  }

  const poll = async (): Promise<void> => {
    if (stopped || polling) return
    polling = true
    try {
      let text: string | null
      try {
        text = await input.source.readFile()
        failing = false
      } catch {
        if (!failing) {
          failing = true
          input.log.warn("FueliX manual model check request could not be read")
        }
        return
      }
      if (stopped || text === null) return
      const request = parseManualCheckRequest(text)
      if (!request || !accept(request)) return
      seen.add(request.requestId)
      try {
        await input.onRequest(request)
      } catch {
        // A failed check is reported by the check itself.
      }
    } catch {
      // Polling never throws.
    } finally {
      polling = false
    }
  }

  const handle = input.setInterval(() => void poll(), input.source.intervalMs ?? MANUAL_CHECK_POLL_MS)
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
  return () => {
    stopped = true
    input.clearInterval(handle)
  }
}
