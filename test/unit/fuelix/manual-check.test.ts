import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"
import { setupFuelix, type FuelixDeps } from "../../../src/fuelix/index.ts"
import {
  createFileManualCheckSource,
  manualCheckPath,
  MANUAL_CHECK_POLL_MS,
  MAX_REQUEST_BYTES,
  parseManualCheckRequest,
} from "../../../src/fuelix/manual-check.ts"
import {
  httpReason,
  REASONS,
  REQUEST_ID_PATTERN,
  sanitizeReport,
  type FuelixStatusReport,
  type StatusReportLocation,
} from "../../../src/fuelix/status.ts"
import type { FuelixOptions } from "../../../src/options.ts"
import { createFakeCtx, waitFor } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)
const T0 = Date.parse("2026-11-12T10:00:00.000Z")
const ID_A = "AAAAAAAAAAAAAAAAAAAAAA"
const ID_B = "BBBBBBBBBBBBBBBBBBBBBB"
const ID_C = "C-_CCCCCCCCCCCCCCCCCCC"
const IDS = ["claude-opus", "gemini-3.5-flash", "gpt-6-luna"]

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
const body = (requestId: string, requestedAt: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, requestId, requestedAt, ...extra })
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString()

interface Timer {
  readonly ms: number
  readonly callback: () => void
  cleared: boolean
}

