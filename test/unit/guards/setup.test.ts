import { describe, expect, test } from "bun:test"
import { setupGuards, COVERED_ACTIONS } from "../../../src/guards/index.ts"
import { activationRelationship } from "../../../src/guards/policy.ts"
import { FAIL_CLOSED_MESSAGE, MUTATING_ACTIONS, parseRuntimeReport, type GuardStore } from "../../../src/guards/schema.ts"
import { runtimeFileName } from "../../../src/guards/store.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { activation, commitRule, createGuardCtx, createMemoryFs, guard, PATHS, settle, storeOf, T0 } from "./helpers.ts"
import { join } from "node:path"

const BASE = Date.parse("2026-11-12T10:00:00.000Z")

async function start(input: { store?: GuardStore | string; sessions?: Record<string, string | null>; hookFail?: boolean; nowMs?: () => number; fsSetup?: (fs: ReturnType<typeof createMemoryFs>) => void } = {}) {
  const fs = createMemoryFs()
  if (input.store !== undefined) fs.put(PATHS.store, typeof input.store === "string" ? input.store : JSON.stringify(input.store))
  input.fsSetup?.(fs)
  const g = createGuardCtx({ sessions: input.sessions ?? { root: null, child: "root", grandchild: "child", other: null }, failHook: input.hookFail, directory: "/fake/project" })
  const log = createMemoryLogger()
  const clock = { ms: BASE }
  const intervals: (() => void)[] = []
  const cleanup = await setupGuards(g.ctx, log, {
    fs,
    home: () => "/fake/home",
    now: input.nowMs ? () => new Date(input.nowMs!()) : () => new Date(clock.ms),
    instanceId: "inst-test",
    setInterval: (callback) => (intervals.push(callback), intervals.length),
    clearInterval: () => {},
    sleep: async () => {},
  })
  return { fs, g, log, clock, cleanup, intervals }
}

const shell = (sessionID: string, command: string, effect = "allow") => ({ sessionID, action: "shell", resources: [command], effect })

describe("enforcement", () => {
  const store = storeOf([guard("g1", [commitRule], "Commits are blocked by your TD-Plugin guard.")], [activation("a1", "g1", "root")])

  test("no store file: nothing is blocked", async () => {
    const { g } = await start()
    expect((await g.evaluate(shell("root", "git commit -m x"))).effect).toBe("allow")
  })

  test("denies a guarded command whatever the incoming effect, and sets the guard message", async () => {
    const { g } = await start({ store })
    for (const effect of ["allow", "ask"]) {
      const result = await g.evaluate(shell("root", "git commit -m x", effect))
      expect(result.effect).toBe("deny")
      expect(result.message).toBe("Commits are blocked by your TD-Plugin guard.")
    }
  })

  test("permits unrelated work and quoted text, and never turns a deny into an allow", async () => {
    const { g } = await start({ store })
    expect((await g.evaluate(shell("root", "git status"))).effect).toBe("allow")
    expect((await g.evaluate(shell("root", "echo 'git commit'"))).effect).toBe("allow")
    const denied = await g.evaluate(shell("root", "ls", "deny"))
    expect(denied.effect).toBe("deny")
    const ask = await g.evaluate(shell("root", "ls", "ask"))
    expect(ask.effect).toBe("ask")
    const alreadyDenied = await g.evaluate(shell("root", "git commit", "deny"))
    expect(alreadyDenied.effect).toBe("deny")
  })

  test("any resource segment of a shell action is checked", async () => {
    const { g } = await start({ store })
    const result = await g.evaluate({ sessionID: "root", action: "shell", resources: ["ls", "cd x", "git commit"], effect: "allow" })
    expect(result.effect).toBe("deny")
  })

  test("children and grandchildren inherit; unrelated sessions do not", async () => {
    const { g } = await start({ store })
    expect((await g.evaluate(shell("child", "git commit"))).effect).toBe("deny")
    expect((await g.evaluate(shell("grandchild", "git commit"))).effect).toBe("deny")
    expect((await g.evaluate(shell("other", "git commit"))).effect).toBe("allow")
  })

  test("a parent lookup that fails assumes the guard applies", async () => {
    const { g } = await start({ store, sessions: { root: null } })
    expect((await g.evaluate(shell("mystery", "git commit"))).effect).toBe("deny")
    expect((await g.evaluate(shell("mystery", "git status"))).effect).toBe("allow")
  })

  test("a parent cycle assumes the guard applies", async () => {
    const { g } = await start({ store, sessions: { x: "y", y: "x" } })
    expect((await g.evaluate(shell("x", "git commit"))).effect).toBe("deny")
  })

  test("a deep chain beyond the bound assumes the guard applies", async () => {
    const sessions: Record<string, string | null> = { s0: null }
    for (let i = 1; i < 60; i++) sessions[`s${i}`] = `s${i - 1}`
    const { g } = await start({ store: storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "elsewhere")]), sessions })
    expect((await g.evaluate(shell("s59", "git commit"))).effect).toBe("deny")
  })

  test("permission rules guard edit and subagent actions", async () => {
    const rules = [
      { kind: "permission" as const, action: "edit", resources: ["/repo/secrets/**"] },
      { kind: "permission" as const, action: "subagent", resources: ["general"] },
    ]
    const { g } = await start({ store: storeOf([guard("g2", rules)], [activation("a2", "g2", "root")]) })
    expect((await g.evaluate({ sessionID: "child", action: "edit", resources: ["/repo/secrets/a"], effect: "allow" })).effect).toBe("deny")
    expect((await g.evaluate({ sessionID: "child", action: "edit", resources: ["/repo/src/a"], effect: "allow" })).effect).toBe("allow")
    expect((await g.evaluate({ sessionID: "root", action: "subagent", resources: ["general"], effect: "allow" })).effect).toBe("deny")
    expect((await g.evaluate({ sessionID: "root", action: "subagent", resources: ["explore"], effect: "allow" })).effect).toBe("allow")
  })

  test("a deleted guard stops applying; an activation without a guard is ignored", async () => {
    const { g, fs } = await start({ store })
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    fs.put(PATHS.store, JSON.stringify(storeOf([], [], 2)))
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("allow")
    fs.put(PATHS.store, JSON.stringify(storeOf([], [activation("a1", "missing", "root")], 3)))
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("allow")
  })

  test("the activation snapshot wins over a later guard edit", async () => {
    const snapshot = { label: "old", message: "old message", rules: [commitRule] }
    const edited = storeOf([guard("g1", [{ kind: "command", program: "rm" }], "new message")], [activation("a1", "g1", "root", { snapshot })])
    const { g } = await start({ store: edited })
    const result = await g.evaluate(shell("root", "git commit"))
    expect(result.effect).toBe("deny")
    expect(result.message).toBe("old message")
    expect((await g.evaluate(shell("root", "rm -rf x"))).effect).toBe("allow")
  })
})

