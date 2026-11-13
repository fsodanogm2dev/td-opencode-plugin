import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"
import { createStorageModelHistory, HISTORY_PREFIX, type ModelHistoryStore } from "../../../src/fuelix/history.ts"
import { setupFuelix, type FuelixDeps } from "../../../src/fuelix/index.ts"
import type { FuelixStatusReport, StatusReportLocation } from "../../../src/fuelix/status.ts"
import type { FuelixOptions } from "../../../src/options.ts"
import { createFakeCtx, waitFor, type FakeOptions } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const KEY2 = "sk-test-rotated-key-two"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)
const CACHE = "fuelix/models"
const T0 = "2026-11-12T09:00:00.000Z"

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

const S0 = ["claude-opus", "gemini-3.5-flash", "gpt-6-luna"]
const S1 = [...S0, "gpt-7-new"]
const S2 = [...S1, "gpt-8-next"]

function collector(extra: { delay?: boolean } = {}) {
  const reports: FuelixStatusReport[] = []
  const gates: (() => void)[] = []
  const state = { delay: extra.delay ?? false }
  const write = async (report: FuelixStatusReport, _location?: StatusReportLocation) => {
    if (state.delay) await new Promise<void>((resolve) => gates.push(resolve))
    reports.push(structuredClone(report))
  }
  return { reports, write, gates, state, last: () => reports[reports.length - 1] }
}

type Collector = ReturnType<typeof collector>

function clock(start = "2026-11-12T10:00:00.000Z") {
  let time = Date.parse(start)
  return () => new Date((time += 1000))
}

async function checkDone(c: Collector, previous: string | null = null): Promise<FuelixStatusReport> {
  await waitFor(() => {
    const report = c.last()
    return report !== undefined && !report.checking && report.lastCheck !== null && report.lastCheck.finishedAt !== previous
  })
  return c.last()!
}

