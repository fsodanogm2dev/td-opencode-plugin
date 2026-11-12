import { describe, expect, test } from "bun:test"
import { createJevCache } from "../../../src/jev/cache.ts"
import {
  chosenOption,
  createJevClient,
  MAX_RESPONSE_BYTES,
  noulProbability,
  scoreValue,
  validateResponse,
  validQuestions,
  type FetchFn,
  type JevClientOptions,
} from "../../../src/jev/client.ts"
import type { JevKey, JevKeyProvider, JevQuestions, JevRequest } from "../../../src/jev/types.ts"

const KEY = "ts-test-not-a-real-key"
const keys = (key: string | null = KEY): JevKeyProvider => ({
  resolve: async (): Promise<JevKey | undefined> => (key ? { key, source: "env" } : undefined),
})

const questions: JevQuestions = {
  danger: { type: "noul", instructions: "Is it destructive?" },
  kind: { type: "choice", instructions: "Kind?", criteria: { assertion: "a", syntax: "s", timeout: "t" } },
  depth: { type: "score", instructions: "Depth?", criteria: ["low", "mid", "high", "max"] },
}

const goodBody = (extra: Record<string, unknown> = {}) => ({
  model: "jev-1.14.0-r2",
  answers: {
    danger: { type: "noul", noul: 0.83 },
    kind: { type: "choice", choice: "syntax", confidence: 0.9, probabilities: { assertion: 0.1, syntax: 0.9 } },
    depth: { type: "score", score: 2.4, legend: { "2": "high" } },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
  ...extra,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Call {
  url: string
  init: RequestInit
}

function setup(handler: (call: Call) => Response | Promise<Response>, overrides: Partial<JevClientOptions> = {}) {
  const calls: Call[] = []
  const fetchFn: FetchFn = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  const client = createJevClient({
    baseURL: "https://api.typesafe.ai",
    model: "jev-1.14.0",
    keys: keys(),
    locationScope: "/work/a",
    fetch: fetchFn,
    cache: createJevCache(),
    ...overrides,
  })
  return { client, calls }
}

const request = (overrides: Partial<JevRequest> = {}): JevRequest => ({
  state: { commands: ["rm -rf build"] },
  questions,
  timeoutMs: 1000,
  ...overrides,
})

describe("request", () => {
  test("posts model, state, and questions with the key only in Authorization", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    const result = await client.decide(request())
    expect(result.ok).toBe(true)
    const [call] = calls
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(call?.init.method).toBe("POST")
    expect(call?.init.redirect).toBe("error")
    const headers = call?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(String(call?.init.body)).not.toContain(KEY)
    expect(JSON.parse(String(call?.init.body))).toEqual({ model: "jev-1.14.0", state: { commands: ["rm -rf build"] }, questions })
  })

  test("redacts the state, including the literal key, before it leaves", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    await client.decide(request({ state: { commands: [`curl -H "Authorization: Bearer abcdef0123456789" --data ${KEY}`, "echo password=hunter2"] } }))
    const body = String(calls[0]?.init.body)
    for (const secret of ["abcdef0123456789", KEY, "hunter2"]) expect(body).not.toContain(secret)
    expect(body).toContain("[REDACTED]")
  })

  test("custom base URL and trailing slash", async () => {
    const { client, calls } = setup(() => json(goodBody()), { baseURL: "http://127.0.0.1:9999/" })
    await client.decide(request())
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/v1/systemone")
  })

  test("rejects invalid requests without a network call", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    const bad: JevRequest[] = [
      request({ timeoutMs: Number.NaN }),
      request({ questions: {} }),
      request({ questions: { "bad id!": questions.danger! } }),
      request({ questions: { q: { type: "choice", instructions: "x", criteria: {} } } }),
      request({ questions: { q: { type: "score", instructions: "x", criteria: [] } } }),
      request({ questions: { q: { type: "weird", instructions: "x" } as never } }),
      request({ state: { big: "x".repeat(300_000) } }),
    ]
    for (const item of bad) expect(await client.decide(item)).toEqual({ ok: false, error: { code: "invalid-request" } })
    expect(calls.length).toBe(0)
  })

  test("no key skips the request", async () => {
    const { client, calls } = setup(() => json(goodBody()), { keys: keys(null) })
    expect(await client.decide(request())).toEqual({ ok: false, error: { code: "no-key" } })
    expect(calls.length).toBe(0)
  })
})

