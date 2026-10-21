import { describe, expect, test } from "bun:test"
import { buildReport, formatReport, isFailing } from "../../../scripts/lib/doctor-report.ts"
import { fixtureCatalog } from "./helpers.ts"

describe("doctor report", () => {
  test("reports live IDs missing from the catalog", async () => {
    const catalog = await fixtureCatalog(["alpha"])
    const report = buildReport(catalog, ["alpha", "zeta-new", "another-new"])
    expect(report.missingFromCatalog).toEqual(["another-new", "zeta-new"])
    expect(isFailing(report)).toBe(true)
  })

  test("reports listed IDs that are no longer live", async () => {
    const catalog = await fixtureCatalog(["alpha", "no-cost"])
    const report = buildReport(catalog, ["alpha"])
    expect(report.notLive).toEqual(["no-cost"])
    expect(report.missingFromCatalog).toEqual([])
  })

  test("reports chat gaps, rule routing, and price spread", async () => {
    const catalog = await fixtureCatalog(["alpha", "no-cost", "claude-brand-new"])
    const report = buildReport(catalog, ["alpha", "no-cost", "claude-brand-new"])
    expect(report.chatGaps).toEqual([
      { id: "claude-brand-new", missing: ["cost", "limit"] },
      { id: "no-cost", missing: ["cost", "limit"] },
    ])
    expect(report.ruleRouted.map((item) => item.id)).toEqual(["claude-brand-new", "no-cost"])
    expect(report.priceSpread).toEqual(["alpha"])
    expect(isFailing(report)).toBe(true)
  })

  test("passes when the catalog is complete", async () => {
    const catalog = await fixtureCatalog(["alpha", "beta"])
    const report = buildReport(catalog, ["alpha", "beta"])
    expect(report.missingFromCatalog).toEqual([])
    expect(report.chatGaps).toEqual([])
    expect(isFailing(report)).toBe(false)
  })

  test("formats every section", async () => {
    const catalog = await fixtureCatalog(["alpha", "no-cost"])
    const text = formatReport(buildReport(catalog, ["alpha", "no-cost", "new-one"]))
    for (const label of ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)"]) expect(text).toContain(label)
    expect(text).toContain("new-one")
    expect(text).toContain("no-cost (missing cost, limit)")
  })

  test("flags a title model that is not live, not in the catalog, or not active", async () => {
    const base = await fixtureCatalog(["alpha"])
    const catalog = {
      ...base,
      models: {
        ...base.models,
        "gpt-6-luna": { ...base.models.alpha!, provider: "fuelix-openai" as const, status: "active" as const },
        "claude-haiku-5-5": { ...base.models.alpha!, provider: "fuelix-anthropic" as const, status: "deprecated" as const },
      },
    }
    const report = buildReport(catalog, ["alpha", "gpt-6-luna", "claude-haiku-5-5"])
    expect(report.titleModels).toEqual([
      { provider: "fuelix-openai", id: "gpt-6-luna", problem: undefined },
      { provider: "fuelix-anthropic", id: "claude-haiku-5-5", problem: "status deprecated" },
      { provider: "fuelix", id: "gemini-3.1-flash-lite", problem: "not live" },
    ])
    expect(formatReport(report)).toContain("fuelix/gemini-3.1-flash-lite: not live")
    const notInCatalog = buildReport(base, ["alpha", "gemini-3.1-flash-lite"])
    expect(notInCatalog.titleModels.find((item) => item.id === "gemini-3.1-flash-lite")?.problem).toBe("not in the catalog")
  })
})
