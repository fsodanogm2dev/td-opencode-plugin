import { KNOWN_MODEL_PREFIX, normalizeBatchModel } from "./requests.ts"
import type { BatchCost, BatchCurrency, BatchResult, BatchUsage } from "./types.ts"

/** Price of one model in currency units per million tokens. */
export interface BatchModelRate {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  /** Cache write with the default 5 minute TTL. */
  readonly cacheWrite5m?: number
  readonly cacheWrite1h?: number
}

/**
 * Batch rates with provenance. Callers must give a verifiable `source` (for example a document title and date).
 * The module ships no rates: Fuel iX batch prices are not assumed to match any other vendor's.
 */
export interface BatchRateCard {
  readonly source: string
  readonly currency: BatchCurrency
  readonly models: Readonly<Record<string, BatchModelRate>>
}

export const MAX_RATE_SOURCE_LENGTH = 2048
export const MAX_RATE_MODELS = 1000
const MAX_RATE = 1_000_000

const RATE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE
}

/**
 * Validates user-supplied batch rates. Returns a fresh, normalized card, or `undefined` when anything is malformed:
 * unknown fields, a non-USD currency, an empty or oversized source, hostile or foreign model IDs, or invalid rates.
 * Model IDs are raw IDs or carry the `fuelix-anthropic/` prefix, which is removed. The result never aliases the input.
 */
