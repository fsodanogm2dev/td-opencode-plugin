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
    for (const label of ["(a)", "(b)", "(c)", "(d)", "(e)"]) expect(text).toContain(label)
    expect(text).toContain("new-one")
    expect(text).toContain("no-cost (missing cost, limit)")
  })
})
