import { describe, expect, test } from "bun:test"
import { buildCatalog } from "../../../scripts/lib/build.ts"
import type { Deployment } from "../../../scripts/lib/inventory.ts"
import type { SeedModel } from "../../../scripts/lib/seed.ts"

function deployment(name: string, aliases: string[], extra: Partial<Deployment> = {}): Deployment {
  return {
    deployment: name,
    provider: "azure",
    modelName: aliases[0] ?? name,
    aliases,
    active: true,
    kind: "chat",
    prices: { input: 1e-6, output: 2e-6 },
    ...extra,
  }
}

function seed(extra: Partial<SeedModel> = {}): SeedModel {
  return { provider: "fuelix-openai", ...extra }
}

function build(seeds: Record<string, SeedModel>, deployments: Deployment[]) {
  return buildCatalog({
    seed: new Map(Object.entries(seeds)),
    deployments,
    liveIds: Object.keys(seeds),
    generatedAt: "2026-01-01T00:00:00.000Z",
    sources: ["test"],
  }).models
}

describe("field borrowing", () => {
  test("borrows a missing limit from an ID with the same deployment", () => {
    const models = build(
      {
        "m-new": seed(),
        "m-old": seed({ context: 1050000, output: 128000 }),
      },
      [deployment("azure/m-uswest", ["m-new", "m-old"])],
    )
    expect(models["m-old"]?.limit).toEqual({ context: 1050000, output: 128000 })
    expect(models["m-new"]?.limit).toEqual({ context: 1050000, output: 128000 })
    expect(models["m-new"]?.notes).toContain("limit borrowed from m-old (same deployment azure/m-uswest).")
    expect(models["m-new"]?.sources.metadata).toBe("mixed")
    expect(models["m-old"]?.notes?.some((note) => note.includes("borrowed"))).toBe(false)
    expect(models["m-old"]?.sources.metadata).toBe("mixed")
  })

  test("does not borrow across different deployments", () => {
    const models = build(
      {
        "m-new": seed(),
        "m-old": seed({ context: 1050000, output: 128000 }),
      },
      [deployment("azure/m-new", ["m-new"]), deployment("azure/m-old", ["m-old"])],
    )
    expect(models["m-new"]?.limit).toBeUndefined()
    expect(models["m-new"]?.notes?.some((note) => note.includes("borrowed"))).toBe(false)
    expect(models["m-new"]?.sources.metadata).toBe("inventory")
  })

  test("does not borrow when the ID has no inventory deployment", () => {
    const models = build({ "m-new": seed(), "m-old": seed({ context: 10, output: 5 }) }, [])
    expect(models["m-new"]?.limit).toBeUndefined()
    expect(models["m-new"]?.sources.metadata).toBe("none")
  })

  test("breaks a tie between donors by sort order", () => {
    const models = build(
      {
        "m-a": seed(),
        "m-b": seed({ context: 200, output: 20 }),
        "m-c": seed({ context: 300, output: 30 }),
      },
      [deployment("azure/m", ["m-a", "m-b", "m-c"])],
    )
    expect(models["m-a"]?.limit).toEqual({ context: 200, output: 20 })
    expect(models["m-a"]?.notes).toContain("limit borrowed from m-b (same deployment azure/m).")
  })

  test("borrows cost from the seed of an ID with the same deployment", () => {
    const models = build(
      { "m-a": seed(), "m-b": seed({ cost: { input: 1, output: 2 } }) },
      [deployment("azure/m", ["m-a", "m-b"], { prices: {} })],
    )
    expect(models["m-a"]?.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(models["m-a"]?.notes).toContain("cost borrowed from m-b (same deployment azure/m).")
  })

  test("borrows modalities, tool support, and reasoning support", () => {
    const models = build(
      {
        "m-a": seed(),
        "m-b": seed({ inputModalities: ["text", "image"], tools: true, reasoning: true }),
      },
      [
        deployment("azure/m", ["m-a", "m-b"], { prices: {} }),
      ],
    )
    expect(models["m-a"]?.input).toEqual(["text", "image"])
    expect(models["m-a"]?.tools).toBe(true)
    expect(models["m-a"]?.reasoning).toBe(true)
    const notes = models["m-a"]?.notes ?? []
    expect(notes).toContain("input modalities borrowed from m-b (same deployment azure/m).")
    expect(notes).toContain("tool support borrowed from m-b (same deployment azure/m).")
    expect(notes).toContain("reasoning support borrowed from m-b (same deployment azure/m).")
  })
})

describe("borrowing by model name", () => {
  const limits = { context: 1050000, output: 128000 }

  test("borrows limit and modalities from the ID that equals the model name", () => {
    const models = build(
      {
        "m-sol": seed({ ...limits, inputModalities: ["text", "image"], cost: { input: 9, output: 9 }, tools: false }),
        "m-sol-alias": seed({ cost: { input: 1, output: 2 }, tools: true, reasoning: true }),
      },
      [
        deployment("openai/m-1", ["m-sol"], { modelName: "m-1" }),
        deployment("azure/m-uswest", ["m-sol-alias"], { modelName: "m-sol", prices: {} }),
      ],
    )
    const entry = models["m-sol-alias"]
    expect(entry?.limit).toEqual(limits)
    expect(entry?.input).toEqual(["text", "image"])
    expect(entry?.notes).toContain(
      "limit borrowed from m-sol (same model m-sol, deployment azure/m-uswest).",
    )
    expect(entry?.notes).toContain(
      "input modalities borrowed from m-sol (same model m-sol, deployment azure/m-uswest).",
    )
    expect(entry?.sources.metadata).toBe("mixed")
  })

  test("never borrows cost, tools, or reasoning by model name", () => {
    const models = build(
      {
        "m-sol": seed({ ...limits, cost: { input: 9, output: 9 }, tools: true, reasoning: true }),
        "m-sol-alias": seed(),
      },
      [
        deployment("openai/m-1", ["m-sol"], { modelName: "m-1" }),
        deployment("azure/m-uswest", ["m-sol-alias"], { modelName: "m-sol", prices: {} }),
      ],
    )
    const entry = models["m-sol-alias"]
    expect(entry?.limit).toEqual(limits)
    expect(entry?.cost).toBeUndefined()
    expect(entry?.tools).toBeUndefined()
    expect(entry?.reasoning).toBeUndefined()
    expect(entry?.notes?.some((note) => /cost|tool|reasoning/.test(note.replace(/deployment.*/, "")))).toBe(false)
  })

  test("uses another ID with the same model name when no ID equals it", () => {
    const models = build(
      {
        "m-b": seed(),
        "m-c": seed({ ...limits }),
      },
      [
        deployment("azure/one", ["m-b"], { modelName: "m-x" }),
        deployment("azure/two", ["m-c"], { modelName: "m-x" }),
      ],
    )
    expect(models["m-b"]?.limit).toEqual(limits)
    expect(models["m-b"]?.notes).toContain("limit borrowed from m-c (same model m-x, deployment azure/one).")
  })

  test("the same-deployment pass wins over the model-name pass", () => {
    const models = build(
      {
        "m-sol": seed({ context: 1, output: 1 }),
        "m-a": seed(),
        "m-b": seed({ context: 2, output: 2 }),
      },
      [
        deployment("openai/m-1", ["m-sol"], { modelName: "m-sol" }),
        deployment("azure/shared", ["m-a", "m-b"], { modelName: "m-sol" }),
      ],
    )
    expect(models["m-a"]?.limit).toEqual({ context: 2, output: 2 })
    expect(models["m-a"]?.notes).toContain("limit borrowed from m-b (same deployment azure/shared).")
    expect(models["m-a"]?.notes?.some((note) => note.includes("same model"))).toBe(false)
  })

  test("does not borrow across different model names", () => {
    const models = build(
      { "m-a": seed(), "m-b": seed({ ...limits }) },
      [deployment("azure/one", ["m-a"], { modelName: "x" }), deployment("azure/two", ["m-b"], { modelName: "y" })],
    )
    expect(models["m-a"]?.limit).toBeUndefined()
  })
})
