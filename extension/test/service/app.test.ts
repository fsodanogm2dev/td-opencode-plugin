import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { ApiError } from "../../service/contract.ts"
import {
  FakeBridge,
  TOKEN,
  call,
  createGuard,
  enable,
  goodDraft,
  makeApp,
  makeEnv,
  opId,
  type Env,
} from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

const storeFile = () => join(env.root, "guards", "store.json")
const readStore = () => JSON.parse(readFileSync(storeFile(), "utf8"))

function runtimeFile(directory: string | null): string {
  const name = directory === null ? "global" : createHash("sha256").update(directory, "utf8").digest("hex")
  return join(env.root, "guards", "runtime", `${name}.json`)
}

function writeRuntime(directory: string | null, recordedAt: string) {
  mkdirSync(join(env.root, "guards", "runtime"), { recursive: true })
  writeFileSync(
    runtimeFile(directory),
    JSON.stringify({
      schema: "td-guards-runtime/1",
      directory,
      instanceId: "inst-1",
      registered: true,
      recordedAt,
      storeState: "ready",
      revision: 1,
      blockedCount: 2,
      uncertainCount: 0,
      coveredActions: ["shell"],
      sessions: [{ id: "ses_root", parentId: null, activity: "idle" }],
    }),
  )
}

function writeFacts(lines: string[]) {
  mkdirSync(join(env.root, "guards"), { recursive: true })
  appendFileSync(join(env.root, "guards", "lifecycle.jsonl"), lines.join("\n"))
}

const fact = (activationId: string, kind: string, reason = "request-completed") =>
  JSON.stringify({ activationId, fact: kind, at: "2026-11-12T10:00:00.000Z", reason, instance: "inst-1" })

describe("authentication and transport rules", () => {
  test("every route, /health included, needs the bearer token", async () => {
    env = makeEnv()
    const app = makeApp(env)
    for (const [method, url] of [["GET", "/health"], ["GET", "/state"], ["POST", "/guards"], ["DELETE", "/guards/x"]]) {
      const none = await call(app, method!, url!, undefined, {})
      expect(none.status).toBe(401)
      expect(none.body).toEqual({ ok: false, error: { code: "UNAUTHORIZED", message: "The request has no valid service token." } })
      const wrong = await call(app, method!, url!, undefined, { authorization: "Bearer wrong" })
      expect(wrong.status).toBe(401)
      const scheme = await call(app, method!, url!, undefined, { authorization: TOKEN })
      expect(scheme.status).toBe(401)
    }
    expect(existsSync(join(env.root, "guards"))).toBe(false)
  })

  test("health answers ok with the token", async () => {
    env = makeEnv()
    const response = await call(makeApp(env), "GET", "/health")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })

  test("unknown routes, wrong methods, bad JSON, and unknown keys are explicit errors", async () => {
    env = makeEnv()
    const app = makeApp(env)
    expect((await call(app, "GET", "/nope")).body.error.code).toBe("NOT_FOUND")
    expect((await call(app, "GET", "/guards")).status).toBe(405)
    expect((await call(app, "POST", "/state")).status).toBe(405)
    expect((await call(app, "POST", "/guards", "{ nope")).body.error.code).toBe("INVALID_JSON")
    expect((await call(app, "POST", "/guards", "[]")).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/guards", { opId: opId(), draft: goodDraft, extra: 1 })).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/guards", { draft: goodDraft })).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/guards", { opId: "../../x", draft: goodDraft })).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "DELETE", "/guards/..%2Fetc")).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/guards", "x".repeat(70_000))).body.error.code).toBe("PAYLOAD_TOO_LARGE")
  })

  test("error bodies carry fixed prose only", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const response = await call(app, "POST", "/guards", { opId: opId(), draft: { ...goodDraft, label: "SECRET-LABEL", rules: [] } })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ ok: false, error: { code: "INVALID_DRAFT", message: "The guard draft is not valid." } })
  })
})

