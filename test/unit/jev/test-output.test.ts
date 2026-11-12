import { describe, expect, test } from "bun:test"
import { redactText } from "../../../src/jev/redact.ts"
import { buildSummary, createTestOutputHandler, looksLikeFailure, selectExcerpt, excerptSample, type ToolAfterEvent } from "../../../src/jev/points/test-output.ts"
import { createTaskTracker, type JevDecideRequest, type JevPointRuntime } from "../../../src/jev/runtime.ts"
import type { JevTelemetryEvent } from "../../../src/jev/telemetry.ts"
import type { JevOutcome } from "../../../src/jev/types.ts"

const options = (extra: Record<string, unknown> = {}) => ({ mode: "enforce" as const, timeoutMs: 2500, maxRawLength: 1200, ...extra })

const classified = (choice = "assertion", flaky = 0.1): JevOutcome => ({
  ok: true,
  value: {
    model: "jev-1.14.0",
    requestedModel: "jev-1.14.0",
    answers: { error_type: { type: "choice", choice, confidence: 0.9 }, is_flaky: { type: "noul", noul: flaky } },
    cached: false,
    latencyMs: 7,
  },
})

function fakeRuntime(input: { decide?: (r: JevDecideRequest) => JevOutcome | Promise<JevOutcome>; secrets?: string[]; writeLog?: (s: string, c: string, text: string) => Promise<string> } = {}) {
  const requests: JevDecideRequest[] = []
  const records: JevTelemetryEvent[] = []
  const logs: Array<{ sessionID: string; callID: string; text: string }> = []
  const state = { disposed: false }
  const runtime: JevPointRuntime = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => 0,
    get disposed() {
      return state.disposed
    },
    async decide(request) {
      requests.push(request)
      return (input.decide ?? (() => classified()))(request)
    },
    secrets: async () => input.secrets ?? [],
    record: (event) => void records.push(event),
    writeLog: async (sessionID, callID, text) => {
      logs.push({ sessionID, callID, text })
      return input.writeLog ? input.writeLog(sessionID, callID, text) : `/private/jev/logs/${sessionID}/${callID}.log`
    },
    modelVariants: async () => undefined,
    tasks: createTaskTracker(4),
  }
  return { runtime, requests, records, logs, state }
}

const SECRET = "sk-test-not-a-real-key-0123456789"
const FAIL_LINE = "FAIL test/marker.test.ts > adds numbers"
const ASSERT_LINE = "AssertionError: expected 3 to be 4"

const padding = (name: string, n: number) => Array.from({ length: n }, () => `PASS test/${name}.test.ts > keeps spacing between the words of the line`)

/** A failing run that redaction leaves unchanged. */
function failingOutput(extra: string[] = []): string {
  return [
    "RUN v1.0.0 /work",
    ...padding("padding", 60),
    FAIL_LINE,
    ASSERT_LINE,
    "    at test/marker.test.ts:12:5",
    ...padding("more-padding", 40),
    ...extra,
    "Tests: 1 failed, 100 passed",
  ].join("\n")
}

/** A failing run that carries recognized secrets. */
function sensitiveOutput(): string {
  return failingOutput([`API_KEY=hunter2-not-a-real-password`, `using ${SECRET}`])
}

function shellEvent(text: string, extra: Partial<ToolAfterEvent> = {}): ToolAfterEvent {
  return {
    tool: "shell",
    sessionID: "ses_1",
    id: "call_1",
    status: "completed",
    result: {
      output: { exit: 1, truncated: false, output: text, status: "exited" },
      content: [
        { type: "text", text },
        { type: "text", text: "Exited with code 1" },
      ],
      metadata: { status: "exited", truncated: false, exit: 1 },
    },
    ...extra,
  }
}

