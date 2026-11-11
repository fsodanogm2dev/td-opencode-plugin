import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Catalog, CatalogEntry } from "../../../src/fuelix/catalog-types.ts"
import { buildModelInfo } from "../../../src/fuelix/models.ts"

// The shipped catalog, not a fixture.
const shipped = JSON.parse(readFileSync(new URL("../../../data/fuelix-models.json", import.meta.url), "utf8")) as Catalog

const SOL_IDS = ["gpt-6-sol", "gpt-6.0-sol", "gpt-6.1-sol"] as const

describe("PDF input in the shipped catalog", () => {
  for (const id of SOL_IDS) {
    test(`${id} accepts text, image, and PDF input through buildModelInfo`, () => {
      const entry = shipped.models[id]
      expect(entry).toBeDefined()
      const { info } = buildModelInfo(entry!.provider, id, entry)
      expect([...info.capabilities.input].sort()).toEqual(["image", "pdf", "text"])
      expect(info.capabilities.output).toEqual(["text"])
      expect(info.capabilities.tools).toBe(true)
    })
  }

  test("an unknown model does not gain PDF input", () => {
    const { info } = buildModelInfo("fuelix-openai", "gpt-6-sol-unknown-variant", shipped.models["gpt-6-sol-unknown-variant"])
    expect(shipped.models["gpt-6-sol-unknown-variant"]).toBeUndefined()
    expect(info.capabilities.input).toEqual(["text"])
  })

  test("a catalog entry without PDF in its input does not gain PDF", () => {
    const entry: CatalogEntry = { ...shipped.models["gpt-6-sol"]!, input: ["text"] }
    const { info } = buildModelInfo("fuelix-openai", "gpt-6-sol", entry)
    expect(info.capabilities.input).toEqual(["text"])
  })

  test("shipped embedding models do not gain PDF", () => {
    const embeddings = Object.entries(shipped.models).filter(([id]) => id.includes("embedding"))
    expect(embeddings.length).toBeGreaterThan(0)
    for (const [id, entry] of embeddings) {
      const { info } = buildModelInfo(entry.provider, id, entry)
      expect(info.capabilities.input).not.toContain("pdf")
    }
  })

  test("shipped text-only models do not gain PDF", () => {
    const textOnly = Object.entries(shipped.models).filter(
      ([, entry]) => entry.input !== undefined && !entry.input.includes("image") && !entry.input.includes("pdf"),
    )
    expect(textOnly.length).toBeGreaterThan(0)
    for (const [id, entry] of textOnly) {
      const { info } = buildModelInfo(entry.provider, id, entry)
      expect(info.capabilities.input).toEqual([...entry.input!])
      expect(info.capabilities.input).not.toContain("pdf")
    }
  })
})
