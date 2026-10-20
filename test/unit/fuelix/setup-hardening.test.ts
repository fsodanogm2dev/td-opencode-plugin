import { describe, expect, test } from "bun:test"
import type { FuelixOptions } from "../../../src/options.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { ALLOW_CUSTOM_URL_ENV } from "../../../src/fuelix/base-url.ts"
import { loadCatalog, type LoadedCatalog } from "../../../src/fuelix/catalog.ts"
import { KEYCHAIN_RETRY_MS, type ExecFn } from "../../../src/fuelix/credentials.ts"
import { setupFuelix, type FuelixDeps } from "../../../src/fuelix/index.ts"
import { createFakeCtx, waitFor, type FakeOptions } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const OTHER_KEY = "sk-test-other-not-real"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)

const options: FuelixOptions = {
  baseURL: "https://api.fuelix.ai",
  keychainService: "fuelix-api-key",
  refreshMinutes: 15,
  includeNonChatModels: false,
  discoveryTimeoutMs: 1000,
  scrubShellEnv: true,
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const modelsResponse = (...ids: string[]) => json({ data: ids.map((id) => ({ id })) })
const modelIDs = (fake: ReturnType<typeof createFakeCtx>, providerID: string) => [...(fake.providers.get(providerID)?.models.keys() ?? [])].sort()
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

interface Timers {
  callbacks: (() => void)[]
  cleared: unknown[]
}

async function setup(fakeOptions: FakeOptions = {}, extra: Partial<FuelixDeps> = {}, overrides: Partial<FuelixOptions> = {}) {
  const fake = createFakeCtx(fakeOptions)
  const log = createMemoryLogger()
  const timers: Timers = { callbacks: [], cleared: [] }
  const cleanup = await setupFuelix(
    fake.ctx,
    { ...options, ...overrides },
    log,
    {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: async () => ({ exitCode: 44, stdout: "" }),
      env: { [ALLOW_CUSTOM_URL_ENV]: "1" },
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
      setInterval: (callback) => {
        timers.callbacks.push(callback)
        return timers.callbacks.length
      },
      clearInterval: (handle) => void timers.cleared.push(handle),
      fetch: async () => {
        throw new Error("unexpected fetch")
      },
      ...extra,
    },
  )
  fake.runProviderTransforms()
  return { fake, log, cleanup, timers }
}

describe("H2: stale configuration blocks", () => {
  const configured = { "fuelix-anthropic": { settings: { apiKey: "sk-test-leaked-value" } } }

  test("warns once per process after setup and never prints the value", async () => {
    const holder: Record<symbol, unknown> = {}
    const first = await setup({ configured }, { staleConfigHolder: holder })
    await waitFor(() => first.log.lines.some((line) => line.includes("hold a credential")))
    const second = await setup({ configured }, { staleConfigHolder: holder })
    await tick()
    expect(first.log.lines.filter((line) => line.includes("hold a credential")).length).toBe(1)
    expect(second.log.lines.filter((line) => line.includes("hold a credential")).length).toBe(0)
    expect(first.log.lines.join("\n")).toContain("fuelix-anthropic settings.apiKey")
    expect(first.log.lines.join("\n")).not.toContain("sk-test-leaked-value")
  })

  test("a thrown provider read does not break setup", async () => {
    const { log } = await setup({}, {})
    await tick()
    expect(log.lines.some((line) => line.includes("hold a credential"))).toBe(false)
  })
})

describe("M2 and L6: key re-resolution", () => {
  test("a Keychain miss at setup is retried by a later cycle and enables the providers", async () => {
    let clock = 1_000_000
    let keychain: string | undefined
    const exec: ExecFn = async () => (keychain ? { exitCode: 0, stdout: `${keychain}\n` } : { exitCode: 44, stdout: "" })
    const seen: string[] = []
    const { fake, timers } = await setup(
      {},
      {
        exec,
        now: () => new Date(clock),
        fetch: async (_url, init) => {
          seen.push(new Headers(init?.headers).get("authorization") ?? "")
          return modelsResponse("gpt-6-luna", "claude-opus", "gemini-3.5-flash", "gpt-7-new")
        },
      },
    )
    expect(timers.callbacks.length).toBe(1) // The interval runs even without a key.
    expect(fake.providers.get("fuelix")?.provider.activation).toBe("auto")
    await tick()
    expect(seen).toEqual([])

    keychain = KEY
    timers.callbacks[0]!()
    await tick()
    expect(seen).toEqual([]) // Less than 5 minutes since the miss: no new Keychain read.

    clock += KEYCHAIN_RETRY_MS
    timers.callbacks[0]!()
    await waitFor(() => fake.state.reloads >= 1)
    expect(seen).toEqual([`Bearer ${KEY}`])
    expect(fake.providers.get("fuelix")?.provider.activation).toBe("enabled")
    expect(modelIDs(fake, "fuelix-openai")).toContain("gpt-7-new")

    // The auth hook reads the new key.
    const request = new Request("https://api.fuelix.ai/v1/messages", { headers: { "x-api-key": "sk-test-stale" } })
    fake.hooks[0]!.callback({ request })
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  test("a credential store key added later enables discovery", async () => {
    const seen: string[] = []
    const { fake, timers } = await setup(
      {},
      { fetch: async (_url, init) => (seen.push(new Headers(init?.headers).get("authorization") ?? ""), modelsResponse("gpt-6-luna", "claude-opus", "gpt-8")) },
    )
    await tick()
    expect(seen).toEqual([])
    fake.setConnectionKey(KEY)
    timers.callbacks[0]!()
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual([`Bearer ${KEY}`])
  })

  test("a rotated credential store key is used on the next cycle", async () => {
    const seen: string[] = []
    const { fake, timers } = await setup(
      { connectionKey: KEY },
      { fetch: async (_url, init) => (seen.push(new Headers(init?.headers).get("authorization") ?? ""), modelsResponse("gpt-6-luna")) },
    )
    await waitFor(() => seen.length === 1)
    await tick() // Let the first cycle finish.
    fake.setConnectionKey(OTHER_KEY)
    timers.callbacks[0]!()
    await waitFor(() => seen.length === 2)
    expect(seen).toEqual([`Bearer ${KEY}`, `Bearer ${OTHER_KEY}`])
  })

  test("refreshMinutes 0 starts no interval", async () => {
    const { timers } = await setup({}, {}, { refreshMinutes: 0 })
    expect(timers.callbacks).toEqual([])
  })
})

describe("M3: discovery drop guard", () => {
  const current = ["claude-x1", "gemini-x1", ...Array.from({ length: 8 }, (_, i) => `gpt-a${i + 1}`)].sort()
  const cached = { "fuelix/models": { fetchedAt: "x", ids: current } }
  const run = async (found: string[]) => {
    const result = await setup({ storage: cached, connectionKey: KEY }, { fetch: async () => modelsResponse(...found) })
    await tick()
    return result
  }

  test("rejects a result that drops more than 30% of the current IDs", async () => {
    const { fake, log } = await run(current.slice(0, 6))
    expect(fake.state.reloads).toBe(0)
    expect(fake.state.storageWrites).toBe(0)
    expect(modelIDs(fake, "fuelix-openai").length).toBe(8)
    const warning = log.lines.find((line) => line.includes("drops 4 of 10"))
    expect(warning).toBeDefined()
    expect(warning).toContain("dropped=4")
    expect(warning).toContain("droppedIDs=")
  })

  test("lists at most 10 dropped IDs", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `gpt-b${String(i).padStart(2, "0")}`)
    const result = await setup({ storage: { "fuelix/models": { fetchedAt: "x", ids: many } }, connectionKey: KEY }, { fetch: async () => modelsResponse("gpt-b00") })
    await tick()
    const warning = result.log.lines.find((line) => line.includes("drops 29 of 30"))!
    expect(warning.match(/gpt-b\d\d/g)!.length).toBe(10)
  })

  test("rejects a result that removes every model of one provider", async () => {
    const { fake, log } = await run(current.filter((id) => id !== "claude-x1"))
    expect(fake.state.reloads).toBe(0)
    expect(fake.state.storageWrites).toBe(0)
    expect(log.lines.some((line) => line.includes("removes every model of fuelix-anthropic"))).toBe(true)
  })

  test("accepts a small change", async () => {
    const { fake } = await run([...current.filter((id) => id !== "gpt-a1"), "gpt-new"])
    expect(fake.state.reloads).toBe(1)
    expect(fake.state.storageWrites).toBe(1)
    expect(modelIDs(fake, "fuelix-openai")).toContain("gpt-new")
  })

  test("does not guard a list that comes from the catalog (no earlier discovery)", async () => {
    const { fake } = await setup({ connectionKey: KEY }, { fetch: async () => modelsResponse("gpt-only") })
    await waitFor(() => fake.state.reloads === 1)
    expect(modelIDs(fake, "fuelix-openai")).toEqual(["gpt-only"])
  })
})

describe("M4: base URL", () => {
  test("a custom URL needs the opt-in", async () => {
    const denied = await setup({}, { env: {} }, { baseURL: "https://gw.example.test", refreshMinutes: 0 })
    expect(denied.fake.providers.get("fuelix")?.provider.settings.baseURL).toBe("https://api.fuelix.ai")
    expect(denied.log.lines.some((line) => line.includes("warn") && line.includes("fuelix.baseURL is ignored"))).toBe(true)
    const allowed = await setup({}, {}, { baseURL: "https://gw.example.test", refreshMinutes: 0 })
    expect(allowed.fake.providers.get("fuelix")?.provider.settings.baseURL).toBe("https://gw.example.test")
    expect(allowed.fake.providers.get("fuelix-openai")?.provider.settings.baseURL).toBe("https://gw.example.test/v1")
  })

  test("discovery uses the effective base URL", async () => {
    const urls: string[] = []
    await setup(
      { connectionKey: KEY },
      { env: {}, fetch: async (url) => (urls.push(url), modelsResponse("gpt-6-luna")) },
      { baseURL: "https://gw.example.test" },
    )
    await waitFor(() => urls.length === 1)
    expect(urls).toEqual(["https://api.fuelix.ai/v1/models"])
  })
})

describe("L4: model build errors", () => {
  test("a model whose build throws is skipped and logged once", async () => {
    const broken = JSON.parse(await Bun.file(new URL("../../fixtures/fuelix/catalog.json", import.meta.url)).text())
    broken.models["gpt-6-luna"].input = 5 // The loader would drop this; a bad catalog source could not.
    const loaded: LoadedCatalog = { catalog: broken }
    const { fake, log } = await setup({}, { loadCatalog: async () => loaded, env: {} }, { refreshMinutes: 0 })
    fake.runProviderTransforms()
    expect(modelIDs(fake, "fuelix-openai")).toEqual([])
    expect(modelIDs(fake, "fuelix-anthropic")).toEqual(["claude-opus"])
    expect(log.lines.filter((line) => line.includes("skipped because its metadata is invalid")).length).toBe(1)
  })
})

describe("L5: hook registration", () => {
  test("auth hooks are registered before the provider transform", async () => {
    const { fake } = await setup({}, {}, { refreshMinutes: 0 })
    expect(fake.order).toEqual(["hook:fuelix-openai", "hook:fuelix-anthropic", "hook:fuelix", "provider.transform"])
  })

  test("a failing hook registration is logged and setup continues", async () => {
    const { fake, log } = await setup({ failHookFor: "fuelix-anthropic" }, {}, { refreshMinutes: 0 })
    expect(log.lines.some((line) => line.includes("error") && line.includes("could not register the FueliX auth hook"))).toBe(true)
    expect(fake.hooks.map((hook) => hook.options?.providerID).sort()).toEqual(["fuelix", "fuelix-openai"])
    expect([...fake.providers.keys()].sort()).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
  })
})

describe("shell environment", () => {
  test("create.before removes FUELIX_API_KEY and keeps other variables", async () => {
    const { fake } = await setup({}, {}, { refreshMinutes: 0 })
    expect(fake.shellHooks.map((hook) => hook.name)).toEqual(["create.before"])
    const env: Record<string, string | undefined> = { FUELIX_API_KEY: KEY, PATH: "/usr/bin" }
    fake.shellHooks[0]!.callback({ env })
    expect(env).toEqual({ PATH: "/usr/bin" })
  })

  test("scrubShellEnv false registers no shell hook", async () => {
    const { fake } = await setup({}, {}, { refreshMinutes: 0, scrubShellEnv: false })
    expect(fake.shellHooks).toEqual([])
  })
})