describe("selectExcerpt", () => {
  test("keeps the failure region, drops pass lines around it, and keeps the summary tail", () => {
    const excerpt = selectExcerpt(failingOutput())
    expect(excerpt.regions.join("\n")).toContain(FAIL_LINE)
    expect(excerpt.regions.join("\n")).toContain(ASSERT_LINE)
    expect(excerpt.regions.join("\n")).not.toContain("PASS test/more-padding")
    expect(excerpt.regions.join("\n")).toContain("Tests: 1 failed")
    expect(excerpt.tail).not.toContain("PASS")
  })

  test("keeps informative lines after the last failure as the tail", () => {
    const excerpt = selectExcerpt(["FAIL a", "boom", ...padding("x", 30), "Ran 31 tests in 0.2s", "", "done"].join("\n"))
    expect(excerpt.tail).toBe("Ran 31 tests in 0.2s\ndone")
  })

  test("finds a failure in the middle of a long output", () => {
    const lines = [...Array.from({ length: 3000 }, (_, i) => `noise line ${i}`), "AssertionError: the real error", ...Array.from({ length: 3000 }, (_, i) => `more noise ${i}`)]
    const excerpt = selectExcerpt(lines.join("\n"))
    expect(excerpt.regions.join("\n")).toContain("the real error")
  })

  test("bounds the excerpt and counts omitted regions", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `FAIL test/${i}.test.ts ${"x".repeat(60)}\nplain line ${i}\nanother ${i}\n${".".repeat(1)}`)
    const excerpt = selectExcerpt(lines.join("\n"))
    expect(excerpt.omittedRegions).toBeGreaterThan(0)
    expect(excerptSample(excerpt).length).toBeLessThan(5000)
  })

  test("cuts very long lines", () => {
    const excerpt = selectExcerpt(`FAIL ${"x".repeat(5000)}`)
    expect(excerpt.regions[0]!.length).toBeLessThan(400)
  })
})

describe("looksLikeFailure", () => {
  test("detects test and build failures and ignores ordinary output", () => {
    expect(looksLikeFailure("FAIL a.test.ts")).toBe(true)
    expect(looksLikeFailure("error TS2322: bad")).toBe(true)
    expect(looksLikeFailure("npm ERR! code ELIFECYCLE")).toBe(true)
    expect(looksLikeFailure("error[E0382]: borrow")).toBe(true)
    expect(looksLikeFailure("Tests: 2 failed, 3 passed")).toBe(true)
    expect(looksLikeFailure("all good\nPASS a\nok b")).toBe(false)
    expect(looksLikeFailure("the file was not found")).toBe(false)
  })
})

