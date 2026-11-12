import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Activation, LifecycleFact } from "../../service/contract.ts"
import { backendSchema } from "../../service/backend-port.ts"
import { resolveLifecycleViews, type LifecycleReading } from "../../../src/guards/lifecycle-history.ts"
import { readLifecycle } from "../../service/runtime-reader.ts"
import { createRequestTracker } from "../../../src/guards/lifecycle.ts"
import { createSessionTracker } from "../../../src/guards/sessions.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { FakeBridge, call, createGuard, enable, goodDraft, makeApp, makeEnv, opId, type Env } from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

const T0 = Date.parse("2026-11-12T10:00:00.000Z")
const iso = (offset: number) => new Date(T0 + offset).toISOString()

function activation(id: string, scope: "request" | "session" = "request", createdOffset = 0): Activation {
  return { id, guardId: "g1", sessionId: "ses_root", scope, createdAt: iso(createdOffset), expiresAt: null }
}

function fact(
  activationId: string,
  kind: LifecycleFact["fact"],
  offset: number,
  instance = "inst-a",
  reason: LifecycleFact["reason"] = kind === "bound" ? "observed-start" : kind === "ended" ? "request-completed" : "plugin-restarted",
): LifecycleFact {
  return { activationId, fact: kind, at: iso(offset), reason, instance }
}

const reading = (facts: LifecycleFact[], extra: Partial<LifecycleReading> = {}): LifecycleReading => ({
  facts,
  gaps: [],
  truncated: false,
  partialTail: false,
  ...extra,
})

const view = (activations: Activation[], r: LifecycleReading, id = "r1") =>
  resolveLifecycleViews(activations, r).find((v) => v.activationId === id)!

describe("lifecycle views", () => {
  const r1 = [activation("r1")]

  test("bound then ended by the same instance after creation releases", () => {
    const v = view(r1, reading([fact("r1", "bound", 10), fact("r1", "ended", 20)]))
    expect(v).toMatchObject({ phase: "ended", releasable: true, trust: "ok", instance: "inst-a" })
  })

  test("ended without a visible bound does not release", () => {
    const v = view(r1, reading([fact("r1", "ended", 20)]))
    expect(v).toMatchObject({ phase: "pending", releasable: false, trust: "unverified-end" })
  })

  test("ended from another instance than the bound does not release", () => {
    const v = view(r1, reading([fact("r1", "bound", 10, "inst-a"), fact("r1", "ended", 20, "inst-b")]))
    expect(v).toMatchObject({ phase: "bound", releasable: false, trust: "unverified-end" })
  })

  test("facts from before the activation was created are ignored", () => {
    const v = view([activation("r1", "request", 100)], reading([fact("r1", "bound", 10), fact("r1", "ended", 20)]))
    expect(v).toMatchObject({ phase: "pending", releasable: false })
  })

  test("a session activation never releases, even with bound and ended facts", () => {
    const v = view([activation("s1", "session")], reading([fact("s1", "bound", 10), fact("s1", "ended", 20)]), "s1")
    expect(v).toMatchObject({ phase: "session", releasable: false })
  })

  test("uncertain stays enforced and an unknown reason on ended proves nothing", () => {
    expect(view(r1, reading([fact("r1", "bound", 10), fact("r1", "uncertain", 20, "inst-a", "event-stream-lost")]))).toMatchObject({
      phase: "uncertain",
      releasable: false,
    })
    expect(view(r1, reading([fact("r1", "bound", 10), fact("r1", "ended", 20, "inst-a", "shutdown")]))).toMatchObject({
      phase: "bound",
      releasable: false,
    })
  })

  test("another observer's lost coverage reports a conflict but one clean end releases", () => {
    const v = view(r1, reading([fact("r1", "bound", 10, "a"), fact("r1", "uncertain", 15, "b"), fact("r1", "ended", 20, "a")]))
    expect(v).toMatchObject({ phase: "ended", releasable: true, conflict: true })
  })

  test("a malformed line never vetoes a complete bound then ended proof", () => {
    const facts = [fact("r1", "bound", 10), fact("r1", "ended", 20)]
    expect(view(r1, reading(facts, { gaps: [1, 1, 2] }))).toMatchObject({ phase: "ended", releasable: true, trust: "ok" })
  })

  test("a truncated history with no visible bound is pending and says why", () => {
    const v = view(r1, reading([fact("other", "bound", 500)], { truncated: true }))
    expect(v).toMatchObject({ phase: "pending", releasable: false, trust: "history-truncated" })
  })
})

