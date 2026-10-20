import { describe, expect, test } from "bun:test"
import { DiscoveryError, fetchModelIDs, readCachedModels, STORAGE_KEY, writeCachedModels } from "../../../src/fuelix/discovery.ts"

const KEY = "sk-test-not-a-real-key"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("fetchModelIDs", () => {
  test("returns sorted unique IDs and sends a Bearer header", async () => {
    const seen: { url: string; headers: Headers }[] = []
    const ids = await fetchModelIDs({
      baseURL: "https://api.example.test",
      key: KEY,
      timeoutMs: 1000,
      fetch: async (url, init) => {
        seen.push({ url, headers: new Headers(init?.headers) })
        return json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { object: "model" }] })
      },
    })
    expect(ids).toEqual(["a", "b"])
    expect(seen[0]?.url).toBe("https://api.example.test/v1/models")
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("HTTP errors carry the status and not the key", async () => {
    const error = await fetchModelIDs({
      baseURL: "https://api.example.test",
      key: KEY,
      timeoutMs: 1000,
      fetch: async () => json({ error: KEY }, 401),
    }).catch((e) => e)
    expect(error).toBeInstanceOf(DiscoveryError)
    expect(error.status).toBe(401)
    expect(error.message).toContain("401")
    expect(error.message).not.toContain(KEY)
  })

  test("network errors do not leak the key", async () => {
    const error = await fetchModelIDs({
      baseURL: "https://api.example.test",
      key: KEY,
      timeoutMs: 1000,
      fetch: async () => {
        throw new Error(`boom ${KEY}`)
      },
    }).catch((e) => e)
    expect(error).toBeInstanceOf(DiscoveryError)
    expect(error.message).not.toContain(KEY)
  })

  test("rejects an unexpected body", async () => {
    const error = await fetchModelIDs({ baseURL: "https://x.test", key: KEY, timeoutMs: 1000, fetch: async () => json({ nope: true }) }).catch((e) => e)
    expect(error).toBeInstanceOf(DiscoveryError)
  })

  test("times out when fetch never answers", async () => {
    const started = Date.now()
    const error = await fetchModelIDs({ baseURL: "https://x.test", key: KEY, timeoutMs: 30, fetch: () => new Promise<Response>(() => {}) }).catch((e) => e)
    expect(error).toBeInstanceOf(DiscoveryError)
    expect(error.message).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("model cache", () => {
  test("round-trips through storage", async () => {
    const store = new Map<string, unknown>()
    const storage = { get: async (k: string) => store.get(k) as never, set: async (k: string, v: unknown) => void store.set(k, v) }
    await writeCachedModels(storage as never, ["a", "b"], new Date("2026-10-19T00:00:00.000Z"))
    expect(store.get(STORAGE_KEY)).toEqual({ fetchedAt: "2026-10-19T00:00:00.000Z", ids: ["a", "b"] })
    expect(await readCachedModels(storage as never)).toEqual({ fetchedAt: "2026-10-19T00:00:00.000Z", ids: ["a", "b"] })
  })

  test("ignores a missing or malformed cache", async () => {
    expect(await readCachedModels({ get: async () => undefined } as never)).toBeUndefined()
    expect(await readCachedModels({ get: async () => ({ ids: "no" }) } as never)).toBeUndefined()
    expect(await readCachedModels({ get: async () => { throw new Error("x") } } as never)).toBeUndefined()
  })
})
