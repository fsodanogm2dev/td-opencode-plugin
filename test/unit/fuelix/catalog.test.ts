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