describe("expiry", () => {
  const rules = [guard("g1", [commitRule])]
  test("an explicit expiry is checked at each action, with no timer", async () => {
    let now = BASE
    const { g } = await start({ store: storeOf(rules, [activation("a1", "g1", "root", { expiresAt: new Date(BASE + 60_000).toISOString() })]), nowMs: () => now })
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    now = BASE + 59_999
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    now = BASE + 60_000
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("allow")
  })
  test("no expiry means no default expiry, even after a long time", async () => {
    let now = BASE
    const { g, intervals } = await start({ store: storeOf(rules, [activation("a1", "g1", "root")]), nowMs: () => now })
    now = BASE + 400 * 24 * 3600 * 1000
    for (const tick of intervals) tick() // Heartbeat runs.
    await settle()
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
  })
})

describe("store failure", () => {
  const good = storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "root")])

  test("an invalid store at startup blocks mutating actions with the fixed message", async () => {
    const { g, fs } = await start({ store: '{"schema":"td-guards/1","revision":1,"guards":[{"bad":true}],"activations":[]}' })
    for (const action of MUTATING_ACTIONS) {
      const result = await g.evaluate({ sessionID: "root", action, resources: ["x"], effect: "allow" })
      expect(result.effect).toBe("deny")
      expect(result.message).toBe(FAIL_CLOSED_MESSAGE)
    }
    expect((await g.evaluate({ sessionID: "root", action: "read", resources: ["x"], effect: "allow" })).effect).toBe("allow")
    // The service repairs the file: guards apply again.
    fs.put(PATHS.store, JSON.stringify(good))
    expect((await g.evaluate(shell("root", "ls"))).effect).toBe("allow")
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
  })

  test("a store that cannot be read at startup fails closed", async () => {
    const { g } = await start({ store: good, fsSetup: (fs) => (fs.failures.read = true) })
    expect((await g.evaluate(shell("root", "ls"))).message).toBe(FAIL_CLOSED_MESSAGE)
  })

  test("an invalid store after a good one keeps the last good store", async () => {
    const { g, fs } = await start({ store: good })
    fs.put(PATHS.store, "{ torn write")
    const result = await g.evaluate(shell("root", "git commit"))
    expect(result.effect).toBe("deny")
    expect(result.message).toBe("blocked by g1")
    expect((await g.evaluate(shell("root", "ls"))).effect).toBe("allow")
  })

  test("a store that is missing at startup means no guards", async () => {
    const { g } = await start()
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("allow")
  })

  test("a store file that disappears after a good read keeps the last good guards", async () => {
    const { g, fs } = await start({ store: good })
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    fs.remove(PATHS.store)
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    expect((await g.evaluate(shell("child", "git commit"))).effect).toBe("deny")
    expect((await g.evaluate(shell("root", "git status"))).effect).toBe("allow")
  })

  test("a valid store that removes the activation releases the guard, even after a deletion", async () => {
    const { g, fs } = await start({ store: good })
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    fs.remove(PATHS.store)
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [], 2)))
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("allow")
  })

  test("a stat failure after a good store keeps the last good store", async () => {
    const { g, fs } = await start({ store: good })
    fs.failures.stat = true
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
  })
})

