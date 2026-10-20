import { describe, expect, test } from "bun:test"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"

describe("loadCatalog", () => {
  test("loads the fixture", async () => {
    const { catalog, warning } = await loadCatalog(new URL("../../fixtures/fuelix/catalog.json", import.meta.url))
    expect(warning).toBeUndefined()
    expect(Object.keys(catalog.models)).toContain("gpt-6-luna")
  })

  test("a missing file gives an empty catalog and a warning", async () => {
    const { catalog, warning } = await loadCatalog(new URL("../../fixtures/fuelix/missing.json", import.meta.url))
    expect(catalog.models).toEqual({})
    expect(warning).toContain("not loaded")
  })

  test("an invalid file gives an empty catalog and a warning", async () => {
    const { catalog, warning } = await loadCatalog(new URL("./catalog.test.ts", import.meta.url))
    expect(catalog.models).toEqual({})
    expect(warning).toContain("not loaded")
  })
})

describe("loadCatalog field validation", () => {
  const load = () => loadCatalog(new URL("../../fixtures/fuelix/catalog-invalid-fields.json", import.meta.url))

  test("drops invalid fields, keeps the entries, and counts both in the warning", async () => {
    const { catalog, warning } = await load()
    expect(Object.keys(catalog.models).sort()).toEqual([
      "bad-cost", "bad-limit", "bad-modalities", "bad-tier-item", "bad-tiers", "good", "zero-output",
    ])
    // bad-limit, zero-output, bad-cost, bad-tiers, bad-tier-item, bad-modalities (2 fields)
    expect(warning).toBe("FueliX catalog has problems: 1 invalid entry skipped, 7 invalid fields dropped")
  })

  test("a valid entry is unchanged", async () => {
    const { catalog } = await load()
    expect(catalog.models.good).toMatchObject({
      limit: { context: 1000, output: 100 },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      costTiers: [{ contextOver: 500, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
      input: ["text"],
      output: ["text"],
    })
  })

  test("each invalid field is removed", async () => {
    const { catalog } = await load()
    expect(catalog.models["bad-limit"]!.limit).toBeUndefined()
    expect(catalog.models["bad-limit"]!.cost).toBeDefined()
    expect(catalog.models["zero-output"]!.limit).toBeUndefined()
    expect(catalog.models["bad-cost"]!.cost).toBeUndefined()
    expect(catalog.models["bad-cost"]!.limit).toBeDefined()
    expect(catalog.models["bad-tiers"]!.costTiers).toBeUndefined()
    expect(catalog.models["bad-tier-item"]!.costTiers).toBeUndefined()
    expect(catalog.models["bad-modalities"]!.input).toBeUndefined()
    expect(catalog.models["bad-modalities"]!.output).toBeUndefined()
  })
})

describe("loadCatalog on the shipped catalog", () => {
  test("loads data/fuelix-models.json without a warning", async () => {
    const { catalog, warning } = await loadCatalog()
    expect(warning).toBeUndefined()
    expect(Object.keys(catalog.models).length).toBeGreaterThan(50)
    // Non-chat models keep a limit with a 0 side.
    expect(catalog.models["text-embedding-3-small"]?.limit).toEqual({ context: 8191, output: 0 })
  })

  test("a chat model with output 0 loses its limit", async () => {
    const { catalog } = await loadCatalog(new URL("../../fixtures/fuelix/catalog-invalid-fields.json", import.meta.url))
    expect(catalog.models["zero-output"]!.limit).toBeUndefined()
  })
})
