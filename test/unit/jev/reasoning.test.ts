import { describe, expect, test } from "bun:test"
import { createReasoningHandler, levelOf, pickVariant } from "../../../src/jev/points/reasoning.ts"
import { createTaskTracker, type JevDecideRequest, type JevPointRuntime } from "../../../src/jev/runtime.ts"
import type { JevTelemetryEvent } from "../../../src/jev/telemetry.ts"
import type { JevOutcome } from "../../../src/jev/types.ts"

const options = (extra: Record<string, unknown> = {}) => ({ mode: "shadow" as const, timeoutMs: 800, ...extra })

const scored = (score: number): JevOutcome => ({
  ok: true,
  value: { model: "jev-1.14.0", requestedModel: "jev-1.14.0", answers: { reasoning_depth: { type: "score", score } }, cached: false, latencyMs: 3 },
})

function fakeRuntime(input: { decide?: (r: JevDecideRequest) => JevOutcome | Promise<JevOutcome>; variants?: readonly string[] | undefined; secrets?: string[]; taskLimit?: number } = {}) {
  const requests: JevDecideRequest[] = []
  const records: JevTelemetryEvent[] = []
  const variantCalls: unknown[] = []
  const state = { disposed: false }
  const runtime: JevPointRuntime = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => 0,
    get disposed() {
      return state.disposed
    },
    async decide(request) {
      requests.push(request)
      return (input.decide ?? (() => scored(2)))(request)
    },
    secrets: async () => input.secrets ?? [],
    record: (event) => void records.push(event),
    writeLog: async () => {
      throw new Error("unused")
    },
    modelVariants: async (model) => {
      variantCalls.push(model)
      return "variants" in input ? input.variants : ["low", "medium", "high"]
    },
    tasks: createTaskTracker(input.taskLimit ?? 4),
  }
  return { runtime, requests, records, variantCalls, state }
}

const settle = async (runtime: JevPointRuntime) => {
  for (let i = 0; i < 100 && runtime.tasks.size > 0; i++) await Bun.sleep(2)
}

const contextEvent = (text: string, extra: Record<string, unknown> = {}, id: string | null = "msg_1") => ({
  sessionID: "ses_1",
  model: { providerID: "fuelix-anthropic", id: "claude", ...extra },
  system: [{ type: "text", text: "system" }],
  messages: [{ ...(id === null ? {} : { id }), role: "user", content: [{ type: "text", text }] }],
})

describe("variant choice", () => {
  test("rounds scores into four levels", () => {
    expect([-1, 0, 0.4, 0.6, 1.5, 2.4, 3, 9].map(levelOf)).toEqual([0, 0, 0, 1, 2, 2, 3, 3])
  })

  test("takes the exact variant", () => {
    expect(pickVariant(0, ["low", "medium", "high", "max"])).toBe("low")
    expect(pickVariant(3, ["low", "medium", "high", "max"])).toBe("max")
  })

  test("takes the nearest supported variant, the lower one on a tie", () => {
    expect(pickVariant(3, ["low", "medium", "high"])).toBe("high")
    expect(pickVariant(0, ["medium", "high"])).toBe("medium")
    expect(pickVariant(1, ["low", "high"])).toBe("low")
    expect(pickVariant(2, ["low", "max"])).toBe("max")
  })

  test("returns nothing without a supported variant", () => {
    expect(pickVariant(1, undefined)).toBeUndefined()
    expect(pickVariant(1, [])).toBeUndefined()
    expect(pickVariant(1, ["minimal", "xhigh"])).toBeUndefined()
  })
})

