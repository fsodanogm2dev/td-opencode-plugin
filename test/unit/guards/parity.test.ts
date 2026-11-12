import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { setupGuards } from "../../../src/guards/index.ts"
import { LIFECYCLE_TAIL_BYTES, parseLifecycleText, releasedActivationIds, resolveLifecycleViews } from "../../../src/guards/lifecycle-history.ts"
import { resolveLifecycles } from "../../../src/guards/lifecycle-state.ts"
import { FAIL_CLOSED_MESSAGE, type Activation, type LifecycleFact, type LifecycleFactKind, type LifecycleReason } from "../../../src/guards/schema.ts"
import { createLifecycleReader, createNodeGuardFs, createStoreReader } from "../../../src/guards/store.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { activation, commitRule, createGuardCtx, createMemoryFs, guard, PATHS, settle, storeOf, until } from "./helpers.ts"

const BASE = Date.parse("2026-11-12T10:00:00.000Z")
const at = (ms: number) => new Date(BASE + ms).toISOString()
const fact = (kind: LifecycleFactKind, instance: string, ms: number, reason: LifecycleReason, activationId = "r1"): LifecycleFact => ({ activationId, fact: kind, at: at(ms), reason, instance })
const line = (f: LifecycleFact) => `\n${JSON.stringify(f)}\n`
const request = (id = "r1", createdMs = 0): Activation => activation(id, "g1", "root", { scope: "request", createdAt: at(createdMs) })

async function start(input: { activations: Activation[]; log?: string; store?: string; nowMs?: number; fsSetup?: (fs: ReturnType<typeof createMemoryFs>) => void }) {
  const fs = createMemoryFs()
  fs.put(PATHS.store, input.store ?? JSON.stringify(storeOf([guard("g1", [commitRule])], input.activations)))
  if (input.log !== undefined) fs.put(PATHS.lifecycle, input.log)
  input.fsSetup?.(fs)
  const g = createGuardCtx({ sessions: { root: null, child: "root", other: null } })
  const clock = { ms: input.nowMs ?? BASE + 100_000 }
  const cleanup = await setupGuards(g.ctx, createMemoryLogger(), {
    fs,
    home: () => "/fake/home",
    now: () => new Date(clock.ms),
    instanceId: "inst-fresh",
    setInterval: () => 1,
    clearInterval: () => {},
    sleep: async () => {},
  })
  const commit = (sessionID = "root") => g.evaluate({ sessionID, action: "shell", resources: ["git commit"], effect: "allow" })
  return { fs, g, clock, cleanup, commit }
}

