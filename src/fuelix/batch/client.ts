import { isBatchTimestamp, type BatchProcessingStatus, type BatchRequest, type BatchRequestCounts, type RemoteBatch } from "./types.ts"

export const ANTHROPIC_VERSION = "2023-06-01"
export const MAX_BODY_BYTES = 256 * 1024 * 1024
export const MAX_METADATA_BYTES = 1024 * 1024
export const MAX_BATCH_REQUEST_COUNT = 100_000
export const DEFAULT_TIMEOUT_MS = 120_000

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export type BatchFetch = (input: string, init?: RequestInit) => Promise<Response>

export type BatchClientErrorCode =
  | "invalid_base_url"
  | "invalid_argument"
  | "no_key"
  | "aborted"
  | "timeout"
  | "network"
  | "unauthorized"
  | "not_found"
  | "rejected"
  | "rate_limited"
  | "too_large"
  | "server_error"
  | "http_error"
  | "malformed_response"
  | "id_mismatch"
  | "results_unavailable"
  | "unsafe_results_url"

/**
 * Batch client error. The message is a fixed string per code: it never contains the remote body, the key, request
 * content, or headers. `ambiguous` is true when a submission may have reached the gateway and may be billed,
 * so the caller must not retry it blindly.
 */
export class BatchClientError extends Error {
  readonly code: BatchClientErrorCode
  readonly status: number | undefined
  readonly ambiguous: boolean
  /** Safe handle from malformed metadata in a successful submission response, never from an HTTP error body. */
  readonly batchID?: string
  constructor(code: BatchClientErrorCode, options: { status?: number; ambiguous?: boolean; batchID?: string } = {}) {
    super(options.status === undefined ? `FueliX batch request failed (${code})` : `FueliX batch request failed (${code}, HTTP ${options.status})`)
    this.name = "BatchClientError"
    this.code = code
    this.status = options.status
    this.ambiguous = options.ambiguous ?? false
    this.batchID = options.batchID
  }
}

export interface BatchClientOptions {
  /** Gateway origin or API root. `https://api.fuelix.ai` and `https://api.fuelix.ai/v1` both give the `/v1` root. */
  readonly baseURL: string
  readonly resolveKey: () => Promise<string | undefined>
  readonly fetch?: BatchFetch
  /** Timeout of one HTTP call, body included. Default 120 s. */
  readonly timeoutMs?: number
}

