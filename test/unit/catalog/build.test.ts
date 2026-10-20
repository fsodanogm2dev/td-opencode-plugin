import { describe, expect, test } from "bun:test"
import {
  FORBIDDEN_SUBSTRINGS,
  buildCatalog,
  formatSummary,
  serializeCatalog,
  stabilizeTimestamp,
  summarize,
} from "../../../scripts/lib/build.ts"
import { parseIds } from "../../../scripts/lib/ids.ts"
import { fixtureCatalog, fixtureDeployments, fixtureSeed } from "./helpers.ts"

describe("catalog build", () => {
  test("applies the pricing policy to a multi-deployment ID", async () => {
    const { models } = await fixtureCatalog()
    const alpha = models.alpha
    expect(alpha?.provider).toBe("fuelix-anthropic")
    expect(alpha?.sources).toEqual({ routing: "config", metadata: "inventory" })
    expect(alpha?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(alpha?.limit).toEqual({ context: 200000, output: 64000 })
    expect(alpha?.input).toEqual(["text", "image", "pdf"])
    expect(alpha?.tools).toBe(true)
    expect(alpha?.reasoning).toBe(true)
    expect(alpha?.costTiers).toBeUndefined()
    expect(alpha?.notes?.[0]).toContain("vertex_ai/alpha@default")
    expect(alpha?.notes?.some((note) => note.startsWith("Price spread"))).toBe(true)
  })

  test("adds a 200k tier only when prices differ from base", async () => {
    const { models } = await fixtureCatalog()
    expect(models.beta?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(models.beta?.costTiers).toEqual([
      { contextOver: 200000, input: 6, output: 22.5, cacheRead: 0.3, cacheWrite: 3.75 },
    ])
    expect(models.beta?.limit).toEqual({ context: 400000, output: 100000 })
    expect(models.beta?.status).toBe("deprecated")
    expect(models.alpha?.costTiers).toBeUndefined()
  })

  test("falls back to the seed for fields that the inventory lacks", async () => {
    const { models } = await fixtureCatalog()
    expect(models["seed-only"]?.sources).toEqual({ routing: "config", metadata: "config" })
    expect(models["seed-only"]?.cost).toEqual({ input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.6 })
    expect(models["seed-only"]?.limit).toEqual({ context: 128000, output: 8000 })
    expect(models["seed-only"]?.notes?.[0]).toContain("No active inventory deployment")
    expect(models.emb?.sources.metadata).toBe("inventory")
    expect(models.emb?.cost).toBeUndefined()
  })

  test("uses the inventory kind, and keeps image-capable chat models as chat", async () => {
    const { models } = await fixtureCatalog()
    expect(models.emb?.kind).toBe("embedding")
    expect(models["img-chat"]?.kind).toBe("chat")
    expect(models["img-chat"]?.output).toEqual(["text", "image"])
  })

  test("routes live IDs without a seed entry by rule and marks live IDs as listed", async () => {
    const { models } = await fixtureCatalog(["alpha", "no-cost", "claude-brand-new", "gpt-9", "gemma-9"])
    expect(models["claude-brand-new"]).toMatchObject({
      provider: "fuelix-anthropic",
      kind: "chat",
      listed: true,
      sources: { routing: "rule", metadata: "none" },
    })
    expect(models["gpt-9"]?.provider).toBe("fuelix-openai")
    expect(models["gemma-9"]?.provider).toBe("fuelix")
    expect(models.alpha?.listed).toBe(true)
    expect(models.alpha?.sources.routing).toBe("config")
    expect(models.beta?.listed).toBeUndefined()
    expect(models["no-cost"]?.cost).toBeUndefined()
  })

  test("summary lists chat entries without cost or limit", async () => {
    const summary = summarize(await fixtureCatalog(["no-cost", "claude-brand-new"]))
    expect(summary.chatMissing.map((item) => item.id)).toEqual(["claude-brand-new", "no-cost"])
    expect(summary.byProvider["fuelix-anthropic"]).toBe(2)
    expect(summary.byKind.embedding).toBe(1)
    expect(formatSummary(summary)).toContain("no-cost: missing cost, limit")
  })

  test("output is deterministic and sorted by ID", async () => {
    const seed = await fixtureSeed()
    const deployments = await fixtureDeployments()
    const make = (reverse: boolean) =>
      serializeCatalog(
        buildCatalog({
          seed: new Map(reverse ? [...seed.entries()].reverse() : seed),
          deployments: reverse ? [...deployments].reverse() : deployments,
          liveIds: reverse ? ["no-cost", "alpha"] : ["alpha", "no-cost"],
          generatedAt: "2026-01-01T00:00:00.000Z",
          sources: ["fixture"],
        }),
      )
    const first = make(false)
    expect(make(true)).toBe(first)
    expect(first.endsWith("}\n")).toBe(true)
    const ids = Object.keys(JSON.parse(first).models)
    expect(ids).toEqual([...ids].sort())
    expect(first).toContain('\n  "version": 1,')
  })

  test("never emits secrets", async () => {
    const text = serializeCatalog(await fixtureCatalog(["alpha"]))
    for (const word of FORBIDDEN_SUBSTRINGS) expect(text).not.toContain(word)
    expect(text).not.toContain("AKIA")
    expect(text).not.toContain("fake-aws")
  })

  test("serialization stops when the output holds a forbidden string", async () => {
    const catalog = await fixtureCatalog()
    const bad = { ...catalog, sources: ["leak sk-test-not-a-real-key"] }
    expect(() => serializeCatalog(bad)).toThrow("forbidden")
  })

  test("keeps generatedAt when nothing else changed", async () => {
    const catalog = await fixtureCatalog()
    const existing = serializeCatalog(catalog)
    const later = { ...catalog, generatedAt: "2030-01-01T00:00:00.000Z" }
    expect(stabilizeTimestamp(existing, later)).toBe(existing)
    const changed = { ...later, sources: ["other"] }
    expect(stabilizeTimestamp(existing, changed)).toBe(serializeCatalog(changed))
    expect(stabilizeTimestamp(undefined, later)).toBe(serializeCatalog(later))
  })
})

describe("id parsing", () => {
  test("accepts a /v1/models response, an array, and lines", () => {
    expect(parseIds('{"object":"list","data":[{"id":"b"},{"id":"a"},{"id":"a"}]}')).toEqual(["a", "b"])
    expect(parseIds('["z","y"]')).toEqual(["y", "z"])
    expect(parseIds("c\n\n b \r\nc\n")).toEqual(["b", "c"])
  })
})