describe("persisted log is the authority", () => {
  test("a fresh instance with empty memory allows after another instance's clean end, with no service call", async () => {
    const log = line(fact("bound", "dead-instance", 1000, "observed-start")) + line(fact("ended", "dead-instance", 2000, "request-completed"))
    const t = await start({ activations: [request("r1", 500)], log })
    expect((await t.commit()).effect).toBe("allow")
    await settle()
    expect(t.fs.appended).toEqual([]) // No uncertainty noise for a request that already ended.
  })

  test("without the persisted end, the same activation is enforced", async () => {
    const log = line(fact("bound", "dead-instance", 1000, "observed-start"))
    const t = await start({ activations: [request("r1", 500)], log })
    expect((await t.commit()).effect).toBe("deny")
  })

  test("a missing bind never releases; a malformed line cannot veto a clean end", async () => {
    const orphanEnd = line(fact("ended", "i1", 2000, "request-completed"))
    expect((await (await start({ activations: [request("r1", 500)], log: orphanEnd })).commit()).effect).toBe("deny")
    const crashed = `${line(fact("bound", "i1", 1000, "observed-start"))}{"activationId":"r1","fa\nnot json at all\n${line(fact("ended", "i1", 2000, "request-completed"))}`
    expect((await (await start({ activations: [request("r1", 500)], log: crashed })).commit()).effect).toBe("allow")
  })

  test("a log that cannot be read releases nothing; once readable, the end applies", async () => {
    const log = line(fact("bound", "i1", 1000, "observed-start")) + line(fact("ended", "i1", 2000, "request-completed"))
    const t = await start({ activations: [request("r1", 500)], log, fsSetup: (fs) => (fs.failures.readTail = true) })
    expect((await t.commit()).effect).toBe("deny")
    t.fs.failures.readTail = false
    expect((await t.commit()).effect).toBe("allow")
  })

  test("an instance's own end fact releases on the next read, and an unreadable log keeps denying", async () => {
    const t = await start({ activations: [request("r1", 0)], nowMs: BASE })
    const exec = (type: string, ms: number) => t.g.emit({ type: `session.execution.${type}`, created: BASE + ms, data: { sessionID: "root" } })
    t.clock.ms = BASE + 10_000
    exec("started", 100)
    await until(() => t.fs.appended.length === 1)
    t.fs.failures.readTail = true
    exec("succeeded", 200)
    await until(() => t.fs.appended.length === 2)
    expect((await t.commit()).effect).toBe("deny") // The end is written but cannot be read back.
    t.fs.failures.readTail = false
    expect((await t.commit()).effect).toBe("allow")
  })

  test("a crashed partial line and a leading newline: the next fact is still valid", async () => {
    const crashed = '{"activationId":"r1","fact":"bo'
    const safe = parseLifecycleText(`${crashed}${line(fact("bound", "i1", 1000, "observed-start"))}${line(fact("ended", "i1", 2000, "request-completed"))}`, false)
    expect(safe.facts.map((f) => f.fact)).toEqual(["bound", "ended"])
    expect(safe.gaps.length).toBe(1)
    const unsafe = parseLifecycleText(`${crashed}${JSON.stringify(fact("bound", "i1", 1000, "observed-start"))}\n`, false)
    expect(unsafe.facts).toEqual([]) // Without the leading newline the fact would be swallowed.
  })

  test("an unterminated invalid last line is ignored; an unterminated valid one counts", () => {
    const valid = JSON.stringify(fact("bound", "i1", 1000, "observed-start"))
    expect(parseLifecycleText(`${valid}\n{"activationId":"r1","fa`, false)).toMatchObject({ partialTail: true })
    expect(parseLifecycleText(`${valid}\n{"activationId":"r1","fa`, false).facts.length).toBe(1)
    expect(parseLifecycleText(valid, false).facts.length).toBe(1)
    expect(parseLifecycleText(`${valid}\n${valid}`, false).partialTail).toBe(false)
  })

  test("a truncated tail drops the cut first line and marks history-truncated for an older pending activation", () => {
    const text = `cut-off-half-line"}\n${JSON.stringify(fact("bound", "i1", 5000, "observed-start", "r2"))}\n`
    const reading = parseLifecycleText(text, true)
    expect(reading.facts.length).toBe(1)
    expect(reading.gaps).toEqual([])
    const views = resolveLifecycleViews([request("r1", 100), request("r2", 100)], reading)
    expect(views[0]).toMatchObject({ phase: "pending", releasable: false, trust: "history-truncated" })
    expect(views[1]).toMatchObject({ phase: "bound", trust: "ok" })
  })

  test("an unverified end is a diagnostic, not a release", () => {
    const reading = parseLifecycleText(line(fact("ended", "i1", 2000, "request-completed")), false)
    expect(resolveLifecycleViews([request("r1", 100)], reading)[0]).toMatchObject({ phase: "pending", releasable: false, trust: "unverified-end" })
  })
})