/** Returns the normalized API root (no trailing slash, ends with `/v1`). */
export function normalizeBatchBaseURL(baseURL: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new BatchClientError("invalid_base_url")
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))
  if (!secure || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || baseURL.includes("?") || baseURL.includes("#")) {
    throw new BatchClientError("invalid_base_url")
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (!/(^|\/)v1$/.test(path)) path += "/v1"
  return `${url.origin}${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function optionalTime(value: unknown): string | null | undefined | false {
  if (value === undefined || value === null) return value
  return isBatchTimestamp(value) ? value : false
}

/** Validates an untrusted batch object. Returns `undefined` when it is malformed. */
export function parseRemoteBatch(value: unknown): RemoteBatch | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string" || !SAFE_ID.test(value.id)) return undefined
  if (value.type !== "message_batch") return undefined
  const status = value.processing_status
  if (status !== "in_progress" && status !== "canceling" && status !== "ended") return undefined
  const counts = value.request_counts
  if (!isRecord(counts)) return undefined
  const processing = count(counts.processing)
  const succeeded = count(counts.succeeded)
  const errored = count(counts.errored)
  const canceled = count(counts.canceled)
  const expired = count(counts.expired)
  if (processing === undefined || succeeded === undefined || errored === undefined || canceled === undefined || expired === undefined) {
    return undefined
  }
  if (processing + succeeded + errored + canceled + expired > MAX_BATCH_REQUEST_COUNT) return undefined
  if (!isBatchTimestamp(value.created_at)) return undefined
  const endedAt = optionalTime(value.ended_at)
  if (endedAt === false) return undefined
  const expiresAt = optionalTime(value.expires_at)
  const cancelAt = optionalTime(value.cancel_initiated_at)
  const archivedAt = optionalTime(value.archived_at)
  if (expiresAt === false || cancelAt === false || archivedAt === false) return undefined
  const resultsURL = value.results_url
  if (resultsURL !== undefined && resultsURL !== null && typeof resultsURL !== "string") return undefined
  const request_counts: BatchRequestCounts = { processing, succeeded, errored, canceled, expired }
  return {
    id: value.id,
    type: "message_batch",
    processing_status: status as BatchProcessingStatus,
    request_counts,
    created_at: value.created_at,
    ended_at: endedAt ?? null,
    results_url: resultsURL ?? null,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(cancelAt !== undefined ? { cancel_initiated_at: cancelAt } : {}),
    ...(archivedAt !== undefined ? { archived_at: archivedAt } : {}),
  }
}

interface CallOptions {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly body?: string
  readonly signal?: AbortSignal
  readonly maxBytes: number
  /** True for the submission: a request that may have reached the gateway may be billed. */
  readonly submission?: boolean
  readonly accept: string
}

export class BatchClient {
  readonly #root: string
  readonly #resolveKey: () => Promise<string | undefined>
  readonly #fetch: BatchFetch
  readonly #timeoutMs: number

  constructor(options: BatchClientOptions) {
    this.#root = normalizeBatchBaseURL(options.baseURL)
    this.#resolveKey = options.resolveKey
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout <= 0) throw new BatchClientError("invalid_argument")
    this.#timeoutMs = timeout
  }

  get #batchesURL(): string {
    return `${this.#root}/messages/batches`
  }

  async submit(requests: readonly BatchRequest[], signal?: AbortSignal): Promise<RemoteBatch> {
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH_REQUEST_COUNT) {
      throw new BatchClientError("invalid_argument")
    }
    const body = JSON.stringify({ requests })
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new BatchClientError("too_large")
    const text = await this.#call({
      method: "POST",
      url: this.#batchesURL,
      body,
      signal,
      maxBytes: MAX_METADATA_BYTES,
      submission: true,
      accept: "application/json",
    })
    return this.#metadata(text, undefined, true)
  }

  status(batchID: string, signal?: AbortSignal): Promise<RemoteBatch> {
    return this.#byID("GET", batchID, "", signal)
  }

  cancel(batchID: string, signal?: AbortSignal): Promise<RemoteBatch> {
    return this.#byID("POST", batchID, "/cancel", signal)
  }

  /** Downloads the results JSONL of an ended batch. */
  async results(batch: RemoteBatch, signal?: AbortSignal): Promise<string> {
    if (!isRecord(batch) || typeof batch.id !== "string" || !SAFE_ID.test(batch.id)) throw new BatchClientError("invalid_argument")
    if (batch.processing_status !== "ended" || typeof batch.results_url !== "string" || batch.results_url === "") {
      throw new BatchClientError("results_unavailable")
    }
    return this.#call({
      method: "GET",
      url: this.#checkResultsURL(batch.results_url),
      signal,
      maxBytes: MAX_BODY_BYTES,
      accept: "application/x-jsonl, application/json",
    })
  }

  #checkResultsURL(raw: string): string {
    let url: URL
    let root: URL
    try {
      url = new URL(raw)
      root = new URL(this.#root)
    } catch {
      throw new BatchClientError("unsafe_results_url")
    }
    const basePath = root.pathname
    const inTree = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)
    if (url.origin !== root.origin || url.username !== "" || url.password !== "" || url.hash !== "" || !inTree) {
      throw new BatchClientError("unsafe_results_url")
    }
    return url.href
  }

  async #byID(method: "GET" | "POST", batchID: string, suffix: string, signal?: AbortSignal): Promise<RemoteBatch> {
    if (typeof batchID !== "string" || !SAFE_ID.test(batchID)) throw new BatchClientError("invalid_argument")
    const text = await this.#call({
      method,
      url: `${this.#batchesURL}/${encodeURIComponent(batchID)}${suffix}`,
      signal,
      maxBytes: MAX_METADATA_BYTES,
      accept: "application/json",
    })
    return this.#metadata(text, batchID, false)
  }

  #metadata(text: string, expectedID: string | undefined, submission: boolean): RemoteBatch {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new BatchClientError("malformed_response", { ambiguous: submission })
    }
    const batch = parseRemoteBatch(value)
    if (!batch) {
      const batchID = submission && isRecord(value) && typeof value.id === "string" && SAFE_ID.test(value.id) ? value.id : undefined
      throw new BatchClientError("malformed_response", { ambiguous: submission, batchID })
    }
    if (expectedID !== undefined && batch.id !== expectedID) throw new BatchClientError("id_mismatch")
    return batch
  }

  async #call(options: CallOptions): Promise<string> {
    const submission = options.submission === true
    const controller = new AbortController()
    let sent = false
    let done = false
    let timedOut = false
    const abortError = () => {
      const code = timedOut ? "timeout" : "aborted"
      return new BatchClientError(code, { ambiguous: submission && sent })
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        if (!done) reject(abortError())
      })
    })
    aborted.catch(() => {})
    const external = options.signal
    if (external) {
      if (external.aborted) throw new BatchClientError("aborted")
      onAbort = () => controller.abort()
      external.addEventListener("abort", onAbort, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    const operation = (async (): Promise<string> => {
      const key = await this.#resolveKey().catch(() => undefined)
      if (done || controller.signal.aborted) throw abortError()
      if (typeof key !== "string" || key === "" || /[\u0000-\u001f\u007f\s]/.test(key)) throw new BatchClientError("no_key")
      const headers: Record<string, string> = {
        authorization: `Bearer ${key}`,
        "anthropic-version": ANTHROPIC_VERSION,
        accept: options.accept,
      }
      if (options.body !== undefined) headers["content-type"] = "application/json"
      sent = true
      let response: Response
      try {
        response = await this.#fetch(options.url, {
          method: options.method,
          headers,
          body: options.body,
          signal: controller.signal,
          redirect: "error",
        })
      } catch {
        throw new BatchClientError("network", { ambiguous: submission })
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw httpError(response.status, submission)
      }
      return readCapped(response, options.maxBytes, submission)
    })()
    operation.catch(() => {})
    try {
      return await Promise.race([operation, aborted])
    } finally {
      done = true
      clearTimeout(timer)
      if (external && onAbort) external.removeEventListener("abort", onAbort)
      controller.abort() // Releases the connection of a failed or abandoned call.
    }
  }
}

function httpError(status: number, submission: boolean): BatchClientError {
  const ambiguous = submission && (status === 408 || status >= 500 || status < 200 || (status >= 300 && status < 400))
  let code: BatchClientErrorCode
  if (status === 401 || status === 403) code = "unauthorized"
  else if (status === 404) code = "not_found"
  else if (status === 413) code = "too_large"
  else if (status === 429) code = "rate_limited"
  else if (status === 408) code = "timeout"
  else if (status >= 500) code = "server_error"
  else if (status >= 400) code = "rejected"
  else code = "http_error"
  return new BatchClientError(code, { status, ambiguous })
}

/** Reads a body into text with a hard byte cap. */
async function readCapped(response: Response, maxBytes: number, submission: boolean): Promise<string> {
  const tooLarge = () => new BatchClientError("too_large", { ambiguous: submission })
  const declared = response.headers.get("content-length")
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  const body = response.body
  if (!body) return ""
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>
      try {
        step = await reader.read()
      } catch {
        throw new BatchClientError("network", { ambiguous: submission })
      }
      if (step.done) break
      total += step.value.byteLength
      if (total > maxBytes) throw tooLarge()
      chunks.push(step.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString("utf8")
}
