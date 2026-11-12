import { describe, expect, test } from "bun:test"
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  createJevCache,
  credentialFingerprint,
  globalJevCache,
  jevCacheKey,
  type JevCacheIdentity,
} from "../../../src/jev/cache.ts"
import type { JevDecisionData } from "../../../src/jev/types.ts"

const data = (model = "jev-1.14.0"): JevDecisionData => ({ model, answers: { q: { type: "noul", noul: 0.5 } } })

describe("createJevCache", () => {
  test("entries expire after the lifetime", () => {
    let time = 1000
    const cache = createJevCache({ now: () => time })
    cache.set("k", data())
    time += CACHE_TTL_MS - 1
    expect(cache.get("k")?.model).toBe("jev-1.14.0")
    time += 1
    expect(cache.get("k")).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test("limits above the hard caps are lowered", () => {
    let time = 0
    const cache = createJevCache({ ttlMs: 10 * CACHE_TTL_MS, maxEntries: 10 * CACHE_MAX_ENTRIES, now: () => time })
    cache.set("k", data())
    time += CACHE_TTL_MS
    expect(cache.get("k")).toBeUndefined()
    for (let index = 0; index < CACHE_MAX_ENTRIES + 50; index++) cache.set(`k${index}`, data())
    expect(cache.size).toBe(CACHE_MAX_ENTRIES)
    expect(cache.get("k0")).toBeUndefined()
    expect(cache.get(`k${CACHE_MAX_ENTRIES + 49}`)).toBeDefined()
  })

  test("eviction drops expired entries first, then the oldest", () => {
    let time = 0
    const cache = createJevCache({ maxEntries: 3, now: () => time })
    cache.set("a", data())
    time += 100
    cache.set("b", data())
    cache.set("c", data())
    cache.set("d", data())
    expect(cache.get("a")).toBeUndefined()
    expect(cache.size).toBe(3)
  })

  test("get and set return and store private copies", () => {
    const cache = createJevCache()
    const original = data()
    cache.set("k", original)
    const first = cache.get("k") as { answers: Record<string, { noul: number }> }
    first.answers.q!.noul = 0.99
    expect((cache.get("k")?.answers.q as { noul: number }).noul).toBe(0.5)
    ;(original.answers as Record<string, unknown>).q = { type: "noul", noul: 0.1 }
    expect((cache.get("k")?.answers.q as { noul: number }).noul).toBe(0.5)
  })

  test("clear empties the cache", () => {
    const cache = createJevCache()
    cache.set("k", data())
    cache.clear()
    expect(cache.size).toBe(0)
  })

  test("globalJevCache returns one process-wide instance", () => {
    expect(globalJevCache()).toBe(globalJevCache())
  })
})

describe("jevCacheKey", () => {
  const base: JevCacheIdentity = {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    credential: credentialFingerprint("sk-test-key-a"),
    location: "/work/a",
    model: "jev-1.14.0",
    state: { commands: ["ls"] },
    questions: { q: { type: "noul", instructions: "?" } },
  }

  test("is stable and every part changes the key", () => {
    const key = jevCacheKey(base)
    expect(jevCacheKey({ ...base })).toBe(key)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    const variants: Partial<JevCacheIdentity>[] = [
      { endpoint: "https://other.example.com/v1/systemone" },
      { credential: credentialFingerprint("sk-test-key-b") },
      { location: "/work/b" },
      { model: "jev-1.13.0" },
      { state: { commands: ["rm -rf x"] } },
      { questions: { q: { type: "noul", instructions: "other" } } },
    ]
    for (const variant of variants) expect(jevCacheKey({ ...base, ...variant })).not.toBe(key)
  })

  test("parts cannot run into each other", () => {
    const a = jevCacheKey({ ...base, location: "ab", model: "c" })
    const b = jevCacheKey({ ...base, location: "a", model: "bc" })
    expect(a).not.toBe(b)
  })

  test("fingerprint does not contain the key", () => {
    expect(credentialFingerprint("sk-test-key-a")).not.toContain("sk-test")
    expect(credentialFingerprint("sk-test-key-a")).toBe(credentialFingerprint("sk-test-key-a"))
  })
})
