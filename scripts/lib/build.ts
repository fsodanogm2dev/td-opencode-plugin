/** Pure catalog builder: seed + inventory + live IDs in, `Catalog` out. No I/O. */

import type {
  Catalog,
  CatalogCost,
  CatalogCostTier,
  CatalogEntry,
  CatalogLimit,
  MetadataSource,
  ModelKind,
} from "../../src/fuelix/catalog-types.ts"
import { classifyKind, routeModel } from "../../src/fuelix/rules.ts"
import { selectDeployment, toPerMillion, type Deployment } from "./inventory.ts"
import type { SeedModel } from "./seed.ts"

export interface BuildInput {
  readonly seed: ReadonlyMap<string, SeedModel>
  readonly deployments: readonly Deployment[]
  /** IDs from the live `/v1/models` list. Optional. */
  readonly liveIds?: readonly string[]
  readonly generatedAt: string
  readonly sources: readonly string[]
}

/** Substrings that must never appear in the catalog file. */
export const FORBIDDEN_SUBSTRINGS = ["apiKey", "api_key", "Authorization", "aws_secret", "sk-"] as const

export function assertNoSecrets(text: string): void {
  for (const word of FORBIDDEN_SUBSTRINGS) {
    if (text.includes(word)) throw new Error(`Catalog output contains forbidden text "${word}". Build stopped.`)
  }
}

function sameCost(a: CatalogCost, b: CatalogCost): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

function buildEntry(id: string, input: BuildInput): CatalogEntry {
  const seed = input.seed.get(id)
  const live = input.liveIds?.includes(id) ?? false
  const selection = selectDeployment(id, input.deployments)
  const chosen = selection?.chosen
  const notes: string[] = []

  const routing = seed ? "config" : "rule"
  const provider = seed?.provider ?? routeModel(id)
  // An image-generation deployment whose seed entry takes and returns text and images is a chat model that can
  // draw (for example `gemini-3.1-flash-image`). The seed registered it as chat, so the catalog keeps it as chat.
  const imageChat =
    chosen?.kind === "image" &&
    seed?.outputModalities?.includes("text") === true &&
    seed.outputModalities.includes("image") &&
    seed.inputModalities?.includes("text") === true
  const kind: ModelKind = imageChat ? "chat" : (chosen?.kind ?? classifyKind(id))

  let fromInventory = 0
  let fromSeed = 0

  // Limit: per component, inventory first, then seed.
  const context = selection?.context ?? seed?.context
  const outputLimit = selection?.output ?? seed?.output
  let limit: CatalogLimit | undefined
  if (context !== undefined && outputLimit !== undefined) {
    limit = { context, output: outputLimit }
    if (selection?.context !== undefined && selection.output !== undefined) fromInventory++
    else if (selection?.context === undefined && selection?.output === undefined) fromSeed++
    else {
      fromInventory++
      fromSeed++
    }
  }

  // Cost: base input and output must come from one source. Cache prices fall back per field.
  let cost: CatalogCost | undefined
  let costTiers: CatalogCostTier[] | undefined
  const prices = chosen?.prices
  if (prices?.input !== undefined && prices.output !== undefined) {
    const seedCost = seed?.cost
    const inventoryRead = toPerMillion(prices.cacheRead)
    const inventoryWrite = toPerMillion(prices.cacheWrite)
    const cacheRead = inventoryRead ?? seedCost?.cacheRead
    const cacheWrite = inventoryWrite ?? seedCost?.cacheWrite
    const usedSeed =
      (inventoryRead === undefined && cacheRead !== undefined) || (inventoryWrite === undefined && cacheWrite !== undefined)
    cost = {
      input: toPerMillion(prices.input) as number,
      output: toPerMillion(prices.output) as number,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
    }
    fromInventory++
    if (usedSeed) fromSeed++
    if (prices.input200k !== undefined || prices.output200k !== undefined) {
      const tier: CatalogCostTier = {
        contextOver: 200_000,
        input: toPerMillion(prices.input200k) ?? cost.input,
        output: toPerMillion(prices.output200k) ?? cost.output,
        cacheRead: toPerMillion(prices.cacheRead200k) ?? cost.cacheRead,
        cacheWrite: toPerMillion(prices.cacheWrite200k) ?? cost.cacheWrite,
      }
      if (!sameCost(tier, cost)) costTiers = [tier]
    }
  } else if (seed?.cost?.input !== undefined && seed.cost.output !== undefined) {
    cost = {
      input: seed.cost.input,
      output: seed.cost.output,
      cacheRead: seed.cost.cacheRead ?? 0,
      cacheWrite: seed.cost.cacheWrite ?? 0,
    }
    fromSeed++
  }

  // Input modalities, tools, reasoning: chosen deployment first, then seed.
  const inputModalities = chosen?.modalities ?? seed?.inputModalities
  if (inputModalities) {
    if (chosen?.modalities) fromInventory++
    else fromSeed++
  }
  const tools = chosen?.tools ?? seed?.tools
  if (tools !== undefined) {
    if (chosen?.tools !== undefined) fromInventory++
    else fromSeed++
  }
  const reasoning = chosen?.reasoning ?? seed?.reasoning
  if (reasoning !== undefined) {
    if (chosen?.reasoning !== undefined) fromInventory++
    else fromSeed++
  }

  const outputModalities = seed?.outputModalities ?? (kind === "chat" ? ["text"] : undefined)

  if (imageChat) notes.push("Inventory mode is image_generation. Kept as chat because the routing seed lists text and image output.")
  if (selection && chosen) {
    if (selection.deploymentNames.length > 1) {
      notes.push(
        `Matched ${selection.deploymentNames.length} inventory deployments. Price and capabilities come from ${chosen.deployment} (highest input price). Limits are the minimum across: ${selection.deploymentNames.join(", ")}.`,
      )
    } else {
      notes.push(`Inventory deployment: ${chosen.deployment}.`)
    }
    if (selection.priceSpread) {
      notes.push(`Price spread above 1% across deployments (input/output per 1M tokens): ${selection.spreadDetail}.`)
    }
  } else {
    notes.push("No active inventory deployment matches this ID. Metadata comes from the routing seed.")
  }

  const metadata: MetadataSource =
    fromInventory > 0 && fromSeed > 0 ? "mixed" : fromInventory > 0 ? "inventory" : fromSeed > 0 ? "config" : "none"

  const status = chosen?.deprecation === "deprecated" || chosen?.deprecation === "sunset" ? "deprecated" : chosen ? "active" : undefined

  return {
    provider,
    kind,
    name: seed?.name ?? id,
    ...(limit ? { limit } : {}),
    ...(inputModalities ? { input: [...inputModalities] } : {}),
    ...(outputModalities ? { output: [...outputModalities] } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cost ? { cost } : {}),
    ...(costTiers ? { costTiers } : {}),
    ...(status ? { status } : {}),
    ...(live ? { listed: true } : {}),
    sources: { routing, metadata },
    notes,
  }
}