describe("state", () => {
  test("an empty store reports revision 0 and creates no files", async () => {
    env = makeEnv()
    const response = await call(makeApp(env), "GET", "/state")
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      revision: 0,
      guards: [],
      activations: [],
      runtime: null,
      runtimeStatus: "missing",
      lifecycle: [],
      effective: null,
      bridge: "none",
    })
    expect(existsSync(join(env.root, "guards"))).toBe(false)
  })

  test("a corrupt store is reported and never overwritten", async () => {
    env = makeEnv()
    mkdirSync(join(env.root, "guards"), { recursive: true })
    writeFileSync(storeFile(), '{"schema":"td-guards/1","revision":"x"}')
    const app = makeApp(env)
    const view = await call(app, "GET", "/state")
    expect(view.status).toBe(503)
    expect(view.body.error.code).toBe("STORE_CORRUPT")
    const write = await createGuard(app)
    expect(write.body.error.code).toBe("STORE_CORRUPT")
    expect(readFileSync(storeFile(), "utf8")).toBe('{"schema":"td-guards/1","revision":"x"}')
  })

  test("runtime: fresh snapshot is live, stale is null, malformed is invalid", async () => {
    env = makeEnv()
    const app = makeApp(env)
    writeRuntime("/work/project", new Date(env.clock.now() - 10_000).toISOString())
    let view = await call(app, "GET", `/state?directory=${encodeURIComponent("/work/project")}`)
    expect(view.body.data.runtimeStatus).toBe("live")
    expect(view.body.data.runtime.blockedCount).toBe(2)
    env.clock.advance(61_000)
    view = await call(app, "GET", `/state?directory=${encodeURIComponent("/work/project")}`)
    expect(view.body.data.runtime).toBeNull()
    expect(view.body.data.runtimeStatus).toBe("stale")
    writeFileSync(runtimeFile("/work/project"), '{"schema":"nope"}')
    view = await call(app, "GET", `/state?directory=${encodeURIComponent("/work/project")}`)
    expect(view.body.data.runtimeStatus).toBe("invalid")
  })

  test("runtime without a directory reads global.json; the directory is only hashed", async () => {
    env = makeEnv()
    writeRuntime(null, new Date(env.clock.now()).toISOString())
    const view = await call(makeApp(env), "GET", "/state")
    expect(view.body.data.runtimeStatus).toBe("live")
    const bad = await call(makeApp(env), "GET", `/state?directory=${encodeURIComponent("relative/../x")}`)
    expect(bad.body.error.code).toBe("INVALID_REQUEST")
  })

  test("the verified session directory outranks the one the panel sent", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root", null, "/verified/dir")
    writeRuntime("/verified/dir", new Date(env.clock.now()).toISOString())
    const view = await call(makeApp(env, { bridge }), "GET", `/state?sessionId=ses_root&directory=${encodeURIComponent("/other")}`)
    expect(view.body.data.runtimeStatus).toBe("live")
  })

  test("lifecycle facts: malformed lines and a truncated tail are ignored, unknown facts are not reported", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const app = makeApp(env, { bridge })
    const guard = (await createGuard(app)).body.data.guard
    const activation = (await enable(app, guard.id, "ses_root", "request")).body.data.activation
    writeFacts([
      "garbage",
      fact(activation.id, "bound", "observed-start"),
      fact("someone-else", "bound", "observed-start"),
      fact(activation.id, "uncertain", "event-stream-lost"),
      '{"activationId":"' + activation.id + '","fact":"bou',
    ])
    const view = await call(app, "GET", "/state")
    expect(view.body.data.lifecycle.map((f: any) => f.fact)).toEqual(["bound", "uncertain"])
  })
})

