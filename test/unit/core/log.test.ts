import { describe, expect, test } from "bun:test"
import { createLogger, createMemoryLogger, redact } from "../../../src/log.ts"

describe("redact", () => {
  test("masks values that look like FueliX or Cortex keys", () => {
    expect(redact("key sk-KZ0abcdefGHIJ end")).toBe("key sk-[redacted] end")
    expect(redact("ak_ is not matched but ak-12345678 is")).toBe("ak_ is not matched but ak-[redacted] is")
  })

  test("keeps ordinary text", () => {
    expect(redact("registered 108 models")).toBe("registered 108 models")
    expect(redact("task-runner sk-1")).toBe("task-runner sk-1")
  })
})

describe("createLogger", () => {
  test("formats level, message, and fields on one line", () => {
    const lines: string[] = []
    const log = createLogger({ sink: (line) => lines.push(line) })
    log.info("registered models", { count: 3, provider: "fuelix", skipped: undefined })
    expect(lines).toEqual(['[td-opencode-plugin] info registered models count=3 provider="fuelix"'])
  })

  test("drops debug lines unless debug is on", () => {
    const lines: string[] = []
    createLogger({ sink: (line) => lines.push(line) }).debug("hidden")
    createLogger({ debug: true, sink: (line) => lines.push(line) }).debug("shown")
    expect(lines).toEqual(["[td-opencode-plugin] debug shown"])
  })

  test("redacts secrets in messages and field values", () => {
    const log = createMemoryLogger()
    log.error("request failed for sk-test-not-a-real-key", { header: "Bearer sk-test-not-a-real-key" })
    expect(log.lines.join("\n")).not.toContain("sk-test-not-a-real-key")
    expect(log.lines[0]).toContain("sk-[redacted]")
  })

  test("never throws when the sink throws", () => {
    const log = createLogger({
      sink: () => {
        throw new Error("sink failed")
      },
    })
    expect(() => log.warn("message")).not.toThrow()
  })
})
