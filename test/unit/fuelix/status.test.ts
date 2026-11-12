import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryLogger } from "../../../src/log.ts"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"
import { setupFuelix, type FuelixDeps } from "../../../src/fuelix/index.ts"
import {
  createFileStatusWriter,
  createStatusRecorder,
  PLUGIN_VERSION,
  REASONS,
  sanitizeReport,
  statusFileName,
  statusReportRoot,
  type FuelixStatusReport,
  type StatusReportLocation,
  type StatusState,
} from "../../../src/fuelix/status.ts"
import type { FuelixOptions } from "../../../src/options.ts"
import { createFakeCtx, waitFor, type FakeOptions } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)
const CACHE = "fuelix/models"

const options: FuelixOptions = {
  baseURL: "https://api.fuelix.test",
  keychainService: "fuelix-api-key",
  refreshMinutes: 60,
  includeNonChatModels: false,
  discoveryTimeoutMs: 1000,
  scrubShellEnv: true,
}

const noKeychain = async () => ({ exitCode: 44, stdout: "" })
const modelsResponse = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))

function collector(extra: { fail?: boolean; delay?: boolean } = {}) {
  const reports: FuelixStatusReport[] = []
  const locations: (StatusReportLocation | undefined)[] = []
  let active = 0
  let maxActive = 0
  const gates: (() => void)[] = []
  const state = { fail: extra.fail ?? false, delay: extra.delay ?? false }
  const write = async (report: FuelixStatusReport, location?: StatusReportLocation) => {
    active++
    maxActive = Math.max(maxActive, active)
    try {
      if (state.delay) await new Promise<void>((resolve) => gates.push(resolve))
      if (state.fail) throw new Error(`write failed with ${KEY}`)
      reports.push(structuredClone(report))
      locations.push(location)
    } finally {
      active--
    }
  }
  return {
    reports,
    locations,
    write,
    state,
    gates,
    maxActive: () => maxActive,
    last: () => reports[reports.length - 1],
  }
}

type Collector = ReturnType<typeof collector>

/** Waits for a finished check that differs from `previous`. */
async function checkDone(c: Collector, previous: string | null = null): Promise<FuelixStatusReport> {
  await waitFor(() => {
    const report = c.last()
    return report !== undefined && !report.checking && report.lastCheck !== null && report.lastCheck.finishedAt !== previous
  })
  return c.last()!
}

function clock() {
  let time = Date.parse("2026-11-12T10:00:00.000Z")
  return () => new Date((time += 1000))
}

async function setup(
  c: Collector,
  input: {
    fake?: FakeOptions
    deps?: Partial<FuelixDeps>
    options?: Partial<FuelixOptions>
    /** Runs before setup, so a test can replace fake context methods without racing the startup check. */
    prepare?: (fake: ReturnType<typeof createFakeCtx>) => void
  } = {},
) {
  const fake = createFakeCtx(input.fake)
  input.prepare?.(fake)
  const log = createMemoryLogger()
  const ticks: (() => void)[] = []
  const deps: FuelixDeps = {
    loadCatalog: () => loadCatalog(CATALOG_URL),
    exec: noKeychain,
    env: {},
    platform: "darwin",
    keychainCache: new Map(),
    staleConfigHolder: {},
    staleConfigDelaysMs: [0],
    now: clock(),
    setInterval: (callback) => {
      ticks.push(callback)
      return undefined
    },
    clearInterval: () => {},
    fetch: async () => {
      throw new Error("unexpected fetch")
    },
    statusReport: c.write,
    ...input.deps,
  }
  const cleanup = await setupFuelix(fake.ctx, { ...options, ...input.options }, log, deps)
  fake.runProviderTransforms()
  return { fake, log, cleanup, tick: () => ticks[0]!() }
}

const withKey = { env: { FUELIX_API_KEY: KEY } }
const ids5 = ["gpt-6-luna", "gpt-6-a", "gpt-6-b", "gpt-6-c", "gpt-6-d"]