describe("guards", () => {
  test("create stores a guard and leaves it inactive", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const response = await createGuard(app)
    expect(response.status).toBe(200)
    expect(response.body.data.revision).toBe(1)
    const { guard } = response.body.data
    expect(guard).toMatchObject({ ...goodDraft })
    expect(guard.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(guard.createdAt).toBe("2026-11-12T10:00:00.000Z")
    expect(guard.updatedAt).toBe(guard.createdAt)
    const view = await call(app, "GET", "/state")
    expect(view.body.data.guards).toHaveLength(1)
    expect(view.body.data.activations).toEqual([])
    expect(readStore().activations).toEqual([])
  })

  test("the draft goes through the strict backend validator", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const bad = [
      { ...goodDraft, rules: [{ kind: "command", program: "/bin/git" }] },
      { ...goodDraft, rules: [{ kind: "command", program: "git", script: "rm -rf" }] },
      { ...goodDraft, rules: [{ kind: "permission", action: "edit", resources: ["***"] }] },
      { ...goodDraft, id: "forced-id" },
      { ...goodDraft, rules: [] },
      "string",
    ]
    for (const draft of bad) expect((await createGuard(app, draft)).body.error.code).toBe("INVALID_DRAFT")
    expect(existsSync(storeFile())).toBe(false)
  })

  test("delete removes the guard and ends its activations in one write", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const app = makeApp(env, { bridge })
    const a = (await createGuard(app)).body.data.guard
    const b = (await createGuard(app, { ...goodDraft, label: "Other" })).body.data.guard
    const act1 = (await enable(app, a.id, "ses_root")).body.data.activation
    const act2 = (await enable(app, a.id, "ses_root", "request")).body.data.activation
    const keep = (await enable(app, b.id, "ses_root")).body.data.activation
    const before = readStore().revision
    const response = await call(app, "DELETE", `/guards/${a.id}`, { opId: opId() })
    expect(response.body.data).toMatchObject({ guardId: a.id, removed: true })
    expect(response.body.data.endedActivationIds.sort()).toEqual([act1.id, act2.id].sort())
    expect(response.body.data.revision).toBe(before + 1)
    const store = readStore()
    expect(store.guards.map((g: any) => g.id)).toEqual([b.id])
    expect(store.activations.map((x: any) => x.id)).toEqual([keep.id])
  })

  test("deleting an unknown guard succeeds without a write", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await createGuard(app)
    const before = readFileSync(storeFile(), "utf8")
    const response = await call(app, "DELETE", "/guards/00000000-0000-4000-8000-ffffffffffff", { opId: opId() })
    expect(response.body.data.removed).toBe(false)
    expect(readFileSync(storeFile(), "utf8")).toBe(before)
  })

  test("the opId can travel in the query for a DELETE without a body", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const guard = (await createGuard(app)).body.data.guard
    const response = await call(app, "DELETE", `/guards/${guard.id}?opId=${opId()}`)
    expect(response.body.data.removed).toBe(true)
  })

  test("files and the directory are private", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await createGuard(app)
    expect(statSync(join(env.root, "guards")).mode & 0o777).toBe(0o700)
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(env.root, "guards")).sort()).toEqual(["store.json"])
  })
})