describe("two live instances on one log", () => {
  async function instance(fs: ReturnType<typeof createMemoryFs>, instanceId: string, startMs: number) {
    const g = createGuardCtx({ sessions: { root: null, child: "root" } })
    const clock = { ms: startMs }
    const cleanup = await setupGuards(g.ctx, createMemoryLogger(), {
      fs,
      home: () => "/fake/home",
      now: () => new Date(clock.ms),
      instanceId,
      setInterval: () => 1,
      clearInterval: () => {},
      sleep: async () => {},
    })
    const exec = (type: string, sessionID: string, ms: number) => g.emit({ type: `session.execution.${type}`, created: BASE + ms, data: { sessionID } })
    const commit = (sessionID: string) => g.evaluate({ sessionID, action: "shell", resources: ["git commit"], effect: "allow" })
    return { g, clock, cleanup, exec, commit }
  }
  const written = (fs: ReturnType<typeof createMemoryFs>) =>
    fs.appended
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((text) => JSON.parse(text) as LifecycleFact)

  test("a late observer's uncertainty does not stop the owner from ending the request; both then allow", async () => {
    const fs = createMemoryFs()
    const activationRow = request("r1", 1000)
    fs.put(PATHS.store, JSON.stringify(storeOf([guard("g1", [commitRule])], [activationRow])))
    const storeBefore = fs.files.get(PATHS.store)

    // A watches from the start: it binds the root and tracks a child.
    const a = await instance(fs, "inst-A", BASE)
    a.clock.ms = BASE + 10_000
    a.exec("started", "root", 2000)
    a.g.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } })
    a.exec("started", "child", 2100)
    await until(() => written(fs).some((f) => f.instance === "inst-A" && f.fact === "bound"))
    expect((await a.commit("child")).effect).toBe("deny")

    // B starts later. The request began before its coverage, so it reports uncertainty.
    const b = await instance(fs, "inst-B", BASE + 20_000)
    await until(() => written(fs).some((f) => f.instance === "inst-B" && f.fact === "uncertain"))
    expect(written(fs).find((f) => f.instance === "inst-B")).toMatchObject({ fact: "uncertain", reason: "plugin-restarted" })
    expect((await a.commit("root")).effect).toBe("deny")
    expect((await b.commit("child")).effect).toBe("deny") // Uncertain: retained.

    // A sees the child and the root complete. A is still tracking, so it writes the end.
    a.clock.ms = BASE + 30_000
    for (const side of [a, b]) {
      side.exec("succeeded", "child", 3000)
      side.exec("succeeded", "root", 3100)
    }
    await until(() => written(fs).some((f) => f.fact === "ended"))
    const facts = written(fs)
    const end = facts.find((f) => f.fact === "ended")!
    expect(end).toMatchObject({ instance: "inst-A", reason: "request-completed" })
    expect(facts.some((f) => f.instance === "inst-A" && f.fact === "bound" && facts.indexOf(f) < facts.indexOf(end))).toBe(true)
    expect(facts.filter((f) => f.fact === "ended" && f.instance !== "inst-A")).toEqual([])

    // Both instances allow the next guarded action. The store was never written.
    expect((await a.commit("root")).effect).toBe("allow")
    expect((await b.commit("root")).effect).toBe("allow")
    expect((await b.commit("child")).effect).toBe("allow")
    expect(fs.files.get(PATHS.store)).toBe(storeBefore)

    // The shared view is ended, and says that another instance was uncertain.
    const view = resolveLifecycleViews([activationRow], parseLifecycleText(fs.files.get(PATHS.lifecycle)!, false))[0]!
    expect(view).toMatchObject({ phase: "ended", releasable: true, instance: "inst-A", conflict: true, trust: "ok" })
    await a.cleanup()
    await b.cleanup()
  })
})

describe("random histories: shared views and the backend release the same ids", () => {
  function rng(seed: number) {
    let state = seed
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      return state / 4294967296
    }
  }

  test("30 seeded histories", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed)
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!
      const activations = ["r1", "r2", "r3"].map((id, index) => request(id, index * 100))
      let text = ""
      const count = Math.floor(random() * 12)
      for (let i = 0; i < count; i++) {
        const kind = pick<LifecycleFactKind>(["bound", "ended", "uncertain"])
        const reason: LifecycleReason = kind === "ended" ? pick(["request-completed", "request-completed", "shutdown"]) : kind === "bound" ? "observed-start" : pick(["plugin-restarted", "event-stream-lost"])
        const f = fact(kind, pick(["i1", "i2"]), Math.floor(random() * 4000) - 200, reason, pick(["r1", "r2", "r3", "r9"]))
        const roll = random()
        if (roll < 0.1) text += `${JSON.stringify(f).slice(0, 20)}` // A crashed partial write, no newline.
        else if (roll < 0.2) text += "\ngarbage line\n"
        else if (roll < 0.25) text += "\n\n"
        text += line(f)
      }
      if (random() < 0.3) text += '{"activationId":"r1","fa' // Unterminated tail.
      const reading = parseLifecycleText(text, false)
      const shared = releasedActivationIds(activations, reading)
      // Parity with the pure resolver on the same valid facts.
      const direct = resolveLifecycles(activations, reading.facts)
      expect(new Set(activations.filter((a) => direct.get(a.id)!.releasable).map((a) => a.id))).toEqual(shared)
      // The backend, with empty memory, denies exactly the activations that the shared view does not release.
      for (const a of activations) {
        const single = await start({ activations: [a], log: text })
        expect((await single.commit()).effect).toBe(shared.has(a.id) ? "allow" : "deny")
        await single.cleanup()
      }
    }
  })
})