describe("response", () => {
  test("typed answers, upstream model, tokens", async () => {
    const { client } = setup(() => json(goodBody()))
    const result = await client.decide(request())
    if (!result.ok) throw new Error("expected success")
    expect(result.value.model).toBe("jev-1.14.0-r2")
    expect(result.value.requestedModel).toBe("jev-1.14.0")
    expect(result.value.cached).toBe(false)
    expect(result.value.inputTokens).toBe(120)
    expect(noulProbability(result.value, "danger")).toBe(0.83)
    expect(chosenOption(result.value, "kind")).toBe("syntax")
    expect(scoreValue(result.value, "depth")).toBe(2.4)
    expect(() => noulProbability(result.value, "kind")).toThrow()
  })

  test("the model comes from the response, not from the request alias", async () => {
    const { client } = setup(() => json(goodBody({ model: "jev-1.13.0" })), { model: "jev-latest" })
    const result = await client.decide(request())
    expect(result.ok && result.value.model).toBe("jev-1.13.0")
    expect(result.ok && result.value.requestedModel).toBe("jev-latest")
  })

  const invalid: Array<[string, (body: ReturnType<typeof goodBody>) => unknown]> = [
    ["probability above 1", (b) => ({ ...b, answers: { ...b.answers, danger: { type: "noul", noul: 1.2 } } })],
    ["negative probability", (b) => ({ ...b, answers: { ...b.answers, danger: { type: "noul", noul: -0.1 } } })],
    ["string probability", (b) => ({ ...b, answers: { ...b.answers, danger: { type: "noul", noul: "0.5" } } })],
    ["wrong type", (b) => ({ ...b, answers: { ...b.answers, danger: { type: "choice", choice: "x" } } })],
    ["choice outside options", (b) => ({ ...b, answers: { ...b.answers, kind: { type: "choice", choice: "other" } } })],
    ["choice probability key outside options", (b) => ({ ...b, answers: { ...b.answers, kind: { type: "choice", choice: "syntax", probabilities: { other: 0.5 } } } })],
    ["choice probability above 1", (b) => ({ ...b, answers: { ...b.answers, kind: { type: "choice", choice: "syntax", probabilities: { syntax: 2 } } } })],
    ["confidence out of range", (b) => ({ ...b, answers: { ...b.answers, kind: { type: "choice", choice: "syntax", confidence: 5 } } })],
    ["score above the levels", (b) => ({ ...b, answers: { ...b.answers, depth: { type: "score", score: 3.5 } } })],
    ["negative score", (b) => ({ ...b, answers: { ...b.answers, depth: { type: "score", score: -1 } } })],
    ["missing answer", (b) => ({ ...b, answers: { danger: b.answers.danger } })],
    ["model with bad characters", (b) => ({ ...b, model: "jev\nsecret" })],
    ["missing model", (b) => ({ answers: b.answers })],
    ["not an object", () => []],
  ]
  test.each(invalid)("rejects %s", async (_name, mutate) => {
    const { client } = setup(() => json(mutate(goodBody())))
    expect(await client.decide(request())).toEqual({ ok: false, error: { code: "invalid-response" } })
  })

  test("score and choice without probabilities are valid, as in the official schema", async () => {
    const body = goodBody()
    const lean = { ...body, answers: { danger: body.answers.danger, kind: { type: "choice", choice: "timeout" }, depth: { type: "score", score: 0 } } }
    const { client } = setup(() => json(lean))
    const result = await client.decide(request())
    expect(result.ok).toBe(true)
  })

  test("invalid JSON", async () => {
    const { client } = setup(() => new Response("not json {"))
    expect(await client.decide(request())).toEqual({ ok: false, error: { code: "invalid-json" } })
  })

  test("a response above the size limit is refused", async () => {
    const { client } = setup(() => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)))
    expect(await client.decide(request())).toEqual({ ok: false, error: { code: "invalid-response" } })
  })

  test("validateResponse and validQuestions are pure helpers", () => {
    expect(validateResponse(goodBody(), questions)?.model).toBe("jev-1.14.0-r2")
    expect(validateResponse(goodBody(), { danger: questions.danger! })?.answers.danger).toEqual({ type: "noul", noul: 0.83 })
    expect(validQuestions(questions)).toBe(true)
    expect(validQuestions(null)).toBe(false)
  })
})