describe("status report lifecycle", () => {
  test("startup snapshot describes the configuration and the registered models", async () => {
    const c = collector()
    const gate = Promise.withResolvers<Response>()
    await setup(c, { deps: { ...withKey, fetch: () => gate.promise } })
    await waitFor(() => c.reports.length >= 1)
    const first = c.reports[0]!
    expect(first).toMatchObject({
      version: 1,
      pluginVersion: PLUGIN_VERSION,
      directory: "/fake/project",
      checking: false,
      lastCheck: null,
      lastSuccessfulCheckAt: null,
      lastChange: null,
      configuration: {
        refreshMinutes: 60,
        includeNonChatModels: false,
        authSource: "environment",
        activation: "enabled",
        shellKeyScrubbing: "enabled",
        batchTools: "registered",
        authHooks: { sessionProviders: ["fuelix-openai", "fuelix-anthropic", "fuelix"], aiSdk: true },
      },
      models: {
        source: "catalog",
        providers: [
          { id: "fuelix-openai", count: 1, titleModel: "gpt-6-luna" },
          { id: "fuelix-anthropic", count: 1, titleModel: null },
          { id: "fuelix", count: 1, titleModel: null },
        ],
      },
    })
    expect(Date.parse(first.startedAt)).toBeLessThanOrEqual(Date.parse(first.recordedAt))
    gate.resolve(modelsResponse("gpt-6-luna", "claude-opus", "gemini-3.5-flash"))
    const done = await checkDone(c)
    expect(done.lastCheck?.outcome).toBe("unchanged")
    // Reports show a running check before it ends.
    expect(c.reports.some((report) => report.checking)).toBe(true)
  })

  test("a discovery that adds models reports them and keeps lastChange after an unchanged check", async () => {
    const c = collector()
    const found = ["claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new"]
    const { tick, fake } = await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse(...found) } })
    const first = await checkDone(c)
    expect(first.lastCheck).toMatchObject({ outcome: "updated", added: ["gpt-7-new"], removed: [], reason: null, reload: "succeeded" })
    expect(first.lastSuccessfulCheckAt).toBe(first.lastCheck!.finishedAt)
    expect(first.lastChange).toEqual({ at: first.lastCheck!.finishedAt, added: ["gpt-7-new"], removed: [] })
    expect(first.models.source).toBe("discovery")
    expect(first.models.providers.find((provider) => provider.id === "fuelix-openai")?.count).toBe(2)
    expect(fake.state.reloads).toBe(1)

    tick()
    const second = await checkDone(c, first.lastCheck!.finishedAt)
    expect(second.lastCheck).toMatchObject({ outcome: "unchanged", added: [], removed: [], reload: "not-needed" })
    expect(second.lastSuccessfulCheckAt).toBe(second.lastCheck!.finishedAt)
    expect(second.lastChange).toEqual(first.lastChange)
    expect(fake.state.reloads).toBe(1)
  })

  test("removals are reported", async () => {
    const c = collector()
    const found = ids5.slice(0, 4)
    await setup(c, {
      fake: { storage: { [CACHE]: { fetchedAt: "x", ids: ids5 } } },
      deps: { ...withKey, fetch: async () => modelsResponse(...found) },
    })
    const done = await checkDone(c)
    expect(done.models.source).toBe("discovery")
    expect(done.lastCheck).toMatchObject({ outcome: "updated", added: [], removed: ["gpt-6-d"] })
    expect(done.lastChange?.removed).toEqual(["gpt-6-d"])
  })

  test("the cache source is labeled and is not reported as an addition", async () => {
    const c = collector()
    await setup(c, { fake: { storage: { [CACHE]: { fetchedAt: "x", ids: ["gpt-6-luna"] } } }, deps: { ...withKey, fetch: async () => modelsResponse("gpt-6-luna") } })
    const done = await checkDone(c)
    expect(c.reports[0]!.models.source).toBe("cache")
    expect(c.reports[0]!.lastChange).toBeNull()
    expect(done.models.source).toBe("cache")
    expect(done.lastCheck).toMatchObject({ outcome: "unchanged", added: [], removed: [] })
    expect(done.lastChange).toBeNull()
  })

  test("a new non-chat API ID changes the cache but is not reported as an added model", async () => {
    const c = collector()
    const { fake } = await setup(c, {
      fake: { storage: { [CACHE]: { fetchedAt: "x", ids: ["gpt-6-luna"] } } },
      deps: { ...withKey, fetch: async () => modelsResponse("gpt-6-luna", "text-embedding-9") },
    })
    const done = await checkDone(c)
    expect(done.lastCheck).toMatchObject({ outcome: "unchanged", added: [], removed: [], reload: "succeeded" })
    expect(done.lastChange).toBeNull()
    expect(fake.storage.get(CACHE)).toMatchObject({ ids: ["gpt-6-luna", "text-embedding-9"] })
  })

  test("a drop that is too large is rejected", async () => {
    const c = collector()
    const { fake } = await setup(c, {
      fake: { storage: { [CACHE]: { fetchedAt: "x", ids: ids5 } } },
      deps: { ...withKey, fetch: async () => modelsResponse("gpt-6-luna", "gpt-6-a", "gpt-6-b") },
    })
    const done = await checkDone(c)
    expect(done.lastCheck).toMatchObject({ outcome: "rejected", reason: REASONS.dropShare, added: [], removed: [], reload: "not-needed" })
    expect(done.lastSuccessfulCheckAt).toBeNull()
    expect(done.lastChange).toBeNull()
    expect(fake.state.reloads).toBe(0)
  })

  test("a result that empties a provider is rejected", async () => {
    const c = collector()
    await setup(c, {
      fake: { storage: { [CACHE]: { fetchedAt: "x", ids: ["gpt-6-luna", "claude-opus", "gemini-3.5-flash", "gemini-x"] } } },
      deps: { ...withKey, fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gemini-x") },
    })
    const done = await checkDone(c)
    expect(done.lastCheck).toMatchObject({ outcome: "rejected", reason: REASONS.providerEmptied })
  })

  test("an empty response is recorded", async () => {
    const c = collector()
    await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse() } })
    const done = await checkDone(c)
    expect(done.lastCheck).toMatchObject({ outcome: "empty", reason: REASONS.empty, reload: "not-needed" })
    expect(done.lastSuccessfulCheckAt).toBeNull()
  })

  test("a fetch failure uses a fixed reason and never the exception text", async () => {
    const c = collector()
    const { log } = await setup(c, {
      deps: {
        ...withKey,
        fetch: async () => {
          throw new Error(`connect ECONNREFUSED with ${KEY} and /Users/secret/path`)
        },
      },
    })
    const done = await checkDone(c)
    expect(done.lastCheck).toMatchObject({ outcome: "failed", reason: REASONS.checkFailed, reload: "not-needed" })
    expect(JSON.stringify(c.reports)).not.toContain("ECONNREFUSED")
    expect(JSON.stringify(c.reports)).not.toContain(KEY)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a rejected key has its own fixed reason", async () => {
    const c = collector()
    await setup(c, { deps: { ...withKey, fetch: async () => new Response("{}", { status: 401 }) } })
    expect((await checkDone(c)).lastCheck).toMatchObject({ outcome: "failed", reason: REASONS.keyRejected })
  })

  test("a failed reload does not claim that models were applied, and the next cycle retries it", async () => {
    const c = collector()
    const found = ["claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new"]
    let failReload = true
    const { tick, log } = await setup(c, {
      deps: { ...withKey, fetch: async () => modelsResponse(...found) },
      prepare: (fake) => {
        const original = fake.ctx.provider.reload.bind(fake.ctx.provider)
        ;(fake.ctx.provider as { reload: () => Promise<void> }).reload = async () => {
          if (failReload) throw new Error(`reload exploded ${KEY}`)
          await original()
        }
      },
    })
    const startup = await checkDone(c)
    expect(startup.lastCheck).toMatchObject({ outcome: "failed", reason: REASONS.reloadFailed, reload: "failed", added: [], removed: [] })
    expect(startup.models.source).toBe("catalog")
    expect(startup.models.providers.find((provider) => provider.id === "fuelix-openai")?.count).toBe(1)
    expect(startup.lastChange).toBeNull()
    expect(startup.lastSuccessfulCheckAt).toBeNull()
    failReload = false
    tick()
    const retried = await checkDone(c, startup.lastCheck!.finishedAt)
    expect(retried.lastCheck).toMatchObject({ outcome: "updated", added: ["gpt-7-new"], removed: [], reload: "succeeded" })
    expect(retried.models.source).toBe("discovery")
    expect(retried.lastChange?.added).toEqual(["gpt-7-new"])
    expect(JSON.stringify(c.reports)).not.toContain(KEY)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a missing key at startup records a no-key snapshot and does not fetch", async () => {
    const c = collector()
    await setup(c)
    await waitFor(() => c.reports.length >= 1)
    const first = c.reports[0]!
    expect(first.lastCheck).toMatchObject({ outcome: "no-key", reason: REASONS.noKey, added: [], removed: [], reload: "not-needed" })
    expect(first.configuration).toMatchObject({ authSource: "none", activation: "auto" })
    expect(first.lastSuccessfulCheckAt).toBeNull()
    expect(first.checking).toBe(false)
  })

  test("a periodic check without a key records no-key and keeps earlier results", async () => {
    const c = collector()
    const { tick, fake } = await setup(c, { fake: { connectionKey: KEY }, deps: { fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new") } })
    const first = await checkDone(c)
    expect(first.configuration.authSource).toBe("credential-store")
    expect(first.lastCheck?.outcome).toBe("updated")
    fake.setConnectionKey(undefined)
    tick()
    const second = await checkDone(c, first.lastCheck!.finishedAt)
    expect(second.lastCheck).toMatchObject({ outcome: "no-key", reason: REASONS.noKey })
    expect(second.configuration.authSource).toBe("none")
    expect(second.lastSuccessfulCheckAt).toBe(first.lastSuccessfulCheckAt)
    expect(second.lastChange).toEqual(first.lastChange)
  })

  test("report text never contains a key, even from hostile model IDs and locations", async () => {
    const c = collector()
    const hostileID = `gpt-${KEY}-x`
    await setup(c, {
      fake: { directory: `/work/${KEY}/project` },
      deps: { ...withKey, fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", hostileID) },
    })
    const done = await checkDone(c)
    expect(done.lastCheck?.added).toEqual(["gpt-[redacted]-x"])
    expect(done.directory).toBe("/work/[redacted]/project")
    expect(JSON.stringify(c.reports)).not.toContain(KEY)
    // The writer gets the real path as a separate location, so the file name matches what the panel computes.
    expect(c.locations.every((location) => location?.directory === `/work/${KEY}/project`)).toBe(true)
  })

  test("a short key that is not sk- or ak- never appears anywhere in the serialized reports", async () => {
    const c = collector()
    const short = "zq91x7k"
    await setup(c, {
      fake: { directory: `/work/${short}/p` },
      deps: {
        env: { FUELIX_API_KEY: short },
        fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", `m-${short}`),
      },
    })
    await checkDone(c)
    expect(JSON.stringify(c.reports)).not.toContain(short)
    expect(c.last()!.lastCheck?.added).toEqual(["m-[redacted]"])
  })

  test("statusReport false writes nothing", async () => {
    const c = collector()
    const { tick } = await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse("gpt-6-luna", "gpt-7-new") }, options: { statusReport: false } })
    tick()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(c.reports).toEqual([])
  })

  test("without an injected writer nothing is written and setup works", async () => {
    const fake = createFakeCtx()
    const cleanup = await setupFuelix(fake.ctx, options, createMemoryLogger(), {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: noKeychain,
      env: {},
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
    })
    await cleanup()
  })

  test("a failing writer is nonfatal: discovery, reload and cache still work, one warning per failure streak", async () => {
    const c = collector({ fail: true })
    const { fake, log, tick } = await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new") } })
    await waitFor(() => fake.state.reloads === 1)
    await waitFor(() => log.lines.some((line) => line.includes("status report write failed")))
    expect(fake.storage.get(CACHE)).toMatchObject({ ids: ["claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new"] })
    tick()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(log.lines.filter((line) => line.includes("status report write failed")).length).toBe(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a writer that throws synchronously is nonfatal", async () => {
    const fake = createFakeCtx()
    const log = createMemoryLogger()
    const cleanup = await setupFuelix(fake.ctx, options, log, {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: noKeychain,
      env: {},
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
      setInterval: () => undefined,
      statusReport: (() => {
        throw new Error("sync failure")
      }) as never,
    })
    await waitFor(() => log.lines.some((line) => line.includes("status report write failed")))
    await cleanup()
  })

  test("a failing cache write is nonfatal and the check still reports the update", async () => {
    const c = collector()
    const fake = createFakeCtx()
    ;(fake.ctx.storage as unknown as { set: () => Promise<void> }).set = async () => {
      throw new Error("disk full")
    }
    const cleanup = await setupFuelix(fake.ctx, options, createMemoryLogger(), {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: noKeychain,
      env: { FUELIX_API_KEY: KEY },
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
      setInterval: () => undefined,
      fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new"),
      statusReport: c.write,
    })
    expect((await checkDone(c)).lastCheck).toMatchObject({ outcome: "updated", added: ["gpt-7-new"] })
    await cleanup()
  })

  test("writes are serialized and updates during a write merge into the latest state", async () => {
    const c = collector({ delay: true })
    await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new") } })
    await waitFor(() => c.gates.length >= 1)
    // The first write is blocked. Later state changes must not start a second write.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(c.gates.length).toBe(1)
    c.state.delay = false
    c.gates.shift()!()
    await checkDone(c)
    expect(c.maxActive()).toBe(1)
    expect(c.last()!.lastCheck?.outcome).toBe("updated")
    // Initial write, plus one merged write for every later change.
    expect(c.reports.length).toBeLessThanOrEqual(3)
  })

  test("disposal writes no report and a check that finishes after it is not recorded", async () => {
    const c = collector()
    const gate = Promise.withResolvers<Response>()
    const { cleanup } = await setup(c, { deps: { ...withKey, fetch: () => gate.promise } })
    await waitFor(() => c.reports.some((report) => report.checking))
    await cleanup()
    const count = c.reports.length
    gate.resolve(modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(c.reports.length).toBe(count)
  })

  test("a reload does not cause another report write loop", async () => {
    const c = collector()
    const { fake } = await setup(c, { deps: { ...withKey, fetch: async () => modelsResponse("claude-opus", "gemini-3.5-flash", "gpt-6-luna", "gpt-7-new") } })
    await checkDone(c)
    const count = c.reports.length
    fake.runProviderTransforms()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(c.reports.length).toBe(count)
  })

  test("the shell and batch registration results appear in the configuration", async () => {
    const c = collector()
    await setup(c, { options: { scrubShellEnv: false } })
    await waitFor(() => c.reports.length >= 1)
    expect(c.reports[0]!.configuration.shellKeyScrubbing).toBe("disabled")

    const d = collector()
    await setup(d, { fake: { failToolTransform: true, failHookFor: "fuelix" } })
    await waitFor(() => d.reports.length >= 1)
    expect(d.reports[0]!.configuration.batchTools).toBe("failed")
    expect(d.reports[0]!.configuration.authHooks.sessionProviders).toEqual(["fuelix-openai", "fuelix-anthropic"])
  })
})

describe("sanitizeReport", () => {
  const base = (): FuelixStatusReport => ({
    version: 1,
    pluginVersion: "1.0.0",
    directory: null,
    startedAt: "2026-11-12T10:00:00.000Z",
    recordedAt: "2026-11-12T10:00:01.000Z",
    checking: false,
    configuration: {
      refreshMinutes: 60,
      includeNonChatModels: false,
      authSource: "none",
      activation: "auto",
      shellKeyScrubbing: "enabled",
      batchTools: "registered",
      authHooks: { sessionProviders: [], aiSdk: false },
    },
    models: { source: "catalog", providers: [] },
    lastCheck: null,
    lastSuccessfulCheckAt: null,
    lastChange: null,
  })

  test("drops unknown fields, invalid enums and arbitrary reason text", () => {
    const dirty = {
      ...base(),
      apiKey: KEY,
      headers: { authorization: `Bearer ${KEY}` },
      configuration: { ...base().configuration, authSource: KEY, secret: KEY },
      lastCheck: {
        startedAt: "bad",
        finishedAt: "2026-11-12T10:00:00.000Z",
        outcome: "weird",
        added: ["a"],
        removed: [],
        reason: `Error: connect failed ${KEY}`,
        reload: "nope",
        extra: KEY,
      },
    } as unknown as FuelixStatusReport
    const clean = sanitizeReport(dirty, [KEY])
    const json = JSON.stringify(clean)
    expect(json).not.toContain(KEY)
    expect(json).not.toContain("headers")
    expect(clean.configuration.authSource).toBe("none")
    expect(clean.lastCheck).toMatchObject({ startedAt: "1970-01-01T00:00:00.000Z", outcome: "failed", reason: REASONS.unexpected, reload: "not-needed" })
  })

  test("redacts exact keys and secret-like tokens and keeps everything else in full", () => {
    const other = "custom-secret-value-123"
    const report = base()
    const long = "x".repeat(1000)
    const many = Array.from({ length: 900 }, (_, i) => `id-${i}`)
    const directory = `/${"d".repeat(3000)}`
    const clean = sanitizeReport(
      { ...report, directory, lastChange: { at: report.startedAt, added: [`m-${other}`, "sk-abcdefghijk", long], removed: many } },
      [other],
    )
    expect(clean.lastChange!.added).toEqual(["m-[redacted]", "sk-[redacted]", long])
    expect(clean.lastChange!.removed).toEqual(many)
    expect(clean.directory).toBe(directory)
  })

  test("redacts a short key of 7 characters that has no sk- or ak- form", () => {
    const short = "zq91x7k"
    const clean = sanitizeReport(
      { ...base(), directory: `/a/${short}/b`, lastChange: { at: base().startedAt, added: [`m${short}`], removed: [] } },
      [short],
    )
    expect(JSON.stringify(clean)).not.toContain(short)
    expect(sanitizeReport({ ...base(), directory: "/a/q/b" }, ["q"]).directory).toBe("/a/[redacted]/b")
  })

  test("the replacement token never contains a secret and a removal that joins a match is repeated", () => {
    const clean = sanitizeReport({ ...base(), directory: "/red/acte" }, ["red", "acte"])
    expect(clean.directory).not.toContain("red")
    expect(clean.directory).not.toContain("acte")
    const joined = sanitizeReport({ ...base(), directory: "/aabb" }, ["ab", "a[x]b", "[redacted]", "[removed]", "[hidden]", "***", "#"])
    expect(joined.directory).not.toContain("ab")
    expect(sanitizeReport({ ...base(), directory: "/ab" }, ["ab", "[redacted]"]).directory).toBe("/[removed]")
  })

  test("fixed reasons are scrubbed too", () => {
    const report = { ...base(), lastCheck: { startedAt: base().startedAt, finishedAt: base().startedAt, outcome: "failed", added: [], removed: [], reason: REASONS.keyRejected, reload: "not-needed" } } as FuelixStatusReport
    const clean = sanitizeReport(report, ["gateway"])
    expect(clean.lastCheck!.reason).toBe("The [redacted] rejected the API key")
    expect(JSON.stringify(clean)).not.toContain("gateway")
    expect(sanitizeReport(report, []).lastCheck!.reason).toBe(REASONS.keyRejected)
  })
})

describe("createStatusRecorder", () => {
  const initial = (): StatusState => ({
    checking: false,
    configuration: sanitizeReport({ configuration: undefined } as never).configuration,
    models: { source: "catalog", providers: [] },
    lastCheck: null,
    lastSuccessfulCheckAt: null,
    lastChange: null,
  })

  test("close stops later writes", async () => {
    const reports: FuelixStatusReport[] = []
    const recorder = createStatusRecorder({
      directory: null,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: async (report) => void reports.push(report),
      log: createMemoryLogger(),
      initial: initial(),
      secrets: () => [],
    })
    recorder.update({ checking: true })
    await recorder.flush()
    recorder.close()
    recorder.update({ checking: false })
    await recorder.flush()
    expect(reports.map((report) => report.checking)).toEqual([true])
  })

  test("a writer that throws synchronously does not stall later updates", async () => {
    const reports: FuelixStatusReport[] = []
    let calls = 0
    const log = createMemoryLogger()
    const recorder = createStatusRecorder({
      directory: null,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: ((report: FuelixStatusReport) => {
        calls++
        if (calls === 1) throw new Error("sync failure")
        reports.push(report)
        return Promise.resolve()
      }) as never,
      log,
      initial: initial(),
      secrets: () => [],
    })
    recorder.update({ checking: true })
    await recorder.flush()
    expect(calls).toBe(1)
    expect(reports).toEqual([])
    recorder.update({ checking: false })
    await recorder.flush()
    expect(calls).toBe(2)
    expect(reports.length).toBe(1)
    expect(log.lines.filter((line) => line.includes("write failed")).length).toBe(1)
  })

  test("a report above the size limit is rejected as a whole and the writer is not called", async () => {
    let calls = 0
    const log = createMemoryLogger()
    const recorder = createStatusRecorder({
      directory: null,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: async () => void calls++,
      log,
      initial: initial(),
      secrets: () => [],
    })
    const added = Array.from({ length: 200_000 }, (_, i) => `model-with-a-long-identifier-${i}`)
    recorder.update({ lastChange: { at: "2026-11-12T10:00:00.000Z", added, removed: [] } })
    await recorder.flush()
    expect(calls).toBe(0)
    expect(log.lines.some((line) => line.includes("status report write failed") && line.includes("ETOOLARGE"))).toBe(true)
    // A smaller report goes through later.
    recorder.update({ lastChange: null })
    await recorder.flush()
    expect(calls).toBe(1)
  })

  test("remembers every key it has seen, with no cap", async () => {
    const reports: FuelixStatusReport[] = []
    let current = ""
    const recorder = createStatusRecorder({
      directory: null,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: async (report) => void reports.push(report),
      log: createMemoryLogger(),
      initial: initial(),
      secrets: () => [current],
    })
    for (let i = 0; i < 40; i++) {
      current = `key${String(i).padStart(2, "0")}`
      recorder.update({ checking: i % 2 === 0 })
    }
    recorder.update({ lastChange: { at: "2026-11-12T10:00:00.000Z", added: ["m-key00", "m-key39"], removed: [] } })
    await recorder.flush()
    expect(JSON.stringify(reports[reports.length - 1])).not.toMatch(/key\d\d/)
  })

  test("keeps redacting a rotated key", async () => {
    const reports: FuelixStatusReport[] = []
    let current: string | undefined = "sk-first-secret-key"
    const recorder = createStatusRecorder({
      directory: null,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: async (report) => void reports.push(report),
      log: createMemoryLogger(),
      initial: initial(),
      secrets: () => [current],
    })
    recorder.update({ checking: true })
    await recorder.flush()
    current = "custom-second-secret"
    recorder.update({
      lastChange: { at: "2026-11-12T10:00:00.000Z", added: ["m-sk-first-secret-key", "m-custom-second-secret"], removed: [] },
    })
    await recorder.flush()
    expect(reports[1]!.lastChange!.added).toEqual(["m-[redacted]", "m-[redacted]"])
  })
})

describe("createFileStatusWriter", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "td-status-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const report = (directory: string | null): FuelixStatusReport =>
    sanitizeReport({ configuration: undefined, directory, startedAt: "2026-11-12T10:00:00.000Z", recordedAt: "2026-11-12T10:00:00.000Z" } as never)

  test("file names are the SHA-256 of the UTF-8 directory, or global", () => {
    const directory = "/Users/ñandú/proyecto"
    expect(statusFileName(directory)).toBe(`${createHash("sha256").update(Buffer.from(directory, "utf8")).digest("hex")}.json`)
    expect(statusFileName(null)).toBe("global.json")
    expect(statusFileName("/a")).not.toBe(statusFileName("/b"))
  })

  test("the default root is below the home directory", async () => {
    expect(statusReportRoot("/home/x")).toBe("/home/x/.td-opencode-plugin/status")
    const write = createFileStatusWriter({ homedir: () => dir })
    await write(report("/p"))
    const text = await readFile(join(dir, ".td-opencode-plugin", "status", statusFileName("/p")), "utf8")
    expect(JSON.parse(text).directory).toBe("/p")
  })

  test("writes atomically with private modes and replaces the previous report", async () => {
    const root = join(dir, "status")
    const write = createFileStatusWriter({ root })
    await write(report("/p"))
    await write({ ...report("/p"), checking: true })
    await write(report(null))
    const files = (await readdir(root)).sort()
    expect(files).toEqual([statusFileName("/p"), "global.json"].sort())
    expect(JSON.parse(await readFile(join(root, statusFileName("/p")), "utf8")).checking).toBe(true)
    expect((await stat(join(root, "global.json"))).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })

  test("concurrent writes leave valid JSON and no temporary files", async () => {
    const root = join(dir, "status")
    const write = createFileStatusWriter({ root })
    await Promise.all(Array.from({ length: 20 }, (_, i) => write({ ...report("/p"), checking: i % 2 === 0 })))
    expect(await readdir(root)).toEqual([statusFileName("/p")])
    expect(() => JSON.parse(readFileSync(join(root, statusFileName("/p")), "utf8"))).not.toThrow()
  })

  test("a failed write rejects and leaves no temporary file", async () => {
    const root = join(dir, "status")
    await mkdir(join(root, statusFileName("/p")), { recursive: true }) // A directory blocks the rename.
    const write = createFileStatusWriter({ root })
    await expect(write(report("/p"))).rejects.toBeDefined()
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("the file name comes from the real directory while the JSON holds the scrubbed one", async () => {
    const root = join(dir, "status")
    const real = `/work/${KEY}/project`
    const writer = createFileStatusWriter({ root })
    const recorder = createStatusRecorder({
      directory: real,
      startedAt: new Date(0),
      now: () => new Date(1000),
      write: writer,
      log: createMemoryLogger(),
      initial: {
        checking: false,
        configuration: sanitizeReport({ configuration: undefined } as never).configuration,
        models: { source: "catalog", providers: [] },
        lastCheck: null,
        lastSuccessfulCheckAt: null,
        lastChange: null,
      },
      secrets: () => [KEY],
    })
    recorder.update({ checking: true })
    await recorder.flush()
    expect(await readdir(root)).toEqual([statusFileName(real)])
    const text = await readFile(join(root, statusFileName(real)), "utf8")
    expect(JSON.parse(text).directory).toBe("/work/[redacted]/project")
    expect(text).not.toContain(KEY)
  })

  test("the writer rejects an overlarge report and keeps the previous file", async () => {
    const root = join(dir, "status")
    const write = createFileStatusWriter({ root })
    await write(report("/p"))
    const added = Array.from({ length: 200_000 }, (_, i) => `model-with-a-long-identifier-${i}`)
    await expect(write({ ...report("/p"), lastChange: { at: "2026-11-12T10:00:00.000Z", added, removed: [] } })).rejects.toMatchObject({ code: "ETOOLARGE" })
    expect(await readdir(root)).toEqual([statusFileName("/p")])
    expect(JSON.parse(await readFile(join(root, statusFileName("/p")), "utf8")).lastChange).toBeNull()
  })

  test("an unusable root rejects", async () => {
    const file = join(dir, "blocker")
    await writeFile(file, "x")
    await expect(createFileStatusWriter({ root: join(file, "status") })(report(null))).rejects.toBeDefined()
  })
})
