import { describe, expect, test } from "bun:test"
import { withAuthFetch } from "../../../src/fuelix/auth.ts"
import { ensureCacheBreakpoint, withCacheFetch } from "../../../src/fuelix/cache.ts"

const KEY = "sk-test-not-a-real-key"
const URL_MESSAGES = "https://api.fuelix.test/v1/messages"

interface Seen {
  url: string
  method: string
  headers: Headers
  text: string
  signal?: AbortSignal | null
}

/** A fake network boundary. It records what `fetch` would send. */
function boundary(response: () => Response = () => new Response("{}")) {
  const seen: Seen[] = []
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      seen.push({
        url: input.url,
        method: input.method,
        headers: new Headers(input.headers),
        text: await input.clone().text(),
        signal: input.signal,
      })
    } else {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        text: typeof init?.body === "string" ? init.body : "",
        signal: init?.signal,
      })
    }
    return response()
  }
  // The same chain as the AI SDK hook builds: auth outside, cache inside.
  const wrapped = withAuthFetch(withCacheFetch(fake), () => ({ fallback: KEY }))
  return { seen, wrapped }
}

const EPHEMERAL = { type: "ephemeral" }
const LONG = "lorem ipsum ".repeat(2000)

function longSession(extra: Record<string, unknown> = {}) {
  return {
    model: "claude-opus",
    max_tokens: 4096,
    stream: true,
    system: [
      { type: "text", text: "You are a coding agent." },
      { type: "text", text: LONG },
    ],
    tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: [{ type: "text", text: LONG }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: LONG }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ],
    ...extra,
  }
}

const post = (body: unknown, headers: Record<string, string> = { "x-api-key": "fuelix-plugin-managed" }) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
})

const markerCount = (value: unknown): number => JSON.stringify(value).split('"cache_control"').length - 1

describe("ensureCacheBreakpoint", () => {
  test("marks the last system block and leaves the input untouched", () => {
    const body = longSession()
    const snapshot = JSON.stringify(body)
    const next = ensureCacheBreakpoint(body) as any
    expect(next.system[1].cache_control).toEqual(EPHEMERAL)
    expect(next.system[0].cache_control).toBeUndefined()
    expect(markerCount(next)).toBe(1)
    expect(JSON.stringify(body)).toBe(snapshot)
  })

  test("normalizes a string system", () => {
    const next = ensureCacheBreakpoint({ model: "m", system: "Be brief.", messages: [] }) as any
    expect(next.system).toEqual([{ type: "text", text: "Be brief.", cache_control: EPHEMERAL }])
  })

  test("skips empty system text and uses the last cacheable system block", () => {
    const next = ensureCacheBreakpoint({
      model: "m",
      system: [{ type: "text", text: "Keep" }, { type: "text", text: "  " }],
      messages: [],
    }) as any
    expect(next.system[0].cache_control).toEqual(EPHEMERAL)
    expect(next.system[1].cache_control).toBeUndefined()
  })

  test("falls back to the last cacheable message block when there is no usable system", () => {
    const next = ensureCacheBreakpoint({
      model: "m",
      system: "",
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    }) as any
    expect(next.messages[1].content[0].cache_control).toEqual(EPHEMERAL)
    expect(markerCount(next)).toBe(1)
  })

  test("normalizes string message content in the fallback", () => {
    const next = ensureCacheBreakpoint({ model: "m", messages: [{ role: "user", content: "hello" }] }) as any
    expect(next.messages[0].content).toEqual([{ type: "text", text: "hello", cache_control: EPHEMERAL }])
  })

  test("never marks thinking blocks and keeps them intact", () => {
    const thinking = { type: "thinking", thinking: "hmm", signature: "sig==" }
    const redacted = { type: "redacted_thinking", data: "abc" }
    const body = {
      model: "m",
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: [{ type: "text", text: "answer" }, thinking, redacted] },
      ],
    }
    const next = ensureCacheBreakpoint(body) as any
    expect(next.messages[1].content[0].cache_control).toEqual(EPHEMERAL)
    expect(next.messages[1].content[1]).toEqual(thinking)
    expect(next.messages[1].content[2]).toEqual(redacted)
  })

  test("marks a tool_use block when it is the last cacheable block", () => {
    const next = ensureCacheBreakpoint({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: {} }] }],
    }) as any
    expect(next.messages[0].content[0].cache_control).toEqual(EPHEMERAL)
  })

  test.each([
    ["system block", { system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    ["message block", { messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: EPHEMERAL }] }] }],
    ["tool", { tools: [{ name: "n", input_schema: {}, cache_control: EPHEMERAL }] }],
    ["top-level", { cache_control: EPHEMERAL }],
    [
      "nested tool_result content",
      {
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x", cache_control: EPHEMERAL }] }] },
        ],
      },
    ],
  ])("leaves a body with an existing %s marker unchanged", (_name, patch) => {
    const body = { model: "m", system: "Sys", messages: [{ role: "user", content: "hi" }], ...patch }
    expect(ensureCacheBreakpoint(body)).toBeUndefined()
  })

  test("a user property named cache_control inside tool input does not count as a marker", () => {
    const next = ensureCacheBreakpoint({
      model: "m",
      system: "Sys",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: { cache_control: "x" } }] }],
    })
    expect(next).toBeDefined()
  })

  test("a schema property named cache_control in output_config is not a marker", () => {
    const outputConfig = {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { cache_control: { type: "string" } },
          required: ["cache_control"],
          additionalProperties: false,
        },
      },
    }
    const next = ensureCacheBreakpoint({
      model: "claude-opus",
      system: "Stable system prompt",
      messages: [{ role: "user", content: "Continue" }],
      output_config: outputConfig,
    }) as any
    expect(next.system).toEqual([{ type: "text", text: "Stable system prompt", cache_control: EPHEMERAL }])
    expect(next.output_config).toEqual(outputConfig)
    expect(next.output_config.format.schema.properties.cache_control).toEqual({ type: "string" })
  })

  test("a tool input_schema property named cache_control is not a marker", () => {
    const tools = [{ name: "n", input_schema: { type: "object", properties: { cache_control: { type: "string" } } } }]
    const next = ensureCacheBreakpoint({ model: "m", system: "Sys", tools, messages: [{ role: "user", content: "hi" }] }) as any
    expect(next.system[0].cache_control).toEqual(EPHEMERAL)
    expect(next.tools).toEqual(tools)
  })

  test("returns undefined for bodies that are not Anthropic messages", () => {
    expect(ensureCacheBreakpoint(null)).toBeUndefined()
    expect(ensureCacheBreakpoint([])).toBeUndefined()
    expect(ensureCacheBreakpoint({ model: "m" })).toBeUndefined()
    expect(ensureCacheBreakpoint({ messages: [] })).toBeUndefined()
    expect(ensureCacheBreakpoint({ model: "m", messages: [] })).toBeUndefined()
    expect(ensureCacheBreakpoint({ model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }] })).toBeUndefined()
  })
})

