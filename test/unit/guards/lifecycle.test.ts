import { describe, expect, test } from "bun:test"
import { setupGuards } from "../../../src/guards/index.ts"
import { parseLifecycleLine, type Activation, type GuardStore } from "../../../src/guards/schema.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { activation, commitRule, createGuardCtx, createMemoryFs, guard, PATHS, settle, storeOf, until } from "./helpers.ts"

const BASE = Date.parse("2026-11-12T10:00:00.000Z")
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString()

interface Options {
  activations: Activation[]
  sessions?: Record<string, string | null>
  /** Offset of "now" at setup from BASE. */
  startOffset?: number
}

async function start(options: Options) {
  const fs = createMemoryFs()
  const store: GuardStore = storeOf([guard("g1", [commitRule])], options.activations)
  fs.put(PATHS.store, JSON.stringify(store))
  const g = createGuardCtx({ sessions: options.sessions ?? { root: null, child: "root", other: null } })
  const clock = { ms: BASE + (options.startOffset ?? 0) }
  const intervals: (() => void)[] = []
  const sleeps: number[] = []
  const cleanup = await setupGuards(g.ctx, createMemoryLogger(), {
    fs,
    home: () => "/fake/home",
    now: () => new Date(clock.ms),
    instanceId: "inst-a",
    setInterval: (callback) => (intervals.push(callback), 1),
    clearInterval: () => {},
    sleep: async (ms) => void sleeps.push(ms),
  })
  clock.ms = BASE + 10_000 // Later than every activation in these tests, so facts are not older than them.
  const facts = () =>
    fs.appended
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseLifecycleLine(line)!)
  const exec = (type: "started" | "succeeded" | "failed" | "interrupted", sessionID: string, offset: number, reason?: string) =>
    g.emit({ type: `session.execution.${type}`, created: BASE + offset, data: { sessionID, ...(reason ? { reason } : {}) } })
  const commit = (sessionID = "root") => g.evaluate({ sessionID, action: "shell", resources: ["git commit"], effect: "allow" })
  return { fs, g, clock, intervals, sleeps, cleanup, facts, exec, commit }
}

const request = (id = "r1", createdAtOffset = 0, sessionId = "root") => activation(id, "g1", sessionId, { scope: "request", createdAt: at(createdAtOffset) })

