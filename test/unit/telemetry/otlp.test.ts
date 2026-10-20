import { describe, expect, test } from "bun:test"
import { buildOtlpPayload, encodeAttribute } from "../../../src/telemetry/otlp.ts"
import { msToUnixNano } from "../../../src/telemetry/types.ts"
import type { TelemetryRecord } from "../../../src/telemetry/types.ts"

describe("otlp encoding", () => {
  test("strings, ints, doubles, booleans", () => {
    expect(encodeAttribute("a", "x")).toEqual({ key: "a", value: { stringValue: "x" } })
    expect(encodeAttribute("input_tokens", 1500)).toEqual({ key: "input_tokens", value: { intValue: "1500" } })
    expect(encodeAttribute("ratio", 0.25)).toEqual({ key: "ratio", value: { doubleValue: 0.25 } })
    expect(encodeAttribute("flag", true)).toEqual({ key: "flag", value: { stringValue: "true" } })
    expect(encodeAttribute("flag", false)).toEqual({ key: "flag", value: { stringValue: "false" } })
  })

  test("cost_usd is always a double", () => {
    expect(encodeAttribute("cost_usd", 0)).toEqual({ key: "cost_usd", value: { doubleValue: 0 } })
    expect(encodeAttribute("cost_usd", 2)).toEqual({ key: "cost_usd", value: { doubleValue: 2 } })
    expect(encodeAttribute("cost_usd", 0.0123)).toEqual({ key: "cost_usd", value: { doubleValue: 0.0123 } })
  })

  test("a non-finite number is dropped", () => {
    expect(encodeAttribute("x", Number.NaN)).toBeUndefined()
    expect(encodeAttribute("x", Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test("payload shape", () => {
    const record: TelemetryRecord = {
      eventName: "tool_result",
      sessionID: "ses_1",
      timeUnixNano: msToUnixNano(1_700_000_000_123),
      attributes: { tool_name: "Task", duration_ms: 12, success: "true" },
    }
    const payload = buildOtlpPayload([record], { serviceVersion: "9.9.9", observedMs: 1_700_000_001_000 })
    const resource = payload.resourceLogs[0]
    expect(resource?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "td-opencode-plugin" } },
      { key: "service.version", value: { stringValue: "9.9.9" } },
    ])
    expect(resource?.scopeLogs[0]?.scope).toEqual({ name: "td-opencode-plugin" })
    const log = resource?.scopeLogs[0]?.logRecords[0]
    expect(log?.timeUnixNano).toBe("1700000000123000000")
    expect(log?.observedTimeUnixNano).toBe("1700000001000000000")
    expect(log?.attributes).toEqual([
      { key: "session.id", value: { stringValue: "ses_1" } },
      { key: "event.name", value: { stringValue: "tool_result" } },
      { key: "event.timestamp", value: { stringValue: "2023-11-14T22:13:20.123Z" } },
      { key: "td.session.kind", value: { stringValue: "work" } },
      { key: "tool_name", value: { stringValue: "Task" } },
      { key: "duration_ms", value: { intValue: "12" } },
      { key: "success", value: { stringValue: "true" } },
    ])
  })
})