describe("lifecycle reader", () => {
  function setup(content: string) {
    env = makeEnv()
    mkdirSync(join(env.root, "guards"), { recursive: true })
    writeFileSync(join(env.root, "guards", "lifecycle.jsonl"), content)
    return env.runtime()
  }
  const line = (f: LifecycleFact) => `${JSON.stringify(f)}\n`

  test("malformed lines are counted, valid lines keep their order, nothing is capped", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => line(fact(`a${i}`, "bound", i)))
    const content = lines.slice(0, 300).join("") + "garbage\n" + lines.slice(300).join("")
    const result = await readLifecycle(setup(content), backendSchema, env.root)
    expect(result.facts).toHaveLength(600)
    expect(result.facts[0]!.activationId).toBe("a0")
    expect(result.gaps).toEqual([300])
    expect(result.truncated).toBe(false)
  })

  test("an unterminated invalid last line is a write in flight, not malformed", async () => {
    const content = line(fact("r1", "bound", 1)) + '{"activationId":"r1","fact":"end'
    const result = await readLifecycle(setup(content), backendSchema, env.root)
    expect(result.facts).toHaveLength(1)
    expect(result.gaps).toEqual([])
    expect(result.partialTail).toBe(true)
  })

  test("a half-written line does not hide the next fact when each write starts with a newline", async () => {
    const half = '{"activationId":"r1","fact":"bou'
    const content = line(fact("r1", "bound", 1)) + half + "\n" + JSON.stringify(fact("r1", "ended", 2)) + "\n"
    const result = await readLifecycle(setup(content), backendSchema, env.root)
    expect(result.facts.map((f) => f.fact)).toEqual(["bound", "ended"])
    expect(result.gaps).toEqual([1])
    expect(resolveLifecycleViews([activation("r1")], result)[0]).toMatchObject({ phase: "ended", releasable: true })
  })

  test("an unreadable log reads as empty and truncated, so nothing is proved", async () => {
    const runtime = setup(line(fact("r1", "bound", 1)))
    const unreadable = {
      ...runtime,
      fs: {
        ...runtime.fs,
        async readTail() {
          throw new Error("denied")
        },
      },
    }
    const result = await readLifecycle(unreadable, backendSchema, env.root)
    expect(result).toMatchObject({ facts: [], truncated: true })
  })

  test("a file longer than the tail window is reported truncated and its cut first line is dropped", async () => {
    const big = line(fact("old", "bound", 1)).repeat(12_000)
    const content = big + line(fact("r1", "bound", 2)) + line(fact("r1", "ended", 3))
    const result = await readLifecycle(setup(content), backendSchema, env.root)
    expect(result.truncated).toBe(true)
    expect(result.gaps).toEqual([])
    expect(result.facts.at(-1)!.fact).toBe("ended")
  })
})