describe("withCacheFetch at the fetch boundary", () => {
  test("a cold long request reaches the network with one system marker and Bearer auth", async () => {
    const { seen, wrapped } = boundary()
    await wrapped(URL_MESSAGES, post(longSession()))
    expect(seen).toHaveLength(1)
    const sent = JSON.parse(seen[0]!.text)
    expect(markerCount(sent)).toBe(1)
    expect(sent.system[1].cache_control).toEqual(EPHEMERAL)
    expect(sent.system[1].text).toBe(LONG)
    expect(sent.messages).toEqual(longSession().messages)
    expect(sent.tools).toEqual(longSession().tools)
    expect(sent.stream).toBe(true)
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(seen[0]!.headers.has("x-api-key")).toBe(false)
    expect(seen[0]!.headers.get("content-type")).toBe("application/json")
  })

  test("a resumed session sent twice with a string system gets a marker both times", async () => {
    const { seen, wrapped } = boundary()
    const body = { ...longSession(), system: "System prompt" }
    await wrapped(URL_MESSAGES, post(body))
    await wrapped(URL_MESSAGES, post({ ...body, messages: [...body.messages, { role: "assistant", content: "more" }] }))
    for (const entry of seen) {
      const sent = JSON.parse(entry.text)
      expect(sent.system).toEqual([{ type: "text", text: "System prompt", cache_control: EPHEMERAL }])
      expect(markerCount(sent)).toBe(1)
    }
  })

  test("an already marked request is sent byte for byte", async () => {
    const { seen, wrapped } = boundary()
    const marked = longSession({ cache_control: { type: "ephemeral", ttl: "1h" } })
    const raw = JSON.stringify(marked)
    await wrapped(URL_MESSAGES, post(raw))
    expect(seen[0]!.text).toBe(raw)
    const blockMarked = longSession()
    ;(blockMarked.messages[4]!.content as any[])[0].cache_control = { type: "ephemeral", ttl: "1h" }
    const raw2 = JSON.stringify(blockMarked)
    await wrapped(URL_MESSAGES, post(raw2))
    expect(seen[1]!.text).toBe(raw2)
  })

  test("a request without system gets the marker on the last message block", async () => {
    const { seen, wrapped } = boundary()
    const { system: _system, ...noSystem } = longSession()
    await wrapped(URL_MESSAGES, post(noSystem))
    const sent = JSON.parse(seen[0]!.text)
    expect(markerCount(sent)).toBe(1)
    expect(sent.messages[4].content[0]).toEqual({ type: "text", text: "Continue", cache_control: EPHEMERAL })
  })

  test("a short prompt still gets a marker", async () => {
    const { seen, wrapped } = boundary()
    await wrapped(URL_MESSAGES, post({ model: "claude-opus", max_tokens: 10, system: "Hi", messages: [{ role: "user", content: "yo" }] }))
    expect(JSON.parse(seen[0]!.text).system[0].cache_control).toEqual(EPHEMERAL)
  })

  test("a final thinking block stays unmarked and unchanged", async () => {
    const { seen, wrapped } = boundary()
    const thinking = { type: "thinking", thinking: "plan", signature: "sig==" }
    await wrapped(
      URL_MESSAGES,
      post({
        model: "claude-opus",
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [thinking] },
        ],
      }),
    )
    const sent = JSON.parse(seen[0]!.text)
    expect(sent.messages[1].content).toEqual([thinking])
    expect(sent.messages[0].content[0].cache_control).toEqual(EPHEMERAL)
  })

  test.each([
    ["not JSON", "this is not json"],
    ["truncated JSON", '{"model":"claude-opus","messages":['],
    ["JSON array", "[1,2,3]"],
    ["JSON without messages", '{"model":"claude-opus"}'],
  ])("a %s body is sent unchanged", async (_name, raw) => {
    const { seen, wrapped } = boundary()
    await wrapped(URL_MESSAGES, post(raw))
    expect(seen[0]!.text).toBe(raw)
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("a non-string body is passed through", async () => {
    const body = new Uint8Array([1, 2, 3])
    let received: unknown
    const fake = withCacheFetch(async (_input, init) => {
      received = init?.body
      return new Response("{}")
    })
    await fake(URL_MESSAGES, { method: "POST", body })
    expect(received).toBe(body)
  })

  test.each([
    ["count_tokens", "https://api.fuelix.test/v1/messages/count_tokens"],
    ["batches", "https://api.fuelix.test/v1/messages/batches"],
    ["models", "https://api.fuelix.test/v1/models"],
    ["chat completions", "https://api.fuelix.test/v1/chat/completions"],
  ])("a POST to %s is untouched", async (_name, url) => {
    const { seen, wrapped } = boundary()
    const raw = JSON.stringify(longSession())
    await wrapped(url, post(raw))
    expect(seen[0]!.text).toBe(raw)
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("a GET to /messages is untouched", async () => {
    const { seen, wrapped } = boundary()
    await wrapped(URL_MESSAGES, { method: "GET", headers: {} })
    expect(seen[0]!.text).toBe("")
  })

  test("a URL object input is handled", async () => {
    const { seen, wrapped } = boundary()
    await wrapped(new URL(URL_MESSAGES), post(longSession()))
    expect(markerCount(JSON.parse(seen[0]!.text))).toBe(1)
  })

  test("a Request input keeps method, headers, and signal, and gets the marker and Bearer auth", async () => {
    const { seen, wrapped } = boundary()
    const controller = new AbortController()
    const request = new Request(URL_MESSAGES, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fuelix-plugin-managed", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(longSession()),
      signal: controller.signal,
    })
    await wrapped(request)
    expect(seen).toHaveLength(1)
    const entry = seen[0]!
    expect(entry.url).toBe(URL_MESSAGES)
    expect(entry.method).toBe("POST")
    expect(entry.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(entry.headers.has("x-api-key")).toBe(false)
    expect(entry.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(entry.headers.get("content-type")).toBe("application/json")
    expect(markerCount(JSON.parse(entry.text))).toBe(1)
    controller.abort()
    expect(entry.signal?.aborted).toBe(true)
  })

  test("a Request input that is already marked or not JSON is forwarded readable", async () => {
    const { seen, wrapped } = boundary()
    const marked = JSON.stringify(longSession({ cache_control: EPHEMERAL }))
    await wrapped(new Request(URL_MESSAGES, { method: "POST", body: marked }))
    await wrapped(new Request(URL_MESSAGES, { method: "POST", body: "nope" }))
    expect(seen[0]!.text).toBe(marked)
    expect(seen[1]!.text).toBe("nope")
  })

  test("a stale content-length header is dropped when the body changes", async () => {
    const { seen, wrapped } = boundary()
    const raw = JSON.stringify(longSession())
    await wrapped(URL_MESSAGES, post(raw, { "content-length": String(raw.length), "x-api-key": "fuelix-plugin-managed" }))
    expect(seen[0]!.headers.has("content-length")).toBe(false)
  })

  test("the streaming response is returned as base returns it", async () => {
    const stream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: message_start\n\n"))
          controller.enqueue(new TextEncoder().encode("event: message_stop\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const { wrapped } = boundary(() => stream)
    const response = await wrapped(URL_MESSAGES, post(longSession()))
    expect(response).toBe(stream)
    expect(await response.text()).toBe("event: message_start\n\nevent: message_stop\n\n")
  })

  test("an error response and a base failure pass through without a retry", async () => {
    let calls = 0
    const failing = withCacheFetch(async () => {
      calls++
      throw new Error("network down")
    })
    await expect(failing(URL_MESSAGES, post(longSession()))).rejects.toThrow("network down")
    expect(calls).toBe(1)
    const { wrapped } = boundary(() => new Response("{}", { status: 400 }))
    expect((await wrapped(URL_MESSAGES, post(longSession()))).status).toBe(400)
  })
})