describe("activations", () => {
  async function setup(sessions: (b: FakeBridge) => void = (b) => b.add("ses_root").add("ses_child", "ses_root").add("ses_grand", "ses_child")) {
    env = makeEnv()
    const bridge = new FakeBridge()
    sessions(bridge)
    const app = makeApp(env, { bridge })
    const guard = (await createGuard(app)).body.data.guard
    return { app, bridge, guard }
  }

  test("enabling is explicit: nothing is active after saving", async () => {
    const { app } = await setup()
    expect((await call(app, "GET", "/state?sessionId=ses_root")).body.data.effective.activationIds).toEqual([])
  })

  test("default scope has no expiry and freezes the previewed guard", async () => {
    const { app, guard } = await setup()
    const response = await enable(app, guard.id, "ses_root")
    expect(response.status).toBe(200)
    const { activation, alreadyActive } = response.body.data
    expect(alreadyActive).toBe(false)
    expect(activation).toMatchObject({
      guardId: guard.id,
      sessionId: "ses_root",
      scope: "session",
      expiresAt: null,
      createdAt: "2026-11-12T10:00:00.000Z",
      guardUpdatedAt: guard.updatedAt,
      snapshot: { label: guard.label, message: guard.message, rules: guard.rules },
    })
  })

  test("expiresInMinutes sets an exact expiry; invalid values are refused", async () => {
    const { app, guard } = await setup()
    const response = await enable(app, guard.id, "ses_root", "session", { expiresInMinutes: 30 })
    expect(response.body.data.activation.expiresAt).toBe("2026-11-12T10:30:00.000Z")
    for (const bad of [0, -5, 1.5, "10", 60 * 24 * 30 + 1, true]) {
      const r = await enable(app, guard.id, "ses_child", "session", { expiresInMinutes: bad })
      expect(r.body.error.code).toBe("INVALID_REQUEST")
    }
    expect((await enable(app, guard.id, "ses_root", "forever" as never)).body.error.code).toBe("INVALID_REQUEST")
  })

  test("an expired activation disappears from state, and the next mutation removes it", async () => {
    const { app, guard } = await setup()
    await enable(app, guard.id, "ses_root", "session", { expiresInMinutes: 5 })
    expect((await call(app, "GET", "/state")).body.data.activations).toHaveLength(1)
    env.clock.advance(5 * 60_000)
    const view = await call(app, "GET", "/state?sessionId=ses_root")
    expect(view.body.data.activations).toEqual([])
    expect(view.body.data.effective.activationIds).toEqual([])
    expect(readStore().activations).toHaveLength(1)
    await createGuard(app, { ...goodDraft, label: "Trigger" })
    expect(readStore().activations).toEqual([])
  })

  test("session scope covers the selected session and its descendants, not its parents", async () => {
    const { app, guard } = await setup()
    const activation = (await enable(app, guard.id, "ses_child", "session")).body.data.activation
    expect(activation.sessionId).toBe("ses_child")
    const effective = async (id: string) => (await call(app, "GET", `/state?sessionId=${id}`)).body.data.effective.activationIds
    expect(await effective("ses_root")).toEqual([])
    expect(await effective("ses_child")).toEqual([activation.id])
    expect(await effective("ses_grand")).toEqual([activation.id])
  })

  test("request scope anchors to the true root", async () => {
    const { app, guard } = await setup()
    const activation = (await enable(app, guard.id, "ses_grand", "request")).body.data.activation
    expect(activation.sessionId).toBe("ses_root")
    expect(activation.scope).toBe("request")
    const view = await call(app, "GET", "/state?sessionId=ses_child")
    expect(view.body.data.effective).toEqual({ sessionId: "ses_child", rootSessionId: "ses_root", activationIds: [activation.id] })
  })

  test("the same guard on the same anchor is kept as it is", async () => {
    const { app, guard } = await setup()
    const first = (await enable(app, guard.id, "ses_root", "session")).body.data
    env.clock.advance(1000)
    const second = (await enable(app, guard.id, "ses_root", "session", { expiresInMinutes: 5 })).body.data
    expect(second.alreadyActive).toBe(true)
    expect(second.activation).toEqual(first.activation)
    expect(second.revision).toBe(first.revision)
    expect(readStore().activations).toHaveLength(1)
  })

  test("an unknown session or guard is refused", async () => {
    const { app, guard } = await setup()
    const noSession = await enable(app, guard.id, "ses_missing")
    expect(noSession.status).toBe(400)
    expect(noSession.body.error.code).toBe("SESSION_NOT_FOUND")
    const noGuard = await enable(app, "00000000-0000-4000-8000-ffffffffffff", "ses_root")
    expect(noGuard.status).toBe(409)
    expect(noGuard.body.error.code).toBe("GUARD_NOT_FOUND")
    expect((await enable(app, "bad id", "ses_root")).body.error.code).toBe("INVALID_REQUEST")
    expect((await enable(app, guard.id, "../x")).body.error.code).toBe("INVALID_REQUEST")
  })

  test("a broken ancestry is a failed lookup, not a guess", async () => {
    const { app, guard, bridge } = await setup()
    bridge.add("ses_orphan", "ses_gone")
    expect((await enable(app, guard.id, "ses_orphan", "request")).body.error.code).toBe("SESSION_LOOKUP_FAILED")
    bridge.add("ses_a", "ses_b").add("ses_b", "ses_a")
    expect((await enable(app, guard.id, "ses_a", "request")).body.error.code).toBe("SESSION_LOOKUP_FAILED")
  })

  test("without the session bridge, enabling is refused but viewing and releasing work", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const withBridge = makeApp(env, { bridge })
    const guard = (await createGuard(withBridge)).body.data.guard
    const activation = (await enable(withBridge, guard.id, "ses_root")).body.data.activation

    const blind = makeApp(env, { bridge: null })
    const refused = await enable(blind, guard.id, "ses_root", "request")
    expect(refused.status).toBe(503)
    expect(refused.body.error.code).toBe("SESSION_BRIDGE_UNAVAILABLE")
    const view = await call(blind, "GET", "/state?sessionId=ses_root")
    expect(view.status).toBe(200)
    expect(view.body.data.activations).toHaveLength(1)
    expect(view.body.data.effective).toBeNull()
    expect(view.body.data.bridge).toBe("unavailable")
    const release = await call(blind, "DELETE", `/activations/${activation.id}`, { opId: opId() })
    expect(release.body.data.removed).toBe(true)
  })

  test("a failing bridge refuses enabling with 503 and state still answers", async () => {
    const { app, guard, bridge } = await setup()
    bridge.failWith = new ApiError("SESSION_LOOKUP_FAILED")
    expect((await enable(app, guard.id, "ses_root")).status).toBe(503)
    const view = await call(app, "GET", "/state?sessionId=ses_root")
    expect(view.status).toBe(200)
    expect(view.body.data.bridge).toBe("unavailable")
  })

  test("release removes one activation and is safe to repeat", async () => {
    const { app, guard } = await setup()
    const a = (await enable(app, guard.id, "ses_root", "session")).body.data.activation
    const b = (await enable(app, guard.id, "ses_root", "request")).body.data.activation
    const first = await call(app, "DELETE", `/activations/${a.id}`, { opId: opId() })
    expect(first.body.data).toMatchObject({ activationId: a.id, removed: true })
    const second = await call(app, "DELETE", `/activations/${a.id}`, { opId: opId() })
    expect(second.body.data).toMatchObject({ activationId: a.id, removed: false })
    expect(readStore().activations.map((x: any) => x.id)).toEqual([b.id])
    expect(readStore().guards).toHaveLength(1)
  })

  test("a proven end (bound, then ended by the same instance) is pruned at the next mutation, not before", async () => {
    const { app, guard } = await setup()
    const request = (await enable(app, guard.id, "ses_root", "request")).body.data.activation
    const session = (await enable(app, guard.id, "ses_root", "session")).body.data.activation
    writeFacts([
      fact(request.id, "bound", "observed-start") + "\n",
      fact(request.id, "ended", "request-completed") + "\n",
      fact(session.id, "uncertain", "plugin-restarted") + "\n",
      "{broken\n",
    ])
    const view = await call(app, "GET", "/state?sessionId=ses_root")
    expect(view.body.data.activations).toHaveLength(2)
    // The row is still listed, but it is not effective and its phase says ended.
    expect(view.body.data.effective.activationIds).toEqual([session.id])
    expect(view.body.data.lifecycles.find((l: any) => l.activationId === request.id)).toMatchObject({
      phase: "ended",
      releasable: true,
      trust: "ok",
    })
    await createGuard(app, { ...goodDraft, label: "Trigger" })
    expect(readStore().activations.map((x: any) => x.id)).toEqual([session.id])
  })

  test("an unproven ended fact never prunes or hides an activation", async () => {
    const { app, guard } = await setup()
    const request = (await enable(app, guard.id, "ses_root", "request")).body.data.activation
    const session = (await enable(app, guard.id, "ses_root", "session")).body.data.activation
    writeFacts([
      // ended without bound, ended for a session activation, wrong reason, unknown kind, unknown reason
      fact(request.id, "ended", "request-completed") + "\n",
      fact(session.id, "bound", "observed-start") + "\n",
      fact(session.id, "ended", "request-completed") + "\n",
      JSON.stringify({ activationId: request.id, fact: "ended", at: "2026-11-12T10:00:00.000Z", reason: "made-up", instance: "inst-1" }) + "\n",
      JSON.stringify({ activationId: request.id, fact: "finished", at: "2026-11-12T10:00:00.000Z", reason: "shutdown", instance: "inst-1" }) + "\n",
    ])
    const view = await call(app, "GET", "/state?sessionId=ses_root")
    expect(view.body.data.effective.activationIds.sort()).toEqual([request.id, session.id].sort())
    const states = Object.fromEntries(view.body.data.lifecycles.map((l: any) => [l.activationId, l]))
    expect(states[request.id]).toMatchObject({ phase: "pending", releasable: false, trust: "unverified-end" })
    expect(states[session.id]).toMatchObject({ phase: "session", releasable: false })
    await createGuard(app, { ...goodDraft, label: "Trigger" })
    expect(readStore().activations).toHaveLength(2)
  })

  test("the session lookup uses only the fixed read route with an encoded id", async () => {
    env = makeEnv()
    const { createSessionBridge } = await import("../../service/session.ts")
    const urls: string[] = []
    const init: RequestInit[] = []
    const fetchImpl = (async (url: URL, options: RequestInit) => {
      urls.push(String(url))
      init.push(options)
      return new Response(JSON.stringify({ id: "ses_ok", directory: "/work" }), { status: 200 })
    }) as unknown as typeof fetch
    const bridge = createSessionBridge(
      { OPENCHAMBER_OPENCODE_URL: "http://127.0.0.1:5555", OPENCHAMBER_SERVICE_TOKEN: TOKEN },
      fetchImpl,
    )!
    expect(await bridge.get("ses_ok")).toEqual({ id: "ses_ok", parentId: null, directory: "/work" })
    expect(urls).toEqual(["http://127.0.0.1:5555/api/session/ses_ok"])
    expect(init[0]).toMatchObject({ method: "GET", redirect: "manual" })
    expect((init[0]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    for (const bad of ["../x", "a/b", "a?b=1", "..", "ses id", "ses%2f"]) {
      await expect(bridge.get(bad)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    }
    expect(urls).toHaveLength(1)
  })

  test("the bridge refuses a non-loopback or non-http base URL and a missing token", async () => {
    const { createSessionBridge } = await import("../../service/session.ts")
    expect(createSessionBridge({ OPENCHAMBER_OPENCODE_URL: "http://evil.example", OPENCHAMBER_SERVICE_TOKEN: TOKEN })).toBeNull()
    expect(createSessionBridge({ OPENCHAMBER_OPENCODE_URL: "https://127.0.0.1:1", OPENCHAMBER_SERVICE_TOKEN: TOKEN })).toBeNull()
    expect(createSessionBridge({ OPENCHAMBER_OPENCODE_URL: "http://user:pw@127.0.0.1:1", OPENCHAMBER_SERVICE_TOKEN: TOKEN })).toBeNull()
    expect(createSessionBridge({ OPENCHAMBER_OPENCODE_URL: "http://127.0.0.1:1" })).toBeNull()
    expect(createSessionBridge({})).toBeNull()
  })

  test("bridge status codes map to explicit errors", async () => {
    const { createSessionBridge } = await import("../../service/session.ts")
    const make = (status: number, body = "{}") =>
      createSessionBridge(
        { OPENCHAMBER_OPENCODE_URL: "http://127.0.0.1:5555", OPENCHAMBER_SERVICE_TOKEN: TOKEN },
        (async () => new Response(body, { status })) as unknown as typeof fetch,
      )!
    expect(await make(404).get("ses_x")).toBeNull()
    await expect(make(403).get("ses_x")).rejects.toMatchObject({ code: "SESSION_BRIDGE_UNAVAILABLE" })
    await expect(make(500).get("ses_x")).rejects.toMatchObject({ code: "SESSION_LOOKUP_FAILED" })
    await expect(make(302).get("ses_x")).rejects.toMatchObject({ code: "SESSION_LOOKUP_FAILED" })
    await expect(make(200, JSON.stringify({ id: "other" })).get("ses_x")).rejects.toMatchObject({ code: "SESSION_LOOKUP_FAILED" })
    await expect(make(200, "not json").get("ses_x")).rejects.toMatchObject({ code: "SESSION_LOOKUP_FAILED" })
    const wrapped = make(200, JSON.stringify({ data: { id: "ses_x", parentID: "ses_p", directory: "/d" } }))
    expect(await wrapped.get("ses_x")).toEqual({ id: "ses_x", parentId: "ses_p", directory: "/d" })
  })
})

describe("idempotency and revisions", () => {
  test("a retry with the same opId returns the first outcome without a second write", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const body = { opId: "op-retry-0001", draft: goodDraft }
    const first = await call(app, "POST", "/guards", body)
    const second = await call(app, "POST", "/guards", body)
    expect(second.body.data.replayed).toBe(true)
    expect(second.body.data.guard).toEqual(first.body.data.guard)
    expect(readStore().guards).toHaveLength(1)
    expect(readStore().revision).toBe(1)
  })

  test("a retry after another writer moved on still returns the stored outcome", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const body = { opId: "op-retry-0002", draft: goodDraft }
    const first = await call(app, "POST", "/guards", body)
    await createGuard(app, { ...goodDraft, label: "B" })
    const again = await call(app, "POST", "/guards", body)
    expect(again.body.data.guard.id).toBe(first.body.data.guard.id)
    expect(again.body.data.revision).toBe(2)
    expect(readStore().guards).toHaveLength(2)
  })

  test("an opId reused for another request is a conflict", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await call(app, "POST", "/guards", { opId: "op-reuse-0001", draft: goodDraft })
    const other = await call(app, "POST", "/guards", { opId: "op-reuse-0001", draft: { ...goodDraft, label: "Different" } })
    expect(other.status).toBe(409)
    expect(other.body.error.code).toBe("OP_ID_REUSED")
  })

  test("an activation retry returns the same activation", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const app = makeApp(env, { bridge })
    const guard = (await createGuard(app)).body.data.guard
    const body = { opId: "op-enable-0001", guardId: guard.id, sessionId: "ses_root", scope: "session" }
    const first = await call(app, "POST", "/activations", body)
    const second = await call(app, "POST", "/activations", body)
    expect(second.body.data.activation).toEqual(first.body.data.activation)
    expect(second.body.data.replayed).toBe(true)
    expect(readStore().activations).toHaveLength(1)
  })

  test("history keeps at least 256 outcomes and stays inside the backend bound", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const first = await call(app, "POST", "/guards", { opId: "op-history-0000", draft: goodDraft })
    // Alternate create and delete so the number of guards stays small while the history grows.
    let lastId = ""
    for (let i = 0; i < 150; i++) {
      const made = await call(app, "POST", "/guards", { opId: `op-fill-${String(i).padStart(5, "0")}`, draft: { ...goodDraft, label: `G${i}` } })
      lastId = made.body.data.guard.id
      await call(app, "DELETE", `/guards/${lastId}`, { opId: `op-drop-${String(i).padStart(5, "0")}` })
    }
    const store = readStore()
    expect(store.operations).toHaveLength(256)
    // The first operation fell out of the history: a retry runs again and says nothing about a replay.
    const retry = await call(app, "POST", "/guards", { opId: "op-history-0000", draft: goodDraft })
    expect(retry.body.data.replayed).toBeUndefined()
    expect(retry.body.data.guard.id).not.toBe(first.body.data.guard.id)
    const recent = await call(app, "DELETE", `/guards/${lastId}`, { opId: "op-drop-00149" })
    expect(recent.body.data.replayed).toBe(true)
  })

  test("expectedRevision detects a stale view", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await createGuard(app)
    const stale = await call(app, "POST", "/guards", { opId: opId(), draft: goodDraft, expectedRevision: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("STALE_REVISION")
    const fresh = await call(app, "POST", "/guards", { opId: opId(), draft: goodDraft, expectedRevision: 1 })
    expect(fresh.body.data.revision).toBe(2)
    expect((await call(app, "POST", "/guards", { opId: opId(), draft: goodDraft, expectedRevision: -1 })).body.error.code).toBe("INVALID_REQUEST")
  })

  test("transactions read the latest document: two apps on one store lose nothing", async () => {
    env = makeEnv()
    const a = makeApp(env)
    const b = makeApp(env)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(i % 2 ? a : b, "POST", "/guards", { opId: opId(), draft: { ...goodDraft, label: `L${i}` } })),
    )
    expect(results.every((r) => r.status === 200)).toBe(true)
    const store = readStore()
    expect(store.guards).toHaveLength(20)
    expect(store.revision).toBe(20)
    expect(new Set(store.guards.map((g: any) => g.id)).size).toBe(20)
  })

  test("a store that is already at the guard limit refuses more guards", async () => {
    env = makeEnv()
    const { backendSchema } = await import("../../service/backend-port.ts")
    const app = makeApp(env)
    const first = await createGuard(app)
    const store = readStore()
    const copies = Array.from({ length: backendSchema.maxGuards - 1 }, (_, i) => ({ ...first.body.data.guard, id: `g-${i}` }))
    store.guards.push(...copies)
    writeFileSync(storeFile(), JSON.stringify(store))
    const over = await createGuard(app, { ...goodDraft, label: "Over" })
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe("LIMIT_REACHED")
  })

  test("the store never holds a key, token, or command text from the service itself", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await createGuard(app)
    expect(readFileSync(storeFile(), "utf8")).not.toContain(TOKEN)
  })
})
