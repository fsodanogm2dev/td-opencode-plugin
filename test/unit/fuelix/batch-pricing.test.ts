import { describe, expect, test } from "bun:test"
import { actualBatchCost, estimateBatchCost, parseBatchRateCard, type BatchRateCard } from "../../../src/fuelix/batch/pricing.ts"
import { parseBatchResults, type BatchResult } from "../../../src/fuelix/batch/types.ts"

const rates: BatchRateCard = {
  source: "test rate card (fake)",
  currency: "USD",
  models: {
    "model-a": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    "model-b": { input: 2, output: 10 },
  },
}

const ok = (id: string, model: string | undefined, usage: Record<string, unknown> | undefined): BatchResult => ({
  custom_id: id,
  result: { type: "succeeded", message: { ...(model ? { model } : {}), ...(usage ? { usage } : {}) } },
})

describe("estimateBatchCost", () => {
  test("is unavailable without rates", () => {
    const cost = estimateBatchCost([ok("a", "model-a", { input_tokens: 1, output_tokens: 1 })], undefined)
    expect(cost.kind).toBe("unavailable")
  })

  test("sums mixed models and cache classes", () => {
    const cost = estimateBatchCost(
      [
        ok("a", "model-a", {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 2_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
        }),
        ok("b", "fuelix-anthropic/model-b", { input_tokens: 500_000, output_tokens: 100_000 }),
        { custom_id: "c", result: { type: "canceled" } },
        { custom_id: "d", result: { type: "expired" } },
        { custom_id: "e", result: { type: "errored", error: { type: "error" } } },
      ],
      rates,
    )
    expect(cost).toEqual({
      kind: "estimate",
      source: "test rate card (fake)",
      currency: "USD",
      amount: 1 + 5 + 0.1 + 1.25 + 2 + 1 + 1,
      succeeded: 2,
      excluded: { errored: 1, canceled: 1, expired: 1 },
    })
  })

  test("cache writes without a TTL breakdown need an explicit TTL", () => {
    const results = [ok("a", "model-a", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })]
    expect(estimateBatchCost(results, rates).kind).toBe("unavailable")
    expect(estimateBatchCost(results, rates, { cacheWriteTTL: "5m" })).toMatchObject({ kind: "estimate", amount: 1.25 })
    expect(estimateBatchCost(results, rates, { cacheWriteTTL: "1h" })).toMatchObject({ kind: "estimate", amount: 2 })
    // Zero cache writes need no TTL.
    expect(
      estimateBatchCost([ok("a", "model-a", { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0 })], rates),
    ).toMatchObject({ kind: "estimate", amount: 1 })
  })

  test("keeps totals finite and rejects non-finite rates", () => {
    const huge: BatchRateCard = { source: "fake", currency: "USD", models: { "model-a": { input: 1_000_000, output: 0 } } }
    const results = Array.from({ length: 3 }, (_, i) =>
      ok(`r${i}`, "model-a", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }),
    )
    const cost = estimateBatchCost(results, huge)
    expect(cost.kind === "estimate" ? Number.isFinite(cost.amount) : true).toBe(true)
    const bad = { ...huge, models: { "model-a": { input: Number.POSITIVE_INFINITY, output: 0 } } }
    expect(estimateBatchCost(results, bad).kind).toBe("unavailable")
  })

  test("is unavailable for missing or malformed data", () => {
    const u = (r: BatchResult[]) => estimateBatchCost(r, rates).kind
    expect(u([ok("a", undefined, { input_tokens: 1, output_tokens: 1 })])).toBe("unavailable")
    expect(u([ok("a", "model-a", undefined)])).toBe("unavailable")
    expect(u([ok("a", "model-a", { input_tokens: 1 })])).toBe("unavailable")
    expect(u([ok("a", "model-a", { input_tokens: -1, output_tokens: 1 })])).toBe("unavailable")
    expect(u([ok("a", "model-a", { input_tokens: 1.5, output_tokens: 1 })])).toBe("unavailable")
    expect(u([ok("a", "unknown", { input_tokens: 1, output_tokens: 1 })])).toBe("unavailable")
    expect(u([ok("a", "constructor", { input_tokens: 1, output_tokens: 1 })])).toBe("unavailable")
    // Token class without a rate.
    expect(u([ok("a", "model-b", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5 })])).toBe("unavailable")
    // Inconsistent cache breakdown.
    expect(
      u([ok("a", "model-a", { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 1 } })]),
    ).toBe("unavailable")
    expect(estimateBatchCost([ok("a", "model-a", { input_tokens: 1, output_tokens: 1 })], { ...rates, source: " " }).kind).toBe("unavailable")
  })

  test("accepts zero results as a zero estimate", () => {
    expect(estimateBatchCost([], rates)).toMatchObject({ kind: "estimate", amount: 0, succeeded: 0 })
  })

  test("server-side web tool usage cannot be priced with token rates", () => {
    for (const server_tool_use of [{ web_search_requests: 1 }, { web_search_requests: 0, web_fetch_requests: 1 }]) {
      const cost = estimateBatchCost([ok("a", "model-a", { input_tokens: 1, output_tokens: 1, server_tool_use })], rates)
      expect(cost.kind).toBe("unavailable")
    }
    const cost = estimateBatchCost([ok("a", "model-a", {
      input_tokens: 1_000_000, output_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    })], rates)
    expect(cost).toMatchObject({ kind: "estimate", amount: 1 })
  })

  test("malformed server tool counters make the whole estimate unavailable", () => {
    for (const server_tool_use of [null, [], "0", 0, { web_search_requests: -1 }, { web_search_requests: "0" }, { web_search_requests: 0.5 }, { web_search_requests: Number.NaN }, { web_search_requests: Infinity }, { web_search_requests: undefined }]) {
      expect(estimateBatchCost([ok("a", "model-a", { input_tokens: 1, output_tokens: 1, server_tool_use })], rates).kind).toBe("unavailable")
    }
  })
})

