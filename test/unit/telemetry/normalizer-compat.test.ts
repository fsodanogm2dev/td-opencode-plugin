import { describe, expect, test } from "bun:test"
import { MIN_TD_TELEMETRY, readTdTelemetryVersion, tdTelemetryVersionSupported } from "../../../src/telemetry/locate.ts"
import { buildOtlpPayload } from "../../../src/telemetry/otlp.ts"
import type { TelemetryRecord } from "../../../src/telemetry/types.ts"
import { runFixture } from "./helpers.ts"

/**
 * Runs td-telemetry's own normalizer on the emitted payloads. Set `TD_TELEMETRY_REF` to a read-only clone of
 * `willowtreeapps/td-telemetry` at version `MIN_TD_TELEMETRY` or later. The test is skipped when the variable is unset.
 */
const ref = process.env.TD_TELEMETRY_REF
const refVersion = ref ? await readTdTelemetryVersion(ref) : undefined

interface Decoded {
  type: string
  sessionId: string
  ts: number
  attrs: Record<string, any>
  kind?: string
}

describe.skipIf(!ref)("td-telemetry normalizer compatibility", () => {
  async function decode(records: readonly TelemetryRecord[]): Promise<{ records: Decoded[]; malformed: boolean }> {
    if (!tdTelemetryVersionSupported(refVersion)) {
      throw new Error(`td-telemetry at TD_TELEMETRY_REF is ${refVersion ?? "unknown"}; need >= ${MIN_TD_TELEMETRY}`)
    }
    const mod = (await import(`${ref}/lib/otel-normalize.mjs`)) as {
      decodeOtlpLogs(payload: unknown): { records: Decoded[]; malformed: boolean }
    }
    const payload = buildOtlpPayload(records, { serviceVersion: "0.1.0", observedMs: 1_700_000_000_000 })
    return mod.decodeOtlpLogs(JSON.parse(JSON.stringify(payload)))
  }

  test("root turn decodes into the expected record types and fields", async () => {
    const emitted = runFixture("root-turn.json")
    const { records, malformed } = await decode(emitted)
    expect(malformed).toBe(false)
    expect(records).toHaveLength(emitted.length)
    expect(records.map((record) => record.type)).toEqual([
      "user_prompt",
      "tool_decision",
      "tool_result",
      "tool_decision",
      "tool_result",
      "api_request",
      "skill_activated",
      "api_request",
    ])
    expect(records.every((record) => record.kind === "work" && record.sessionId === "ses_root")).toBe(true)
    expect(records[0]?.ts).toBe(2000)

    const first = records[5]
    expect(first?.attrs).toEqual({
      costUsd: 0.0123,
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
      model: "claude-sonnet-5-5",
      agentName: "build",
      querySource: "repl_main_thread",
      promptId: "msg_user1",
    })
    expect(records[7]?.attrs.costUsd).toBe(0.5)

    expect(records[2]?.attrs).toEqual({ toolName: "read", durationMs: 100, success: true, toolUseId: "call_1", promptId: "msg_user1" })
    expect(records[0]?.attrs).toEqual({ promptId: "msg_user1", eventSequence: 1 })
    expect(records[3]?.attrs).toEqual({ toolUseId: "call_2", promptId: "msg_user1", decision: "accept", source: "user_permanent", toolName: "bash" })
    expect(records[6]?.attrs).toEqual({ skillName: "brainstorm", skillSource: "opencode", promptId: "msg_user1" })
  })

  test("a failed tool decodes as success false", async () => {
    const { records } = await decode([
      { eventName: "tool_result", sessionID: "ses_x", timeUnixNano: "1700000000000000000", attributes: { tool_name: "bash", duration_ms: 3, success: "false", tool_use_id: "c1" } },
    ])
    expect(records[0]?.attrs.success).toBe(false)
  })

  test("subagent activity decodes under the root with the agent query source and a Task result", async () => {
    const emitted = runFixture("subagent.json")
    const { records, malformed } = await decode(emitted)
    expect(malformed).toBe(false)
    expect(records).toHaveLength(emitted.length)
    expect(new Set(records.map((record) => record.sessionId))).toEqual(new Set(["ses_root"]))
    const child = records.find((record) => record.type === "api_request" && record.attrs.querySource?.startsWith("agent:"))
    expect(child?.attrs.querySource).toBe("agent:builtin:explorer")
    expect(child?.attrs.costUsd).toBe(0.002)
    const task = records.find((record) => record.type === "tool_result" && record.attrs.toolName === "Task")
    expect(task?.attrs.success).toBe(true)
    const completed = records.find((record) => record.type === "subagent_completed")
    expect(completed?.attrs).toEqual({
      agentType: "explorer",
      agentSource: "opencode",
      isBuiltIn: false,
      isAsync: false,
      totalTokens: 590,
      totalToolUses: 1,
      durationMs: 670,
      model: "claude-haiku-5",
      finalModel: "claude-haiku-5",
      modelSwapped: false,
      eventSequence: 2,
    })
  })

  test("a failed step with partial cost decodes", async () => {
    const { records, malformed } = await decode(runFixture("failed-step.json"))
    expect(malformed).toBe(false)
    const request = records.filter((record) => record.type === "api_request")
    expect(request).toHaveLength(1)
    expect(request[0]?.attrs.costUsd).toBe(0.004)
    expect(request[0]?.attrs.inputTokens).toBe(800)
  })
})