describe("with facts from the real backend tracker", () => {
  async function backendFacts(script: (t: ReturnType<typeof createRequestTracker>, a: Activation) => Promise<void>) {
    const facts: LifecycleFact[] = []
    const sessions = createSessionTracker(async () => undefined)
    sessions.noteParent("ses_root", null)
    const tracker = createRequestTracker({
      sessions,
      instanceId: "inst-backend",
      now: () => new Date(T0 + 5_000),
      append: async (f) => void facts.push(f),
      log: createMemoryLogger(),
      coverageSince: T0 - 60_000,
    })
    const act: Activation = { id: "req-1", guardId: "g1", sessionId: "ses_root", scope: "request", createdAt: iso(0), expiresAt: null }
    tracker.sync([act])
    await tracker.idle()
    await script(tracker, act)
    await tracker.idle()
    return facts
  }

  async function serviceWith(facts: LifecycleFact[]) {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const app = makeApp(env, { bridge })
    const guard = (await createGuard(app)).body.data.guard
    const act = (await enable(app, guard.id, "ses_root", "request")).body.data.activation
    // Rewrite the backend facts for the id the service assigned.
    const lines = facts.map((f) => JSON.stringify({ ...f, activationId: act.id })).join("\n") + (facts.length ? "\n" : "")
    writeFileSync(join(env.root, "guards", "lifecycle.jsonl"), lines)
    return { app, act }
  }

  test("a completed request: the service reads bound then ended, hides it, and prunes it", async () => {
    const facts = await backendFacts(async (t) => {
      t.onExecution({ type: "started", sessionId: "ses_root", created: T0 + 1_000 })
      await t.idle()
      t.onExecution({ type: "succeeded", sessionId: "ses_root", created: T0 + 2_000 })
    })
    expect(facts.map((f) => f.fact)).toEqual(["bound", "ended"])
    const { app, act } = await serviceWith(facts)
    const state = await call(app, "GET", "/state?sessionId=ses_root")
    expect(state.body.data.effective.activationIds).toEqual([])
    expect(state.body.data.lifecycles[0]).toMatchObject({ activationId: act.id, phase: "ended", releasable: true })
    await createGuard(app, { ...goodDraft, label: "Trigger" })
    expect(JSON.parse(readFileSync(join(env.root, "guards", "store.json"), "utf8")).activations).toEqual([])
  })

  test("a request still running stays active", async () => {
    const facts = await backendFacts(async (t) => {
      t.onExecution({ type: "started", sessionId: "ses_root", created: T0 + 1_000 })
    })
    const { app, act } = await serviceWith(facts)
    const state = await call(app, "GET", "/state?sessionId=ses_root")
    expect(state.body.data.effective.activationIds).toEqual([act.id])
    expect(state.body.data.lifecycles[0]).toMatchObject({ phase: "bound", releasable: false })
  })

  test("a lost event stream gives uncertain, which stays active until the user releases", async () => {
    const facts = await backendFacts(async (t) => {
      t.onExecution({ type: "started", sessionId: "ses_root", created: T0 + 1_000 })
      await t.idle()
      t.streamLost()
    })
    expect(facts.map((f) => f.fact)).toEqual(["bound", "uncertain"])
    const { app, act } = await serviceWith(facts)
    const state = await call(app, "GET", "/state?sessionId=ses_root")
    expect(state.body.data.lifecycles[0]).toMatchObject({ phase: "uncertain", reason: "event-stream-lost", releasable: false })
    await createGuard(app, { ...goodDraft, label: "Trigger" })
    expect(JSON.parse(readFileSync(join(env.root, "guards", "store.json"), "utf8")).activations).toHaveLength(1)
    const release = await call(app, "DELETE", `/activations/${act.id}`, { opId: opId() })
    expect(release.body.data.removed).toBe(true)
  })

  test("the backend's own ended fact, copied under another instance, is not trusted", async () => {
    const facts = await backendFacts(async (t) => {
      t.onExecution({ type: "started", sessionId: "ses_root", created: T0 + 1_000 })
      await t.idle()
      t.onExecution({ type: "succeeded", sessionId: "ses_root", created: T0 + 2_000 })
    })
    const forged = facts.map((f) => (f.fact === "ended" ? { ...f, instance: "inst-other" } : f))
    const { app, act } = await serviceWith(forged)
    const state = await call(app, "GET", "/state?sessionId=ses_root")
    expect(state.body.data.effective.activationIds).toEqual([act.id])
    expect(state.body.data.lifecycles[0]).toMatchObject({ releasable: false, trust: "unverified-end" })
  })
})