async function setup(
  input: {
    fetch?: FuelixDeps["fetch"]
    manual?: boolean
    statusReport?: boolean
    options?: Partial<FuelixOptions>
    readFile?: () => Promise<string | null>
  } = {},
) {
  const reports: FuelixStatusReport[] = []
  const timers: Timer[] = []
  let time = T0
  let file: string | null = null
  let reads = 0
  const fake = createFakeCtx()
  const log = createMemoryLogger()
  const fetches = { count: 0 }
  const deps: FuelixDeps = {
    loadCatalog: () => loadCatalog(CATALOG_URL),
    exec: noKeychain,
    env: { FUELIX_API_KEY: KEY },
    platform: "darwin",
    keychainCache: new Map(),
    staleConfigHolder: {},
    staleConfigDelaysMs: [0],
    now: () => new Date(time),
    setInterval: (callback, ms) => {
      const timer: Timer = { ms, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearInterval: (handle) => {
      ;(handle as Timer).cleared = true
    },
    fetch:
      input.fetch ??
      (async () => {
        fetches.count++
        return modelsResponse(...IDS)
      }),
    ...(input.statusReport === false
      ? {}
      : {
          statusReport: async (report: FuelixStatusReport, _location?: StatusReportLocation) => {
            reports.push(structuredClone(report))
          },
        }),
    ...(input.manual === false
      ? {}
      : {
          manualCheck: {
            readFile:
              input.readFile ??
              (async () => {
                reads++
                return file
              }),
          },
        }),
  }
  const cleanup = await setupFuelix(fake.ctx, { ...options, ...input.options }, log, deps)
  fake.runProviderTransforms()
  const poller = () => timers.find((timer) => timer.ms === MANUAL_CHECK_POLL_MS)
  return {
    fake,
    log,
    cleanup,
    reports,
    timers,
    fetches,
    poller,
    reads: () => reads,
    last: () => reports[reports.length - 1]!,
    setFile: (text: string | null) => {
      file = text
    },
    advance: (ms: number) => {
      time += ms
    },
    /** Runs one poll and waits for its read. */
    async poll() {
      const before = reads
      poller()!.callback()
      await waitFor(() => reads > before)
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
    async startupDone() {
      await waitFor(() => {
        const report = reports[reports.length - 1]
        return report !== undefined && !report.checking && report.lastCheck !== null
      })
    },
    async done(requestId: string) {
      await waitFor(() => {
        const report = reports[reports.length - 1]
        return report !== undefined && !report.checking && report.lastCheck?.requestId === requestId
      })
      return reports[reports.length - 1]!
    },
  }
}

describe("manual check request parser", () => {
  const good = body(ID_A, iso(0))

  test("accepts the exact form", () => {
    expect(parseManualCheckRequest(good)).toEqual({ requestId: ID_A, requestedAt: iso(0) })
    expect(parseManualCheckRequest(body(ID_C, iso(0)))?.requestId).toBe(ID_C)
    expect(REQUEST_ID_PATTERN.test(ID_C)).toBe(true)
  })

  test("rejects unknown keys, a missing key, and a wrong version", () => {
    expect(parseManualCheckRequest(body(ID_A, iso(0), { extra: 1 }))).toBeUndefined()
    expect(parseManualCheckRequest(JSON.stringify({ version: 1, requestId: ID_A }))).toBeUndefined()
    expect(parseManualCheckRequest(JSON.stringify({ requestId: ID_A, requestedAt: iso(0) }))).toBeUndefined()
    expect(parseManualCheckRequest(JSON.stringify({ version: 2, requestId: ID_A, requestedAt: iso(0) }))).toBeUndefined()
    expect(parseManualCheckRequest(JSON.stringify({ version: "1", requestId: ID_A, requestedAt: iso(0) }))).toBeUndefined()
  })

  test("rejects a request ID that is not 22 base64url characters", () => {
    for (const id of ["A".repeat(21), "A".repeat(23), `${"A".repeat(21)}+`, `${"A".repeat(21)}=`, `${"A".repeat(21)} `, "", 7]) {
      expect(parseManualCheckRequest(JSON.stringify({ version: 1, requestId: id, requestedAt: iso(0) }))).toBeUndefined()
    }
  })

  test("rejects a time that is not canonical ISO", () => {
    for (const at of ["2026-11-12T10:00:00Z", "2026-11-12", "yesterday", "2026-11-12T10:00:00.000+00:00", 5, null, ""]) {
      expect(parseManualCheckRequest(JSON.stringify({ version: 1, requestId: ID_A, requestedAt: at }))).toBeUndefined()
    }
  })

  test("rejects invalid JSON, non-objects, and a body above 1 KiB", () => {
    expect(parseManualCheckRequest("")).toBeUndefined()
    expect(parseManualCheckRequest("{")).toBeUndefined()
    expect(parseManualCheckRequest("[]")).toBeUndefined()
    expect(parseManualCheckRequest("null")).toBeUndefined()
    expect(parseManualCheckRequest(`${good}${" ".repeat(MAX_REQUEST_BYTES)}`)).toBeUndefined()
    expect(parseManualCheckRequest(good.padEnd(MAX_REQUEST_BYTES, " "))).toEqual({ requestId: ID_A, requestedAt: iso(0) })
  })

  test("the file path is below the home directory", () => {
    expect(manualCheckPath("/home/x")).toBe("/home/x/.td-opencode-plugin/requests/model-check.json")
  })

  test("the file source reads null for a missing file and the text of a present one", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join, dirname } = await import("node:path")
    const home = await mkdtemp(join(tmpdir(), "td-manual-check-"))
    try {
      const source = createFileManualCheckSource(() => home)
      expect(await source.readFile()).toBeNull()
      await mkdir(dirname(manualCheckPath(home)), { recursive: true })
      await writeFile(manualCheckPath(home), good)
      expect(await source.readFile()).toBe(good)
      await writeFile(manualCheckPath(home), "x".repeat(MAX_REQUEST_BYTES * 8))
      const big = await source.readFile()
      expect(Buffer.byteLength(big ?? "")).toBe(MAX_REQUEST_BYTES + 1)
      expect(parseManualCheckRequest(big ?? "")).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("manual check in the plugin", () => {
  test("a manual request starts exactly one check and the report names the request", async () => {
    const t = await setup()
    await t.startupDone()
    expect(t.fetches.count).toBe(1)
    expect(t.last().lastCheck).toMatchObject({ trigger: "automatic", requestId: null })
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    const done = await t.done(ID_A)
    expect(t.fetches.count).toBe(2)
    expect(done.lastCheck).toMatchObject({ trigger: "manual", requestId: ID_A, outcome: "unchanged", reload: "not-needed" })
    // The same file is not acted on again.
    await t.poll()
    await t.poll()
    expect(t.fetches.count).toBe(2)
    await t.cleanup()
  })

  test("the report shows trigger and request ID while the check runs and keeps them after it ends", async () => {
    const gate = Promise.withResolvers<Response>()
    let call = 0
    const t = await setup({
      fetch: async () => {
        call++
        return call === 1 ? modelsResponse(...IDS) : gate.promise
      },
    })
    await t.startupDone()
    const previous = t.last().lastCheck!
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    await waitFor(() => t.last().checking)
    expect(t.last().checking).toBe(true)
    expect(t.last().lastCheck).toMatchObject({ trigger: "manual", requestId: ID_A, outcome: previous.outcome, finishedAt: previous.finishedAt })
    gate.resolve(modelsResponse(...IDS))
    const done = await t.done(ID_A)
    expect(done.lastCheck).toMatchObject({ trigger: "manual", requestId: ID_A })
    await t.cleanup()
  })

  test("the running report of the first check has no previous check, and a request waits for it", async () => {
    const gate = Promise.withResolvers<Response>()
    const u = await setup({ fetch: () => gate.promise })
    await waitFor(() => u.reports.some((report) => report.checking))
    expect(u.reports.find((report) => report.checking)?.lastCheck).toBeNull()
    u.setFile(body(ID_A, iso(0)))
    await u.poll()
    gate.resolve(modelsResponse(...IDS))
    await u.done(ID_A)
    expect(u.reports.some((report) => report.checking && report.lastCheck?.requestId === null)).toBe(false)
    await u.cleanup()
  })

  test("a request during a running check queues exactly one follow-up run", async () => {
    const gates: ReturnType<typeof Promise.withResolvers<Response>>[] = []
    let count = 0
    const t = await setup({
      fetch: () => {
        count++
        const gate = Promise.withResolvers<Response>()
        gates.push(gate)
        return gate.promise
      },
    })
    await waitFor(() => count === 1) // The startup check is in flight.
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    t.setFile(body(ID_B, iso(0)))
    await t.poll()
    expect(count).toBe(1)
    gates[0]!.resolve(modelsResponse(...IDS))
    await waitFor(() => count === 2)
    // The follow-up serves the latest request. The earlier request ID is not run on its own.
    gates[1]!.resolve(modelsResponse(...IDS))
    const done = await t.done(ID_B)
    expect(done.lastCheck).toMatchObject({ trigger: "manual", requestId: ID_B })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(count).toBe(2)
    await t.cleanup()
  })

  test("a duplicate request ID is ignored, a new one runs", async () => {
    const t = await setup()
    await t.startupDone()
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    await t.done(ID_A)
    t.setFile(body(ID_B, iso(0)))
    await t.poll()
    await t.done(ID_B)
    t.setFile(body(ID_A, iso(0))) // Old ID back in the file.
    await t.poll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.fetches.count).toBe(3)
    await t.cleanup()
  })

  test("a request older than five minutes is ignored", async () => {
    const t = await setup()
    await t.startupDone()
    t.advance(6 * 60_000)
    t.setFile(body(ID_A, iso(5000)))
    await t.poll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.fetches.count).toBe(1)
    // A request within five minutes of the clock runs.
    t.setFile(body(ID_B, iso(6 * 60_000 - 1000)))
    await t.poll()
    await t.done(ID_B)
    expect(t.fetches.count).toBe(2)
    await t.cleanup()
  })

  test("a request from before the startup of this instance is ignored", async () => {
    const t = await setup()
    await t.startupDone()
    t.setFile(body(ID_A, iso(-6000))) // Older than startup minus 5 s, but younger than 5 minutes.
    await t.poll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.fetches.count).toBe(1)
    t.setFile(body(ID_B, iso(-4000))) // Inside the 5 s skew.
    await t.poll()
    await t.done(ID_B)
    expect(t.fetches.count).toBe(2)
    await t.cleanup()
  })

  test("invalid, oversize, and missing files are ignored silently", async () => {
    const t = await setup()
    await t.startupDone()
    for (const text of [null, "{", body(ID_A, iso(0), { extra: true }), body("short", iso(0)), `${body(ID_A, iso(0))}${" ".repeat(2000)}`]) {
      t.setFile(text)
      await t.poll()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.fetches.count).toBe(1)
    expect(t.log.lines.filter((line) => line.includes("manual"))).toEqual([])
    await t.cleanup()
  })

  test("a read failure logs one fixed warning per streak and never the error text", async () => {
    let mode: "fail" | "ok" = "fail"
    const t = await setup({
      readFile: async () => {
        if (mode === "fail") throw Object.assign(new Error(`EACCES /Users/secret/path ${KEY}`), { code: "EACCES" })
        return null
      },
    })
    await t.startupDone()
    for (let i = 0; i < 3; i++) {
      t.poller()!.callback()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const warnings = () => t.log.lines.filter((line) => line.includes("manual model check request could not be read"))
    expect(warnings()).toHaveLength(1)
    mode = "ok"
    t.poller()!.callback()
    await new Promise((resolve) => setTimeout(resolve, 5))
    mode = "fail"
    t.poller()!.callback()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(warnings()).toHaveLength(2)
    const all = t.log.lines.join("\n") + JSON.stringify(t.reports)
    expect(all).not.toContain(KEY)
    expect(all).not.toContain("EACCES")
    expect(all).not.toContain("/Users/secret")
    await t.cleanup()
  })

  test("the key never reaches the report or the log during a manual check", async () => {
    const t = await setup()
    await t.startupDone()
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    await t.done(ID_A)
    expect(JSON.stringify(t.reports)).not.toContain(KEY)
    expect(t.log.lines.join("\n")).not.toContain(KEY)
    await t.cleanup()
  })

  test("the poller reads every 2000 ms by default and stops at cleanup", async () => {
    const t = await setup()
    await t.startupDone()
    expect(t.poller()).toBeDefined()
    expect(t.poller()!.cleared).toBe(false)
    await t.cleanup()
    expect(t.poller()!.cleared).toBe(true)
    // A poll that still fires does nothing after cleanup.
    const before = t.reads()
    t.setFile(body(ID_A, iso(0)))
    t.poller()!.callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.reads()).toBe(before)
    expect(t.fetches.count).toBe(1)
  })

  test("statusReport false never polls", async () => {
    const t = await setup({ options: { statusReport: false } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.poller()).toBeUndefined()
    expect(t.reads()).toBe(0)
    await t.cleanup()
  })

  test("without a report writer the plugin never polls", async () => {
    const t = await setup({ statusReport: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.poller()).toBeUndefined()
    expect(t.reads()).toBe(0)
    await t.cleanup()
  })

  test("without a manual check source the plugin never polls", async () => {
    const t = await setup({ manual: false })
    await t.startupDone()
    expect(t.poller()).toBeUndefined()
    await t.cleanup()
  })

  test("a manual check keeps the discovery protections: a large drop is rejected", async () => {
    const stored = ["gpt-6-a", "gpt-6-b", "gpt-6-c", "gpt-6-d", "gpt-6-luna"]
    let ids = stored
    const reports: FuelixStatusReport[] = []
    const fake = createFakeCtx({ storage: { "fuelix/models": { fetchedAt: "x", ids: stored } } })
    const timers: Timer[] = []
    let file: string | null = null
    await setupFuelix(fake.ctx, options, createMemoryLogger(), {
      loadCatalog: () => loadCatalog(CATALOG_URL),
      exec: noKeychain,
      env: { FUELIX_API_KEY: KEY },
      platform: "darwin",
      keychainCache: new Map(),
      staleConfigHolder: {},
      staleConfigDelaysMs: [0],
      now: () => new Date(T0),
      setInterval: (callback, ms) => {
        const timer: Timer = { ms, callback, cleared: false }
        timers.push(timer)
        return timer
      },
      clearInterval: () => {},
      fetch: async () => modelsResponse(...ids),
      statusReport: async (report) => void reports.push(structuredClone(report)),
      manualCheck: { readFile: async () => file },
    })
    fake.runProviderTransforms()
    await waitFor(() => reports.some((report) => !report.checking && report.lastCheck !== null))
    ids = ["gpt-6-a", "gpt-6-b", "gpt-6-luna"]
    file = body(ID_A, iso(0))
    timers.find((timer) => timer.ms === MANUAL_CHECK_POLL_MS)!.callback()
    await waitFor(() => reports.some((report) => !report.checking && report.lastCheck?.requestId === ID_A))
    const done = reports[reports.length - 1]!
    expect(done.lastCheck).toMatchObject({ outcome: "rejected", reason: REASONS.dropShare, trigger: "manual", requestId: ID_A })
    expect(fake.state.reloads).toBe(0)
  })

  test("a manual check reloads providers and records the new list", async () => {
    let found = [...IDS]
    const t = await setup({ fetch: async () => modelsResponse(...found) })
    await t.startupDone()
    const reloads = t.fake.state.reloads
    found = [...IDS, "gpt-7-new"]
    t.setFile(body(ID_A, iso(0)))
    await t.poll()
    const done = await t.done(ID_A)
    expect(done.lastCheck).toMatchObject({ outcome: "updated", added: ["gpt-7-new"], reload: "succeeded", trigger: "manual" })
    expect(t.fake.state.reloads).toBe(reloads + 1)
    expect(done.modelHistory?.entries[0]).toMatchObject({ kind: "change", added: ["gpt-7-new"] })
    await t.cleanup()
  })
})

describe("failure reasons", () => {
  async function reasonFor(fetch: FuelixDeps["fetch"], extra: Partial<FuelixOptions> = {}) {
    const t = await setup({ fetch, manual: false, options: extra })
    await t.startupDone()
    const report = t.last()
    const reports = JSON.stringify(t.reports)
    const text = reports + t.log.lines.join("\n")
    await t.cleanup()
    return { check: report.lastCheck!, text, reports }
  }

  test("a timeout is named", async () => {
    const { check } = await reasonFor(() => new Promise<Response>(() => {}), { discoveryTimeoutMs: 20 })
    expect(check).toMatchObject({ outcome: "failed", reason: REASONS.timedOut })
    expect(REASONS.timedOut).toBe("Model discovery timed out")
  })

  test("a network error is named and its text never appears", async () => {
    const { check, text, reports } = await reasonFor(async () => {
      throw new Error(`connect ECONNREFUSED ${KEY} /Users/secret/path`)
    })
    expect(check).toMatchObject({ outcome: "failed", reason: "Could not reach FueliX" })
    // The report holds no error text. The log keeps its existing warning, which redacts the key.
    expect(reports).not.toContain("ECONNREFUSED")
    expect(reports).not.toContain("/Users/secret")
    expect(text).not.toContain(KEY)
  })

  test("another HTTP status is named with the status", async () => {
    expect((await reasonFor(async () => new Response("{}", { status: 503 }))).check.reason).toBe("FueliX returned HTTP 503")
    expect((await reasonFor(async () => new Response("{}", { status: 429 }))).check.reason).toBe("FueliX returned HTTP 429")
  })

  test("an invalid response is named", async () => {
    expect((await reasonFor(async () => new Response("not json"))).check.reason).toBe("FueliX returned an invalid model list")
    expect((await reasonFor(async () => new Response(JSON.stringify({ nope: 1 })))).check.reason).toBe("FueliX returned an invalid model list")
  })

  test("401 and 403 still mean a rejected key", async () => {
    expect((await reasonFor(async () => new Response("{}", { status: 401 }))).check.reason).toBe(REASONS.keyRejected)
    expect((await reasonFor(async () => new Response("{}", { status: 403 }))).check.reason).toBe(REASONS.keyRejected)
  })

  test("httpReason falls back for a value that is not a status", () => {
    expect(httpReason(undefined)).toBe(REASONS.checkFailed)
    expect(httpReason(99)).toBe(REASONS.checkFailed)
    expect(httpReason(502)).toBe("FueliX returned HTTP 502")
  })
})

describe("report sanitizing of trigger and request ID", () => {
  const base = (check: Record<string, unknown>): FuelixStatusReport =>
    ({
      version: 1,
      pluginVersion: "x",
      directory: null,
      startedAt: iso(0),
      recordedAt: iso(0),
      checking: false,
      configuration: { refreshMinutes: 1, includeNonChatModels: false, authSource: "none", activation: "auto", shellKeyScrubbing: "enabled", batchTools: "registered", authHooks: { sessionProviders: [], aiSdk: false } },
      models: { source: "catalog", providers: [] },
      lastCheck: { startedAt: iso(0), finishedAt: iso(0), outcome: "failed", added: [], removed: [], reason: null, reload: "not-needed", ...check },
      lastSuccessfulCheckAt: null,
      lastChange: null,
    }) as FuelixStatusReport

  test("keeps a valid manual request ID", () => {
    expect(sanitizeReport(base({ trigger: "manual", requestId: ID_C })).lastCheck).toMatchObject({ trigger: "manual", requestId: ID_C })
  })

  test("drops an invalid request ID and any request ID of an automatic check", () => {
    expect(sanitizeReport(base({ trigger: "manual", requestId: "short" })).lastCheck).toMatchObject({ trigger: "manual", requestId: null })
    expect(sanitizeReport(base({ trigger: "manual", requestId: `${KEY}-xxxxxxxxxxxxx` })).lastCheck?.requestId).toBeNull()
    expect(sanitizeReport(base({ trigger: "automatic", requestId: ID_A })).lastCheck).toMatchObject({ trigger: "automatic", requestId: null })
  })

  test("omits both fields for an unknown trigger or none (older reports)", () => {
    expect("trigger" in sanitizeReport(base({ trigger: "robot", requestId: ID_A })).lastCheck!).toBe(false)
    expect("requestId" in sanitizeReport(base({ trigger: "robot", requestId: ID_A })).lastCheck!).toBe(false)
    expect("trigger" in sanitizeReport(base({})).lastCheck!).toBe(false)
  })

  test("keeps a fixed HTTP reason and replaces any other text", () => {
    expect(sanitizeReport(base({ reason: "FueliX returned HTTP 502" })).lastCheck?.reason).toBe("FueliX returned HTTP 502")
    expect(sanitizeReport(base({ reason: `FueliX returned HTTP 502 ${KEY}` })).lastCheck?.reason).toBe(REASONS.unexpected)
    expect(sanitizeReport(base({ reason: "FueliX returned HTTP 9999" })).lastCheck?.reason).toBe(REASONS.unexpected)
  })
})