describe("store recovery", () => {
  const good = JSON.stringify(storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "root")]))
  const empty = JSON.stringify(storeOf([], [], 5))

  test("invalid at startup, temporarily missing, then a valid empty store: fail closed until the valid store", async () => {
    const t = await start({ activations: [], store: "{ not a store" })
    expect((await t.commit()).message).toBe(FAIL_CLOSED_MESSAGE)
    t.fs.remove(PATHS.store)
    expect((await t.commit()).message).toBe(FAIL_CLOSED_MESSAGE) // A repair rename can show a missing file.
    t.fs.put(PATHS.store, empty)
    expect((await t.commit()).effect).toBe("allow")
    t.fs.remove(PATHS.store) // Missing after a good read: no failed start, and no guards in the last good store.
    expect((await t.commit()).effect).toBe("allow")
  })

  test("unreadable at startup, then missing: still fail closed; first-ever missing allows", async () => {
    const t = await start({ activations: [], store: good, fsSetup: (fs) => (fs.failures.read = true) })
    expect((await t.commit()).message).toBe(FAIL_CLOSED_MESSAGE)
    t.fs.remove(PATHS.store)
    expect((await t.commit()).message).toBe(FAIL_CLOSED_MESSAGE)
    const fresh = createMemoryFs()
    const reader = createStoreReader({ fs: fresh, path: PATHS.store })
    expect((await reader.refresh()).failClosed).toBe(false)
  })
})

describe("readers", () => {
  test("lifecycle reader: missing is empty, failures are unreadable, changes are re-read", async () => {
    const fs = createMemoryFs()
    const reader = createLifecycleReader({ fs, path: PATHS.lifecycle })
    expect((await reader.refresh()).reading.facts).toEqual([])
    expect((await reader.refresh()).reading.truncated).toBe(false)
    fs.put(PATHS.lifecycle, line(fact("bound", "i1", 1000, "observed-start")))
    const first = await reader.refresh()
    expect(first.reading.facts.length).toBe(1)
    expect((await reader.refresh()).version).toBe(first.version) // Signature unchanged: cached.
    await fs.appendFile(PATHS.lifecycle, line(fact("ended", "i1", 2000, "request-completed")))
    expect((await reader.refresh()).reading.facts.length).toBe(2)
    fs.failures.readTail = true
    fs.put(PATHS.lifecycle, "x")
    expect((await reader.refresh()).reading.truncated).toBe(true)
    fs.failures.readTail = false
    fs.failures.stat = true
    expect((await reader.refresh()).reading).toMatchObject({ facts: [], truncated: true })
  })

  test("node readTail reads a bounded tail of a file in a temporary directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "td-guards-tail-"))
    try {
      const fs = createNodeGuardFs()
      const path = join(dir, "lifecycle.jsonl")
      expect(await fs.readTail(path, 100)).toBeNull()
      writeFileSync(path, "0123456789\nabcdefghij\n")
      expect(await fs.readTail(path, 1000)).toEqual({ text: "0123456789\nabcdefghij\n", truncated: false })
      expect((await fs.readTail(path, 8))!.truncated).toBe(true)
      expect((await fs.readTail(path, 8))!.text.endsWith("ghij\n")).toBe(true)
      expect((await fs.readTail(path, 8))!.text.length).toBe(8)
      expect(LIFECYCLE_TAIL_BYTES).toBe(1024 * 1024)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
