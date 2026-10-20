import { describe, expect, test } from "bun:test"
import type { FuelixProviderID } from "../../../src/fuelix/catalog-types.ts"
import { resolveVariants } from "../../../src/fuelix/variants.ts"
import live from "../../fixtures/fuelix/variants-live-2.0.32.json"

describe("resolveVariants", () => {
  for (const item of live.cases) {
    test(`matches OpenCode 2.0.32 for ${item.providerID}/${item.modelID}`, () => {
      const variants = resolveVariants({
        providerID: item.providerID as FuelixProviderID,
        modelID: item.modelID,
        outputLimit: item.outputLimit,
      })
      expect(variants).toEqual(item.variants)
    })
  }

  test("returns no variants when reasoning is false", () => {
    expect(resolveVariants({ providerID: "fuelix", modelID: "gemini-3.5-flash", outputLimit: 65536, reasoning: false })).toEqual([])
  })

  test("reasoning true uses the default effort support", () => {
    const ids = resolveVariants({ providerID: "fuelix", modelID: "gemini-3.5-flash", outputLimit: 65536, reasoning: true }).map((v) => v.id)
    expect(ids).toEqual(["low", "medium", "high"])
  })

  test("manual-thinking Claude models derive budgets from the output limit", () => {
    const variants = resolveVariants({ providerID: "fuelix-anthropic", modelID: "claude-sonnet-4-5", outputLimit: 64000 })
    expect(variants.map((v) => [v.id, v.settings])).toEqual([
      ["high", { thinking: { type: "enabled", budgetTokens: 16000 } }],
      ["max", { thinking: { type: "enabled", budgetTokens: 31999 } }],
    ])
  })
})