async function setup(
  c: Collector,
  input: {
    fake?: FakeOptions
    deps?: Partial<FuelixDeps>
    options?: Partial<FuelixOptions>
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
    env: { FUELIX_API_KEY: KEY },
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

const historyKeys = (map: Map<string, unknown>) => [...map.keys()].filter((key) => key.startsWith(HISTORY_PREFIX))
const cache = (fetchedAt: string, ids: string[]) => ({ [CACHE]: { fetchedAt, ids } })
const warns = (log: { lines: string[] }) => log.lines.filter((line) => line.includes(" warn "))

describe("model history in the plugin setup", () => {
  test("a change stays visible after an unchanged check and after a fresh setup in another location", async () => {
    const shared = new Map<string, unknown>()
    const found = { ids: S1 }
    const a = collector()
    const first = await setup(a, {
      fake: { sharedStorage: shared, storage: cache(T0, S0), directory: "/loc/a" },
      deps: { fetch: async () => modelsResponse(...found.ids) },
    })
    const startup = a.reports[0] ?? (await waitFor(() => a.reports.length > 0), a.reports[0]!)
    expect(startup.modelHistory).toEqual({
      since: T0,
      truncated: false,
      entries: [{ kind: "baseline", fetchedAt: T0, source: "cache", totalIDs: 3, eligible: 3, added: [], removed: [] }],
    })
    const changed = await checkDone(a)
    const fetchedAt = (shared.get(CACHE) as { fetchedAt: string }).fetchedAt
    expect(changed.modelHistory!.entries.map((entry) => [entry.kind, entry.fetchedAt, entry.source, entry.added])).toEqual([
      ["change", fetchedAt, "discovery", ["gpt-7-new"]],
      ["baseline", T0, "cache", []],
    ])
    expect(changed.modelHistory!.entries[0]).toMatchObject({ totalIDs: 4, eligible: 4, removed: [] })
    expect(changed.lastChange?.added).toEqual(["gpt-7-new"])

    // The hourly check is unchanged. The history keeps the change, and no key is added.
    const keysBefore = historyKeys(shared).length
    expect(keysBefore).toBe(2)
    first.tick()
    const unchanged = await checkDone(a, changed.lastCheck!.finishedAt)
    expect(unchanged.lastCheck?.outcome).toBe("unchanged")
    expect(unchanged.modelHistory).toEqual(changed.modelHistory)
    expect(historyKeys(shared)).toHaveLength(keysBefore)

    // Another location starts later from the shared cache and shows the first location's change.
    const b = collector()
    await setup(b, {
      fake: { sharedStorage: shared, directory: "/loc/b" },
      deps: { fetch: () => new Promise<Response>(() => {}) },
    })
    await waitFor(() => b.reports.length > 0)
    const other = b.reports[0]!
    expect(other.directory).toBe("/loc/b")
    expect(other.lastChange).toBeNull()
    expect(other.modelHistory).toEqual(changed.modelHistory)
    expect(historyKeys(shared)).toHaveLength(keysBefore)
  })

  test("a fresh setup with the same storage keeps the history across a restart", async () => {
    const shared = new Map<string, unknown>()
    const a = collector()
    await setup(a, { fake: { sharedStorage: shared, storage: cache(T0, S0) }, deps: { fetch: async () => modelsResponse(...S1) } })
    const done = await checkDone(a)
    const b = collector()
    await setup(b, { fake: { sharedStorage: shared }, deps: { fetch: async () => modelsResponse(...S1) } })
    const restarted = await checkDone(b)
    expect(restarted.lastCheck?.outcome).toBe("unchanged")
    expect(restarted.modelHistory).toEqual(done.modelHistory)
  })

  test("each location filters by what it registers; the totals count every ID", async () => {
    const withEmbedding = [...S1, "text-embedding-9"]
    const chat = collector()
    await setup(chat, { fake: { storage: cache(T0, S0) }, deps: { fetch: async () => modelsResponse(...withEmbedding) } })
    const chatReport = await checkDone(chat)
    expect(chatReport.modelHistory!.entries[0]).toMatchObject({ added: ["gpt-7-new"], totalIDs: 5, eligible: 4 })
    const all = collector()
    await setup(all, {
      fake: { storage: cache(T0, S0) },
      options: { includeNonChatModels: true },
      deps: { fetch: async () => modelsResponse(...withEmbedding) },
    })
    const allReport = await checkDone(all)
    expect(allReport.modelHistory!.entries[0]).toMatchObject({ added: ["gpt-7-new", "text-embedding-9"], totalIDs: 5, eligible: 5 })
  })

  test("a catalog-only startup records nothing and the history is null", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    await setup(c, { fake: { sharedStorage: shared }, deps: { env: {} } })
    await waitFor(() => c.reports.length > 0)
    expect(c.reports[0]!.modelHistory).toBeNull()
    expect(historyKeys(shared)).toEqual([])
  })

  test("a cache with an invalid fetchedAt records nothing and invents no time", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    await setup(c, { fake: { sharedStorage: shared, storage: cache("", S0) }, deps: { env: {} } })
    await waitFor(() => c.reports.length > 0)
    expect(c.reports[0]!.modelHistory).toBeNull()
    expect(historyKeys(shared)).toEqual([])
  })

  test("cache-only recovery: a cache list that the history lacks appears with source cache at the cache time", async () => {
    const shared = new Map<string, unknown>()
    const store = createStorageModelHistory(createFakeCtx({ sharedStorage: shared }).ctx.storage)
    await store.append({ fetchedAt: T0, source: "discovery", ids: S0 })
    const T1 = "2026-11-12T09:30:00.000Z"
    const c = collector()
    await setup(c, { fake: { sharedStorage: shared, storage: cache(T1, S1) }, deps: { env: {} } })
    await waitFor(() => c.reports.length > 0)
    expect(c.reports[0]!.modelHistory!.entries.map((entry) => [entry.kind, entry.fetchedAt, entry.source, entry.added])).toEqual([
      ["change", T1, "cache", ["gpt-7-new"]],
      ["baseline", T0, "discovery", []],
    ])
  })

  test("a failed reload is not a change; the retry records the original fetch time", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    let failReload = true
    const { tick } = await setup(c, {
      fake: { sharedStorage: shared, storage: cache(T0, S0) },
      deps: { fetch: async () => modelsResponse(...S1) },
      prepare: (made) => {
        const reload = made.ctx.provider.reload.bind(made.ctx.provider)
        ;(made.ctx.provider as { reload: () => Promise<void> }).reload = async () => {
          if (failReload) throw new Error("reload failed")
          await reload()
        }
      },
    })
    const failed = await checkDone(c)
    expect(failed.lastCheck).toMatchObject({ outcome: "failed", reload: "failed" })
    expect(failed.modelHistory!.entries.map((entry) => entry.kind)).toEqual(["baseline"])
    const fetchedAt = (shared.get(CACHE) as { fetchedAt: string }).fetchedAt
    failReload = false
    tick()
    const retried = await checkDone(c, failed.lastCheck!.finishedAt)
    expect(retried.lastCheck).toMatchObject({ reload: "succeeded" })
    expect(retried.modelHistory!.entries[0]).toMatchObject({ kind: "change", fetchedAt, source: "discovery", added: ["gpt-7-new"] })
    expect(retried.modelHistory!.entries).toHaveLength(2)
  })

  test("rejected, empty, failed, and no-key checks are not events", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    const response: { make: () => Promise<Response> } = { make: async () => modelsResponse(...S0) }
    const { tick } = await setup(c, { fake: { sharedStorage: shared, storage: cache(T0, S0) }, deps: { fetch: () => response.make() } })
    let report = await checkDone(c)
    expect(historyKeys(shared)).toHaveLength(1)
    for (const [make, outcome] of [
      [async () => modelsResponse(), "empty"],
      [async () => modelsResponse("gpt-6-luna"), "rejected"],
      [async () => new Response("no", { status: 500 }), "failed"],
      [async () => new Response("no", { status: 401 }), "failed"],
    ] as const) {
      response.make = make
      tick()
      report = await checkDone(c, report.lastCheck!.finishedAt)
      expect(report.lastCheck?.outcome).toBe(outcome)
      expect(report.modelHistory!.entries.map((entry) => entry.kind)).toEqual(["baseline"])
      expect(historyKeys(shared)).toHaveLength(1)
    }
    const none = collector()
    const noKey = await setup(none, { fake: { sharedStorage: shared }, deps: { env: {} } })
    await waitFor(() => none.reports.length > 0)
    expect(none.reports[0]!.lastCheck?.outcome).toBe("no-key")
    noKey.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(historyKeys(shared)).toHaveLength(1)
  })

  test("a blocked report writer cannot hide two quick changes", async () => {
    const shared = new Map<string, unknown>()
    const c = collector({ delay: true })
    const found = { ids: S1 }
    const { fake, tick } = await setup(c, {
      fake: { sharedStorage: shared, storage: cache(T0, S0) },
      deps: { fetch: async () => modelsResponse(...found.ids) },
    })
    await waitFor(() => fake.state.reloads === 1)
    found.ids = S2
    tick()
    await waitFor(() => fake.state.reloads === 2)
    expect(c.reports).toHaveLength(0) // The writer has not finished any write.
    c.state.delay = false
    const release = setInterval(() => {
      while (c.gates.length > 0) c.gates.shift()!()
    }, 2)
    try {
      await waitFor(() => (c.last()?.modelHistory?.entries.length ?? 0) === 3)
    } finally {
      clearInterval(release)
    }
    expect(c.last()!.modelHistory!.entries.map((entry) => entry.added)).toEqual([["gpt-8-next"], ["gpt-7-new"], []])
  })

  test("two instances that fetch the same list produce one change in the projection", async () => {
    const shared = new Map<string, unknown>()
    const gate = Promise.withResolvers<void>()
    const fetchGated = async () => {
      await gate.promise
      return modelsResponse(...S1)
    }
    const a = collector()
    const b = collector()
    await setup(a, { fake: { sharedStorage: shared, storage: cache(T0, S0), directory: "/loc/a" }, deps: { fetch: fetchGated, now: clock("2026-11-12T10:00:00.000Z") } })
    await setup(b, { fake: { sharedStorage: shared, directory: "/loc/b" }, deps: { fetch: fetchGated, now: clock("2026-11-12T10:05:00.000Z") } })
    gate.resolve()
    const [doneA, doneB] = await Promise.all([checkDone(a), checkDone(b)])
    expect(historyKeys(shared).length).toBeGreaterThanOrEqual(2)
    for (const report of [doneA, doneB]) {
      expect(report.modelHistory!.entries.map((entry) => entry.kind)).toEqual(["change", "baseline"])
    }
    // The next check of either location reads the shared store and reports the same projection.
    expect(doneA.modelHistory!.entries[0]!.added).toEqual(["gpt-7-new"])
  })

  test("no key, current or rotated, reaches the store, the report, or the log", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    const env: Record<string, string | undefined> = { FUELIX_API_KEY: KEY }
    const found = { ids: S0 }
    const { tick, log } = await setup(c, {
      fake: { sharedStorage: shared, storage: cache(T0, S0) },
      deps: { env, fetch: async () => modelsResponse(...found.ids) },
    })
    let report = await checkDone(c)
    found.ids = [...S1, `gpt-9-${KEY}`]
    tick()
    report = await checkDone(c, report.lastCheck!.finishedAt)
    expect(report.lastCheck?.outcome).toBe("updated")
    expect(report.modelHistory!.entries.map((entry) => entry.kind)).toEqual(["baseline"])
    env.FUELIX_API_KEY = KEY2
    found.ids = [...S2, `gpt-9-${KEY}`, `gpt-10-${KEY2}`]
    tick()
    report = await checkDone(c, report.lastCheck!.finishedAt)
    const dump = JSON.stringify([...shared.entries()].filter(([key]) => key !== CACHE)) + JSON.stringify(c.reports) + log.lines.join("\n")
    expect(dump).not.toContain(KEY)
    expect(dump).not.toContain(KEY2)
    expect(historyKeys(shared)).toHaveLength(1)
    expect(warns(log).filter((line) => line.includes("secret-like"))).toHaveLength(1)
  })

  test("a store that fails does not stop discovery or the report", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    const { log } = await setup(c, {
      fake: { sharedStorage: shared, storage: cache(T0, S0) },
      deps: { fetch: async () => modelsResponse(...S1) },
      prepare: (fake) => {
        ;(fake.ctx.storage as { scan: unknown }).scan = async () => {
          throw new Error(`scan failed ${KEY}`)
        }
      },
    })
    const done = await checkDone(c)
    expect(done.lastCheck?.outcome).toBe("updated")
    expect(done.lastChange?.added).toEqual(["gpt-7-new"])
    expect(done.modelHistory).toBeNull()
    expect(shared.get(CACHE)).toMatchObject({ ids: S1 })
    expect(warns(log).filter((line) => line.includes("model history"))).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a failed history write keeps the previous projection; an unchanged check retries it with the original fetch time", async () => {
    const shared = new Map<string, unknown>()
    const c = collector()
    const store = createStorageModelHistory(createFakeCtx({ sharedStorage: shared }).ctx.storage)
    const state = { fail: true, appends: 0 }
    const failing: ModelHistoryStore = {
      list: () => store.list(),
      append: async (observation) => {
        state.appends++
        if (state.fail && observation.source === "discovery") throw new Error(`write failed ${KEY}`)
        return store.append(observation)
      },
      prune: (keep) => store.prune(keep),
    }
    const { tick, log, fake } = await setup(c, {
      fake: { storage: cache(T0, S0) },
      deps: { fetch: async () => modelsResponse(...S1), modelHistory: failing },
    })
    const done = await checkDone(c)
    expect(done.lastChange?.added).toEqual(["gpt-7-new"])
    expect(done.modelHistory!.entries.map((entry) => entry.kind)).toEqual(["baseline"])
    expect(warns(log).filter((line) => line.includes("model history"))).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
    const fetchedAt = (fake.storage.get(CACHE) as { fetchedAt: string }).fetchedAt
    state.fail = false
    tick()
    const retried = await checkDone(c, done.lastCheck!.finishedAt)
    expect(retried.lastCheck?.outcome).toBe("unchanged")
    expect(retried.modelHistory!.entries.map((entry) => [entry.kind, entry.added])).toEqual([
      ["change", ["gpt-7-new"]],
      ["baseline", []],
    ])
    expect(retried.modelHistory!.entries[0]!.fetchedAt).toBe(fetchedAt)
    // A further unchanged check writes no new snapshot.
    const appends = state.appends
    tick()
    await checkDone(c, retried.lastCheck!.finishedAt)
    expect(state.appends).toBe(appends)
  })

  test("an injected store is used, and null turns the history off", async () => {
    const calls: string[] = []
    const store: ModelHistoryStore = {
      list: async () => {
        calls.push("list")
        return { snapshots: [], truncated: false }
      },
      append: async () => {
        calls.push("append")
        return "appended"
      },
      prune: async () => 0,
    }
    const used = collector()
    await setup(used, { fake: { storage: cache(T0, S0) }, deps: { modelHistory: store, env: {} } })
    await waitFor(() => used.reports.length > 0)
    expect(calls).toContain("list")
    expect(used.reports[0]!.modelHistory).toBeNull()

    const off = collector()
    await setup(off, { fake: { storage: cache(T0, S0) }, deps: { modelHistory: null, env: {} } })
    await waitFor(() => off.reports.length > 0)
    expect(off.reports[0]).not.toHaveProperty("modelHistory")
  })

  test("a context without scan still sets up, and the report has a null history", async () => {
    const c = collector()
    await setup(c, {
      fake: { storage: cache(T0, S0) },
      deps: { env: {} },
      prepare: (fake) => {
        delete (fake.ctx.storage as { scan?: unknown }).scan
      },
    })
    await waitFor(() => c.reports.length > 0)
    expect(c.reports[0]!.modelHistory).toBeNull()
  })
})

