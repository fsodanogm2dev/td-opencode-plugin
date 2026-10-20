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
  test("takes price from the inventory and limits and capabilities from the seed", async () => {
    const { models } = await fixtureCatalog()
    const alpha = models.alpha
    expect(alpha?.provider).toBe("fuelix-anthropic")
    expect(alpha?.sources).toEqual({ routing: "config", metadata: "mixed" })
    // Price: inventory (highest input price), not the seed price 4/20.
    expect(alpha?.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    // Limit and capabilities: seed. The inventory minimum would be 200000/64000.
    expect(alpha?.limit).toEqual({ context: 500000, output: 64000 })
    expect(alpha?.input).toEqual(["text", "image", "pdf"])
    expect(alpha?.tools).toBe(true)
    // The seed has no reasoning flag, so the inventory value applies.
    expect(alpha?.reasoning).toBe(true)
    expect(alpha?.notes).toContain(
      "Inventory limit 200000/64000 (context/output) differs from the configured 500000/64000; configured value kept.",
    )
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
    expect(models.emb?.sources.metadata).toBe("config")
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

describe("seed-first policy", () => {
  test("keeps the configured limit and modalities and notes the differences", async () => {
    const { models } = await fixtureCatalog()
    expect(models.beta?.limit).toEqual({ context: 400000, output: 100000 })
    expect(models.beta?.notes?.some((note) => note.includes("differs"))).toBe(false)
    const alpha = models.alpha
    expect(alpha?.notes?.some((note) => note.startsWith("Inventory limit"))).toBe(true)
  })

  test("notes a modality difference and keeps the configured modalities", () => {
    const models = buildCatalog({
      seed: new Map([["m", { provider: "fuelix", inputModalities: ["text", "image", "pdf"] }]]),
      deployments: [
        {
          deployment: "azure/m",
          provider: "azure",
          modelName: "m",
          aliases: ["m"],
          active: true,
          kind: "chat",
          modalities: ["text"],
          prices: { input: 1e-6, output: 2e-6 },
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["test"],
    }).models
    expect(models.m?.input).toEqual(["text", "image", "pdf"])
    expect(models.m?.notes).toContain(
      "Inventory input modalities text differ from the configured text,image,pdf; configured value kept.",
    )
  })

  test("uses the inventory limit when the seed has none, and prefers the seed for capabilities", () => {
    const models = buildCatalog({
      seed: new Map([
        ["m", { provider: "fuelix" as const, tools: false }],
        ["n", { provider: "fuelix" as const, context: 10000 }],
      ]),
      deployments: [
        {
          deployment: "azure/m",
          provider: "azure",
          modelName: "m",
          aliases: ["m"],
          active: true,
          kind: "chat",
          tools: true,
          reasoning: true,
          context: 200000,
          output: 100000,
          prices: { input: 1e-6, output: 2e-6 },
        },
        {
          deployment: "azure/n",
          provider: "azure",
          modelName: "n",
          aliases: ["n"],
          active: true,
          kind: "chat",
          context: 5000,
          output: 2000,
          prices: { input: 1e-6, output: 2e-6 },
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["test"],
    }).models
    expect(models.m?.limit).toEqual({ context: 200000, output: 100000 })
    expect(models.m?.tools).toBe(false)
    expect(models.m?.reasoning).toBe(true)
    expect(models.m?.sources.metadata).toBe("mixed")
    // Components are taken one by one: seed context, inventory output.
    expect(models.n?.limit).toEqual({ context: 10000, output: 2000 })
  })
})

describe("inventory limit sanity rule", () => {
  const base = {
    provider: "azure",
    modelName: "m",
    aliases: ["m"],
    active: true,
    kind: "chat" as const,
    prices: { input: 1e-6, output: 2e-6 },
  }

  test("ignores an output limit that is not below the context limit", () => {
    const models = buildCatalog({
      seed: new Map([["m", { provider: "fuelix" as const }]]),
      deployments: [{ ...base, deployment: "vertex_ai/m", context: 10_000_000, output: 10_000_000 }],
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["test"],
    }).models
    expect(models.m?.limit).toBeUndefined()
    expect(models.m?.notes).toContain(
      "Inventory output limit ignored, because it is not below the context limit: vertex_ai/m (output 10000000, context 10000000).",
    )
  })

  test("still uses the inventory context when the seed has the output", () => {
    const models = buildCatalog({
      seed: new Map([["m", { provider: "fuelix" as const, output: 8192 }]]),
      deployments: [{ ...base, deployment: "vertex_ai/m", context: 1_000_000, output: 1_000_000 }],
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["test"],
    }).models
    expect(models.m?.limit).toEqual({ context: 1_000_000, output: 8192 })
  })

  test("applies the minimum across candidates that pass the rule", () => {
    const models = buildCatalog({
      seed: new Map([["m", { provider: "fuelix" as const }]]),
      deployments: [
        { ...base, deployment: "a/m", context: 200_000, output: 100_000 },
        { ...base, deployment: "b/m", context: 128_000, output: 8_192 },
        { ...base, deployment: "c/m", context: 1_000_000, output: 1_000_000 },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["test"],
    }).models
    // c/m fails the rule: it adds its context but not its output.
    expect(models.m?.limit).toEqual({ context: 128_000, output: 8_192 })
    expect(models.m?.notes?.some((note) => note.includes("c/m (output 1000000"))).toBe(true)
  })
})

describe("id parsing", () => {
  test("accepts a /v1/models response, an array, and lines", () => {
    expect(parseIds('{"object":"list","data":[{"id":"b"},{"id":"a"},{"id":"a"}]}')).toEqual(["a", "b"])
    expect(parseIds('["z","y"]')).toEqual(["y", "z"])
    expect(parseIds("c\n\n b \r\nc\n")).toEqual(["b", "c"])
  })
})
