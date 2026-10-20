/**
 * Shape of `data/fuelix-models.json`, the curated FueliX model catalog.
 *
 * `scripts/build-catalog.ts` generates the file from two sources:
 * - routing seed: the provider that each model ID used in a known-working OpenCode configuration;
 * - metadata: `fuelix/LLM-Inventory` (`data/deployments.yaml`, `data/costs.yaml`).
 *
 * The plugin reads the file at runtime and converts each entry to an OpenCode `Model.Info`.
 * All prices are USD per 1 million tokens.
 */

export const FUELIX_PROVIDER_IDS = ["fuelix-openai", "fuelix-anthropic", "fuelix"] as const
export type FuelixProviderID = (typeof FUELIX_PROVIDER_IDS)[number]

/** Model kinds. Only `chat` models are registered unless `includeNonChatModels` is set. */
export type ModelKind = "chat" | "embedding" | "image" | "speech" | "transcription"

export interface CatalogCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** A price that applies when the request's total input is larger than `contextOver` tokens. */
export interface CatalogCostTier extends CatalogCost {
  readonly contextOver: number
}

export interface CatalogLimit {
  readonly context: number
  readonly output: number
  readonly input?: number
}

export type RoutingSource = "config" | "inventory" | "rule"
export type MetadataSource = "inventory" | "config" | "mixed" | "none"

export interface CatalogEntry {
  /** OpenCode provider that serves this model ID. */
  readonly provider: FuelixProviderID
  readonly kind: ModelKind
  /** Display name. */
  readonly name: string
  readonly limit?: CatalogLimit
  /** Input modalities, for example `["text", "image", "pdf"]`. */
  readonly input?: readonly string[]
  /** Output modalities, for example `["text"]`. */
  readonly output?: readonly string[]
  /** Tool (function) calling support. */
  readonly tools?: boolean
  /** Reasoning support. `false` means the plugin adds no reasoning variants. Unknown when unset. */
  readonly reasoning?: boolean
  /** Base price. */
  readonly cost?: CatalogCost
  /** Additional context-size price tiers, in ascending `contextOver` order. */
  readonly costTiers?: readonly CatalogCostTier[]
  readonly status?: "active" | "deprecated" | "beta" | "alpha"
  readonly sources: {
    readonly routing: RoutingSource
    readonly metadata: MetadataSource
  }
  /** Facts a maintainer needs, for example "price taken from the vertex_ai deployment". */
  readonly notes?: readonly string[]
}

export interface Catalog {
  readonly version: 1
  readonly generatedAt: string
  readonly sources: readonly string[]
  readonly models: Readonly<Record<string, CatalogEntry>>
}