describe("failures", () => {
  const statuses: Array<[number, string]> = [
    [400, "bad-request"],
    [401, "unauthorized"],
    [413, "payload-too-large"],
    [415, "unsupported-media-type"],
    [422, "unprocessable"],
    [429, "rate-limited"],
    [529, "overloaded"],
    [503, "http-error"],
  ]
  test.each(statuses)("HTTP %d maps to %s without upstream text", async (status, code) => {
    const { client } = setup(() => new Response(`upstream says ${KEY} and prompt text`, { status }))
    const result = await client.decide(request())
    expect(result).toEqual({ ok: false, error: { code, status } as never })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  test("network error becomes network without the message", async () => {
    const { client } = setup(() => {
      throw new Error(`socket failed for ${KEY}`)
    })
    const result = await client.decide(request())
    expect(result).toEqual({ ok: false, error: { code: "network" } })
  })

  test("timeout aborts the request", async () => {
    let aborted = false
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        }),
    )
    const result = await client.decide(request({ timeoutMs: 60 }))
    expect(result).toEqual({ ok: false, error: { code: "timeout" } })
    expect(aborted).toBe(true)
  })

  test("caller abort", async () => {
    const controller = new AbortController()
    const { client } = setup(({ init }) => new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("x")))))
    const pending = client.decide(request({ signal: controller.signal, timeoutMs: 5000 }))
    setTimeout(() => controller.abort(), 20)
    expect(await pending).toEqual({ ok: false, error: { code: "aborted" } })
    expect(await client.decide(request({ signal: controller.signal }))).toEqual({ ok: false, error: { code: "aborted" } })
  })

  test("dispose cancels calls in flight and later calls fail", async () => {
    let aborted = false
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_r, reject) =>
          init.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("x"))
          }),
        ),
    )
    const pending = client.decide(request({ timeoutMs: 5000 }))
    await Bun.sleep(20)
    client.dispose()
    expect(await pending).toEqual({ ok: false, error: { code: "disposed" } })
    expect(aborted).toBe(true)
    expect(await client.decide(request())).toEqual({ ok: false, error: { code: "disposed" } })
  })
})

describe("cache and in-flight sharing", () => {
  test("a success is cached; the second call does not fetch", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    const first = await client.decide(request())
    const second = await client.decide(request())
    expect(calls.length).toBe(1)
    expect(first.ok && first.value.cached).toBe(false)
    expect(second.ok && second.value.cached).toBe(true)
    expect(second.ok && second.value.model).toBe("jev-1.14.0-r2")
  })

  test("failures are never cached", async () => {
    let status = 529
    const { client, calls } = setup(() => (status === 200 ? json(goodBody()) : new Response("", { status })))
    expect((await client.decide(request())).ok).toBe(false)
    status = 200
    expect((await client.decide(request())).ok).toBe(true)
    expect(calls.length).toBe(2)
  })

  test("another credential, location, endpoint, or model never reads the entry", async () => {
    const cache = createJevCache()
    const make = (overrides: Partial<JevClientOptions>) => {
      const calls: number[] = []
      const client = createJevClient({
        baseURL: "https://api.typesafe.ai",
        model: "jev-1.14.0",
        keys: keys(),
        locationScope: "/work/a",
        cache,
        fetch: async () => {
          calls.push(1)
          return json(goodBody())
        },
        ...overrides,
      })
      return { client, calls }
    }
    const a = make({})
    await a.client.decide(request())
    expect(a.calls.length).toBe(1)
    for (const overrides of [
      { keys: keys("ts-test-other-account-key") },
      { locationScope: "/work/b" },
      { baseURL: "http://127.0.0.1:9999" },
      { model: "jev-1.13.0" },
    ]) {
      const other = make(overrides)
      await other.client.decide(request())
      expect(other.calls.length).toBe(1)
    }
    const same = make({})
    await same.client.decide(request())
    expect(same.calls.length).toBe(0)
  })

  test("identical calls in flight share one request", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { client, calls } = setup(async () => {
      await gate
      return json(goodBody())
    })
    const results = [client.decide(request()), client.decide(request()), client.decide(request())]
    await Bun.sleep(20)
    release()
    const settled = await Promise.all(results)
    expect(calls.length).toBe(1)
    expect(settled.every((item) => item.ok)).toBe(true)
  })

  test("one waiter that aborts does not cancel the shared request", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { client, calls } = setup(async ({ init }) => {
      await gate
      if (init.signal?.aborted) throw new Error("aborted")
      return json(goodBody())
    })
    const controller = new AbortController()
    const a = client.decide(request({ signal: controller.signal }))
    const b = client.decide(request())
    await Bun.sleep(20)
    controller.abort()
    release()
    expect(await a).toEqual({ ok: false, error: { code: "aborted" } })
    expect((await b).ok).toBe(true)
    expect(calls.length).toBe(1)
  })
})

