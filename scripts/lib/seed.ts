/**
 * Routing seed: reads the FueliX model blocks of an OpenCode configuration.
 *
 * The parser copies only whitelisted fields. It never reads `options`, `settings`, `headers`, `apiKey`, or any other
 * field that can hold a secret.
 */

import type { FuelixProviderID } from "../../src/fuelix/catalog-types.ts"

export interface SeedCost {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface SeedModel {
  readonly provider: FuelixProviderID
  readonly name?: string
  readonly context?: number
  readonly output?: number
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
  readonly tools?: boolean
  readonly reasoning?: boolean
  readonly cost?: SeedCost
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === "string")
  return list.length > 0 ? list : undefined
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function seedCost(input: unknown, cache: { read?: unknown; write?: unknown }): SeedCost | undefined {
  const cost = obj(input)
  if (!cost) return undefined
  const result = compact({
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  })
  return Object.keys(result).length > 0 ? result : undefined
}

/** Legacy V1 shape: `provider[id].models[model]`. */
function parseV1(provider: FuelixProviderID, block: unknown, into: Map<string, SeedModel>): void {
  const models = obj(obj(block)?.models)
  if (!models) return
  for (const [id, raw] of Object.entries(models)) {
    const model = obj(raw)
    if (!model) continue
    const limit = obj(model.limit)
    const modalities = obj(model.modalities)
    const cost = obj(model.cost)
    into.set(
      id,
      compact({
        provider,
        name: str(model.name),
        context: num(limit?.context),
        output: num(limit?.output),
        inputModalities: strings(modalities?.input),
        outputModalities: strings(modalities?.output),
        tools: bool(model.tool_call),
        reasoning: bool(model.reasoning),
        cost: seedCost(cost, { read: cost?.cache_read, write: cost?.cache_write }),
      }),
    )
  }
}

/** V2 shape: `providers[id].models[model]`. */
function parseV2(provider: FuelixProviderID, block: unknown, into: Map<string, SeedModel>): void {
  const models = obj(obj(block)?.models)
  if (!models) return
  for (const [id, raw] of Object.entries(models)) {
    const model = obj(raw)
    if (!model) continue
    const limit = obj(model.limit)
    const capabilities = obj(model.capabilities)
    const cost = obj(model.cost)
    const cache = obj(cost?.cache)
    into.set(
      id,
      compact({
        provider,
        name: str(model.name),
        context: num(limit?.context),
        output: num(limit?.output),
        inputModalities: strings(capabilities?.input),
        outputModalities: strings(capabilities?.output),
        tools: bool(capabilities?.tools),
        reasoning: bool(capabilities?.reasoning),
        cost: seedCost(cost, { read: cache?.read, write: cache?.write }),
      }),
    )
  }
}

const PROVIDERS: readonly FuelixProviderID[] = ["fuelix-openai", "fuelix-anthropic", "fuelix"]

/** Extract the FueliX models from a parsed OpenCode configuration. Reads both the V1 and V2 blocks. */
export function parseSeed(config: unknown): Map<string, SeedModel> {
  const root = obj(config) ?? {}
  const v1 = obj(root.provider)
  const v2 = obj(root.providers)
  const seed = new Map<string, SeedModel>()
  for (const provider of PROVIDERS) {
    if (v1 && provider in v1) parseV1(provider, v1[provider], seed)
    if (v2 && provider in v2) parseV2(provider, v2[provider], seed)
  }
  return seed
}
