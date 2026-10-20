import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { FUELIX_PROVIDER_IDS, type Catalog, type CatalogEntry } from "./catalog-types.ts"

export interface LoadedCatalog {
  readonly catalog: Catalog
  /** Set when the file is missing, invalid, or has invalid entries. */
  readonly warning?: string
}

export const DEFAULT_CATALOG_URL = new URL("../../data/fuelix-models.json", import.meta.url)

export function emptyCatalog(): Catalog {
  return { version: 1, generatedAt: "", sources: [], models: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const STATUSES = ["active", "deprecated", "beta", "alpha"]
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const

const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0
const isNonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0
const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")

function validCost(value: unknown): value is Record<(typeof COST_KEYS)[number], number> {
  return isRecord(value) && COST_KEYS.every((key) => isPrice(value[key]))
}

function pickCost(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(COST_KEYS.map((key) => [key, value[key]!]))
}

/**
 * Copies a valid entry. An invalid field is dropped, not the entry, and counted in `dropped`.
 * Returns `undefined` when `provider`, `kind`, or `name` is invalid.
 */
function sanitizeEntry(value: unknown, dropped: { count: number }): CatalogEntry | undefined {
  if (!isRecord(value)) return undefined
  if (!FUELIX_PROVIDER_IDS.includes(value.provider as never)) return undefined
  if (typeof value.kind !== "string" || typeof value.name !== "string") return undefined
  const entry: Record<string, unknown> = { provider: value.provider, kind: value.kind, name: value.name }
  const drop = () => void dropped.count++
  const present = (key: string) => value[key] !== undefined

  if (present("limit")) {
    const limit = value.limit
    // Non-chat models (embeddings, speech, images) legitimately have a limit of 0 on one side.
    const valid = value.kind === "chat" ? isPositiveInt : isNonNegativeInt
    if (isRecord(limit) && valid(limit.context) && valid(limit.output)) {
      const copy: Record<string, number> = { context: limit.context, output: limit.output }
      if (limit.input !== undefined) {
        if (valid(limit.input)) copy.input = limit.input
        else drop()
      }
      entry.limit = copy
    } else drop()
  }
  for (const key of ["input", "output"] as const) {
    if (!present(key)) continue
    if (isStringArray(value[key])) entry[key] = [...(value[key] as string[])]
    else drop()
  }
  for (const key of ["tools", "reasoning", "listed"] as const) {
    if (!present(key)) continue
    if (typeof value[key] === "boolean") entry[key] = value[key]
    else drop()
  }
  if (present("status")) {
    if (typeof value.status === "string" && STATUSES.includes(value.status)) entry.status = value.status
    else drop()
  }
  if (present("cost")) {
    if (validCost(value.cost)) entry.cost = pickCost(value.cost)
    else drop()
  }
  if (present("costTiers")) {
    const tiers = value.costTiers
    if (Array.isArray(tiers) && tiers.every((tier) => validCost(tier) && isPositiveInt((tier as Record<string, unknown>).contextOver))) {
      entry.costTiers = tiers.map((tier) => ({ ...pickCost(tier as Record<string, number>), contextOver: (tier as { contextOver: number }).contextOver }))
    } else drop()
  }
  if (isRecord(value.sources)) entry.sources = value.sources
  else entry.sources = { routing: "rule", metadata: "none" }
  if (isStringArray(value.notes)) entry.notes = value.notes
  return entry as unknown as CatalogEntry
}

/** Reads the curated catalog. Never throws: a missing or invalid file gives an empty catalog and a warning. */
export async function loadCatalog(url: URL = DEFAULT_CATALOG_URL): Promise<LoadedCatalog> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(fileURLToPath(url), "utf8"))
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    const reason = code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error)
    return { catalog: emptyCatalog(), warning: `FueliX catalog not loaded (${reason})` }
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.models)) {
    return { catalog: emptyCatalog(), warning: "FueliX catalog not loaded (invalid format)" }
  }
  const models: Record<string, CatalogEntry> = {}
  const dropped = { count: 0 }
  let invalid = 0
  for (const [id, entry] of Object.entries(raw.models)) {
    const clean = sanitizeEntry(entry, dropped)
    if (clean) models[id] = clean
    else invalid++
  }
  const catalog: Catalog = {
    version: 1,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    sources: Array.isArray(raw.sources) ? raw.sources.filter((item): item is string => typeof item === "string") : [],
    models,
  }
  const problems: string[] = []
  if (invalid > 0) problems.push(`${invalid} invalid entr${invalid === 1 ? "y" : "ies"} skipped`)
  if (dropped.count > 0) problems.push(`${dropped.count} invalid field${dropped.count === 1 ? "" : "s"} dropped`)
  return problems.length > 0 ? { catalog, warning: `FueliX catalog has problems: ${problems.join(", ")}` } : { catalog }
}
