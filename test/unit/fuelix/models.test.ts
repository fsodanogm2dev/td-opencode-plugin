import { describe, expect, test } from "bun:test"
import type { CatalogEntry } from "../../../src/fuelix/catalog-types.ts"
import { buildModelInfo, buildProviderInfo, enrichFromUpstream, upstreamProviderID } from "../../../src/fuelix/models.ts"
import catalog from "../../fixtures/fuelix/catalog.json"

const entries = catalog.models as unknown as Record<string, CatalogEntry>

describe("buildProviderInfo", () => {
  test("OpenAI Responses provider", () => {
    expect(buildProviderInfo("fuelix-openai", "https://api.fuelix.ai", "auto")).toEqual({
      id: "fuelix-openai",
      integrationID: "fuelix",
      name: "FuelIX (OpenAI Responses)",
      activation: "auto",
      package: "@opencode/ai/providers/openai",
      settings: { baseURL: "https://api.fuelix.ai/v1" },
    } as never)
  })

  test("Anthropic Messages provider", () => {
    const info = buildProviderInfo("fuelix-anthropic", "https://api.fuelix.ai", "enabled")
    expect(info.name).toBe("FuelIX (Anthropic Messages)")
    expect(info.package).toBe("@opencode/ai/providers/anthropic")
    expect(info.settings).toEqual({ baseURL: "https://api.fuelix.ai/v1" })
    expect(info.activation).toBe("enabled")
  })

  test("Chat Completions provider", () => {
    const info = buildProviderInfo("fuelix", "https://api.fuelix.ai", "auto")
    expect(info.name).toBe("FuelIX")
    expect(info.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(info.settings).toEqual({ baseURL: "https://api.fuelix.ai", provider: "fuelix" })
  })

  test("carries no secret fields", () => {
    for (const id of ["fuelix-openai", "fuelix-anthropic", "fuelix"] as const) {
      const info = buildProviderInfo(id, "https://api.fuelix.ai", "enabled")
      expect(info.integrationID as string).toBe("fuelix")
      expect(info.headers).toBeUndefined()
      expect(info.body).toBeUndefined()
      const json = JSON.stringify(info)
      for (const word of ["apiKey", "headers", "Authorization", "sk-"]) expect(json).not.toContain(word)
    }
  })
})

describe("buildModelInfo", () => {
  test("converts base cost, tiers, limits, and capabilities", () => {
    const { info, incomplete } = buildModelInfo("fuelix-openai", "gpt-6-luna", entries["gpt-6-luna"])
    expect(incomplete).toEqual([])
    expect(info.name).toBe("GPT-6 Luna")
    expect(info.cost).toEqual([
      { input: 2.5, output: 10, cache: { read: 0.25, write: 0 } },
      { tier: { type: "context", size: 200000 }, input: 5, output: 15, cache: { read: 0.5, write: 0 } },
    ] as never)
    expect(info.limit).toEqual({ context: 400000, output: 128000 })
    expect(info.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
    expect(info.status).toBe("active")
    expect(info.enabled).toBe(true)
    expect(info.time).toEqual({ released: 0 })
    expect(info.variants.map((v) => v.id as string)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    expect(info.package).toBeUndefined()
    expect(info.settings).toBeUndefined()
  })

  test("reasoning false gives no variants", () => {
    const { info } = buildModelInfo("fuelix", "gemini-3.5-flash", entries["gemini-3.5-flash"])
    expect(info.variants).toEqual([])
  })

  test("unknown model gets defaults and reports incomplete fields", () => {
    const { info, incomplete } = buildModelInfo("fuelix-openai", "gpt-9-new", undefined)
    expect(incomplete).toEqual(["cost", "limit", "capabilities"])
    expect(info.cost).toEqual([])
    expect(info.limit).toEqual({ context: 200000, output: 32000 })
    expect(info.name).toBe("gpt-9-new")
    expect(info.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
  })

  test("entry without cost reports cost only", () => {
    const { incomplete } = buildModelInfo("fuelix", "text-embedding-4", entries["text-embedding-4"])
    expect(incomplete).toEqual(["cost", "limit"])
  })

  test("keeps the input limit when the catalog sets one", () => {
    const entry: CatalogEntry = { ...entries["claude-opus"]!, limit: { context: 1000, input: 900, output: 100 } }
    expect(buildModelInfo("fuelix-anthropic", "claude-opus", entry).info.limit).toEqual({ context: 1000, input: 900, output: 100 })
  })
})

describe("enrichFromUpstream", () => {
  const upstreamModel = {
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
    limit: { context: 123000, output: 45000 },
    capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
  }

  function fakeEditor(upstream: Record<string, unknown> | undefined, upstreamProvider = "openai") {
    const target: Record<string, any> = { cost: [], limit: { context: 200000, output: 32000 }, capabilities: {}, variants: [{ id: "x" }] }
    const editor = {
      get: (id: string) => (id === upstreamProvider && upstream ? { models: new Map(Object.entries(upstream)) } : undefined),
      models: { update: (_p: string, _m: string, fn: (m: any) => void) => fn(target) },
    }
    return { editor: editor as never, target }
  }

  test("copies cost, limit, and capabilities for incomplete models", () => {
    const { editor, target } = fakeEditor({ "gpt-9-new": upstreamModel })
    const { info, incomplete } = buildModelInfo("fuelix-openai", "gpt-9-new", undefined)
    expect(enrichFromUpstream(editor, "fuelix-openai", "gpt-9-new", info, incomplete)).toEqual(["cost", "limit", "capabilities"])
    expect(target.cost).toEqual(upstreamModel.cost)
    expect(target.limit).toEqual({ context: 123000, output: 45000 })
    expect(target.capabilities).toEqual({ tools: false, input: ["text", "image"], output: ["text"] })
  })

  test("does nothing for complete models", () => {
    const { editor, target } = fakeEditor({ "gpt-6-luna": upstreamModel })
    const { info, incomplete } = buildModelInfo("fuelix-openai", "gpt-6-luna", entries["gpt-6-luna"])
    expect(enrichFromUpstream(editor, "fuelix-openai", "gpt-6-luna", info, incomplete)).toEqual([])
    expect(target.cost).toEqual([])
  })

  test("needs an exact model ID match", () => {
    const { editor } = fakeEditor({ "gpt-9": upstreamModel })
    const { info, incomplete } = buildModelInfo("fuelix-openai", "gpt-9-new", undefined)
    expect(enrichFromUpstream(editor, "fuelix-openai", "gpt-9-new", info, incomplete)).toEqual([])
  })

  test("maps upstream providers", () => {
    expect(upstreamProviderID("fuelix-anthropic", "x")).toBe("anthropic")
    expect(upstreamProviderID("fuelix-openai", "x")).toBe("openai")
    expect(upstreamProviderID("fuelix", "gemini-4")).toBe("google")
    expect(upstreamProviderID("fuelix", "gemma-3")).toBe("google")
    expect(upstreamProviderID("fuelix", "claude-3")).toBe("anthropic")
    expect(upstreamProviderID("fuelix", "gpt-oss")).toBe("openai")
    expect(upstreamProviderID("fuelix", "mistral-large")).toBe("mistral")
    expect(upstreamProviderID("fuelix", "deepseek-r1")).toBe("deepseek")
    expect(upstreamProviderID("fuelix", "llama-4")).toBe("meta")
    expect(upstreamProviderID("fuelix", "qwen")).toBeUndefined()
  })
})

describe("title model family", () => {
  const entry = (extra: Partial<CatalogEntry> = {}) =>
    ({ provider: "fuelix", kind: "chat", name: "Test", limit: { context: 1000, output: 100 }, input: ["text"], output: ["text"], tools: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, ...extra }) as CatalogEntry
  const familyOf = (providerID: Parameters<typeof buildModelInfo>[0], modelID: string, extra: Partial<CatalogEntry> = {}) =>
    (buildModelInfo(providerID, modelID, entry(extra)).info as unknown as { family?: string }).family

  test("the three title models get the family that OpenCode uses to pick a title model", () => {
    expect(familyOf("fuelix-openai", "gpt-6-luna")).toBe("gpt-luna")
    expect(familyOf("fuelix-anthropic", "claude-haiku-5-5")).toBe("claude-haiku")
    expect(familyOf("fuelix", "gemini-3.1-flash-lite")).toBe("gemini-flash-lite")
  })

  test("other models get no family, including other luna, haiku, and flash-lite models", () => {
    for (const [providerID, modelID] of [
      ["fuelix-openai", "gpt-6-luna-mini"],
      ["fuelix-openai", "gpt-5-nano"],
      ["fuelix-anthropic", "claude-haiku-4-5"],
      ["fuelix-anthropic", "claude-opus"],
      ["fuelix", "gemini-2.5-flash-lite"],
      ["fuelix", "gemini-3.5-flash"],
    ] as const) {
      expect(familyOf(providerID, modelID)).toBeUndefined()
      expect("family" in buildModelInfo(providerID, modelID, entry()).info).toBe(false)
    }
  })

  test("a title model ID under another provider gets no family", () => {
    expect(familyOf("fuelix", "gpt-6-luna")).toBeUndefined()
    expect(familyOf("fuelix-openai", "claude-haiku-5-5")).toBeUndefined()
  })

  test("a deprecated title model gets no family", () => {
    expect(familyOf("fuelix-anthropic", "claude-haiku-5-5", { status: "deprecated" })).toBeUndefined()
  })

  test("a title model without a catalog entry is active and gets the family", () => {
    const info = buildModelInfo("fuelix-anthropic", "claude-haiku-5-5", undefined).info as unknown as { family?: string }
    expect(info.family).toBe("claude-haiku")
  })
})
