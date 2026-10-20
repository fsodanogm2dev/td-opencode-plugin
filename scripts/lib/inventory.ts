/**
 * Inventory parsing and deployment selection for `fuelix/LLM-Inventory`.
 *
 * The parser copies only whitelisted fields. Deployment records also hold credential fields
 * (`api_key`, `aws_secret_access_key`, ...). The parser never reads them.
 */

import type { ModelKind } from "../../src/fuelix/catalog-types.ts"

/** Per-token USD prices. `undefined` means unknown. */
export interface DeploymentPrices {
  readonly input?: number
  readonly output?: number
  readonly input200k?: number
  readonly output200k?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cacheRead200k?: number
  readonly cacheWrite200k?: number
}

export interface Deployment {
  readonly deployment: string
  readonly provider: string
  readonly modelName: string
  readonly aliases: readonly string[]
  readonly active: boolean
  readonly deprecation?: string
  readonly kind?: ModelKind
  readonly modalities?: readonly string[]
  readonly tools?: boolean
  readonly reasoning?: boolean
  readonly prices: DeploymentPrices
  readonly context?: number
  readonly output?: number
  readonly maxInput?: number
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function strs(value: unknown): readonly string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : []
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Parse a number from a number or a numeric string. Empty or invalid values are unknown. */
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const MODE_KIND: Readonly<Record<string, ModelKind>> = {
  chat: "chat",
  embedding: "embedding",
  image_generation: "image",
  audio_speech: "speech",
  audio_transcription: "transcription",
}

export function modeToKind(mode: unknown): ModelKind | undefined {
  return typeof mode === "string" ? MODE_KIND[mode] : undefined
}

/** Positive limit values only: 0 and unknown both mean "no limit data". */
function limit(value: unknown): number | undefined {
  const parsed = parseNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

export function parseInventory(deploymentsYaml: string, costsYaml: string): Deployment[] {
  const deployments = Bun.YAML.parse(deploymentsYaml)
  const costs = Bun.YAML.parse(costsYaml)
  const costByDeployment = new Map<string, Json>()
  if (Array.isArray(costs)) {
    for (const row of costs) {
      const record = obj(row)
      if (record && typeof record.deployment_model === "string") costByDeployment.set(record.deployment_model, record)
    }
  }
  if (!Array.isArray(deployments)) return []
  const result: Deployment[] = []
  for (const row of deployments) {
    const record = obj(row)
    if (!record || typeof record.deployment !== "string") continue
    const cost = costByDeployment.get(record.deployment)
    const litellm = obj(record.litellm)
    const model = obj(record.model)
    const deprecation = obj(record.deprecation)
    const modalities = strs(litellm?.supported_modalities)
    const mode = litellm?.mode || cost?.mode
    const context = limit(cost?.max_context_window) ?? limit(cost?.max_input_tokens)
    const output = limit(cost?.max_output_tokens) ?? limit(cost?.max_tokens)
    const maxInput = limit(cost?.max_input_tokens)
    result.push({
      deployment: record.deployment,
      provider: typeof record.provider === "string" ? record.provider : "",
      modelName: typeof model?.name === "string" ? model.name : "",
      aliases: strs(obj(record.alias)?.current),
      active: record.active === true,
      ...(typeof deprecation?.status === "string" ? { deprecation: deprecation.status } : {}),
      ...(modeToKind(mode) ? { kind: modeToKind(mode) } : {}),
      ...(modalities.length > 0 ? { modalities } : {}),
      ...(typeof litellm?.supports_function_calling === "boolean" ? { tools: litellm.supports_function_calling } : {}),
      ...(typeof litellm?.supports_reasoning === "boolean" ? { reasoning: litellm.supports_reasoning } : {}),
      prices: {
        input: parseNumber(cost?.input_cost_per_token),
        output: parseNumber(cost?.output_cost_per_token),
        input200k: parseNumber(cost?.input_cost_per_token_200k),
        output200k: parseNumber(cost?.output_cost_per_token_200k),
        cacheRead: parseNumber(cost?.cache_read_input_token_cost),
        cacheWrite: parseNumber(cost?.cache_creation_input_token_cost),
        cacheRead200k: parseNumber(cost?.cache_read_input_token_cost_200k),
        cacheWrite200k: parseNumber(cost?.cache_creation_input_token_cost_200k),
      },
      ...(context ? { context } : {}),
      ...(output ? { output } : {}),
      ...(maxInput ? { maxInput } : {}),
    })
  }
  return result
}

export interface Selection {
  readonly chosen: Deployment
  /** Matching deployments, best first. */
  readonly candidates: readonly Deployment[]
  /** Candidate deployment names without repeats, best first. */
  readonly deploymentNames: readonly string[]
  /** Minimum context across candidates. */
  readonly context?: number
  /** Minimum output across candidates. */
  readonly output?: number
  /** `true` when the base input or output price differs by more than 1% across candidates. */
  readonly priceSpread: boolean
  readonly spreadDetail?: string
}

function candidatesFor(id: string, deployments: readonly Deployment[]): Deployment[] {
  const usable = deployments.filter((item) => item.active && item.deprecation !== "retired")
  const byAlias = usable.filter((item) => item.aliases.includes(id))
  if (byAlias.length > 0) return byAlias
  return usable.filter((item) => item.modelName === id)
}

function minimum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined)
  return known.length > 0 ? Math.min(...known) : undefined
}