describe("reasoning handler (shadow)", () => {
  test("scores the request, picks a real variant, and records", async () => {
    const { runtime, requests, records, variantCalls } = fakeRuntime({ decide: () => scored(3) })
    createReasoningHandler(runtime, options())(contextEvent("design a distributed lock service"))
    await settle(runtime)
    expect(requests[0]!.state).toBe("design a distributed lock service")
    expect(Object.keys(requests[0]!.questions)).toEqual(["reasoning_depth"])
    expect(variantCalls).toEqual([{ providerID: "fuelix-anthropic", id: "claude" }])
    expect(records).toEqual([
      {
        point: "reasoningBudget",
        mode: "shadow",
        sessionID: "ses_1",
        model: "jev-1.14.0",
        score: 3,
        choice: "high",
        applied: false,
        cached: false,
        latencyMs: 3,
        inputChars: "design a distributed lock service".length,
      },
    ])
  })

  test("records the score without a choice when the variants are unknown", async () => {
    const { runtime, records } = fakeRuntime({ variants: undefined })
    createReasoningHandler(runtime, options())(contextEvent("do something moderately hard"))
    await settle(runtime)
    expect(records[0]!.score).toBe(2)
    expect("choice" in records[0]!).toBe(false)
  })

  test("a model known to have no variants makes no upstream call", async () => {
    const { runtime, requests, records } = fakeRuntime({ variants: [] })
    createReasoningHandler(runtime, options())(contextEvent("do something moderately hard"))
    await settle(runtime)
    expect(requests).toEqual([])
    expect(records).toEqual([])
  })

  test("an explicit variant is skipped, the default one is not", async () => {
    const { runtime, requests } = fakeRuntime()
    const handler = createReasoningHandler(runtime, options())
    handler(contextEvent("do something moderately hard", { variant: "high" }, "a"))
    await settle(runtime)
    expect(requests).toEqual([])
    handler(contextEvent("do something moderately hard", { variant: "default" }, "b"))
    await settle(runtime)
    expect(requests.length).toBe(1)
  })

  test("skips short requests, off mode, and a missing user message", async () => {
    const { runtime, requests } = fakeRuntime()
    createReasoningHandler(runtime, options())(contextEvent("hi"))
    createReasoningHandler(runtime, options({ mode: "off" }))(contextEvent("a long enough request"))
    createReasoningHandler(runtime, options())({ ...contextEvent("a long enough request"), messages: [] })
    await settle(runtime)
    expect(requests).toEqual([])
  })

  test("evaluates once per latest user message, and again for a new one", async () => {
    const { runtime, requests } = fakeRuntime()
    const handler = createReasoningHandler(runtime, options())
    const event = contextEvent("a long enough request")
    handler(event)
    handler(event)
    handler(event)
    await settle(runtime)
    expect(requests.length).toBe(1)
    handler(contextEvent("another long request", {}, "msg_2"))
    await settle(runtime)
    expect(requests.length).toBe(2)
  })

  test("never edits the event", async () => {
    const { runtime } = fakeRuntime()
    const event = contextEvent("a long enough request")
    const before = JSON.stringify(event)
    createReasoningHandler(runtime, options())(event)
    await settle(runtime)
    expect(JSON.stringify(event)).toBe(before)
  })

  test("bounds the request text", async () => {
    const { runtime, requests } = fakeRuntime()
    createReasoningHandler(runtime, options())(contextEvent("x".repeat(10_000)))
    await settle(runtime)
    expect((requests[0]!.state as string).length).toBe(2000)
  })

  test("an opaque active key that crosses the 2000 character cap is redacted before the cap", async () => {
    const key = "ts-opaque-key-0123456789abcdefghijklmnop"
    const text = `${"a ".repeat(992)}${key} tail`
    const { runtime, requests } = fakeRuntime({ secrets: [key] })
    createReasoningHandler(runtime, options())(contextEvent(text))
    await settle(runtime)
    const sent = requests[0]!.state as string
    expect(sent).toContain("[REDACTED]")
    expect(sent).not.toContain("ts-opaque")
    expect(sent.length).toBeLessThanOrEqual(2000)
  })

  test("a quoted assignment that straddles the cap is redacted whole", async () => {
    const text = `${"a ".repeat(985)} password = "correct horse battery staple extra words" done`
    const { runtime, requests } = fakeRuntime()
    createReasoningHandler(runtime, options())(contextEvent(text))
    await settle(runtime)
    expect(requests[0]!.state as string).not.toContain("correct")
    expect(requests[0]!.state as string).not.toContain("horse")
  })

  test("a task that capacity rejects does not mark the request as seen", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { runtime, requests } = fakeRuntime({
      taskLimit: 1,
      decide: async () => {
        await gate
        return scored(1)
      },
    })
    const handler = createReasoningHandler(runtime, options())
    handler({ ...contextEvent("a long enough request", {}, "m1"), sessionID: "a" })
    handler({ ...contextEvent("a long enough request", {}, "m1"), sessionID: "b" })
    await Bun.sleep(3)
    expect(requests.length).toBe(1)
    release()
    await settle(runtime)
    handler({ ...contextEvent("a long enough request", {}, "m1"), sessionID: "b" })
    await settle(runtime)
    expect(requests.length).toBe(2)
  })

  test("a result for an older request is dropped", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const { runtime, records } = fakeRuntime({
      decide: async () => {
        const wait = first
        first = false
        if (wait) await gate
        return scored(1)
      },
    })
    const handler = createReasoningHandler(runtime, options())
    handler(contextEvent("old long request", {}, "m1"))
    await Bun.sleep(3)
    handler(contextEvent("new long request", {}, "m2"))
    await Bun.sleep(3)
    release()
    await settle(runtime)
    expect(records.length).toBe(1)
    expect(records[0]!.inputChars).toBe("new long request".length)
  })

  test("a failure records the error code only", async () => {
    const { runtime, records } = fakeRuntime({ decide: () => ({ ok: false, error: { code: "http-error", status: 500 } }) })
    createReasoningHandler(runtime, options())(contextEvent("a long enough request"))
    await settle(runtime)
    expect(records).toEqual([{ point: "reasoningBudget", mode: "shadow", sessionID: "ses_1", applied: false, errorCode: "http-error", status: 500 }])
  })

  test("returns before the call finishes and records nothing after dispose", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { runtime, records, state } = fakeRuntime({
      decide: async () => {
        await gate
        return scored(1)
      },
    })
    createReasoningHandler(runtime, options())(contextEvent("a long enough request"))
    await Bun.sleep(2)
    expect(runtime.tasks.size).toBe(1)
    state.disposed = true
    release()
    await settle(runtime)
    expect(records).toEqual([])
  })
})
