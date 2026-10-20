import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { FUELIX_PACKAGES } from "../../src/fuelix/variants.ts"
import type { Catalog } from "../../src/fuelix/catalog-types.ts"
import {
  FAKE_KEY,
  FUELIX_PROVIDERS,
  type ApiModel,
  type ApiProvider,
  entryFor,
  isFuelix,
  listModels,
  listProviders,
  listedChatIDs,
  loadCatalog,
  startFuelixServer,
  startMockFuelix,
  waitForFuelixModels,
  type MockFuelix,
} from "./fuelix-helpers.ts"
import { type IsolatedServer, pluginEntry, startIsolatedServer, waitFor } from "./harness.ts"

const TIMEOUT = 120_000
const NEW_ID = "gpt-7-preview-test"
const REMOVED_ID = "gpt-4o-mini"

describe("FueliX plugin in an isolated OpenCode server", () => {
  const catalog: Catalog = loadCatalog()
  const mockList = [...listedChatIDs(catalog).filter((id) => id !== REMOVED_ID), NEW_ID].sort()
  let mock: MockFuelix
  let server: IsolatedServer
  let models: ApiModel[]
  let providers: ApiProvider[]
  let providersText: string
  let modelsText: string

  beforeAll(async () => {
    mock = startMockFuelix({ models: mockList })
    server = await startFuelixServer({ baseURL: mock.url, key: FAKE_KEY })
    // Discovery runs after setup and reloads the providers when the ID list differs from the catalog list.
    models = await waitForFuelixModels(server, mockList)
    const listed = await listProviders(server)
    providers = listed.providers.filter((p) => isFuelix(p.id))
    providersText = JSON.stringify(providers)
    modelsText = JSON.stringify(models)
    expect(modelsText.length).toBeGreaterThan(0)
  }, TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    mock?.stop()
  })

  test("registers the three providers", () => {
    expect(providers.map((p) => p.id).sort()).toEqual([...FUELIX_PROVIDERS].sort())
    for (const provider of providers) {
      const id = provider.id as (typeof FUELIX_PROVIDERS)[number]
      expect(provider.integrationID).toBe("fuelix")
      expect(provider.activation).toBe("enabled")
      expect(provider.package).toBe(FUELIX_PACKAGES[id])
      const expectedBase = id === "fuelix" ? mock.url : `${mock.url}/v1`
      expect(provider.settings?.baseURL).toBe(expectedBase)
    }
  })

  test("model IDs equal the discovered list", () => {
    expect([...new Set(models.map((m) => m.id))].sort()).toEqual(mockList)
    expect(models.some((m) => m.id === REMOVED_ID)).toBe(false)
  })

  test("a model that the catalog does not know is routed by rule with default limits", () => {
    const found = models.filter((m) => m.id === NEW_ID)
    expect(found.map((m) => m.providerID)).toEqual(["fuelix-openai"])
    expect(found[0]!.limit).toEqual({ context: 200_000, output: 32_000 })
  })

  test("catalog-backed models carry catalog cost and limits", () => {
    const problems: string[] = []
    let checked = 0
    for (const model of models) {
      const entry = entryFor(catalog, model.id)
      if (!entry) continue
      if (model.providerID !== entry.provider) problems.push(`${model.id}: provider ${model.providerID} != ${entry.provider}`)
      if (!entry.cost) continue // Incomplete entries (no catalog price) are not checked here.
      checked++
      if (model.cost.length === 0) {
        problems.push(`${model.id}: empty cost`)
        continue
      }
      const base = model.cost.find((c) => c.tier === undefined)
      if (
        !base ||
        base.input !== entry.cost.input ||
        base.output !== entry.cost.output ||
        base.cache.read !== entry.cost.cacheRead ||
        base.cache.write !== entry.cost.cacheWrite
      ) {
        problems.push(`${model.id}: base cost ${JSON.stringify(base)} != ${JSON.stringify(entry.cost)}`)
      }
      for (const tier of entry.costTiers ?? []) {
        const actual = model.cost.find((c) => c.tier?.size === tier.contextOver)
        if (!actual || actual.input !== tier.input || actual.output !== tier.output) {
          problems.push(`${model.id}: tier ${tier.contextOver} ${JSON.stringify(actual)} != ${JSON.stringify(tier)}`)
        }
      }
      if (entry.limit) {
        const same =
          model.limit.context === entry.limit.context &&
          model.limit.output === entry.limit.output &&
          model.limit.input === entry.limit.input
        if (!same) problems.push(`${model.id}: limit ${JSON.stringify(model.limit)} != ${JSON.stringify(entry.limit)}`)
      }
    }
    expect(checked).toBeGreaterThan(50)
    expect(problems).toEqual([])
  })

  test("reasoning variants follow the catalog", () => {
    const opus = models.find((m) => m.providerID === "fuelix-anthropic" && m.id === "claude-opus")
    expect(opus?.variants.length).toBe(5)
    const plain = models.find((m) => entryFor(catalog, m.id)?.reasoning === false)
    expect(plain).toBeDefined()
    expect(plain!.variants.length).toBe(0)
  })

  test("discovery used the bearer key", () => {
    const discovery = mock.requests.filter((r) => r.method === "GET" && r.path === "/v1/models")
    expect(discovery.length).toBeGreaterThanOrEqual(1)
    for (const request of discovery) expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
  })

  test("the key does not appear in provider or model data or in logs", async () => {
    // Only FueliX entries are checked. Built-in providers such as `opencode` expose their own public `apiKey` setting.
    const fresh = await listProviders(server)
    const freshModels = await listModels(server)
    const texts = [
      providersText,
      modelsText,
      JSON.stringify(fresh.providers.filter((p) => isFuelix(p.id))),
      JSON.stringify(freshModels.models.filter((m) => isFuelix(m.providerID))),
    ]
    for (const text of texts) {
      expect(text).not.toContain(FAKE_KEY)
      expect(text.toLowerCase()).not.toContain("apikey")
      expect(text.toLowerCase()).not.toContain("authorization")
    }
    const pluginLines = server
      .logs()
      .split("\n")
      .filter((line) => line.includes("[td-opencode-plugin]"))
    expect(pluginLines.length).toBeGreaterThan(0)
    expect(pluginLines.join("\n")).not.toContain(FAKE_KEY)
    expect(server.logs()).not.toContain(FAKE_KEY)
  })

  test("the server stays healthy", async () => {
    const info = await waitFor(async () => {
      const response = await server.api("GET", "/api/info")
      return response.status === 200 ? response : undefined
    }, 10_000)
    expect(info.status).toBe(200)
  })
})