describe("concurrency", () => {
  test("at most maxConcurrent requests run at once; the rest wait and then run", async () => {
    let active = 0
    let peak = 0
    const { client } = setup(
      async () => {
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(30)
        active--
        return json(goodBody())
      },
      { maxConcurrent: 2 },
    )
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => client.decide(request({ state: { n: index }, timeoutMs: 5000 }))))
    expect(results.every((item) => item.ok)).toBe(true)
    expect(peak).toBe(2)
  })

  test("a full queue fails with busy", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { client } = setup(
      async () => {
        await gate
        return json(goodBody())
      },
      { maxConcurrent: 1, maxQueued: 1 },
    )
    const pending = [0, 1, 2].map((index) => client.decide(request({ state: { n: index }, timeoutMs: 5000 })))
    await Bun.sleep(30)
    release()
    const results = await Promise.all(pending)
    expect(results.filter((item) => item.ok).length).toBe(2)
    expect(results.find((item) => !item.ok)).toEqual({ ok: false, error: { code: "busy" } })
  })

  test("queue wait counts toward the timeout", async () => {
    const { client } = setup(() => new Promise<Response>(() => undefined), { maxConcurrent: 1 })
    const first = client.decide(request({ state: { n: 1 }, timeoutMs: 80 }))
    const second = client.decide(request({ state: { n: 2 }, timeoutMs: 60 }))
    expect(await second).toEqual({ ok: false, error: { code: "timeout" } })
    expect(await first).toEqual({ ok: false, error: { code: "timeout" } })
  })
})

describe("key resolution is bounded", () => {
  const hanging = (): { provider: JevKeyProvider; resolveLate: (key: string) => void; calls: () => number } => {
    let resolveKey!: (value: JevKey | undefined) => void
    let calls = 0
    const shared = new Promise<JevKey | undefined>((resolve) => (resolveKey = resolve))
    return {
      provider: { resolve: () => ((calls += 1), shared) },
      resolveLate: (key) => resolveKey({ key, source: "env" }),
      calls: () => calls,
    }
  }

  test("a key that never resolves times out inside the call timeout", async () => {
    const { provider } = hanging()
    const { client, calls } = setup(() => json(goodBody()), { keys: provider })
    const started = Date.now()
    expect(await client.decide(request({ timeoutMs: 80 }))).toEqual({ ok: false, error: { code: "timeout" } })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls.length).toBe(0)
  })

  test("a key that arrives after the timeout starts no request", async () => {
    const hang = hanging()
    const { client, calls } = setup(() => json(goodBody()), { keys: hang.provider })
    expect(await client.decide(request({ timeoutMs: 60 }))).toEqual({ ok: false, error: { code: "timeout" } })
    hang.resolveLate(KEY)
    await Bun.sleep(30)
    expect(calls.length).toBe(0)
  })

  test("caller abort settles a call that waits for the key", async () => {
    const hang = hanging()
    const { client, calls } = setup(() => json(goodBody()), { keys: hang.provider })
    const controller = new AbortController()
    const pending = client.decide(request({ signal: controller.signal, timeoutMs: 5000 }))
    setTimeout(() => controller.abort(), 20)
    expect(await pending).toEqual({ ok: false, error: { code: "aborted" } })
    hang.resolveLate(KEY)
    await Bun.sleep(20)
    expect(calls.length).toBe(0)
  })

  test("dispose settles a call that waits for the key", async () => {
    const hang = hanging()
    const { client, calls } = setup(() => json(goodBody()), { keys: hang.provider })
    const pending = client.decide(request({ timeoutMs: 5000 }))
    await Bun.sleep(20)
    client.dispose()
    expect(await pending).toEqual({ ok: false, error: { code: "disposed" } })
    hang.resolveLate(KEY)
    await Bun.sleep(20)
    expect(calls.length).toBe(0)
  })

  test("a rejecting key provider is no-key, with no detached rejection", async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => void unhandled.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const provider: JevKeyProvider = { resolve: () => Promise.reject(new Error(`boom ${KEY}`)) }
      const { client } = setup(() => json(goodBody()), { keys: provider })
      expect(await client.decide(request())).toEqual({ ok: false, error: { code: "no-key" } })
      // A provider that rejects after the call timed out must not leave an unhandled rejection either.
      let reject!: (error: Error) => void
      const late: JevKeyProvider = { resolve: () => new Promise((_resolve, rej) => (reject = rej)) }
      const second = setup(() => json(goodBody()), { keys: late })
      expect(await second.client.decide(request({ timeoutMs: 50 }))).toEqual({ ok: false, error: { code: "timeout" } })
      reject(new Error("late"))
      await Bun.sleep(30)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", listener)
    }
  })

  test("callers share one pending provider call but each is bounded by its own deadline", async () => {
    const hang = hanging()
    const { client, calls } = setup(() => json(goodBody()), { keys: hang.provider })
    const short = client.decide(request({ timeoutMs: 60 }))
    const long = client.decide(request({ timeoutMs: 400 }))
    expect(await short).toEqual({ ok: false, error: { code: "timeout" } })
    // The long call is still waiting. The shared key arrives, and the long call completes.
    hang.resolveLate(KEY)
    const result = await long
    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  test("the whole call stays within the timeout when the key is slow, then the request is slow", async () => {
    const slowKey: JevKeyProvider = { resolve: async () => (await Bun.sleep(60), { key: KEY, source: "env" as const }) }
    const { client } = setup(({ init }) => new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("x")))), { keys: slowKey })
    const started = Date.now()
    expect(await client.decide(request({ timeoutMs: 150 }))).toEqual({ ok: false, error: { code: "timeout" } })
    expect(Date.now() - started).toBeLessThan(400)
  })
})