export function parseBatchRateCard(input: unknown): BatchRateCard | undefined {
  if (!isPlainRecord(input)) return undefined
  for (const key of Object.keys(input)) {
    if (key !== "source" && key !== "currency" && key !== "models") return undefined
  }
  const { source, currency, models } = input
  if (typeof source !== "string" || source.trim() === "" || source.length > MAX_RATE_SOURCE_LENGTH) return undefined
  if (/[\u0000-\u001f\u007f]/.test(source)) return undefined
  if (currency !== "USD") return undefined
  if (!isPlainRecord(models)) return undefined
  const names = Object.keys(models)
  if (names.length === 0 || names.length > MAX_RATE_MODELS) return undefined
  const out: Record<string, BatchModelRate> = {}
  for (const name of names) {
    const id = normalizeBatchModel(name)
    if (id === undefined || id in Object.prototype || Object.hasOwn(out, id)) return undefined
    const raw = models[name]
    if (!isPlainRecord(raw)) return undefined
    for (const key of Object.keys(raw)) if (!RATE_KEYS.has(key)) return undefined
    if (!validRate(raw.input) || !validRate(raw.output)) return undefined
    const rate: { -readonly [K in keyof BatchModelRate]: BatchModelRate[K] } = { input: raw.input, output: raw.output }
    for (const key of ["cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) {
      const value = raw[key]
      if (value === undefined) continue
      if (!validRate(value)) return undefined
      rate[key] = value
    }
    out[id] = rate
  }
  return { source: source.trim(), currency: "USD", models: out }
}

export interface EstimateBatchCostOptions {
  /**
   * TTL of cache writes when a result reports cache write tokens without a TTL breakdown. Without it, such a result
   * makes the estimate unavailable, because assuming 5 minutes could understate a 1 hour write.
   */
  readonly cacheWriteTTL?: "5m" | "1h"
}

export interface ActualCostInput {
  readonly source: string
  readonly currency: BatchCurrency
  readonly amount: number
}

const unavailable = (reason: string): BatchCost => ({ kind: "unavailable", reason })

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/** Wraps billing evidence (an invoice line, a billing API value) as an `actual` cost. Invalid input is unavailable. */
export function actualBatchCost(input: ActualCostInput): BatchCost {
  if (typeof input.source !== "string" || input.source.trim() === "") return unavailable("Actual cost has no source.")
  if (input.currency !== "USD") return unavailable("Actual cost has an unsupported currency.")
  if (!validAmount(input.amount)) return unavailable("Actual cost amount is invalid.")
  return { kind: "actual", source: input.source, currency: input.currency, amount: input.amount }
}

function tokens(value: unknown): number | undefined {
  if (value === undefined) return 0
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

interface Line {
  readonly tokens: number
  readonly rate: number | undefined
}

function usageLines(usage: BatchUsage, rate: BatchModelRate, ttl: "5m" | "1h" | undefined): Line[] | string {
  const serverTools = usage.server_tool_use
  if (serverTools !== undefined) {
    if (!isPlainRecord(serverTools)) return "a result has malformed server tool usage"
    for (const value of Object.values(serverTools)) {
      const uses = tokens(value)
      if (value === undefined || uses === undefined) return "a result has malformed server tool usage"
      if (uses > 0) return "a result uses server tools without verified tool rates"
    }
  }
  const input = tokens(usage.input_tokens)
  const output = tokens(usage.output_tokens)
  const read = tokens(usage.cache_read_input_tokens)
  const write = tokens(usage.cache_creation_input_tokens)
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return "a result has incomplete usage"
  if (input === undefined || output === undefined || read === undefined || write === undefined) {
    return "a result has malformed usage"
  }
  const lines: Line[] = [
    { tokens: input, rate: rate.input },
    { tokens: output, rate: rate.output },
    { tokens: read, rate: rate.cacheRead },
  ]
  const breakdown = usage.cache_creation
  if (breakdown !== undefined) {
    if (typeof breakdown !== "object" || breakdown === null) return "a result has malformed usage"
    const w5 = tokens(breakdown.ephemeral_5m_input_tokens)
    const w1 = tokens(breakdown.ephemeral_1h_input_tokens)
    if (w5 === undefined || w1 === undefined) return "a result has malformed usage"
    if (w5 + w1 !== write) return "a result has inconsistent cache write usage"
    lines.push({ tokens: w5, rate: rate.cacheWrite5m }, { tokens: w1, rate: rate.cacheWrite1h })
  } else {
    if (write > 0 && ttl === undefined) return "a result has cache writes without a TTL breakdown"
    lines.push({ tokens: write, rate: ttl === "1h" ? rate.cacheWrite1h : rate.cacheWrite5m })
  }
  return lines
}

/**
 * Estimates the cost of batch results from their usage and an explicit rate card. The result is `unavailable`
 * when any succeeded result lacks usage, a model, or a rate for a token class it used, so a total is never partial.
 * Cache writes without a TTL breakdown need `options.cacheWriteTTL`, otherwise the estimate is unavailable.
 * Call it only after usage is collected. Errored, canceled, and expired results add no charge and are counted in `excluded`.
 */
export function estimateBatchCost(
  results: readonly BatchResult[],
  rates: BatchRateCard | undefined,
  options: EstimateBatchCostOptions = {},
): BatchCost {
  if (!rates) return unavailable("No verified Fuel iX batch rates are configured.")
  const card = parseBatchRateCard(rates)
  if (!card) return unavailable("Rate card is invalid.")
  const excluded = { errored: 0, canceled: 0, expired: 0 }
  let succeeded = 0
  // Sum tokens x rate (per million tokens) first and divide once, to keep float error small.
  let total = 0
  for (const record of results) {
    const body = record.result
    if (body.type === "errored") excluded.errored++
    else if (body.type === "canceled") excluded.canceled++
    else if (body.type === "expired") excluded.expired++
    if (body.type !== "succeeded") continue
    const message = body.message
    if (typeof message.model !== "string" || message.model === "") return unavailable("A result has no model.")
    const model = message.model.startsWith(KNOWN_MODEL_PREFIX) ? message.model.slice(KNOWN_MODEL_PREFIX.length) : message.model
    const rate = Object.hasOwn(card.models, model) ? card.models[model] : undefined
    if (!rate) return unavailable("A result uses a model without a valid rate.")
    if (typeof message.usage !== "object" || message.usage === null) return unavailable("A result has no usage.")
    const lines = usageLines(message.usage, rate, options.cacheWriteTTL)
    if (typeof lines === "string") return unavailable(`Cost is incomplete: ${lines}.`)
    for (const line of lines) {
      if (line.tokens === 0) continue
      if (line.rate === undefined) return unavailable("A result uses a token class without a rate.")
      total += line.tokens * line.rate
      if (!Number.isFinite(total)) return unavailable("Cost estimate overflowed.")
    }
    succeeded++
  }
  const amount = Math.round((total / 1_000_000) * 1e9) / 1e9
  return { kind: "estimate", source: card.source, currency: card.currency, amount, succeeded, excluded }
}