describe("parseBatchRateCard", () => {
  const card = (): Record<string, any> => ({
    source: "  customer-provided sheet, 2026-11-05  ",
    currency: "USD",
    models: { "fuelix-anthropic/model-a": { input: 1, output: 2, cacheRead: 0.1 }, "model-b": { input: 0, output: 0 } },
  })

  test("normalizes a valid card into a fresh object", () => {
    const input = card() as { models: Record<string, unknown> }
    const parsed = parseBatchRateCard(input)
    expect(parsed).toEqual({
      source: "customer-provided sheet, 2026-11-05",
      currency: "USD",
      models: { "model-a": { input: 1, output: 2, cacheRead: 0.1 }, "model-b": { input: 0, output: 0 } },
    })
    expect(parsed!.models["model-a"]).not.toBe(input.models["fuelix-anthropic/model-a"])
  })

  test("rejects malformed cards", () => {
    const mutate = (fn: (c: Record<string, any>) => void) => {
      const c = card()
      fn(c)
      return parseBatchRateCard(c)
    }
    for (const value of [undefined, null, "x", [], 5]) expect(parseBatchRateCard(value)).toBeUndefined()
    expect(mutate((c) => (c.source = ""))).toBeUndefined()
    expect(mutate((c) => (c.source = "x".repeat(2049)))).toBeUndefined()
    expect(mutate((c) => (c.source = "a\nb"))).toBeUndefined()
    expect(mutate((c) => (c.source = 5 as never))).toBeUndefined()
    expect(mutate((c) => (c.currency = "EUR"))).toBeUndefined()
    expect(mutate((c) => delete c.currency)).toBeUndefined()
    expect(mutate((c) => (c.models = {}))).toBeUndefined()
    expect(mutate((c) => (c.models = [] as never))).toBeUndefined()
    expect(mutate((c) => (c.extra = "token"))).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"].secret = "k"))).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"].input = -1))).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"].input = Number.NaN))).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"].output = "1"))).toBeUndefined()
    expect(mutate((c) => delete (c.models as any)["model-b"].output)).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"].cacheWrite1h = Number.POSITIVE_INFINITY))).toBeUndefined()
    expect(mutate((c) => ((c.models as any)["model-b"] = null))).toBeUndefined()
    // Duplicate after prefix normalization.
    expect(mutate((c) => ((c.models as any)["model-a"] = { input: 1, output: 1 }))).toBeUndefined()
  })

  test("rejects foreign and hostile model IDs", () => {
    for (const id of ["fuelix-openai/gpt-5", "openai/x", "", " ", "a b", "constructor", "toString", "__proto__", "fuelix-anthropic/"]) {
      const models = JSON.parse(`{${JSON.stringify(id)}: {"input":1,"output":1}}`)
      expect(parseBatchRateCard({ source: "s", currency: "USD", models })).toBeUndefined()
    }
    const polluted = JSON.parse('{"source":"s","currency":"USD","models":{"__proto__":{"input":1,"output":1}}}')
    expect(parseBatchRateCard(polluted)).toBeUndefined()
    expect(({} as Record<string, unknown>).input).toBeUndefined()
  })

  test("rejects class instances and oversized model maps", () => {
    class C {
      input = 1
      output = 1
    }
    expect(parseBatchRateCard({ source: "s", currency: "USD", models: { m: new C() } })).toBeUndefined()
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`m${i}`, { input: 1, output: 1 }]))
    expect(parseBatchRateCard({ source: "s", currency: "USD", models: many })).toBeUndefined()
  })

  test("does not accept context tiers or invent their token thresholds", () => {
    const input = { source: "fake", currency: "USD", models: { "model-a": { input: 1, output: 2, contextTiers: [{ input: 2, output: 4 }] } } }
    expect(parseBatchRateCard(input)).toBeUndefined()
    expect(estimateBatchCost([ok("a", "model-a", { input_tokens: 1, output_tokens: 1 })], input as unknown as BatchRateCard).kind).toBe("unavailable")
  })
})

