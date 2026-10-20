import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { Catalog } from "../../../src/fuelix/catalog-types.ts"
import { FORBIDDEN_SUBSTRINGS } from "../../../scripts/lib/build.ts"
import { FIXTURES } from "./helpers.ts"

const root = join(import.meta.dir, "../../..")
const text = await Bun.file(join(root, "data/fuelix-models.json")).text()
const catalog = JSON.parse(text) as Catalog
const liveIds = (await Bun.file(join(FIXTURES, "live-ids-2026-10-19.json")).json()) as string[]

/** Chat entries that have no cost or limit in the inventory or the routing seed. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  "gpt-6.0-sol":
    "The inventory deployment azure/gpt-6-sol-uswest has no context or output limit, and the routing seed lists no limit for this ID.",
}

describe("data/fuelix-models.json", () => {
  test("has the catalog envelope", () => {
    expect(catalog.version).toBe(1)
    expect(catalog.sources.length).toBeGreaterThan(0)
    expect(text.endsWith("}\n")).toBe(true)
  })

  test("models are sorted by ID", () => {
    const ids = Object.keys(catalog.models)
    expect(ids).toEqual([...ids].sort())
  })

  test("contains every live ID as a listed entry", () => {
    expect(liveIds.length).toBe(108)
    for (const id of liveIds) {
      expect(catalog.models[id], id).toBeDefined()
      expect(catalog.models[id]?.listed, id).toBe(true)
    }
  })

  test("contains no secret markers", () => {
    for (const word of FORBIDDEN_SUBSTRINGS) expect(text).not.toContain(word)
  })

  test("every chat entry has cost and limit, except known gaps", () => {
    for (const [id, reason] of Object.entries(KNOWN_GAPS)) console.log(`Known gap ${id}: ${reason}`)
    for (const [id, entry] of Object.entries(catalog.models)) {
      if (entry.kind !== "chat" || id in KNOWN_GAPS) continue
      expect(entry.cost, `${id} cost`).toBeDefined()
      expect(entry.limit, `${id} limit`).toBeDefined()
    }
  })

  test("known gaps are still gaps", () => {
    for (const id of Object.keys(KNOWN_GAPS)) {
      const entry = catalog.models[id]
      expect(entry && (!entry.cost || !entry.limit), `${id} is fixed. Remove it from KNOWN_GAPS.`).toBe(true)
    }
  })

  test("prices are non-negative and tiers ascend", () => {
    for (const [id, entry] of Object.entries(catalog.models)) {
      for (const value of Object.values(entry.cost ?? {})) expect(value, id).toBeGreaterThanOrEqual(0)
      const tiers = entry.costTiers ?? []
      expect(tiers.map((tier) => tier.contextOver), id).toEqual(tiers.map((tier) => tier.contextOver).sort((a, b) => a - b))
    }
  })
})
