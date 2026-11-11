import { describe, expect, test } from "bun:test"
import { BatchRequestError, parseBatchRequests } from "../../../src/fuelix/batch/requests.ts"

const req = (id: string, extra: Record<string, unknown> = {}) => ({
  custom_id: id,
  params: { model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...extra },
})

describe("parseBatchRequests", () => {
  test("accepts native, array, and JSONL input", () => {
    const items = [req("a"), req("b")]
    expect(parseBatchRequests(JSON.stringify({ requests: items })).map((r) => r.custom_id)).toEqual(["a", "b"])
    expect(parseBatchRequests(JSON.stringify(items)).map((r) => r.custom_id)).toEqual(["a", "b"])
    expect(parseBatchRequests(items.map((i) => JSON.stringify(i)).join("\n") + "\n").map((r) => r.custom_id)).toEqual(["a", "b"])
    expect(parseBatchRequests(JSON.stringify(req("solo")))).toHaveLength(1)
  })

  test("strips only the fuelix-anthropic prefix and keeps extension params", () => {
    const [r] = parseBatchRequests(
      JSON.stringify([req("a", { model: "fuelix-anthropic/claude-haiku-5-5", system: "s", thinking: { type: "enabled", budget_tokens: 1024 } })]),
    )
    expect(r!.params.model).toBe("claude-haiku-5-5")
    expect(r!.params.system).toBe("s")
    expect(r!.params.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(() => parseBatchRequests(JSON.stringify([req("a", { model: "fuelix-openai/gpt-5" })]))).toThrow(BatchRequestError)
    expect(() => parseBatchRequests(JSON.stringify([req("a", { model: "openai/gpt-5" })]))).toThrow(BatchRequestError)
    expect(() => parseBatchRequests(JSON.stringify([req("a", { model: "" })]))).toThrow(BatchRequestError)
  })

  test("rejects invalid structure", () => {
    const bad = (value: unknown) => expect(() => parseBatchRequests(JSON.stringify(value))).toThrow(BatchRequestError)
    bad([])
    bad({ requests: [] })
    bad({ requests: "x" })
    bad([req("a"), req("a")])
    bad([req("bad id")])
    bad([req("x".repeat(65))])
    bad([req("a", { max_tokens: 0 })])
    bad([req("a", { max_tokens: 1.5 })])
    bad([req("a", { max_tokens: 10_000_000 })])
    bad([req("a", { max_tokens: "10" })])
    bad([req("a", { messages: [] })])
    bad([req("a", { messages: "hi" })])
    bad([req("a", { stream: true })])
    bad([{ custom_id: "a" }])
    bad([{ ...req("a"), extra: 1 }])
    bad("text")
    expect(() => parseBatchRequests("")).toThrow(BatchRequestError)
    expect(() => parseBatchRequests("{not json}\n{}")).toThrow(BatchRequestError)
  })

  test("allows stream false", () => {
    expect(parseBatchRequests(JSON.stringify([req("a", { stream: false })]))).toHaveLength(1)
  })

  test("limits the normalized model ID to the store's 256 characters", () => {
    for (const prefix of ["", "fuelix-anthropic/"]) {
      const model = "m".repeat(256)
      expect(parseBatchRequests(JSON.stringify([req("a", { model: `${prefix}${model}` })]))[0]!.params.model).toBe(model)
      expect(() => parseBatchRequests(JSON.stringify([req("a", { model: `${prefix}${model}m` })]))).toThrow(BatchRequestError)
    }
  })

  test("enforces request count and byte bounds", () => {
    const many = Array.from({ length: 100_001 }, (_, i) => ({ custom_id: `i${i}`, params: { model: "m", max_tokens: 1, messages: [1] } }))
    expect(() => parseBatchRequests(many.map((i) => JSON.stringify(i)).join("\n"))).toThrow(/100000/)
    expect(() => parseBatchRequests(JSON.stringify(many))).toThrow(/100000/)
    const text = JSON.stringify([req("a")])
    expect(() => parseBatchRequests(text, { maxBytes: 10 })).toThrow(/larger/)
    expect(parseBatchRequests(text, { maxBytes: Buffer.byteLength(text) })).toHaveLength(1)
    // Multi-byte characters count as bytes.
    const wide = JSON.stringify([req("a", { system: "é".repeat(50) })])
    expect(() => parseBatchRequests(wide, { maxBytes: wide.length })).toThrow(/larger/)
  })

  test("errors never echo prompt content", () => {
    try {
      parseBatchRequests(JSON.stringify([req("a", { max_tokens: 0, system: "SECRET-PROMPT" })]))
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-PROMPT")
    }
    for (const text of [
      JSON.stringify([{ ...req("a"), "SECRET-FIELD": 1 }]),
      JSON.stringify({ requests: [req("a")], "SECRET-FIELD": 1 }),
    ]) {
      try {
        parseBatchRequests(text)
        throw new Error("expected rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(BatchRequestError)
        expect(String(error)).not.toContain("SECRET-FIELD")
      }
    }
    try {
      parseBatchRequests('{"custom_id":"a","params":"SECRET-PROMPT"}\nSECRET-PROMPT')
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-PROMPT")
    }
  })
})
