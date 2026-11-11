import { describe, expect, test } from "bun:test"
import type { FuelixOptions } from "../../../src/options.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"
import { setupFuelix, type FuelixDeps } from "../../../src/fuelix/index.ts"
import { createFakeCtx, waitFor, type FakeOptions } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)

const options: FuelixOptions = {
  baseURL: "https://api.fuelix.test",
  keychainService: "fuelix-api-key",
  refreshMinutes: 0,
  includeNonChatModels: false,
  discoveryTimeoutMs: 1000,
  scrubShellEnv: true,
}

const noKeychain = async () => ({ exitCode: 44, stdout: "" })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function modelsResponse(...ids: string[]) {
  return json({ data: ids.map((id) => ({ id })) })
}

function deps(extra: Partial<FuelixDeps> = {}): FuelixDeps {
  return {
    loadCatalog: () => loadCatalog(CATALOG_URL),
    exec: noKeychain,
    env: {},
    platform: "darwin",
    keychainCache: new Map(),
    staleConfigHolder: {},
    staleConfigDelaysMs: [0],
    fetch: async () => {
      throw new Error("unexpected fetch")
    },
    ...extra,
  }
}

async function setup(fakeOptions: FakeOptions = {}, extra: Partial<FuelixDeps> = {}, overrides: Partial<FuelixOptions> = {}) {
  const fake = createFakeCtx(fakeOptions)
  const log = createMemoryLogger()
  const cleanup = await setupFuelix(fake.ctx, { ...options, ...overrides }, log, deps(extra))
  fake.runProviderTransforms()
  return { fake, log, cleanup }
}

const modelIDs = (fake: ReturnType<typeof createFakeCtx>, providerID: string) => [...(fake.providers.get(providerID)?.models.keys() ?? [])].sort()