export function buildCatalog(input: BuildInput): Catalog {
  const ids = new Set<string>([...input.seed.keys(), ...(input.liveIds ?? [])])
  const models: Record<string, CatalogEntry> = {}
  for (const id of [...ids].sort()) models[id] = buildEntry(id, input)
  return { version: 1, generatedAt: input.generatedAt, sources: [...input.sources], models }
}

export function serializeCatalog(catalog: Catalog): string {
  const text = JSON.stringify(catalog, null, 2) + "\n"
  assertNoSecrets(text)
  return text
}

export interface BuildSummary {
  readonly total: number
  readonly byProvider: Readonly<Record<string, number>>
  readonly byKind: Readonly<Record<string, number>>
  readonly byMetadata: Readonly<Record<string, number>>
  readonly chatMissing: readonly { readonly id: string; readonly missing: readonly string[] }[]
}

export function summarize(catalog: Catalog): BuildSummary {
  const byProvider: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  const byMetadata: Record<string, number> = {}
  const chatMissing: { id: string; missing: string[] }[] = []
  for (const [id, entry] of Object.entries(catalog.models)) {
    byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + 1
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    byMetadata[entry.sources.metadata] = (byMetadata[entry.sources.metadata] ?? 0) + 1
    if (entry.kind === "chat") {
      const missing: string[] = []
      if (!entry.cost) missing.push("cost")
      if (!entry.limit) missing.push("limit")
      if (missing.length > 0) chatMissing.push({ id, missing })
    }
  }
  return { total: Object.keys(catalog.models).length, byProvider, byKind, byMetadata, chatMissing }
}

export function formatSummary(summary: BuildSummary): string {
  const counts = (record: Readonly<Record<string, number>>) =>
    Object.entries(record)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `  ${key}: ${value}`)
      .join("\n")
  const lines = [
    `Catalog entries: ${summary.total}`,
    "By provider:",
    counts(summary.byProvider),
    "By kind:",
    counts(summary.byKind),
    "By metadata source:",
    counts(summary.byMetadata),
    `Chat entries missing cost or limit: ${summary.chatMissing.length}`,
    ...summary.chatMissing.map((item) => `  ${item.id}: missing ${item.missing.join(", ")}`),
  ]
  return lines.join("\n")
}

/**
 * Keep `generatedAt` from the existing file when nothing else changed. This makes the output deterministic and lets
 * `--check` ignore the timestamp.
 */
export function stabilizeTimestamp(existingText: string | undefined, catalog: Catalog): string {
  const next = serializeCatalog(catalog)
  if (!existingText) return next
  try {
    const existing = JSON.parse(existingText) as Catalog
    const same = serializeCatalog({ ...catalog, generatedAt: existing.generatedAt })
    return same === existingText ? existingText : next
  } catch {
    return next
  }
}