describe("actualBatchCost", () => {
  test("requires source, currency, and a valid amount", () => {
    expect(actualBatchCost({ source: "invoice 1", currency: "USD", amount: 1.5 })).toEqual({
      kind: "actual",
      source: "invoice 1",
      currency: "USD",
      amount: 1.5,
    })
    expect(actualBatchCost({ source: "", currency: "USD", amount: 1 }).kind).toBe("unavailable")
    expect(actualBatchCost({ source: "x", currency: "USD", amount: -1 }).kind).toBe("unavailable")
    expect(actualBatchCost({ source: "x", currency: "USD", amount: Number.NaN }).kind).toBe("unavailable")
    expect(actualBatchCost({ source: "x", currency: "EUR" as "USD", amount: 1 }).kind).toBe("unavailable")
  })
})

describe("parseBatchResults", () => {
  test("parses all variants and rejects malformed lines without echoing content", () => {
    const text = [
      { custom_id: "a", result: { type: "succeeded", message: { model: "m", usage: { input_tokens: 1 } } } },
      { custom_id: "b", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "m" } } } },
      { custom_id: "c", result: { type: "canceled" } },
      { custom_id: "d", result: { type: "expired" } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    expect(parseBatchResults(text + "\n").map((r) => r.result.type)).toEqual(["succeeded", "errored", "canceled", "expired"])
    expect(() => parseBatchResults('{"custom_id":"a","result":{"type":"weird"}}')).toThrow()
    expect(() => parseBatchResults(`${text}\n${text.split("\n")[0]}`)).toThrow(/repeat/)
    try {
      parseBatchResults("SECRET-CONTENT")
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-CONTENT")
    }
  })
})