describe("shared requests keep each caller's deadline", () => {
  test("a first caller that times out does not cut a longer joiner", async () => {
    const { client, calls } = setup(async () => {
      await Bun.sleep(250)
      return json(goodBody())
    })
    const first = client.decide(request({ timeoutMs: 100 }))
    const second = client.decide(request({ timeoutMs: 5000 }))
    expect(await first).toEqual({ ok: false, error: { code: "timeout" } })
    const result = await second
    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  test("the first caller aborting does not cancel the second", async () => {
    let aborted = false
    const { client, calls } = setup(async ({ init }) => {
      init.signal?.addEventListener("abort", () => (aborted = true))
      await Bun.sleep(150)
      return json(goodBody())
    })
    const controller = new AbortController()
    const first = client.decide(request({ signal: controller.signal, timeoutMs: 5000 }))
    const second = client.decide(request({ timeoutMs: 5000 }))
    setTimeout(() => controller.abort(), 30)
    expect(await first).toEqual({ ok: false, error: { code: "aborted" } })
    expect((await second).ok).toBe(true)
    expect(aborted).toBe(false)
    expect(calls.length).toBe(1)
  })

  test("the request aborts when its last caller leaves", async () => {
    let aborted = false
    const { client } = setup(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("x"))
          }),
        ),
    )
    const a = client.decide(request({ timeoutMs: 60 }))
    const b = client.decide(request({ timeoutMs: 90 }))
    expect(await a).toEqual({ ok: false, error: { code: "timeout" } })
    expect(aborted).toBe(false)
    expect(await b).toEqual({ ok: false, error: { code: "timeout" } })
    await Bun.sleep(10)
    expect(aborted).toBe(true)
  })
})

describe("input that redaction cannot process whole is never sent", () => {
  test("an oversize string in the state gives invalid-request and no request", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    const result = await client.decide(request({ state: { commands: ["x".repeat(4 * 1024 * 1024 + 1)] } }))
    expect(result).toEqual({ ok: false, error: { code: "invalid-request" } })
    expect(calls.length).toBe(0)
  })

  test("a structure that is too deep gives invalid-request", async () => {
    let deep: unknown = "leaf"
    for (let index = 0; index < 40; index++) deep = { a: deep }
    const { client, calls } = setup(() => json(goodBody()))
    expect(await client.decide(request({ state: deep as never }))).toEqual({ ok: false, error: { code: "invalid-request" } })
    expect(calls.length).toBe(0)
  })

  test("the oversize marker is never part of a request body", async () => {
    const { client, calls } = setup(() => json(goodBody()))
    await client.decide(request({ state: { commands: ["x".repeat(4 * 1024 * 1024 + 1)] } }))
    await client.decide(request())
    expect(calls.every((call) => !String(call.init.body).includes("too large to redact"))).toBe(true)
  })
})

describe("redirects", () => {
  test("a real 307 to another listener is refused: no request and no Authorization reaches the target", async () => {
    const seen: Array<{ authorization: string | null }> = []
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ authorization: req.headers.get("authorization") })
        return Response.json(goodBody())
      },
    })
    const origin = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/v1/systemone` } })
      },
    })
    try {
      const client = createJevClient({
        baseURL: `http://127.0.0.1:${origin.port}`,
        model: "jev-1.14.0",
        keys: keys(),
        locationScope: "/work/a",
        cache: createJevCache(),
      })
      const result = await client.decide(request({ timeoutMs: 3000 }))
      expect(result).toEqual({ ok: false, error: { code: "network" } })
      await Bun.sleep(50)
      expect(seen).toEqual([])
    } finally {
      await origin.stop(true)
      await target.stop(true)
    }
  })
})
