/** JSON-serializable value. Batch request params use it so that every request survives `JSON.stringify` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Parameters of one Anthropic Messages request. Unknown keys are kept and sent unchanged. */
export interface BatchRequestParams {
  readonly model: string
  readonly max_tokens: number
  readonly messages: readonly JsonValue[]
  readonly [key: string]: JsonValue | readonly JsonValue[]
}

export interface BatchRequest {
  readonly custom_id: string
  readonly params: BatchRequestParams
}

export type BatchProcessingStatus = "in_progress" | "canceling" | "ended"

export interface BatchRequestCounts {
  readonly processing: number
  readonly succeeded: number
  readonly errored: number
  readonly canceled: number
  readonly expired: number
}

/** Accepts numeric RFC 3339 timestamps with a valid calendar date and time zone. */
export function isBatchTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 &&
    (match[7] === undefined || (Number(match[8]) <= 23 && Number(match[9]) <= 59))
}

/** Anthropic message batch object, validated by the client. Unknown remote fields are dropped. */
export interface RemoteBatch {
  readonly id: string
  readonly type: "message_batch"
  readonly processing_status: BatchProcessingStatus
  readonly request_counts: BatchRequestCounts
  readonly created_at: string
  readonly ended_at: string | null
  readonly results_url: string | null
  readonly expires_at?: string | null
  readonly cancel_initiated_at?: string | null
  readonly archived_at?: string | null
}

export interface BatchUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens?: number
    readonly ephemeral_1h_input_tokens?: number
  }
  readonly [key: string]: unknown
}

export interface BatchMessage {
  readonly model?: string
  readonly usage?: BatchUsage
  readonly [key: string]: unknown
}

export interface BatchSucceededResult {
  readonly type: "succeeded"
  readonly message: BatchMessage
}

export interface BatchErroredResult {
  readonly type: "errored"
  readonly error: {
    readonly type?: string
    readonly error?: { readonly type?: string; readonly message?: string; readonly [key: string]: unknown }
    readonly request_id?: string | null
    readonly [key: string]: unknown
  }
}

export interface BatchCanceledResult {
  readonly type: "canceled"
}

export interface BatchExpiredResult {
  readonly type: "expired"
}

export type BatchResultBody = BatchSucceededResult | BatchErroredResult | BatchCanceledResult | BatchExpiredResult

/** One line of the results JSONL file. */
export interface BatchResult {
  readonly custom_id: string
  readonly result: BatchResultBody
}

export type BatchCurrency = "USD"

/**
 * Cost of a batch. `actual` needs billing evidence that the caller supplies. `estimate` is computed from usage and
 * provenance-backed rates. `unavailable` states why neither exists.
 */
export type BatchCost =
  | {
      readonly kind: "actual"
      readonly source: string
      readonly currency: BatchCurrency
      readonly amount: number
    }
  | {
      readonly kind: "estimate"
      readonly source: string
      readonly currency: BatchCurrency
      readonly amount: number
      /** Number of succeeded results that the amount covers. */
      readonly succeeded: number
      /** Results that carry no usage charge in the estimate. */
      readonly excluded: { readonly errored: number; readonly canceled: number; readonly expired: number }
    }
  | { readonly kind: "unavailable"; readonly reason: string }

export class BatchResultParseError extends Error {
  /** 1-based line number, when known. */
  readonly line: number | undefined
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`)
    this.name = "BatchResultParseError"
    this.line = line
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses and validates one results line. Errors never contain the line content. */
export function parseBatchResultLine(line: string, lineNumber?: number): BatchResult {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new BatchResultParseError("Batch result line is not valid JSON", lineNumber)
  }
  if (!isRecord(value)) throw new BatchResultParseError("Batch result line is not an object", lineNumber)
  const customID = value.custom_id
  if (typeof customID !== "string" || customID === "") {
    throw new BatchResultParseError("Batch result line has no custom_id", lineNumber)
  }
  const result = value.result
  if (!isRecord(result)) throw new BatchResultParseError("Batch result line has no result object", lineNumber)
  switch (result.type) {
    case "succeeded":
      if (!isRecord(result.message)) {
        throw new BatchResultParseError("Succeeded batch result has no message", lineNumber)
      }
      if (result.message.usage !== undefined && !isRecord(result.message.usage)) {
        throw new BatchResultParseError("Succeeded batch result has malformed usage", lineNumber)
      }
      if (result.message.model !== undefined && typeof result.message.model !== "string") {
        throw new BatchResultParseError("Succeeded batch result has a malformed model", lineNumber)
      }
      break
    case "errored":
      if (!isRecord(result.error)) throw new BatchResultParseError("Errored batch result has no error", lineNumber)
      break
    case "canceled":
    case "expired":
      break
    default:
      throw new BatchResultParseError("Batch result has an unknown type", lineNumber)
  }
  return value as unknown as BatchResult
}

/** Parses a results JSONL text. Blank lines are skipped. Duplicate custom IDs are rejected. */
export function parseBatchResults(text: string): BatchResult[] {
  const out: BatchResult[] = []
  const seen = new Set<string>()
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.endsWith("\r") ? lines[i]!.slice(0, -1) : lines[i]!
    if (raw.trim() === "") continue
    const record = parseBatchResultLine(raw, i + 1)
    if (seen.has(record.custom_id)) throw new BatchResultParseError("Batch results repeat a custom_id", i + 1)
    seen.add(record.custom_id)
    out.push(record)
  }
  return out
}