describe("history is off without a report", () => {
  test("statusReport false never touches the history store or scans", async () => {
    const touched: string[] = []
    const store: ModelHistoryStore = {
      list: async () => void touched.push("list") as never,
      append: async () => void touched.push("append") as never,
      prune: async () => void touched.push("prune") as never,
    }
    const c = collector()
    const shared = new Map<string, unknown>()
    const { tick, fake } = await setup(c, {
      fake: { sharedStorage: shared, storage: cache(T0, S0) },
      options: { statusReport: false },
      deps: { fetch: async () => modelsResponse(...S1), modelHistory: store },
      prepare: (made) => {
        const storage = made.ctx.storage as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        for (const name of ["get", "scan", "remove"] as const) {
          const original = storage[name]!
          storage[name] = async (...args: unknown[]) => {
            touched.push(`${name}:${String((args[0] as { prefix?: string })?.prefix ?? args[0])}`)
            return original(...args)
          }
        }
      },
    })
    await waitFor(() => fake.state.reloads === 1)
    tick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(c.reports).toEqual([])
    expect(touched.filter((entry) => !entry.endsWith(`:${CACHE}`))).toEqual([])
    expect(historyKeys(shared)).toEqual([])
  })

  test("without a writer the storage writes are the cache write only", async () => {
    const fake = createFakeCtx({ storage: cache(T0, S0) })
    const log = createMemoryLogger()
    await setupFuelix(fake.ctx, options, log, {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: noKeychain,
      env: { FUELIX_API_KEY: KEY },
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
      setInterval: () => undefined,
      clearInterval: () => {},
      fetch: async () => modelsResponse(...S1),
    })
    await waitFor(() => fake.state.reloads === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.state.storageWrites).toBe(1)
    expect(historyKeys(fake.storage)).toEqual([])
  })
})
