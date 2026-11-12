import { describe, expect, test } from "bun:test"
import { legacyConfigPaths, setupJev, JEV_SETUP_FAILED, type JevDeps } from "../../../src/jev/index.ts"
import { createJevCache } from "../../../src/jev/cache.ts"
import { createJevRuntime, withDeadline } from "../../../src/jev/runtime.ts"
import { parseJevOptions } from "../../../src/jev/options.ts"
import type { Logger } from "../../../src/log.ts"

type Callback = (event: any) => unknown

interface Fake {
  ctx: any
  readonly calls: string[]
  readonly hooks: Map<string, Callback[]>
  readonly editor: { methods: any[]; names: Record<string, string>; existing: Set<string> }
  failOn: string | undefined
  transform?: (editor: any) => void
}

function fakeCtx(): Fake {
  const calls: string[] = []
  const hooks = new Map<string, Callback[]>()
  const editor = { methods: [] as any[], names: {} as Record<string, string>, existing: new Set<string>() }
  const fake: Fake = { ctx: undefined, calls, hooks, editor, failOn: undefined }
  const hookHost = (kind: string) => ({
    hook: async (name: string, callback: Callback) => {
      const label = `${kind}.${name}`
      if (fake.failOn === label) throw new Error("typesafe-secret-text")
      calls.push(`register ${label}`)
      hooks.set(label, [...(hooks.get(label) ?? []), callback])
      return { dispose: async () => void calls.push(`dispose ${label}`) }
    },
  })
  fake.ctx = {
    location: { directory: "/project" },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        if (fake.failOn === "integration.transform") throw new Error("typesafe-secret-text")
        callback({
          get: (id: string) => (editor.existing.has(id) ? { id } : undefined),
          update: (id: string, update: (item: any) => void) => {
            const item: any = {}
            update(item)
            if (item.name) editor.names[id] = item.name
          },
          method: { update: (input: any) => void editor.methods.push(input) },
        })
        calls.push("register integration.transform")
        return { dispose: async () => void calls.push("dispose integration.transform") }
      },
      connection: { active: async () => undefined, resolve: async () => undefined },
    },
    shell: hookHost("shell"),
    permission: hookHost("permission"),
    tool: hookHost("tool"),
    session: hookHost("session"),
    model: { list: async () => ({ data: [{ id: "m", providerID: "p", variants: [{ id: "low" }] }] }) },
  }
  return fake
}