describe("FueliX plugin hardening in isolated OpenCode servers", () => {
  test("a custom base URL without the opt-in is ignored and the key never goes to it", async () => {
    const mock = startMockFuelix({ models: listedChatIDs() })
    const server = await startIsolatedServer({
      config: { plugins: [pluginEntry({ fuelix: { baseURL: mock.url, keychainService: false, refreshMinutes: 0 } })] },
      env: { FUELIX_API_KEY: FAKE_KEY, TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL: "0" },
    })
    try {
      const { providers } = await waitFor(async () => {
        const listed = await listProviders(server)
        return listed.providers.some((p) => isFuelix(p.id)) ? listed : undefined
      }, 60_000, "FueliX providers")
      const fuelix = providers.find((p) => p.id === "fuelix")
      expect(fuelix?.settings?.baseURL).toBe("https://api.fuelix.ai")
      await waitFor(async () => (server.logs().includes("fuelix.baseURL is ignored") ? true : undefined), 30_000, "warning")
      expect(mock.requests).toEqual([])
      expect(server.logs()).not.toContain(FAKE_KEY)
    } finally {
      await server.stop()
      mock.stop()
    }
  }, TIMEOUT)

  test("a FueliX provider block with a key in the configuration produces one warning without the key", async () => {
    const mock = startMockFuelix({ models: listedChatIDs() })
    const server = await startIsolatedServer({
      config: {
        plugins: [pluginEntry({ fuelix: { baseURL: mock.url, keychainService: false, refreshMinutes: 0 } })],
        providers: { "fuelix-anthropic": { settings: { apiKey: FAKE_KEY } } },
      },
      env: { FUELIX_API_KEY: FAKE_KEY },
    })
    try {
      await listProviders(server) // Boots the location and runs plugin setup.
      await waitFor(async () => (server.logs().includes("hold a credential") ? true : undefined), 60_000, "stale configuration warning")
      const warnings = server.logs().split("\n").filter((line) => line.includes("hold a credential"))
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("fuelix-anthropic settings.apiKey")
      expect(warnings[0]).not.toContain(FAKE_KEY)
    } finally {
      await server.stop()
      mock.stop()
    }
  }, TIMEOUT)
})
