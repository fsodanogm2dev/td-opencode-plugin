import type { BatchRequest, BatchRequestParams } from "./types.ts"

export const MAX_BATCH_REQUESTS = 100_000
export const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024
/** Upper bound for `max_tokens`. Larger values are almost certainly mistakes. */
export const MAX_BATCH_MAX_TOKENS = 1_000_000
export const MAX_BATCH_MODEL_LENGTH = 256
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const KNOWN_MODEL_PREFIX = "fuelix-anthropic/"

/** Invalid batch input. Messages name the request index and the field, never the content. */
export class BatchRequestError extends Error {
  readonly index: number | undefined
  constructor(message: string, index?: number) {
    super(index === undefined ? message : `Request ${index + 1}: ${message}`)
    this.name = "BatchRequestError"
    this.index = index
  }
}

export interface ParseBatchRequestsOptions {
  /** Maximum UTF-8 size of the input. Default 32 MiB. */
  readonly maxBytes?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Strips the known `fuelix-anthropic/` prefix. Raw IDs pass. Any other `/` is a foreign provider prefix. */
export function normalizeBatchModel(model: string): string | undefined {
  const stripped = model.startsWith(KNOWN_MODEL_PREFIX) ? model.slice(KNOWN_MODEL_PREFIX.length) : model
  if (stripped === "" || stripped.length > MAX_BATCH_MODEL_LENGTH || stripped !== stripped.trim() || /[\s/\\]/.test(stripped) || /[\u0000-\u001f]/.test(stripped)) {
    return undefined
  }
  return stripped
}

function validateRequest(value: unknown, index: number): BatchRequest {
  if (!isRecord(value)) throw new BatchRequestError("must be an object", index)
  for (const key of Object.keys(value)) {
    if (key !== "custom_id" && key !== "params") throw new BatchRequestError("has an unknown field", index)
  }
  const customID = value.custom_id
  if (typeof customID !== "string" || !CUSTOM_ID_PATTERN.test(customID)) {
    throw new BatchRequestError("custom_id must match [A-Za-z0-9_-]{1,64}", index)
  }
  const params = value.params
  if (!isRecord(params)) throw new BatchRequestError("params must be an object", index)
  if (typeof params.model !== "string") throw new BatchRequestError("params.model must be a string", index)
  const model = normalizeBatchModel(params.model)
  if (model === undefined) {
    throw new BatchRequestError(`params.model must be a model ID, optionally prefixed with ${KNOWN_MODEL_PREFIX}`, index)
  }
  const maxTokens = params.max_tokens
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_BATCH_MAX_TOKENS) {
    throw new BatchRequestError(`params.max_tokens must be an integer from 1 to ${MAX_BATCH_MAX_TOKENS}`, index)
  }
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    throw new BatchRequestError("params.messages must be a non-empty array", index)
  }
  if (params.stream === true) throw new BatchRequestError("params.stream must not be true", index)
  return { custom_id: customID, params: { ...params, model } as unknown as BatchRequestParams }
}

function decode(text: string): unknown[] {
  const trimmed = text.trim()
  if (trimmed === "") throw new BatchRequestError("Input is empty")
  let whole: unknown
  let wholeOK = false
  try {
    whole = JSON.parse(trimmed)
    wholeOK = true
  } catch {
    // Fall through to JSONL.
  }
  if (wholeOK) {
    if (Array.isArray(whole)) return whole
    if (isRecord(whole)) {
      if ("requests" in whole) {
        for (const key of Object.keys(whole)) {
          if (key !== "requests") throw new BatchRequestError("Input has an unknown field")
        }
        if (!Array.isArray(whole.requests)) throw new BatchRequestError("Input requests must be an array")
        return whole.requests
      }
      if ("custom_id" in whole) return [whole] // One-line JSONL.
    }
    throw new BatchRequestError("Input must be an array, an object with requests, or JSONL")
  }
  const items: unknown[] = []
  const lines = trimmed.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === "") continue
    if (items.length >= MAX_BATCH_REQUESTS) throw new BatchRequestError(`Input has more than ${MAX_BATCH_REQUESTS} requests`)
    try {
      items.push(JSON.parse(line))
    } catch {
      throw new BatchRequestError(`Input line ${i + 1} is not valid JSON`)
    }
  }
  return items
}

/**
 * Parses native `{ "requests": [...] }` JSON, a JSON array, or JSONL into validated batch requests. The result
 * is normalized: the `fuelix-anthropic/` model prefix is stripped, other params are preserved.
 */
export function parseBatchRequests(text: string, options: ParseBatchRequestsOptions = {}): BatchRequest[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INPUT_BYTES
  if (typeof text !== "string") throw new BatchRequestError("Input must be text")
  // UTF-16 length never exceeds the UTF-8 byte length, so the first test is a cheap exit.
  if (text.length > maxBytes || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new BatchRequestError(`Input is larger than ${maxBytes} bytes`)
  }
  return normalizeBatchRequests(decode(text))
}

/** Validates and normalizes already decoded requests. Used by file parsing and by inline submissions. */
export function normalizeBatchRequests(items: readonly unknown[]): BatchRequest[] {
  if (items.length === 0) throw new BatchRequestError("Input has no requests")
  if (items.length > MAX_BATCH_REQUESTS) throw new BatchRequestError(`Input has more than ${MAX_BATCH_REQUESTS} requests`)
  const seen = new Set<string>()
  const out: BatchRequest[] = []
  for (let i = 0; i < items.length; i++) {
    const request = validateRequest(items[i], i)
    if (seen.has(request.custom_id)) throw new BatchRequestError("custom_id is not unique", i)
    seen.add(request.custom_id)
    out.push(request)
  }
  return out
}
