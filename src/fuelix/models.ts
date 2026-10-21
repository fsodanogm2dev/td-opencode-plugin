import type { Model, Plugin, Provider } from "@opencode/plugin"
import type { CatalogEntry, FuelixProviderID } from "./catalog-types.ts"
import { titleFamily } from "./rules.ts"
import { FUELIX_PACKAGES, resolveVariants } from "./variants.ts"

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]

export const FUELIX_INTEGRATION_ID = "fuelix"
export const DEFAULT_LIMIT = { context: 200_000, output: 32_000 } as const

/** Plain shape of a provider. `toProviderInfo` is the only place that casts to the branded OpenCode type. */
interface PlainProviderInfo {
  id: string
  integrationID: string
  name: string
  activation: Provider.Info["activation"]
  package: string
  settings: Record<string, unknown>
}

interface PlainModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature?: boolean }
  variants: { id: string; settings: Record<string, unknown> }[]
  time: { released: number }
  cost: { tier?: { type: "context"; size: number }; input: number; output: number; cache: { read: number; write: number } }[]
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  /** Set only on the title model of a provider. See `TITLE_MODELS`. */
  family?: string
  limit: { context: number; input?: number; output: number }
}

// Single boundary: OpenCode types are branded, so plain objects need one cast.
const toProviderInfo = (plain: PlainProviderInfo): Provider.Info => plain as unknown as Provider.Info
const toModelInfo = (plain: PlainModelInfo): Model.Info => plain as unknown as Model.Info

const PROVIDER_NAMES: Readonly<Record<FuelixProviderID, string>> = {
  "fuelix-openai": "FuelIX (OpenAI Responses)",
  "fuelix-anthropic": "FuelIX (Anthropic Messages)",
  fuelix: "FuelIX",
}

/**
 * Builds provider info without a key: no `apiKey`, no `headers`, no `body`.
 * `baseURL` is the gateway origin without `/v1` and without a trailing slash.
 */
export function buildProviderInfo(
  providerID: FuelixProviderID,
  baseURL: string,
  activation: Provider.Info["activation"],
): Provider.Info {
  const settings: Record<string, unknown> =
    providerID === "fuelix" ? { baseURL, provider: "fuelix" } : { baseURL: `${baseURL}/v1` }
  return toProviderInfo({
    id: providerID,
    integrationID: FUELIX_INTEGRATION_ID,
    name: PROVIDER_NAMES[providerID],
    activation,
    package: FUELIX_PACKAGES[providerID],
    settings,
  })
}

export type IncompleteField = "cost" | "limit" | "capabilities"

export interface BuiltModel {
  readonly info: Model.Info
  /** Metadata fields that the catalog does not provide. They hold defaults. */
  readonly incomplete: IncompleteField[]
}

export function buildModelInfo(providerID: FuelixProviderID, modelID: string, entry: CatalogEntry | undefined): BuiltModel {
  const incomplete: IncompleteField[] = []

  const cost: PlainModelInfo["cost"] = []
  if (entry?.cost) {
    cost.push({
      input: entry.cost.input,
      output: entry.cost.output,
      cache: { read: entry.cost.cacheRead, write: entry.cost.cacheWrite },
    })
    for (const tier of entry.costTiers ?? []) {
      cost.push({
        tier: { type: "context", size: tier.contextOver },
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cacheRead, write: tier.cacheWrite },
      })
    }
  } else {
    incomplete.push("cost")
  }

  let limit: PlainModelInfo["limit"]
  if (entry?.limit) {
    limit = { context: entry.limit.context, output: entry.limit.output }
    if (entry.limit.input !== undefined) limit.input = entry.limit.input
  } else {
    limit = { ...DEFAULT_LIMIT }
    incomplete.push("limit")
  }

  if (!entry) incomplete.push("capabilities")

  const status = entry?.status ?? "active"
  const family = titleFamily(providerID, modelID, status)

  return {
    info: toModelInfo({
      id: modelID,
      modelID,
      providerID,
      name: entry?.name ?? modelID,
      capabilities: {
        tools: entry?.tools ?? true,
        input: [...(entry?.input ?? ["text"])],
        output: [...(entry?.output ?? ["text"])],
      },
      variants: resolveVariants({ providerID, modelID, outputLimit: limit.output, reasoning: entry?.reasoning }),
      time: { released: 0 },
      cost,
      status,
      enabled: true,
      ...(family ? { family } : {}),
      limit,
    }),
    incomplete,
  }
}

/** Built-in OpenCode provider that holds upstream metadata for a FueliX model ID. */
export function upstreamProviderID(providerID: FuelixProviderID, modelID: string): string | undefined {
  if (providerID === "fuelix-anthropic") return "anthropic"
  if (providerID === "fuelix-openai") return "openai"
  const id = modelID.toLowerCase()
  if (id.startsWith("gemini") || id.startsWith("gemma")) return "google"
  if (id.startsWith("claude")) return "anthropic"
  if (id.startsWith("gpt")) return "openai"
  if (id.startsWith("mistral")) return "mistral"
  if (id.startsWith("deepseek")) return "deepseek"
  if (id.startsWith("llama")) return "meta"
  return undefined
}

/**
 * Copies missing cost, limit, and capabilities from the inactive built-in provider with the same model ID.
 * Only fields in `incomplete` change. Returns the fields that it filled.
 */
export function enrichFromUpstream(
  editor: Pick<ProviderEditor, "get" | "models">,
  providerID: FuelixProviderID,
  modelID: string,
  info: Model.Info,
  incomplete: readonly IncompleteField[],
): IncompleteField[] {
  if (incomplete.length === 0) return []
  const upstreamID = upstreamProviderID(providerID, modelID)
  if (!upstreamID) return []
  const upstream = editor.get(upstreamID)?.models.get(modelID)
  if (!upstream) return []

  const filled: IncompleteField[] = []
  const reasoning = info.variants.length > 0
  editor.models.update(providerID, modelID, (model) => {
    if (incomplete.includes("cost") && upstream.cost.length > 0) {
      model.cost = upstream.cost.map((item) => ({
        ...(item.tier ? { tier: { type: item.tier.type, size: item.tier.size } } : {}),
        input: item.input,
        output: item.output,
        cache: { read: item.cache.read, write: item.cache.write },
      }))
      filled.push("cost")
    }
    if (incomplete.includes("limit")) {
      model.limit = {
        context: upstream.limit.context,
        output: upstream.limit.output,
        ...(upstream.limit.input !== undefined ? { input: upstream.limit.input } : {}),
      }
      // Budget-based variants depend on the output limit.
      if (reasoning) {
        model.variants = resolveVariants({ providerID, modelID, outputLimit: upstream.limit.output }) as unknown as typeof model.variants
      }
      filled.push("limit")
    }
    if (incomplete.includes("capabilities")) {
      model.capabilities = {
        tools: upstream.capabilities.tools,
        input: [...upstream.capabilities.input],
        output: [...upstream.capabilities.output],
        ...(upstream.capabilities.temperature !== undefined ? { temperature: upstream.capabilities.temperature } : {}),
      }
      filled.push("capabilities")
    }
  })
  return filled
}