describe("compression handler", () => {
  test("replaces the text with a shorter summary and keeps the other parts", async () => {
    const { runtime, requests, records, logs } = fakeRuntime({ secrets: [SECRET] })
    const text = failingOutput()
    expect(redactText(text, { secrets: [SECRET] })).toBe(text)
    const file = { type: "file", uri: "file:///tmp/a.png", mime: "image/png", name: "a.png" }
    const event = shellEvent(text)
    ;(event.result!.content as unknown[]).push(file)
    await createTestOutputHandler(runtime, options())(event)

    const content = event.result!.content as Array<Record<string, string>>
    const summary = content[0]!.text!
    expect(summary.length).toBeLessThan(text.length)
    expect(summary).toContain(FAIL_LINE)
    expect(summary).toContain(ASSERT_LINE)
    expect(summary).toContain("Classification: assertion (confidence 0.90)")
    expect(summary).toContain("Flaky probability: 0.10")
    expect(summary).toContain("/private/jev/logs/ses_1/call_1.log")
    expect(summary).not.toContain("PASS test/more-padding")
    expect(content[1]).toEqual({ type: "text", text: "Exited with code 1" })
    expect(content[2]).toEqual(file)
    expect(event.result!.metadata).toEqual({ status: "exited", truncated: false, exit: 1 })
    expect(event.result!.output).toEqual({ exit: 1, truncated: false, output: summary, status: "exited" })
    expect(JSON.stringify(event.result)).not.toContain("PASS test/more-padding")
    expect(logs).toEqual([{ sessionID: "ses_1", callID: "call_1", text }])
    expect(JSON.stringify(requests[0]!.state)).not.toContain(SECRET)
    expect(requests[0]!.timeoutMs).toBe(2500)
    expect(Object.keys(requests[0]!.questions)).toEqual(["error_type", "is_flaky"])
    expect(records[0]).toMatchObject({ point: "testCompression", applied: true, choice: "assertion", probability: 0.1, inputChars: text.length, outputChars: summary.length })
  })

  test("an output that redaction would change stays unchanged: no TypeSafe call, no log, applied false", async () => {
    const { runtime, requests, records, logs } = fakeRuntime({ secrets: [SECRET] })
    const text = sensitiveOutput()
    expect(redactText(text, { secrets: [SECRET] })).not.toBe(text)
    const event = shellEvent(text)
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(requests).toEqual([])
    expect(logs).toEqual([])
    expect(records).toEqual([{ point: "testCompression", mode: "enforce", sessionID: "ses_1", inputChars: text.length, applied: false }])
  })

  test("debugging facts that look like secrets stay in the output", async () => {
    const facts = [
      `AssertionError: expected token="abc123" to equal "def456"`,
      `  expected password_hash=$2b$10$abcdefghijklmnopqrstuv but received null`,
      `  apiKey: null`,
      `  apiKey: undefined`,
    ]
    for (const fact of facts) {
      const { runtime, requests, logs } = fakeRuntime()
      const text = failingOutput([fact])
      // Guard: redaction really would change this text.
      expect(redactText(text)).not.toBe(text)
      const event = shellEvent(text)
      await createTestOutputHandler(runtime, options())(event)
      expect((event.result!.content as Array<{ text: string }>)[0]!.text).toBe(text)
      expect((event.result!.output as { output: string }).output).toBe(text)
      expect(requests).toEqual([])
      expect(logs).toEqual([])
    }
  })

  test("shadow classifies the redacted excerpt of a sensitive output and persists nothing", async () => {
    const { runtime, requests, records, logs } = fakeRuntime({ secrets: [SECRET] })
    const text = sensitiveOutput()
    const event = shellEvent(text)
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options({ mode: "shadow" }))(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(logs).toEqual([])
    expect(requests.length).toBe(1)
    const sent = JSON.stringify(requests[0]!.state)
    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain("hunter2")
    expect(records[0]).toMatchObject({ mode: "shadow", applied: false, choice: "assertion" })
  })

  test("handles string content", async () => {
    const { runtime } = fakeRuntime()
    const text = failingOutput()
    const event: ToolAfterEvent = { tool: "shell", sessionID: "s", id: "c", status: "completed", result: { content: text, output: { exit: 1, output: text } } }
    await createTestOutputHandler(runtime, options())(event)
    expect(typeof event.result!.content).toBe("string")
    expect((event.result!.content as string).length).toBeLessThan(text.length)
    expect((event.result!.output as { output: string }).output).toBe(event.result!.content as string)
  })

  test("says when OpenCode had truncated the output, and does not claim a full log", async () => {
    const { runtime } = fakeRuntime()
    const event = shellEvent(failingOutput())
    ;(event.result!.output as { truncated: boolean }).truncated = true
    await createTestOutputHandler(runtime, options())(event)
    const summary = (event.result!.content as Array<{ text: string }>)[0]!.text
    expect(summary).toContain("already truncated")
    expect(summary).not.toContain("full raw")
  })

  const skipped: Array<[string, () => ToolAfterEvent, Record<string, unknown>?]> = [
    ["a short output", () => shellEvent("FAIL a.test.ts\nAssertionError: x")],
    ["a long output without a failure", () => shellEvent(Array.from({ length: 200 }, (_, i) => `line ${i} of build output`).join("\n"))],
    ["a successful exit", () => {
      const event = shellEvent(failingOutput())
      ;(event.result!.output as { exit: number }).exit = 0
      return event
    }],
    ["another tool", () => shellEvent(failingOutput(), { tool: "read" })],
    ["an error status", () => shellEvent(failingOutput(), { status: "error" })],
    ["no result", () => ({ tool: "shell", sessionID: "s", id: "c", status: "completed" })],
    ["content without text", () => ({ tool: "shell", sessionID: "s", id: "c", status: "completed", result: { content: [{ type: "file", uri: "x", mime: "y" }] } })],
  ]
  for (const [label, make] of skipped) {
    test(`leaves ${label} unchanged and sends nothing`, async () => {
      const { runtime, requests } = fakeRuntime()
      const event = make()
      const before = JSON.stringify(event)
      await createTestOutputHandler(runtime, options())(event)
      expect(JSON.stringify(event)).toBe(before)
      expect(requests).toEqual([])
    })
  }

  test("an exit code in the separate text part skips a successful run", async () => {
    const { runtime, requests } = fakeRuntime()
    const text = failingOutput()
    const event: ToolAfterEvent = { tool: "shell", sessionID: "s", id: "c", status: "completed", result: { content: [{ type: "text", text }, { type: "text", text: "Exited with code 0" }] } }
    await createTestOutputHandler(runtime, options())(event)
    expect(requests).toEqual([])
  })

  test("an upstream failure leaves the result unchanged and writes no log", async () => {
    const { runtime, records, logs } = fakeRuntime({ decide: () => ({ ok: false, error: { code: "http-error", status: 529 } }) })
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(logs).toEqual([])
    expect(records[0]).toMatchObject({ applied: false, errorCode: "http-error", status: 529 })
  })

  test("an invalid decision shape leaves the result unchanged", async () => {
    const { runtime } = fakeRuntime({ decide: () => ({ ok: true, value: { model: "m", requestedModel: "m", answers: {}, cached: false, latencyMs: 1 } }) })
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await expect(createTestOutputHandler(runtime, options())(event)).resolves.toBeUndefined()
    expect(JSON.stringify(event)).toBe(before)
  })

  test("a failed log write leaves the result unchanged", async () => {
    const { runtime, records } = fakeRuntime({
      writeLog: async () => {
        throw new Error("disk full")
      },
    })
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(records[0]).toMatchObject({ applied: false })
  })

  test("a summary that is not shorter leaves the result unchanged", async () => {
    const { runtime, records } = fakeRuntime()
    // Short enough to pass the threshold, and full of distinct failure lines so that the excerpt keeps most of it.
    const text = Array.from({ length: 12 }, (_, i) => `FAIL test/${i}.test.ts`).join("\n")
    const event = shellEvent(text)
    await createTestOutputHandler(runtime, options({ maxRawLength: 100 }))(event)
    expect((event.result!.content as Array<{ text: string }>)[0]!.text).toBe(text)
    expect(records.at(-1)).toMatchObject({ applied: false })
  })

  test("shadow asks and records, and changes and writes nothing", async () => {
    const { runtime, records, logs, requests } = fakeRuntime()
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options({ mode: "shadow" }))(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(logs).toEqual([])
    expect(requests.length).toBe(1)
    expect(records[0]).toMatchObject({ mode: "shadow", applied: false, choice: "assertion" })
  })

  test("a disposed runtime does nothing", async () => {
    const { runtime, requests, state } = fakeRuntime()
    state.disposed = true
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
    expect(requests).toEqual([])
  })

  test("a runtime that is disposed during the call leaves the result unchanged", async () => {
    const { runtime, state } = fakeRuntime({
      decide: () => {
        state.disposed = true
        return classified()
      },
    })
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
  })

  test("a log write that finishes after dispose does not change the result", async () => {
    const { runtime, state } = fakeRuntime({
      writeLog: async () => {
        state.disposed = true
        return "/private/jev/logs/x.log"
      },
    })
    const event = shellEvent(failingOutput())
    const before = JSON.stringify(event)
    await createTestOutputHandler(runtime, options())(event)
    expect(JSON.stringify(event)).toBe(before)
  })

  test("buildSummary keeps the classification, the path, and the excerpts", () => {
    const summary = buildSummary({ excerpt: { head: "head", regions: ["r1", "r2"], omittedRegions: 2, tail: "tail" }, originalChars: 9000, choice: "syntax", flaky: 0.5, logPath: "/p/x.log", truncatedByOpenCode: false })
    expect(summary).toContain("Classification: syntax")
    expect(summary).toContain("/p/x.log")
    expect(summary).toContain("2 further failure region(s)")
    expect(summary).toContain("head")
    expect(summary).toContain("tail")
  })
})
