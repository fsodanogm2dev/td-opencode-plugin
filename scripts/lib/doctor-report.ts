/** Pure doctor report: compare live IDs with the catalog. No I/O. */

import type { Catalog } from "../../src/fuelix/catalog-types.ts"
import { TITLE_MODELS } from "../../src/fuelix/rules.ts"

export interface DoctorReport {
  /** (a) Live IDs that the catalog does not contain. */
  readonly missingFromCatalog: readonly string[]
  /** (b) Catalog IDs marked `listed` that are not live any more. */
  readonly notLive: readonly string[]
  /** (c) Chat entries without cost or limit. */
  readonly chatGaps: readonly { readonly id: string; readonly missing: readonly string[] }[]
  /** (d) Entries routed by rule, not by the config seed. */
  readonly ruleRouted: readonly { readonly id: string; readonly provider: string }[]
  /** (e) Entries with a price-spread note. */
  readonly priceSpread: readonly string[]
  /** (f) Title models (`TITLE_MODELS`) that are missing from the live list or the catalog, or not active. */
  readonly titleModels: readonly { readonly provider: string; readonly id: string; readonly problem: string | undefined }[]
}

export function buildReport(catalog: Catalog, liveIds: readonly string[]): DoctorReport {
  const live = new Set(liveIds)
  const entries = Object.entries(catalog.models)
  return {
    missingFromCatalog: [...live].filter((id) => !(id in catalog.models)).sort(),
    notLive: entries.filter(([id, entry]) => entry.listed === true && !live.has(id)).map(([id]) => id),
    chatGaps: entries
      .filter(([, entry]) => entry.kind === "chat" && (!entry.cost || !entry.limit))
      .map(([id, entry]) => ({
        id,
        missing: [...(entry.cost ? [] : ["cost"]), ...(entry.limit ? [] : ["limit"])],
      })),
    ruleRouted: entries
      .filter(([, entry]) => entry.sources.routing === "rule")
      .map(([id, entry]) => ({ id, provider: entry.provider })),
    priceSpread: entries
      .filter(([, entry]) => entry.notes?.some((note) => note.startsWith("Price spread")))
      .map(([id]) => id),
    titleModels: Object.entries(TITLE_MODELS).map(([provider, { modelID }]) => {
      const status = catalog.models[modelID]?.status ?? (modelID in catalog.models ? "active" : undefined)
      const problem = !live.has(modelID)
        ? "not live"
        : status === undefined
          ? "not in the catalog"
          : status !== "active"
            ? `status ${status}`
            : undefined
      return { provider, id: modelID, problem }
    }),
  }
}

/** `--strict` fails when (a) or (c) is not empty. */
export function isFailing(report: DoctorReport): boolean {
  return report.missingFromCatalog.length > 0 || report.chatGaps.length > 0
}

export function formatReport(report: DoctorReport): string {
  const section = (title: string, items: readonly string[]) =>
    [`${title}: ${items.length}`, ...items.map((item) => `  ${item}`)].join("\n")
  return [
    section("(a) Live IDs missing from the catalog", report.missingFromCatalog),
    section("(b) Listed catalog IDs no longer live", report.notLive),
    section(
      "(c) Chat entries without cost or limit",
      report.chatGaps.map((item) => `${item.id} (missing ${item.missing.join(", ")})`),
    ),
    section(
      "(d) Entries routed by rule",
      report.ruleRouted.map((item) => `${item.id} -> ${item.provider}`),
    ),
    section("(e) Entries with price-spread notes", report.priceSpread),
    section(
      "(f) Title models",
      report.titleModels.map((item) => `${item.provider}/${item.id}: ${item.problem ?? "ok"}`),
    ),
  ].join("\n")
}