function spread(values: readonly (number | undefined)[]): boolean {
  const known = values.filter((value): value is number => value !== undefined && value > 0)
  if (known.length < 2) return false
  const max = Math.max(...known)
  return (max - Math.min(...known)) / max > 0.01
}

function rank(a: Deployment, b: Deployment): number {
  const byInput = (b.prices.input ?? -1) - (a.prices.input ?? -1)
  if (byInput !== 0) return byInput
  const byOutput = (b.prices.output ?? -1) - (a.prices.output ?? -1)
  if (byOutput !== 0) return byOutput
  const byCacheWrite = (b.prices.cacheWrite ?? -1) - (a.prices.cacheWrite ?? -1)
  if (byCacheWrite !== 0) return byCacheWrite
  const byCacheRead = (b.prices.cacheRead ?? -1) - (a.prices.cacheRead ?? -1)
  if (byCacheRead !== 0) return byCacheRead
  return a.deployment < b.deployment ? -1 : a.deployment > b.deployment ? 1 : 0
}

/**
 * Selection policy for a model ID that several deployments serve:
 * - price from the candidate with the highest base input price (list rate, conservative);
 * - limits are the minimum context and output across candidates (safe for any route);
 * - modalities, tools, and reasoning come from the chosen candidate.
 */
export function selectDeployment(id: string, deployments: readonly Deployment[]): Selection | undefined {
  const candidates = candidatesFor(id, deployments).sort(rank)
  const chosen = candidates[0]
  if (!chosen) return undefined
  const priceSpread =
    candidates.length > 1 &&
    (spread(candidates.map((item) => item.prices.input)) || spread(candidates.map((item) => item.prices.output)))
  const unique = [...new Map(candidates.map((item) => [item.deployment, item])).values()]
  return {
    chosen,
    candidates,
    deploymentNames: unique.map((item) => item.deployment),
    context: minimum(candidates.map((item) => item.context)),
    output: minimum(candidates.map((item) => item.output)),
    priceSpread,
    ...(priceSpread
      ? {
          spreadDetail: unique
            .map((item) => `${item.deployment} (${toPerMillion(item.prices.input)}/${toPerMillion(item.prices.output)})`)
            .join(", "),
        }
      : {}),
  }
}

/** Convert a per-token USD price to USD per 1M tokens, rounded to 6 decimals. */
export function toPerMillion(perToken: number | undefined): number | undefined {
  if (perToken === undefined) return undefined
  return Number((perToken * 1_000_000).toFixed(6))
}
