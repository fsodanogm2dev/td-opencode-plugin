import { describe, expect, test } from "bun:test"
import { BatchClient, BatchClientError, normalizeBatchBaseURL, type BatchFetch } from "../../../src/fuelix/batch/client.ts"
import { isBatchTimestamp, type BatchRequest } from "../../../src/fuelix/batch/types.ts"

const KEY = "sk-test-not-a-real-key"
const BASE = "https://gw.example.test"

const batchBody = (over: Record<string, unknown> = {}) => ({
  id: "msgbatch_01",
  type: "message_batch",
  processing_status: "in_progress",
  request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  created_at: "2026-11-05T00:00:00Z",
  ended_at: null,
  results_url: null,
  expires_at: "2026-11-06T00:00:00Z",
  unknown_field: "dropped",
  ...over,
})

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

interface Call {
  url: string
  init: RequestInit
}

function harness(respond: (call: Call) => Response | Promise<Response>, options: { key?: string | undefined; baseURL?: string; timeoutMs?: number } = {}) {
  const calls: Call[] = []
  const fetch: BatchFetch = async (url, init) => {
    const call = { url, init: init ?? {} }
    calls.push(call)
    return respond(call)
  }
  let keyCalls = 0
  const client = new BatchClient({
    baseURL: options.baseURL ?? BASE,
    resolveKey: async () => {
      keyCalls++
      return "key" in options ? options.key : KEY
    },
    fetch,
    timeoutMs: options.timeoutMs,
  })
  return { client, calls, keyCalls: () => keyCalls }
}

const requests: BatchRequest[] = [
  { custom_id: "a", params: { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "SECRET-PROMPT" }] } },
]

async function fail(promise: Promise<unknown>): Promise<BatchClientError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(BatchClientError)
    return error as BatchClientError
  }
  throw new Error("expected rejection")
}

