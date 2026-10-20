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

function validEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false
  if (!FUELIX_PROVIDER_IDS.includes(value.provider as never)) return false
  if (typeof value.kind !== "string" || typeof value.name !== "string") return false
  return true
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
  let invalid = 0
  for (const [id, entry] of Object.entries(raw.models)) {
    if (validEntry(entry)) models[id] = entry
    else invalid++
  }
  const catalog: Catalog = {
    version: 1,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    sources: Array.isArray(raw.sources) ? raw.sources.filter((item): item is string => typeof item === "string") : [],
    models,
  }
  return invalid > 0
    ? { catalog, warning: `FueliX catalog has ${invalid} invalid entr${invalid === 1 ? "y" : "ies"}; they are skipped` }
    : { catalog }
}