describe("setup, report, and cleanup", () => {
  test("a hook registration failure throws and reports registered:false", async () => {
    const fs = createMemoryFs()
    const g = createGuardCtx({ failHook: true })
    await expect(setupGuards(g.ctx, createMemoryLogger(), { fs, home: () => "/fake/home", setInterval: () => 1, clearInterval: () => {} })).rejects.toThrow("NOT enforced")
    const file = join(PATHS.runtimeDir, runtimeFileName("/fake/project"))
    const parsed = parseRuntimeReport(JSON.parse(fs.files.get(file)!))
    expect(parsed.ok && parsed.value.registered).toBe(false)
  })

  test("the runtime report carries counts and sessions, never a command", async () => {
    const store = storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "root")])
    const { g, fs, cleanup } = await start({ store })
    await g.evaluate(shell("child", "git commit -m SECRET-COMMAND-TEXT"))
    await settle()
    const file = join(PATHS.runtimeDir, runtimeFileName("/fake/project"))
    const text = fs.files.get(file)!
    expect(text).not.toContain("SECRET-COMMAND-TEXT")
    expect(text).not.toContain("git commit")
    const parsed = parseRuntimeReport(JSON.parse(text))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      registered: true,
      storeState: "ready",
      revision: 1,
      blockedCount: 1,
      uncertainCount: 0,
      instanceId: "inst-test",
      directory: "/fake/project",
      coveredActions: [...COVERED_ACTIONS],
    })
    expect(parsed.value.sessions.find((s) => s.id === "child")?.parentId).toBe("root")
    await cleanup()
    const after = parseRuntimeReport(JSON.parse(fs.files.get(file)!))
    expect(after.ok && after.value.registered).toBe(false)
    expect(g.state.disposed).toBe(1)
  })

  test("the report states missing, invalid, and unavailable stores", async () => {
    const file = join(PATHS.runtimeDir, runtimeFileName("/fake/project"))
    const state = (fs: ReturnType<typeof createMemoryFs>) => {
      const parsed = parseRuntimeReport(JSON.parse(fs.files.get(file)!))
      return parsed.ok ? parsed.value.storeState : "unparsed"
    }
    expect(state((await start()).fs)).toBe("missing")
    expect(state((await start({ store: "nope" })).fs)).toBe("invalid")
    expect(state((await start({ store: "{}", fsSetup: (fs) => (fs.failures.read = true) })).fs)).toBe("unavailable")
  })

  test("a failed report write is nonfatal", async () => {
    const { g, fs, log } = await start({ store: storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "root")]), fsSetup: (fs) => (fs.failures.write = true) })
    expect((await g.evaluate(shell("root", "git commit"))).effect).toBe("deny")
    await settle()
    expect(fs.files.has(join(PATHS.runtimeDir, runtimeFileName("/fake/project")))).toBe(false)
    expect(log.lines.some((line) => line.includes("report write failed"))).toBe(true)
  })
})

describe("activationRelationship", () => {
  const sessions = [
    { id: "root", parentId: null, activity: "idle" as const },
    { id: "child", parentId: "root", activity: "idle" as const },
    { id: "grand", parentId: "child", activity: "running" as const },
    { id: "other", parentId: null, activity: "idle" as const },
    { id: "orphan", parentId: "gone", activity: "unknown" as const },
    { id: "x", parentId: "y", activity: "unknown" as const },
    { id: "y", parentId: "x", activity: "unknown" as const },
  ]
  test("direct, inherited, none, unknown", () => {
    expect(activationRelationship("root", "root", sessions)).toBe("direct")
    expect(activationRelationship("root", "child", sessions)).toBe("inherited")
    expect(activationRelationship("root", "grand", sessions)).toBe("inherited")
    expect(activationRelationship("root", "other", sessions)).toBe("none")
    expect(activationRelationship("root", "orphan", sessions)).toBe("unknown")
    expect(activationRelationship("root", "x", sessions)).toBe("unknown")
    expect(activationRelationship("root", "missing", sessions)).toBe("unknown")
  })
})

void T0