describe("request lifecycle", () => {
  test("idle root: pending, binds on a start after creation, releases when the root ends", async () => {
    const t = await start({ activations: [request("r1", 1000)] })
    await settle()
    expect(t.facts()).toEqual([])
    expect((await t.commit()).effect).toBe("deny") // Enforced while pending.
    t.exec("started", "root", 2000)
    await until(() => t.facts().length === 1)
    expect(t.facts()[0]).toMatchObject({ activationId: "r1", fact: "bound", reason: "observed-start", instance: "inst-a" })
    expect((await t.commit()).effect).toBe("deny")
    t.exec("succeeded", "root", 3000)
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ activationId: "r1", fact: "ended", reason: "request-completed" })
    expect((await t.commit()).effect).toBe("allow") // Released locally once the fact is written.
  })

  test("a start before the activation was created does not bind it", async () => {
    const t = await start({ activations: [request("r1", 5000)] })
    t.exec("started", "root", 1000)
    t.exec("succeeded", "root", 2000)
    await settle()
    expect(t.facts()).toEqual([])
  })

  test("a running root at activation time binds immediately", async () => {
    const t = await start({ activations: [] })
    t.exec("started", "root", 100)
    await settle()
    t.fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [request("r1", 200)], 2)))
    t.exec("started", "child", 300) // Any event refreshes the store.
    await until(() => t.facts().some((f) => f.fact === "bound"))
    expect(t.facts().find((f) => f.fact === "bound")?.reason).toBe("running-tracked")
  })

  test("buffered events of a run that ended before the activation do not bind or release it", async () => {
    const t = await start({ activations: [request("r1", 1000)] })
    await settle()
    t.exec("started", "root", 100) // Both events predate the activation (createdAt = +1000).
    t.exec("succeeded", "root", 500)
    await settle()
    expect(t.facts()).toEqual([])
    expect((await t.commit()).effect).toBe("deny")
    // The next run is the request.
    t.exec("started", "root", 2000)
    t.exec("succeeded", "root", 3000)
    await until(() => t.facts().length === 2)
    expect(t.facts().map((f) => f.fact)).toEqual(["bound", "ended"])
  })

  test("a late claim from an old start still does not release on the old end", async () => {
    const t = await start({ activations: [request("r1", 1000)], sessions: { other: null } }) // The root is not visible yet.
    await settle()
    t.g.sessions.root = null
    t.exec("started", "root", 100) // Old start, delivered late. The claim binds a run that looks active.
    t.exec("succeeded", "root", 500) // Old end: predates the activation, so it must not release.
    await settle()
    expect(t.facts().map((f) => f.fact)).not.toContain("ended")
    expect(t.facts().find((f) => f.fact === "bound")?.reason).toBe("running-tracked")
    expect((await t.commit()).effect).toBe("deny")
    t.exec("started", "root", 2000)
    t.exec("succeeded", "root", 3000)
    await until(() => t.facts().some((f) => f.fact === "ended"))
  })

  test("enabling mid-run still binds and releases at the real end", async () => {
    const t = await start({ activations: [] })
    t.exec("started", "root", 100)
    await settle()
    t.fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [request("r1", 200)], 2)))
    t.exec("started", "child", 250)
    await until(() => t.facts().some((f) => f.fact === "bound"))
    t.exec("succeeded", "child", 300)
    t.exec("succeeded", "root", 400)
    await until(() => t.facts().some((f) => f.fact === "ended"))
    expect(t.facts().map((f) => f.fact)).toEqual(["bound", "ended"])
  })

  test("events without a finite time never release; they make the request uncertain", async () => {
    const pendingCase = await start({ activations: [request("r1", 0)] })
    pendingCase.g.emit({ type: "session.execution.started", data: { sessionID: "root" } })
    await until(() => pendingCase.facts().length === 1)
    expect(pendingCase.facts()[0]).toMatchObject({ fact: "uncertain", reason: "event-time-unknown" })
    const boundCase = await start({ activations: [request("r1", 0)] })
    boundCase.exec("started", "root", 100)
    await until(() => boundCase.facts().length === 1)
    boundCase.g.emit({ type: "session.execution.succeeded", data: { sessionID: "root" } })
    await until(() => boundCase.facts().length === 2)
    expect(boundCase.facts()[1]).toMatchObject({ fact: "uncertain", reason: "event-time-unknown" })
    expect((await boundCase.commit()).effect).toBe("deny")
  })

  test("waits for descendants, including a background child that outlives the root", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.g.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } })
    t.exec("started", "child", 200)
    t.exec("succeeded", "root", 300)
    await settle()
    expect(t.facts().map((f) => f.fact)).toEqual(["bound"])
    expect((await t.commit("child")).effect).toBe("deny")
    t.exec("succeeded", "child", 400)
    await until(() => t.facts().some((f) => f.fact === "ended"))
    expect(t.facts().at(-1)).toMatchObject({ fact: "ended", reason: "request-completed" })
  })

  test("a subagent spawn that never produces a child is uncertain, not released", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    await t.g.evaluate({ sessionID: "root", action: "subagent", resources: ["general"], effect: "allow" })
    t.exec("succeeded", "root", 300)
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "uncertain", reason: "subagent-spawn-unobserved" })
    expect((await t.commit()).effect).toBe("deny")
  })

  test("a subagent spawn that produces a child releases after the child ends", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    await t.g.evaluate({ sessionID: "root", action: "subagent", resources: ["general"], effect: "allow" })
    t.g.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } })
    t.exec("started", "child", 200)
    t.exec("succeeded", "child", 250)
    t.exec("succeeded", "root", 300)
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "ended" })
  })

  test("a denied subagent does not count as a spawn", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    await t.g.evaluate({ sessionID: "root", action: "subagent", resources: ["general"], effect: "deny" })
    t.exec("succeeded", "root", 300)
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "ended" })
  })

  test("user interruption of the root with a never-started child is uncertain", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.g.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } })
    t.exec("interrupted", "root", 200, "user")
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "uncertain", reason: "descendant-never-started" })
  })

  test("user interruption cascades to a running child, then releases", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.exec("started", "child", 150)
    t.exec("interrupted", "root", 200, "user")
    await settle()
    expect(t.facts().map((f) => f.fact)).toEqual(["bound"])
    t.exec("interrupted", "child", 210, "user")
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "ended" })
  })

  test("a failed root ends the request", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.exec("failed", "root", 200)
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "ended" })
  })

  test("a superseded execution is not the end of the request", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.exec("interrupted", "root", 150, "superseded")
    t.exec("started", "root", 160)
    await settle()
    expect(t.facts().map((f) => f.fact)).toEqual(["bound"])
    t.exec("succeeded", "root", 300)
    await until(() => t.facts().length === 2)
  })

  test("shutdown interruption is uncertain", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    t.exec("interrupted", "root", 200, "shutdown")
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "uncertain", reason: "shutdown" })
  })

  test("plugin restart: an activation older than this run with unknown activity is uncertain and stays enforced", async () => {
    const t = await start({ activations: [request("r1", -60_000)], startOffset: 0 })
    await until(() => t.facts().length === 1)
    expect(t.facts()[0]).toMatchObject({ fact: "uncertain", reason: "plugin-restarted" })
    t.exec("started", "root", 100)
    t.exec("succeeded", "root", 200)
    await settle()
    expect(t.facts().length).toBe(1)
    expect((await t.commit()).effect).toBe("deny")
  })

  test("a run that started before the backend watched and ends later is uncertain", async () => {
    const t = await start({ activations: [] })
    t.fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [request("r1", 10)], 2)))
    t.exec("succeeded", "root", 500) // Terminal with no start seen.
    await until(() => t.facts().length === 1)
    expect(t.facts()[0]).toMatchObject({ fact: "uncertain", reason: "run-start-unobserved" })
  })

  test("a lost event stream makes bound activations uncertain and a reconnect is tried", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    t.g.breakStream()
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "uncertain", reason: "event-stream-lost" })
    await until(() => t.g.subscribes() >= 2)
    expect(t.sleeps.length).toBeGreaterThan(0)
    t.exec("succeeded", "root", 300)
    await settle()
    expect(t.facts().length).toBe(2)
    expect((await t.commit()).effect).toBe("deny")
  })

  test("a failed ended-fact write keeps enforcing and retries on the heartbeat", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    t.fs.failures.append = true
    t.exec("succeeded", "root", 200)
    await settle()
    expect((await t.commit()).effect).toBe("deny")
    t.fs.failures.append = false
    for (const tick of t.intervals) tick()
    await until(() => t.facts().length === 2)
    expect(t.facts()[1]).toMatchObject({ fact: "ended" })
    await until(() => true)
    await settle()
    expect((await t.commit()).effect).toBe("allow")
  })

  test("an activation whose session this backend cannot see writes no facts", async () => {
    const t = await start({ activations: [request("r1", 0, "foreign")], sessions: { root: null } })
    t.exec("started", "root", 100)
    t.exec("succeeded", "root", 200)
    await settle()
    expect(t.facts()).toEqual([])
    expect((await t.commit("foreign")).effect).toBe("deny") // Enforced: ancestry is unknown.
  })

  test("session-scope activations never produce facts", async () => {
    const t = await start({ activations: [activation("s1", "g1", "root")] })
    t.exec("started", "root", 100)
    t.exec("succeeded", "root", 200)
    await settle()
    expect(t.facts()).toEqual([])
    expect((await t.commit()).effect).toBe("deny")
  })

  test("malformed events are ignored", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.g.emit({ type: "session.execution.started", data: {} })
    t.g.emit({ type: "session.execution.started", data: { sessionID: 5 } })
    t.g.emit({ type: "unrelated", data: { sessionID: "root" } })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    expect(t.facts()[0]).toMatchObject({ fact: "bound" })
  })

  test("a deleted activation is forgotten and writes nothing more", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    t.fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [], 2)))
    t.exec("succeeded", "root", 200)
    await settle()
    expect(t.facts().length).toBe(1)
  })

  test("facts carry fixed fields only", async () => {
    const t = await start({ activations: [request("r1", 0)] })
    t.exec("started", "root", 100)
    await until(() => t.facts().length === 1)
    expect(Object.keys(t.facts()[0]!).sort()).toEqual(["activationId", "at", "fact", "instance", "reason"])
    // One write per fact: a leading newline (a crashed writer's partial line cannot swallow it) and a trailing one.
    expect(t.fs.appended[0]!.startsWith("\n")).toBe(true)
    expect(t.fs.appended[0]!.endsWith("\n")).toBe(true)
    expect(t.fs.appended[0]!.split("\n").length).toBe(3)
  })
})

describe("log hygiene", () => {
  test("a failing lifecycle step logs a fixed message with no error text or fields", async () => {
    const { createRequestTracker } = await import("../../../src/guards/lifecycle.ts")
    const log = createMemoryLogger()
    const evil = Object.assign(new Error("git commit -m SECRET-TOKEN"), { name: "sk-secret-123456 git commit" })
    const tracker = createRequestTracker({
      sessions: { ancestors: async () => { throw evil } } as never,
      instanceId: "i1",
      now: () => new Date(BASE),
      log,
      coverageSince: BASE,
      append: async () => {},
    })
    tracker.sync([request("r1", 0)])
    await tracker.idle()
    expect(log.lines.length).toBe(1)
    expect(log.lines[0]).toContain("guard lifecycle step failed")
    expect(log.lines[0]).not.toMatch(/SECRET|git commit|error=/)
  })
})
