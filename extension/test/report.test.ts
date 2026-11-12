import { describe, expect, test } from "bun:test"

import { matchesLocation, parseReport } from "../panel/report.ts"
import { baseReport, json, scenarios } from "./support/fixtures.ts"

describe("parseReport", () => {
  test("accepts every fixture", () => {
    for (const [name, report] of Object.entries(scenarios)) {
      const parsed = parseReport(json(report))
      expect(parsed.ok, name).toBe(true)
    }
  })

  test("rejects text that is not JSON", () => {
    expect(parseReport("{ half")).toEqual({ ok: false, problem: "malformed" })
  })

  test("rejects a report with a missing field", () => {
    const { configuration: _drop, ...rest } = baseReport()
    expect(parseReport(json(rest))).toEqual({ ok: false, problem: "malformed" })
  })

  test("rejects an unknown outcome", () => {
    const report = baseReport()
    const bad = { ...report, lastCheck: { ...report.lastCheck, outcome: "exploded" } }
    expect(parseReport(json(bad))).toEqual({ ok: false, problem: "malformed" })
  })

  test("rejects an invalid time", () => {
    expect(parseReport(json({ ...baseReport(), recordedAt: "yesterday-ish" }))).toEqual({ ok: false, problem: "malformed" })
  })

  test("reports another schema version as unsupported", () => {
    expect(parseReport(json({ ...baseReport(), version: 2 }))).toEqual({ ok: false, problem: "unsupported", version: "2" })
  })

  test("treats a report without a version as malformed", () => {
    const { version: _drop, ...rest } = baseReport()
    expect(parseReport(json(rest))).toEqual({ ok: false, problem: "malformed" })
  })

  test("keeps every model ID and long text as written", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `model-${i}-${"x".repeat(40)}`)
    const report = baseReport()
    const parsed = parseReport(json({ ...report, lastChange: { at: report.recordedAt, added: ids, removed: [] } }))
    expect(parsed.ok && parsed.report.lastChange?.added).toEqual(ids)
  })
})

describe("matchesLocation", () => {
  test("exact match", () => {
    expect(matchesLocation("/work/a", "/work/a")).toBe(true)
    expect(matchesLocation(null, null)).toBe(true)
  })

  test("a different path is a mismatch", () => {
    expect(matchesLocation("/work/a", "/work/b")).toBe(false)
    expect(matchesLocation(null, "/work/a")).toBe(false)
    expect(matchesLocation("/work/a", null)).toBe(false)
  })

  test("a redacted part matches any text", () => {
    expect(matchesLocation("/work/[redacted]/app", "/work/sk-test-not-a-real-key/app")).toBe(true)
    expect(matchesLocation("[redacted]", "/anything")).toBe(true)
    expect(matchesLocation("/work/[redacted]/app", "/other/x/app")).toBe(false)
  })

  test("regex characters in the path are literal", () => {
    expect(matchesLocation("/work/a.b/[redacted]", "/work/aXb/c")).toBe(false)
    expect(matchesLocation("/work/(a)/[redacted]", "/work/(a)/c")).toBe(true)
  })
})