describe("normalizeBatchBaseURL", () => {
  test("normalizes origin and /v1 roots", () => {
    expect(normalizeBatchBaseURL("https://api.fuelix.ai")).toBe("https://api.fuelix.ai/v1")
    expect(normalizeBatchBaseURL("https://api.fuelix.ai/")).toBe("https://api.fuelix.ai/v1")
    expect(normalizeBatchBaseURL("https://api.fuelix.ai/v1/")).toBe("https://api.fuelix.ai/v1")
    expect(normalizeBatchBaseURL("https://h.test/proxy")).toBe("https://h.test/proxy/v1")
    expect(normalizeBatchBaseURL("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1")
    expect(normalizeBatchBaseURL("http://localhost:1/v1")).toBe("http://localhost:1/v1")
  })

  test("rejects credentials, downgrade, query, fragment, and garbage", () => {
    for (const bad of [
      "http://api.fuelix.ai",
      "https://user:pw@api.fuelix.ai",
      "https://api.fuelix.ai?x=1",
      "https://api.fuelix.ai/v1#frag",
      "https://api.fuelix.ai/v1?",
      "ftp://api.fuelix.ai",
      "not a url",
    ]) {
      expect(() => normalizeBatchBaseURL(bad)).toThrow(BatchClientError)
    }
  })
})

describe("isBatchTimestamp", () => {
  test("accepts RFC 3339 dates, offsets, and fractional seconds", () => {
    for (const value of ["2026-11-05T00:00:00Z", "2026-11-05T00:00:00.123456Z", "2026-11-05T10:15:30+03:30", "2026-11-05T10:15:30.5-04:00", "2024-02-29T00:00:00Z"]) {
      expect(isBatchTimestamp(value)).toBe(true)
    }
  })

  test("rejects permissive date parsing, invalid dates, and secret-bearing text", () => {
    for (const value of [undefined, 5, "", "2026-11-05", "2026-11-05 00:00:00Z", `${KEY} 2026-11-05`, "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-11-05T24:00:00Z", "2026-11-05T00:00:00+24:00", "2026-11-05T00:00:00"]) {
      expect(isBatchTimestamp(value)).toBe(false)
    }
  })
})

describe("BatchClient requests", () => {
  test("submit sends Bearer-only headers, no redirects, resolves the key per call", async () => {
    const h = harness(() => json(batchBody()))
    const batch = await h.client.submit(requests)
    expect(batch).toMatchObject({ id: "msgbatch_01", processing_status: "in_progress", results_url: null })
    expect("unknown_field" in batch).toBe(false)
    const call = h.calls[0]!
    expect(call.url).toBe("https://gw.example.test/v1/messages/batches")
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    const headers = call.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("x-api-key")
    expect(JSON.parse(call.init.body as string)).toEqual({ requests })
    await h.client.status("msgbatch_01")
    expect(h.keyCalls()).toBe(2)
  })

  test("status and cancel use the right URL and check the returned ID", async () => {
    const h = harness(() => json(batchBody()))
    await h.client.status("msgbatch_01")
    await h.client.cancel("msgbatch_01")
    expect(h.calls[0]!.url).toBe("https://gw.example.test/v1/messages/batches/msgbatch_01")
    expect(h.calls[0]!.init.method).toBe("GET")
    expect(h.calls[1]!.url).toBe("https://gw.example.test/v1/messages/batches/msgbatch_01/cancel")
    expect(h.calls[1]!.init.method).toBe("POST")
    expect((await fail(h.client.status("msgbatch_02"))).code).toBe("id_mismatch")
    expect((await fail(h.client.cancel("msgbatch_02"))).code).toBe("id_mismatch")
  })

  test("rejects unsafe IDs before any request", async () => {
    const h = harness(() => json(batchBody()))
    for (const id of ["../x", "a/b", "a?b", "", "a b", "é"]) {
      expect((await fail(h.client.status(id))).code).toBe("invalid_argument")
      expect((await fail(h.client.cancel(id))).code).toBe("invalid_argument")
    }
    expect(h.calls).toHaveLength(0)
    expect((await fail(h.client.submit([]))).code).toBe("invalid_argument")
  })

  test("missing or unsafe key fails without a request", async () => {
    for (const key of [undefined, "", "bad\nkey"]) {
      const h = harness(() => json(batchBody()), { key })
      const error = await fail(h.client.submit(requests))
      expect(error.code).toBe("no_key")
      expect(error.ambiguous).toBe(false)
      expect(h.calls).toHaveLength(0)
    }
  })
})

describe("BatchClient errors", () => {
  test("HTTP errors are sanitized and classified", async () => {
    const body = `{"error":"echo ${KEY} SECRET-PROMPT"}`
    const cases: Array<[number, string, boolean]> = [
      [400, "rejected", false],
      [401, "unauthorized", false],
      [403, "unauthorized", false],
      [404, "not_found", false],
      [413, "too_large", false],
      [422, "rejected", false],
      [429, "rate_limited", false],
      [408, "timeout", true],
      [500, "server_error", true],
      [503, "server_error", true],
    ]
    for (const [status, code, ambiguous] of cases) {
      const h = harness(() => new Response(body, { status }))
      const error = await fail(h.client.submit(requests))
      expect({ status: error.status, code: error.code as string, ambiguous: error.ambiguous }).toEqual({ status, code, ambiguous })
      expect(error.message).not.toContain(KEY)
      expect(error.message).not.toContain("SECRET")
      expect(JSON.stringify(error)).not.toContain("SECRET")
      expect(String(error.cause ?? "")).not.toContain("SECRET")
      expect(error.batchID).toBeUndefined()
      // Non-submit calls are never ambiguous.
      const status2 = await fail(harness(() => new Response(body, { status })).client.status("msgbatch_01"))
      expect(status2.ambiguous).toBe(false)
    }
  })

  test("fetch failure is ambiguous for submit and the message hides the cause", async () => {
    const h = harness(() => {
      throw new TypeError(`connect failed for ${KEY}`)
    })
    const error = await fail(h.client.submit(requests))
    expect(error).toMatchObject({ code: "network", ambiguous: true })
    expect(error.message).not.toContain(KEY)
    expect((await fail(h.client.status("msgbatch_01"))).ambiguous).toBe(false)
  })

  test("malformed success bodies", async () => {
    for (const body of [
      "not json",
      "[]",
      JSON.stringify(batchBody({ type: "other" })),
      JSON.stringify(batchBody({ processing_status: "weird" })),
      JSON.stringify(batchBody({ id: "bad/id" })),
      JSON.stringify(batchBody({ request_counts: { processing: -1, succeeded: 0, errored: 0, canceled: 0, expired: 0 } })),
      JSON.stringify(batchBody({ request_counts: { processing: 1.5, succeeded: 0, errored: 0, canceled: 0, expired: 0 } })),
      JSON.stringify(batchBody({ request_counts: { processing: 1 } })),
      JSON.stringify(batchBody({ created_at: "yesterday" })),
      JSON.stringify(batchBody({ ended_at: 5 })),
      JSON.stringify(batchBody({ results_url: 5 })),
    ]) {
      const h = harness(() => new Response(body, { status: 200 }))
      const submit = await fail(h.client.submit(requests))
      expect(submit).toMatchObject({ code: "malformed_response", ambiguous: true })
      const status = await fail(h.client.status("msgbatch_01"))
      expect(status).toMatchObject({ code: "malformed_response", ambiguous: false })
      expect(status.batchID).toBeUndefined()
    }
  })

  test("retains only safe handles from malformed successful submissions without retrying or echoing them", async () => {
    for (const body of [
      { id: "msgbatch_x", type: "other" },
      batchBody({ id: "msgbatch_x", created_at: `${KEY} 2026-11-05` }),
      batchBody({ id: "msgbatch_x", ended_at: "2026-02-29T00:00:00Z" }),
    ]) {
      const h = harness(() => json(body))
      const error = await fail(h.client.submit(requests))
      expect(error).toMatchObject({ code: "malformed_response", ambiguous: true, batchID: "msgbatch_x" })
      expect(error.message).toBe("FueliX batch request failed (malformed_response)")
      expect(error.message).not.toContain("msgbatch_x")
      expect(error.message).not.toContain(KEY)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]!.init.method).toBe("POST")
    }
    for (const body of ["not json", JSON.stringify({ id: "unsafe/id", type: "other" }), JSON.stringify({ id: "x".repeat(129), type: "other" })]) {
      const h = harness(() => new Response(body, { status: 200 }))
      expect((await fail(h.client.submit(requests))).batchID).toBeUndefined()
      expect(h.calls).toHaveLength(1)
    }
  })

  test("never retains a handle from HTTP error bodies", async () => {
    for (const status of [400, 408, 500, 503]) {
      const h = harness(() => json(batchBody({ id: "msgbatch_x" }), status))
      expect((await fail(h.client.submit(requests))).batchID).toBeUndefined()
      expect(h.calls).toHaveLength(1)
    }
  })

  test("validates every metadata timestamp", async () => {
    for (const field of ["created_at", "ended_at", "expires_at", "cancel_initiated_at", "archived_at"]) {
      const h = harness(() => json(batchBody({ [field]: `${KEY} 2026-11-05` })))
      expect(await fail(h.client.submit(requests))).toMatchObject({ code: "malformed_response", ambiguous: true, batchID: "msgbatch_01" })
    }
    const h = harness(() => json(batchBody({ created_at: "2026-11-05T10:00:00.123456+03:30", ended_at: "2026-11-05T11:00:00-04:00" })))
    expect((await h.client.submit(requests)).created_at).toBe("2026-11-05T10:00:00.123456+03:30")
  })

  test("caller abort and timeout are honored even if fetch ignores the signal", async () => {
    const never = () => new Promise<Response>(() => {})
    const h = harness(never)
    const controller = new AbortController()
    const pending = fail(h.client.submit(requests, controller.signal))
    await Promise.resolve()
    controller.abort()
    const aborted = await pending
    expect(aborted.code).toBe("aborted")

    const pre = new AbortController()
    pre.abort()
    const early = await fail(harness(never).client.submit(requests, pre.signal))
    expect(early).toMatchObject({ code: "aborted", ambiguous: false })

    const slow = harness(never, { timeoutMs: 20 })
    const timeout = await fail(slow.client.submit(requests))
    expect(timeout).toMatchObject({ code: "timeout", ambiguous: true })
    expect(slow.calls).toHaveLength(1)
    expect((await fail(slow.client.status("msgbatch_01"))).ambiguous).toBe(false)
  })

  test("timeout covers the response body", async () => {
    const h = harness(
      () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
      { timeoutMs: 20 },
    )
    expect((await fail(h.client.status("msgbatch_01"))).code).toBe("timeout")
  })

  test("a key that resolves after timeout or abort never reaches fetch", async () => {
    for (const mode of ["timeout", "abort"] as const) {
      let release: (key: string) => void = () => {}
      const pendingKey = new Promise<string>((resolve) => {
        release = resolve
      })
      let fetchCount = 0
      const client = new BatchClient({
        baseURL: BASE,
        resolveKey: () => pendingKey,
        fetch: async () => {
          fetchCount++
          return json(batchBody())
        },
        timeoutMs: mode === "timeout" ? 20 : 5000,
      })
      const controller = new AbortController()
      const submit = fail(client.submit(requests, controller.signal))
      const status = fail(client.status("msgbatch_01", controller.signal))
      if (mode !== "timeout") {
        await Promise.resolve()
        controller.abort()
      }
      const errors = [await submit, await status]
      for (const error of errors) {
        expect(error.code).toBe(mode === "timeout" ? "timeout" : "aborted")
        expect(error.ambiguous).toBe(false)
      }
      release(KEY)
      for (let i = 0; i < 5; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(fetchCount).toBe(0)
    }
  })

  test("a rejecting or slow-failing key resolver is a no_key error", async () => {
    const client = new BatchClient({
      baseURL: BASE,
      resolveKey: async () => {
        throw new Error(`boom ${KEY}`)
      },
      fetch: async () => json(batchBody()),
    })
    const error = await fail(client.submit(requests))
    expect(error).toMatchObject({ code: "no_key", ambiguous: false })
    expect(error.message).not.toContain(KEY)
  })

  test("never retries", async () => {
    const h = harness(() => new Response("", { status: 503 }))
    await fail(h.client.submit(requests))
    await fail(h.client.status("msgbatch_01"))
    await fail(h.client.cancel("msgbatch_01"))
    expect(h.calls).toHaveLength(3)
  })
})

