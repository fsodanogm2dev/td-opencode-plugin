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

describe("parseReport: modelHistory", () => {
  const parse = (modelHistory: unknown) => {
    const parsed = parseReport(json({ ...baseReport(), modelHistory }))
    if (!parsed.ok) throw new Error("the whole report must stay readable")
    return parsed.report
  }
  const valid = scenarios.history.modelHistory!

  test("an old report without the field reads normally, with no history and no problem", () => {
    const parsed = parseReport(json(baseReport()))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect("modelHistory" in parsed.report).toBe(false)
    expect(parsed.report.modelHistoryProblem).toBeUndefined()
  })

  test("null stays null", () => {
    const report = parse(null)
    expect(report.modelHistory).toBeNull()
    expect(report.modelHistoryProblem).toBeUndefined()
  })

  test("valid history keeps every entry and ID", () => {
    expect(parse(valid).modelHistory).toEqual(valid)
  })

  test("a file cannot set the parser's problem flag", () => {
    const parsed = parseReport(json({ ...baseReport(), modelHistory: valid, modelHistoryProblem: { field: "x" } }))
    expect(parsed.ok && parsed.report.modelHistoryProblem).toBeUndefined()
  })

  const entry = valid.entries[0]!
  const damaged: Array<[string, unknown, string]> = [
    ["not an object", "yesterday", "modelHistory"],
    ["entries missing", { since: valid.since, truncated: false }, "modelHistory.entries"],
    ["bad since", { ...valid, since: "long ago" }, "modelHistory.since"],
    ["truncated not boolean", { ...valid, truncated: "yes" }, "modelHistory.truncated"],
    ["unknown kind", { ...valid, entries: [{ ...entry, kind: "rumor" }] }, "modelHistory.entries[0].kind"],
    ["bad fetchedAt", { ...valid, entries: [{ ...entry, fetchedAt: "today" }] }, "modelHistory.entries[0].fetchedAt"],
    ["unknown source", { ...valid, entries: [{ ...entry, source: "announcement" }] }, "modelHistory.entries[0].source"],
    ["count as text", { ...valid, entries: [{ ...entry, totalIDs: "41" }] }, "modelHistory.entries[0].totalIDs"],
    ["fractional count", { ...valid, entries: [{ ...entry, eligible: 2.5 }] }, "modelHistory.entries[0].eligible"],
    ["negative count", { ...valid, entries: [{ ...entry, eligible: -1 }] }, "modelHistory.entries[0].eligible"],
    ["eligible above total", { ...valid, entries: [{ ...entry, eligible: 99, totalIDs: 41 }] }, "modelHistory.entries[0].eligible"],
    ["ID that is not text", { ...valid, entries: [entry, { ...entry, added: ["ok", 7] }] }, "modelHistory.entries[1].added[1]"],
    ["baseline with changes", { ...valid, entries: [{ ...entry, kind: "baseline" }] }, "modelHistory.entries[0].added"],
    ["more than 50 entries", { ...valid, entries: Array.from({ length: 51 }, () => entry) }, "modelHistory.entries"],
  ]
  for (const [name, value, field] of damaged) {
    test(`damaged history (${name}) is marked unreadable; the rest of the report stays`, () => {
      const report = parse(value)
      expect(report.modelHistory).toBeUndefined()
      expect(report.modelHistoryProblem).toEqual({ field })
      expect(report.lastCheck?.outcome).toBe("unchanged")
      expect(report.models.providers).toHaveLength(3)
    })
  }

  test("a damaged main field still rejects the whole report, even with valid history", () => {
    expect(parseReport(json({ ...baseReport(), recordedAt: "nope", modelHistory: valid }))).toEqual({
      ok: false,
      problem: "malformed",
    })
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
