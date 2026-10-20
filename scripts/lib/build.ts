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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0")
}

function sameCost(a: CatalogCost, b: CatalogCost): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

type Field = "limit" | "cost" | "input" | "output" | "tools" | "reasoning"
type Origin = "inventory" | "seed"

interface Built {
  readonly entry: CatalogEntry
  /** Name of the chosen inventory deployment. */
  readonly deployment?: string
  /** `model.name` of the chosen inventory deployment. */
  readonly model?: string
  /** Where each present field came from. */
  readonly origin: Partial<Record<Field, Origin>>
}

function buildEntry(id: string, input: BuildInput): Built {
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
  const origin: Partial<Record<Field, Origin>> = {}

  // Limit: the seed (known-working configuration) first, then the inventory. Each component on its own.
  const inventoryContext = selection?.context
  const inventoryOutput = selection?.output
  const context = seed?.context ?? inventoryContext
  let outputLimit = seed?.output ?? inventoryOutput
  // An inventory output limit that is not below the final context limit is wrong. Drop it.
  if (seed?.output === undefined && outputLimit !== undefined && context !== undefined && outputLimit >= context) {
    outputLimit = undefined
  }
  let limit: CatalogLimit | undefined
  if (context !== undefined && outputLimit !== undefined) {
    limit = { context, output: outputLimit }
    const contextFromSeed = seed?.context !== undefined
    const outputFromSeed = seed?.output !== undefined
    if (contextFromSeed && outputFromSeed) {
      origin.limit = "seed"
      fromSeed++
    } else if (!contextFromSeed && !outputFromSeed) {
      origin.limit = "inventory"
      fromInventory++
    } else {
      origin.limit = "seed"
      fromSeed++
      fromInventory++
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
    origin.cost = "inventory"
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
    origin.cost = "seed"
  }

  // Input modalities, tools, reasoning: the seed first, then the chosen deployment.
  const inputModalities = seed?.inputModalities ?? chosen?.modalities
  if (inputModalities) {
    origin.input = seed?.inputModalities ? "seed" : "inventory"
    if (seed?.inputModalities) fromSeed++
    else fromInventory++
  }
  const tools = seed?.tools ?? chosen?.tools
  if (tools !== undefined) {
    origin.tools = seed?.tools !== undefined ? "seed" : "inventory"
    if (seed?.tools !== undefined) fromSeed++
    else fromInventory++
  }
  const reasoning = seed?.reasoning ?? chosen?.reasoning
  if (reasoning !== undefined) {
    origin.reasoning = seed?.reasoning !== undefined ? "seed" : "inventory"
    if (seed?.reasoning !== undefined) fromSeed++
    else fromInventory++
  }

  const outputModalities = seed?.outputModalities ?? (kind === "chat" ? ["text"] : undefined)
  if (outputModalities) origin.output = seed?.outputModalities ? "seed" : undefined

  if (imageChat) notes.push("Inventory mode is image_generation. Kept as chat because the routing seed lists text and image output.")
  if (selection && chosen) {
    if (selection.deploymentNames.length > 1) {
      notes.push(
        `Matched ${selection.deploymentNames.length} inventory deployments. Price comes from ${chosen.deployment} (highest input price). Inventory limits are the minimum across: ${selection.deploymentNames.join(", ")}.`,
      )
    } else {
      notes.push(`Inventory deployment: ${chosen.deployment}.`)
    }
    for (const detail of selection.ignoredOutput) {
      notes.push(`Inventory output limit ignored, because it is not below the context limit: ${detail}.`)
    }
    if (seed?.context !== undefined || seed?.output !== undefined) {
      const differs =
        (seed.context !== undefined && inventoryContext !== undefined && seed.context !== inventoryContext) ||
        (seed.output !== undefined && inventoryOutput !== undefined && seed.output !== inventoryOutput)
      if (differs) {
        notes.push(
          `Inventory limit ${inventoryContext ?? "?"}/${inventoryOutput ?? "?"} (context/output) differs from the configured ${seed.context ?? "?"}/${seed.output ?? "?"}; configured value kept.`,
        )
      }
    }
    if (seed?.inputModalities && chosen.modalities && !sameSet(seed.inputModalities, chosen.modalities)) {
      notes.push(
        `Inventory input modalities ${chosen.modalities.join(",")} differ from the configured ${seed.inputModalities.join(",")}; configured value kept.`,
      )
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

  const entry: CatalogEntry = {
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
  return {
    entry,
    ...(chosen ? { deployment: chosen.deployment } : {}),
    ...(chosen?.modelName ? { model: chosen.modelName } : {}),
    origin,
  }
}

const FIELD_LABEL: Readonly<Record<Field, string>> = {
  limit: "limit",
  cost: "cost",
  input: "input modalities",
  output: "output modalities",
  tools: "tool support",
  reasoning: "reasoning support",
}

function hasField(entry: CatalogEntry, field: Field): boolean {
  switch (field) {
    case "limit":
      return entry.limit !== undefined
    case "cost":
      return entry.cost !== undefined
    case "input":
      return entry.input !== undefined
    case "output":
      return entry.output !== undefined
    case "tools":
      return entry.tools !== undefined
    case "reasoning":
      return entry.reasoning !== undefined
  }
}

/**
 * Fill fields that an ID still lacks from another ID with the same chosen inventory deployment.
 * Donor order: field from the inventory first, then from the seed; ties go to the first ID in sort order.
 * Never borrows across deployments.
 */
function borrowFields(built: ReadonlyMap<string, Built>): Map<string, CatalogEntry> {
  const byDeployment = new Map<string, string[]>()
  for (const [id, item] of built) {
    if (!item.deployment) continue
    byDeployment.set(item.deployment, [...(byDeployment.get(item.deployment) ?? []), id])
  }
  const fields: readonly Field[] = ["limit", "cost", "input", "output", "tools", "reasoning"]
  const result = new Map<string, CatalogEntry>()
  for (const [id, item] of built) {
    let entry = item.entry
    const peers = item.deployment ? (byDeployment.get(item.deployment) ?? []).filter((peer) => peer !== id) : []
    const extra: string[] = []
    for (const field of fields) {
      if (hasField(item.entry, field)) continue
      const donors = peers
        .map((peer) => ({ peer, built: built.get(peer) as Built }))
        .filter((donor) => hasField(donor.built.entry, field))
        .sort((a, b) => {
          const rankOf = (donor: { built: Built }) => (donor.built.origin[field] === "inventory" ? 0 : 1)
          return rankOf(a) - rankOf(b) || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)
        })
      const donor = donors[0]
      if (!donor) continue
      const source = donor.built.entry
      entry = {
        ...entry,
        ...(field === "limit" ? { limit: source.limit } : {}),
        ...(field === "cost" ? { cost: source.cost, ...(source.costTiers ? { costTiers: source.costTiers } : {}) } : {}),
        ...(field === "input" ? { input: source.input } : {}),
        ...(field === "output" ? { output: source.output } : {}),
        ...(field === "tools" ? { tools: source.tools } : {}),
        ...(field === "reasoning" ? { reasoning: source.reasoning } : {}),
      }
      extra.push(`${FIELD_LABEL[field]} borrowed from ${donor.peer} (same deployment ${item.deployment}).`)
    }
    if (extra.length > 0) {
      entry = {
        ...entry,
        sources: { ...entry.sources, metadata: "mixed" },
        notes: [...(entry.notes ?? []), ...extra],
      }
    }
    result.set(id, entry)
  }
  return result
}

/** Fields that a second pass may borrow by model name. Prices and features can differ per deployment. */
const MODEL_FIELDS: readonly Field[] = ["limit", "input", "output"]

/**
 * Fill `limit`, `input`, and `output` modalities that an ID still lacks from the catalog ID that equals the chosen
 * deployment's `model.name`. If that ID has no value, use another ID whose chosen deployment has the same
 * `model.name` (first in sort order). Never borrows cost, tools, or reasoning.
 */
function borrowByModel(entries: ReadonlyMap<string, CatalogEntry>, built: ReadonlyMap<string, Built>): Map<string, CatalogEntry> {
  const byModel = new Map<string, string[]>()
  for (const [id, item] of built) {
    if (!item.model) continue
    byModel.set(item.model, [...(byModel.get(item.model) ?? []), id])
  }
  const result = new Map<string, CatalogEntry>()
  for (const [id, original] of entries) {
    const item = built.get(id) as Built
    let entry = original
    const extra: string[] = []
    if (item.model && item.deployment) {
      const named = entries.has(item.model) ? [item.model] : []
      const peers = [...named, ...(byModel.get(item.model) ?? []).filter((peer) => peer !== item.model)].filter(
        (peer) => peer !== id,
      )
      for (const field of MODEL_FIELDS) {
        if (hasField(entry, field)) continue
        const donor = peers.find((peer) => hasField(entries.get(peer) as CatalogEntry, field))
        if (!donor) continue
        const source = entries.get(donor) as CatalogEntry
        entry = {
          ...entry,
          ...(field === "limit" ? { limit: source.limit } : {}),
          ...(field === "input" ? { input: source.input } : {}),
          ...(field === "output" ? { output: source.output } : {}),
        }
        extra.push(
          `${FIELD_LABEL[field]} borrowed from ${donor} (same model ${item.model}, deployment ${item.deployment}).`,
        )
      }
    }
    if (extra.length > 0) {
      entry = {
        ...entry,
        sources: { ...entry.sources, metadata: "mixed" },
        notes: [...(entry.notes ?? []), ...extra],
      }
    }
    result.set(id, entry)
  }
  return result
}

export function buildCatalog(input: BuildInput): Catalog {
  const ids = new Set<string>([...input.seed.keys(), ...(input.liveIds ?? [])])
  const sorted = [...ids].sort()
  const built = new Map(sorted.map((id) => [id, buildEntry(id, input)] as const))
  const borrowed = borrowByModel(borrowFields(built), built)
  const models: Record<string, CatalogEntry> = {}
  for (const id of sorted) models[id] = borrowed.get(id) as CatalogEntry
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