describe("setupFuelix", () => {
  test("registers the integration methods", async () => {
    const { fake } = await setup()
    expect(fake.integrationMethods).toEqual([
      { integrationID: "fuelix", method: { type: "key", label: "FueliX API key" } },
      { integrationID: "fuelix", method: { type: "env", names: ["FUELIX_API_KEY"] } },
    ])
    expect(fake.integrationNames.get("fuelix")).toBe("FuelIX")
  })

  test("the provider transform adds the 3 providers with listed chat models", async () => {
    const { fake } = await setup()
    expect([...fake.providers.keys()].sort()).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
    expect(modelIDs(fake, "fuelix-openai")).toEqual(["gpt-6-luna"])
    expect(modelIDs(fake, "fuelix-anthropic")).toEqual(["claude-opus"])
    // The embedding model is listed but not chat; claude-3-7-sonnet is not listed.
    expect(modelIDs(fake, "fuelix")).toEqual(["gemini-3.5-flash"])
    for (const record of fake.providers.values()) {
      expect(record.provider.integrationID).toBe("fuelix")
      expect(record.provider.activation).toBe("auto")
      expect(JSON.stringify(record.provider)).not.toContain("apiKey")
    }
  })

  test("only the listed title model gets a family", async () => {
    const { fake } = await setup()
    const families = [...fake.providers.entries()].flatMap(([providerID, record]) =>
      [...record.models.values()].map((model) => `${providerID}/${model.id}=${(model as unknown as { family?: string }).family ?? ""}`),
    )
    expect(families.sort()).toEqual(["fuelix-anthropic/claude-opus=", "fuelix-openai/gpt-6-luna=gpt-luna", "fuelix/gemini-3.5-flash="])
  })

  test("includeNonChatModels registers the embedding model", async () => {
    const { fake } = await setup({}, {}, { includeNonChatModels: true })
    expect(modelIDs(fake, "fuelix")).toEqual(["gemini-3.5-flash", "text-embedding-4"])
  })

  test("providers are enabled when the env key exists", async () => {
    const { fake } = await setup({}, { env: { FUELIX_API_KEY: KEY }, fetch: async () => modelsResponse("gpt-6-luna") })
    expect(fake.providers.get("fuelix")?.provider.activation).toBe("enabled")
  })

  test("providers stay auto when only the credential store has a key", async () => {
    const { fake } = await setup({ connectionKey: KEY }, { fetch: async () => modelsResponse("gpt-6-luna") })
    expect(fake.providers.get("fuelix")?.provider.activation).toBe("auto")
  })

  test("registers an http.request hook for each provider", async () => {
    const { fake } = await setup()
    const hooks = fake.hooks.filter((hook) => hook.name === "http.request")
    expect(hooks.map((hook) => hook.options?.providerID).sort()).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
  })

  test("the hook sets Bearer auth from the keychain key", async () => {
    const { fake } = await setup(
      {},
      { exec: async () => ({ exitCode: 0, stdout: `${KEY}\n` }), fetch: async () => modelsResponse("gpt-6-luna") },
    )
    const request = new Request("https://api.fuelix.test/v1/messages", { headers: { "x-api-key": "sk-test-other" } })
    fake.hooks[0]!.callback({ request })
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(request.headers.has("x-api-key")).toBe(false)
  })

  test("registers an AI SDK sdk hook for fuelix-anthropic only", async () => {
    const { fake } = await setup()
    const hooks = fake.aisdkHooks.filter((hook) => hook.name === "sdk")
    expect(hooks.map((hook) => hook.options?.providerID)).toEqual(["fuelix-anthropic"])
  })

  test("the AI SDK hook sets a placeholder key and Bearer auth uses the env key", async () => {
    const { fake } = await setup({}, { env: { FUELIX_API_KEY: KEY }, fetch: async () => modelsResponse("gpt-6-luna") })
    const seen: Headers[] = []
    const options: Record<string, any> = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return new Response("{}")
      },
    }
    fake.aisdkHooks.find((item) => item.options?.providerID === "fuelix-anthropic")!.callback({ options })
    expect(options.apiKey).toBe("fuelix-plugin-managed")
    // The AI SDK sends the placeholder as `x-api-key`. The wrapper must replace it with the real key.
    await options.fetch("https://api.fuelix.test/v1/messages", { method: "POST", headers: { "x-api-key": options.apiKey } })
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(seen[0]!.has("x-api-key")).toBe(false)
  })

  test("the AI SDK hook keeps a real apiKey and an authToken", async () => {
    const { fake } = await setup()
    const hook = fake.aisdkHooks.find((item) => item.options?.providerID === "fuelix-anthropic")!
    const withKey: Record<string, any> = { apiKey: "sk-test-existing" }
    hook.callback({ options: withKey })
    expect(withKey.apiKey).toBe("sk-test-existing")
    const withToken: Record<string, any> = { authToken: "sk-test-token" }
    hook.callback({ options: withToken })
    expect(withToken.apiKey).toBeUndefined()
  })

  test("the AI SDK fetch wrapper sets Bearer auth for stateless calls", async () => {
    const { fake } = await setup({}, { env: { FUELIX_API_KEY: KEY }, fetch: async () => modelsResponse("gpt-6-luna") })
    const seen: Headers[] = []
    const options: Record<string, any> = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return new Response("{}")
      },
    }
    const hook = fake.aisdkHooks.find((item) => item.options?.providerID === "fuelix-anthropic")!
    hook.callback({ options })
    await options.fetch("https://api.fuelix.test/v1/messages", { method: "POST", headers: { "x-api-key": "sk-test-other" } })
    expect(seen[0]!.get("authorization")).toBe("Bearer sk-test-other")
    expect(seen[0]!.has("x-api-key")).toBe(false)
    await options.fetch("https://api.fuelix.test/v1/messages", { method: "POST" })
    expect(seen[1]!.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("the AI SDK fetch wrapper adds a cache breakpoint to /messages bodies only", async () => {
    const { fake } = await setup({}, { env: { FUELIX_API_KEY: KEY }, fetch: async () => modelsResponse("gpt-6-luna") })
    const seen: { url: string; headers: Headers; body: string }[] = []
    const options: Record<string, any> = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) })
        return new Response("{}")
      },
    }
    fake.aisdkHooks.find((item) => item.options?.providerID === "fuelix-anthropic")!.callback({ options })
    const body = JSON.stringify({ model: "claude-opus", system: "Sys", messages: [{ role: "user", content: "hi" }] })
    await options.fetch("https://api.fuelix.test/v1/messages", { method: "POST", headers: { "x-api-key": options.apiKey }, body })
    await options.fetch("https://api.fuelix.test/v1/messages/count_tokens", { method: "POST", body })
    expect(JSON.parse(seen[0]!.body).system[0].cache_control).toEqual({ type: "ephemeral" })
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(seen[1]!.body).toBe(body)
  })

  test("discovery with changed IDs reloads providers and writes the cache", async () => {
    let fetched = 0
    const { fake, log } = await setup(
      {},
      {
        env: { FUELIX_API_KEY: KEY },
        now: () => new Date("2026-10-19T12:00:00.000Z"),
        fetch: async () => {
          fetched++
          return modelsResponse("claude-3-7-sonnet", "gpt-6-luna", "gpt-7-new")
        },
      },
    )
    await waitFor(() => fake.state.reloads === 1)
    expect(fetched).toBe(1)
    expect(fake.storage.get("fuelix/models")).toEqual({
      fetchedAt: "2026-10-19T12:00:00.000Z",
      ids: ["claude-3-7-sonnet", "gpt-6-luna", "gpt-7-new"],
    })
    // The reload re-ran the transform with the new plan.
    expect(modelIDs(fake, "fuelix-openai")).toEqual(["gpt-6-luna", "gpt-7-new"])
    expect(modelIDs(fake, "fuelix")).toEqual(["claude-3-7-sonnet"])
    expect(fake.providers.get("fuelix-openai")?.models.get("gpt-7-new")?.cost).toEqual([])
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("discovery with the same IDs does not reload", async () => {
    const { fake } = await setup(
      { storage: { "fuelix/models": { fetchedAt: "x", ids: ["gpt-6-luna"] } } },
      { env: { FUELIX_API_KEY: KEY }, fetch: async () => modelsResponse("gpt-6-luna") },
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.state.reloads).toBe(0)
    expect(fake.state.storageWrites).toBe(0)
  })

  test("a failed fetch keeps the cached IDs", async () => {
    const { fake, log } = await setup(
      { storage: { "fuelix/models": { fetchedAt: "x", ids: ["gpt-6-luna", "claude-opus"] } } },
      { env: { FUELIX_API_KEY: KEY }, fetch: async () => json({}, 500) },
    )
    await waitFor(() => log.lines.some((line) => line.includes("discovery failed")))
    expect(fake.state.reloads).toBe(0)
    expect(modelIDs(fake, "fuelix-openai")).toEqual(["gpt-6-luna"])
    expect(modelIDs(fake, "fuelix-anthropic")).toEqual(["claude-opus"])
    expect(modelIDs(fake, "fuelix")).toEqual([])
    expect(log.lines.join("\n")).toContain("HTTP 500")
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("no key warns once with setup instructions and does not fetch", async () => {
    const { log } = await setup()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const warnings = log.lines.filter((line) => line.includes("No FueliX API key"))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("/connect")
    expect(warnings[0]).toContain("security add-generic-password -U -s fuelix-api-key")
  })

  test("enriches incomplete models from an upstream built-in provider", async () => {
    const upstream = {
      openai: {
        "gpt-7-new": {
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
          limit: { context: 500000, output: 100000 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [],
        },
      },
    }
    const { fake } = await setup(
      { upstream, storage: { "fuelix/models": { fetchedAt: "x", ids: ["gpt-7-new", "gpt-6-luna"] } } },
    )
    const model = fake.providers.get("fuelix-openai")?.models.get("gpt-7-new")
    expect(model?.cost).toEqual([{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }])
    expect(model?.limit).toEqual({ context: 500000, output: 100000 })
    expect(model?.capabilities.input).toEqual(["text", "image"])
    // A complete catalog model is not touched.
    expect(fake.providers.get("fuelix-openai")?.models.get("gpt-6-luna")?.limit).toEqual({ context: 400000, output: 128000 })
  })

  test("periodic refresh runs discovery again and cleanup clears the interval", async () => {
    const intervals: { callback: () => void; ms: number }[] = []
    const cleared: unknown[] = []
    let call = 0
    const { fake, cleanup } = await setup(
      {},
      {
        env: { FUELIX_API_KEY: KEY },
        setInterval: (callback, ms) => {
          intervals.push({ callback, ms })
          return intervals.length
        },
        clearInterval: (handle) => void cleared.push(handle),
        fetch: async () => (++call === 1 ? modelsResponse("gpt-6-luna") : modelsResponse("gpt-6-luna", "claude-opus")),
      },
      { refreshMinutes: 15 },
    )
    expect(intervals.map((item) => item.ms)).toEqual([15 * 60_000])
    await waitFor(() => fake.state.reloads === 1)
    intervals[0]!.callback()
    await waitFor(() => fake.state.reloads === 2)
    expect(modelIDs(fake, "fuelix-anthropic")).toEqual(["claude-opus"])
    await cleanup()
    expect(cleared).toEqual([1])
  })

  test("a missing catalog logs a warning and routes by rule", async () => {
    const fake = createFakeCtx({ storage: { "fuelix/models": { fetchedAt: "x", ids: ["gpt-9", "claude-9", "gemini-9"] } } })
    const log = createMemoryLogger()
    await setupFuelix(
      fake.ctx,
      options,
      log,
      deps({ loadCatalog: () => loadCatalog(new URL("./missing.json", import.meta.url)) }),
    )
    fake.runProviderTransforms()
    expect(log.lines.some((line) => line.includes("warn") && line.includes("catalog not loaded"))).toBe(true)
    expect(modelIDs(fake, "fuelix-openai")).toEqual(["gpt-9"])
    expect(modelIDs(fake, "fuelix-anthropic")).toEqual(["claude-9"])
    expect(modelIDs(fake, "fuelix")).toEqual(["gemini-9"])
  })

  test("logs one info summary with counts", async () => {
    const { log } = await setup()
    const summary = log.lines.filter((line) => line.includes("FueliX models registered"))
    expect(summary.length).toBe(1)
    expect(summary[0]).toContain('"fuelix-openai"=1'.replace(/"/g, ""))
  })

  test("cleanup disposes hooks' registrations without throwing", async () => {
    const { cleanup } = await setup()
    await cleanup()
  })
})