function fakeLog() {
  const lines: string[] = []
  const log: Logger = {
    debug: (m) => void lines.push(`debug ${m}`),
    info: (m) => void lines.push(`info ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
  }
  return { log, lines }
}

const enabled = (extra: Record<string, unknown> = {}, points: Record<string, unknown> = {}) =>
  parseJevOptions({ enabled: true, keychainService: false, telemetry: false, points, ...extra }, {}, [])

const baseDeps = (extra: JevDeps = {}): JevDeps => ({
  env: {},
  platform: "linux",
  homeDir: "/home/nobody",
  root: "/nonexistent-root-for-tests/jev",
  cleanupLogs: false,
  fileExists: () => false,
  cache: createJevCache(),
  exec: async () => {
    throw new Error("exec must not run")
  },
  fetch: async () => {
    throw new Error("fetch must not run")
  },
  ...extra,
})

describe("setupJev", () => {
  test("disabled registers nothing and touches nothing", async () => {
    const fake = fakeCtx()
    const { log, lines } = fakeLog()
    let touched = 0
    const deps = baseDeps({
      fileExists: () => (touched++, false),
      exec: async () => (touched++, { exitCode: 1, stdout: "" }),
      fetch: async () => (touched++, new Response("")),
    })
    const cleanup = await setupJev(fake.ctx, parseJevOptions(undefined, {}, []), log, deps)
    await cleanup()
    expect(fake.calls).toEqual([])
    expect(lines).toEqual([])
    expect(touched).toBe(0)
    await setupJev(fake.ctx, parseJevOptions({ enabled: false }, {}, []), log, deps)
    expect(fake.calls).toEqual([])
  })

  test("enabled with defaults registers the integration, the shell scrub, and the safety and compression hooks", async () => {
    const fake = fakeCtx()
    const { log } = fakeLog()
    await setupJev(fake.ctx, enabled(), log, baseDeps())
    expect(fake.calls).toEqual([
      "register integration.transform",
      "register shell.create.before",
      "register tool.execute.before",
      "register permission.evaluate",
      "register tool.execute.after",
      "register tool.execute.after",
    ])
  })

  test("shadow points add their session.context hooks", async () => {
    const fake = fakeCtx()
    const { log } = fakeLog()
    await setupJev(fake.ctx, enabled({}, { skillPruning: { mode: "shadow" }, reasoningBudget: { mode: "shadow" } }), log, baseDeps())
    expect(fake.calls.filter((c) => c === "register session.context").length).toBe(2)
  })

  test("points that are off register no hooks, and all off leaves the integration and the scrub", async () => {
    const fake = fakeCtx()
    const { log } = fakeLog()
    const off = { safetyPreCheck: { mode: "off" }, testCompression: { mode: "off" } }
    await setupJev(fake.ctx, enabled({}, off), log, baseDeps())
    expect(fake.calls).toEqual(["register integration.transform", "register shell.create.before"])
  })

  test("the integration has key and env methods and the name TypeSafe", async () => {
    const fake = fakeCtx()
    const { log } = fakeLog()
    await setupJev(fake.ctx, enabled(), log, baseDeps())
    expect(fake.editor.methods).toEqual([
      { integrationID: "typesafe-ai", method: { type: "key", label: "TypeSafe API key" } },
      { integrationID: "typesafe-ai", method: { type: "env", names: ["TYPESAFE_API_KEY"] } },
    ])
    expect(fake.editor.names["typesafe-ai"]).toBe("TypeSafe")
  })

  test("an existing integration keeps its methods and gains the env method", async () => {
    const fake = fakeCtx()
    fake.editor.existing.add("typesafe-ai")
    await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps())
    expect(fake.editor.methods.map((m) => m.method.type)).toEqual(["env"])
  })

  test("the shell hook removes TYPESAFE_API_KEY and nothing else", async () => {
    const fake = fakeCtx()
    await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps())
    const event = { env: { TYPESAFE_API_KEY: "ts-test", FUELIX_API_KEY: "kept-here", PATH: "/bin" } as Record<string, string | undefined> }
    fake.hooks.get("shell.create.before")![0]!(event)
    expect(event.env).toEqual({ FUELIX_API_KEY: "kept-here", PATH: "/bin" })
  })

  test("scrubShellEnv false registers no shell hook", async () => {
    const fake = fakeCtx()
    await setupJev(fake.ctx, enabled({ scrubShellEnv: false }), fakeLog().log, baseDeps())
    expect(fake.calls).not.toContain("register shell.create.before")
  })

  test("setup sends no request and runs no Keychain lookup, even with Keychain on", async () => {
    const fake = fakeCtx()
    let used = 0
    const options = parseJevOptions({ enabled: true, telemetry: false }, {}, [])
    await setupJev(
      fake.ctx,
      options,
      fakeLog().log,
      baseDeps({ platform: "darwin", keychainCache: new Map(), exec: async () => (used++, { exitCode: 44, stdout: "" }), fetch: async () => (used++, new Response("")) }),
    )
    expect(used).toBe(0)
  })

  test("a failure disposes earlier registrations in reverse order and throws a constant error", async () => {
    const fake = fakeCtx()
    fake.failOn = "tool.execute.after"
    const { log, lines } = fakeLog()
    let error: unknown
    try {
      await setupJev(fake.ctx, enabled(), log, baseDeps())
    } catch (caught) {
      error = caught
    }
    expect((error as Error).message).toBe(JEV_SETUP_FAILED)
    expect(JSON.stringify([(error as Error).message, lines])).not.toContain("typesafe-secret-text")
    expect(fake.calls).toEqual([
      "register integration.transform",
      "register shell.create.before",
      "register tool.execute.before",
      "register permission.evaluate",
      "dispose permission.evaluate",
      "dispose tool.execute.before",
      "dispose shell.create.before",
      "dispose integration.transform",
    ])
  })

  test("a failure of the first registration leaves nothing behind", async () => {
    const fake = fakeCtx()
    fake.failOn = "integration.transform"
    await expect(setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps())).rejects.toThrow(JEV_SETUP_FAILED)
    expect(fake.calls).toEqual([])
  })

  test("cleanup disposes in reverse order and is idempotent", async () => {
    const fake = fakeCtx()
    const cleanup = await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps())
    fake.calls.length = 0
    await cleanup()
    await cleanup()
    expect(fake.calls).toEqual([
      "dispose tool.execute.after",
      "dispose tool.execute.after",
      "dispose permission.evaluate",
      "dispose tool.execute.before",
      "dispose shell.create.before",
      "dispose integration.transform",
    ])
  })

  test("the legacy file is checked for existence only, with XDG respected, and warns", async () => {
    const fake = fakeCtx()
    const { log, lines } = fakeLog()
    const seen: string[] = []
    await setupJev(fake.ctx, enabled(), log, baseDeps({ env: { XDG_CONFIG_HOME: "/xdg" }, fileExists: (path) => (seen.push(path), path === "/xdg/opencode/jev.json") }))
    expect(seen).toEqual(["/xdg/opencode/jev.json"])
    expect(lines.some((l) => l.startsWith("warn") && l.includes("jev.json"))).toBe(true)
  })

  test("legacyConfigPaths ignores a relative XDG directory", () => {
    expect(legacyConfigPaths({ XDG_CONFIG_HOME: "relative" }, "/h")).toEqual(["/h/.config/opencode/jev.json"])
    expect(legacyConfigPaths({ XDG_CONFIG_HOME: "/h/.config" }, "/h")).toEqual(["/h/.config/opencode/jev.json"])
  })

  test("a throwing existence check does not fail setup", async () => {
    const fake = fakeCtx()
    await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps({ fileExists: () => { throw new Error("denied") } }))
    expect(fake.calls.length).toBeGreaterThan(0)
  })

  test("the permission hook works end to end: a destructive command asks with no request, a risky one asks after a request", async () => {
    const fake = fakeCtx()
    const requests: { url: string; headers: Record<string, string>; body: any }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      requests.push({ url, headers: init.headers as Record<string, string>, body })
      const answers: Record<string, unknown> = {}
      for (const name of Object.keys(body.questions)) answers[name] = { type: "noul", noul: String(body.state).includes("risky") ? 0.9 : 0.01 }
      return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status: 200, headers: { "content-type": "application/json" } })
    }
    await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps({ env: { TYPESAFE_API_KEY: "ts-test-not-a-real-key" }, fetch }))
    const evaluate = fake.hooks.get("permission.evaluate")![0]!
    const before = fake.hooks.get("tool.execute.before")![0]!
    const run = async (command: string) => {
      before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command } })
      const event = { sessionID: "ses_1", action: "shell", resources: [command], source: { type: "tool", messageID: "m", id: "call_1" }, effect: "allow" }
      await evaluate(event)
      return event.effect
    }
    expect(await run("rm -rf build")).toBe("ask")
    expect(requests).toEqual([])
    expect(await run("git status")).toBe("allow")
    expect(requests).toEqual([])
    expect(await run("touch fine")).toBe("allow")
    expect(requests.length).toBe(1)
    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(requests[0]!.headers.Authorization).toBe("Bearer ts-test-not-a-real-key")
    expect(requests[0]!.body.model).toBe("jev-1.14.0")
    expect(await run("touch risky")).toBe("ask")
  })

  test("without a key the safety hook sends nothing and keeps allow, and still asks for destructive commands", async () => {
    const fake = fakeCtx()
    let sent = 0
    await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps({ fetch: async () => (sent++, new Response("")) }))
    const evaluate = fake.hooks.get("permission.evaluate")![0]!
    fake.hooks.get("tool.execute.before")![0]!({ tool: "shell", sessionID: "s", id: "c", input: { command: "touch x" } })
    const plain = { sessionID: "s", action: "shell", resources: ["touch x"], source: { type: "tool", id: "c" }, effect: "allow" }
    await evaluate(plain)
    expect(plain.effect).toBe("allow")
    // Without the full command the command cannot be judged, so failClosed asks. Nothing goes upstream.
    const unknown = { sessionID: "s", action: "shell", resources: ["touch x"], source: { type: "tool", id: "other" }, effect: "allow" }
    await evaluate(unknown)
    expect(unknown.effect).toBe("ask")
    const bad = { sessionID: "s", action: "shell", resources: ["rm -rf x"], source: { type: "tool", id: "c" }, effect: "allow" }
    await evaluate(bad)
    expect(bad.effect).toBe("ask")
    expect(sent).toBe(0)
  })

  test("after cleanup the hooks do nothing", async () => {
    const fake = fakeCtx()
    const cleanup = await setupJev(fake.ctx, enabled(), fakeLog().log, baseDeps({ env: { TYPESAFE_API_KEY: "ts-test-not-a-real-key" } }))
    await cleanup()
    const event = { sessionID: "s", action: "shell", resources: ["rm -rf x"], source: { type: "tool", id: "c" }, effect: "allow" }
    await fake.hooks.get("permission.evaluate")![0]!(event)
    expect(event.effect).toBe("allow")
  })
})

describe("withDeadline", () => {
  function spySignal() {
    const state = { adds: 0, removes: 0, aborted: false, abort: undefined as undefined | (() => void) }
    const signal = {
      get aborted() {
        return state.aborted
      },
      addEventListener: (_: string, listener: () => void) => {
        state.adds++
        state.abort = listener
      },
      removeEventListener: () => void state.removes++,
    } as unknown as AbortSignal
    return { signal, state }
  }

  test("resolves with the value and removes its listener", async () => {
    const { signal, state } = spySignal()
    expect(await withDeadline(async () => 7, 1000, signal)).toBe(7)
    expect(state).toMatchObject({ adds: 1, removes: 1 })
  })

  test("a hung promise holds no listener after the deadline", async () => {
    const { signal, state } = spySignal()
    await expect(withDeadline(() => new Promise<never>(() => undefined), 5, signal)).rejects.toThrow("timeout")
    expect(state).toMatchObject({ adds: 1, removes: 1 })
  })

  test("a hung promise holds no listener after an abort", async () => {
    const { signal, state } = spySignal()
    const pending = withDeadline(() => new Promise<never>(() => undefined), 10_000, signal)
    state.abort!()
    await expect(pending).rejects.toThrow("aborted")
    expect(state).toMatchObject({ adds: 1, removes: 1 })
  })

  test("an already aborted signal starts no work and adds no listener", async () => {
    const { signal, state } = spySignal()
    state.aborted = true
    let started = 0
    await expect(withDeadline(async () => void started++, 1000, signal)).rejects.toThrow("aborted")
    expect(started).toBe(0)
    expect(state.adds).toBe(0)
  })

  test("a synchronous throw rejects and cleans up", async () => {
    const { signal, state } = spySignal()
    await expect(
      withDeadline(() => {
        throw new Error("sync")
      }, 1000, signal),
    ).rejects.toThrow("sync")
    expect(state).toMatchObject({ adds: 1, removes: 1 })
  })
})

describe("runtime lifecycle", () => {
  const log: Logger = { debug() {}, info() {}, warn() {}, error() {} }
  const client = () => ({ calls: 0, decide: async function (this: { calls: number }) { this.calls++; return { ok: false as const, error: { code: "network" as const } } }, dispose() {} })
  const telemetry = { record() {}, flush: async () => undefined, dispose: async () => undefined }

  test("secrets and writeLog work before dispose and pass the literal key to the store", async () => {
    const written: unknown[] = []
    const runtime = createJevRuntime({
      client: client(),
      keys: { resolve: async () => ({ key: "ts-opaque", source: "env" as const }) },
      telemetry,
      artifacts: { writeLog: async (...args: unknown[]) => (written.push(args), "/p/x.log") },
      log,
    })
    expect(await runtime.secrets()).toEqual(["ts-opaque"])
    expect(await runtime.writeLog("s", "c", "text")).toBe("/p/x.log")
    expect(written).toEqual([["s", "c", "text", { secrets: ["ts-opaque"] }]])
  })

  test("after dispose secrets are empty and no artifact write starts", async () => {
    let writes = 0
    const runtime = createJevRuntime({
      client: client(),
      keys: { resolve: async () => ({ key: "ts-opaque", source: "env" as const }) },
      telemetry,
      artifacts: { writeLog: async () => (writes++, "/p/x.log") },
      log,
    })
    await runtime.dispose()
    expect(await runtime.secrets()).toEqual([])
    await expect(runtime.writeLog("s", "c", "text")).rejects.toThrow()
    expect(writes).toBe(0)
    expect(runtime.disposed).toBe(true)
    expect((await runtime.decide({ state: "x", questions: {}, timeoutMs: 100 })).ok).toBe(false)
  })

  test("a dispose during key resolution stops the write", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let writes = 0
    const runtime = createJevRuntime({
      client: client(),
      keys: { resolve: async () => (await gate, { key: "ts-opaque", source: "env" as const }) },
      telemetry,
      artifacts: { writeLog: async () => (writes++, "/p/x.log") },
      log,
    })
    const pending = runtime.writeLog("s", "c", "text")
    await runtime.dispose()
    release()
    await expect(pending).rejects.toThrow()
    expect(writes).toBe(0)
  })

  test("a failed key resolution writes no log, because the literal key could not be redacted", async () => {
    let writes = 0
    const runtime = createJevRuntime({
      client: client(),
      keys: {
        resolve: async () => {
          throw new Error("keychain")
        },
      },
      telemetry,
      artifacts: { writeLog: async () => (writes++, "/p/x.log") },
      log,
    })
    expect(await runtime.secrets()).toEqual([])
    await expect(runtime.writeLog("s", "c", "text")).rejects.toThrow()
    expect(writes).toBe(0)
  })

  test("no key means an empty list and a log write that proceeds", async () => {
    const runtime = createJevRuntime({ client: client(), keys: { resolve: async () => undefined }, telemetry, artifacts: { writeLog: async () => "/p/x.log" }, log })
    expect(await runtime.secrets()).toEqual([])
    expect(await runtime.writeLog("s", "c", "t")).toBe("/p/x.log")
  })

  test("a hung model list gives up on dispose without leaking", async () => {
    const runtime = createJevRuntime({
      client: client(),
      keys: { resolve: async () => undefined },
      telemetry,
      listModels: () => new Promise(() => undefined),
      log,
    })
    const pending = runtime.modelVariants({ providerID: "p", id: "m" })
    await runtime.dispose()
    expect(await pending).toBeUndefined()
  })

  test("modelVariants finds the model by id or model id", async () => {
    const runtime = createJevRuntime({
      client: client(),
      keys: { resolve: async () => undefined },
      telemetry,
      listModels: async () => [{ id: "p/m", modelID: "m", providerID: "p", variants: [{ id: "low" }, { id: "high" }] }],
      log,
    })
    expect(await runtime.modelVariants({ providerID: "p", id: "m" })).toEqual(["low", "high"])
    expect(await runtime.modelVariants({ providerID: "q", id: "m" })).toBeUndefined()
  })
})