describe("BatchClient results", () => {
  const ended = (over: Record<string, unknown> = {}) =>
    batchBody({
      processing_status: "ended",
      ended_at: "2026-11-05T01:00:00Z",
      results_url: "https://gw.example.test/v1/messages/batches/msgbatch_01/results",
      ...over,
    })
  const parse = async (value: Record<string, unknown>) => {
    const h = harness(() => json(value))
    return { batch: await h.client.status("msgbatch_01"), h }
  }

  test("downloads JSONL from the same origin with the key", async () => {
    const { batch } = await parse(ended())
    const h = harness(() => new Response('{"custom_id":"a"}\n', { status: 200 }))
    expect(await h.client.results(batch)).toBe('{"custom_id":"a"}\n')
    expect(h.calls[0]!.url).toBe("https://gw.example.test/v1/messages/batches/msgbatch_01/results")
    expect(h.calls[0]!.init.redirect).toBe("error")
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })

  test("requires an ended batch with a URL", async () => {
    const h = harness(() => new Response(""))
    const running = (await parse(batchBody())).batch
    expect((await fail(h.client.results(running))).code).toBe("results_unavailable")
    const noURL = (await parse(ended({ results_url: null }))).batch
    expect((await fail(h.client.results(noURL))).code).toBe("results_unavailable")
    expect(h.calls).toHaveLength(0)
  })

  test("rejects results URLs outside the origin and API subtree", async () => {
    for (const url of [
      "https://evil.example.test/v1/messages/batches/msgbatch_01/results",
      "http://gw.example.test/v1/messages/batches/msgbatch_01/results",
      "https://gw.example.test:8443/v1/messages/batches/msgbatch_01/results",
      "https://user:pw@gw.example.test/v1/messages/batches/msgbatch_01/results",
      "https://gw.example.test/other/results",
      "https://gw.example.test/v10/results",
      "https://gw.example.test/v1/../x",
      "https://gw.example.test/v1/results#frag",
      "/v1/messages/batches/msgbatch_01/results",
      "garbage",
    ]) {
      const { batch } = await parse(ended({ results_url: url }))
      const h = harness(() => new Response(""))
      expect((await fail(h.client.results(batch))).code).toBe("unsafe_results_url")
      expect(h.calls).toHaveLength(0)
    }
  })

  test("bounds the body with a content-length check and a streaming cap", async () => {
    const { batch } = await parse(ended())
    const declared = harness(() => new Response("x", { status: 200, headers: { "content-length": String(300 * 1024 * 1024) } }))
    expect((await fail(declared.client.results(batch))).code).toBe("too_large")

    // Metadata responses are capped at 1 MiB while streaming.
    const big = new Uint8Array(1024 * 1024 + 1)
    const h = harness(() => new Response(big, { status: 200 }))
    expect((await fail(h.client.status("msgbatch_01"))).code).toBe("too_large")
    const sub = harness(() => new Response(big, { status: 200 }))
    expect(await fail(sub.client.submit(requests))).toMatchObject({ code: "too_large", ambiguous: true })
  })

  test("results HTTP errors are not ambiguous", async () => {
    const { batch } = await parse(ended())
    const h = harness(() => new Response("boom", { status: 500 }))
    expect(await fail(h.client.results(batch))).toMatchObject({ code: "server_error", ambiguous: false, status: 500 })
  })
})
