import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMemoryLogger } from "../../../src/log.ts"
import { parseOptions } from "../../../src/options.ts"
import type { TelemetryOptions } from "../../../src/options.ts"
import { setupTelemetry } from "../../../src/telemetry/index.ts"
import type { TelemetryDeps } from "../../../src/telemetry/index.ts"
import { MIN_TD_TELEMETRY } from "../../../src/telemetry/locate.ts"
import type { RunProcess } from "../../../src/telemetry/process.ts"
import { isPrompt, loadFixture, sleep } from "./helpers.ts"

let dir: string
let root: string
let server: ReturnType<typeof Bun.serve> | undefined
const bodies: string[] = []

/** Creates a td-telemetry installation with the required files and a `package.json` of `version`. */
function installAt(target: string, version: string): string {
  mkdirSync(path.join(target, "scripts"), { recursive: true })
  mkdirSync(path.join(target, "lib"), { recursive: true })
  writeFileSync(path.join(target, "scripts", "hook-record-feature.mjs"), "")
  writeFileSync(path.join(target, "lib", "process-manager.mjs"), "")
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "td-telemetry", version }))
  return target
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "td-index-"))
  root = installAt(path.join(dir, "td"), MIN_TD_TELEMETRY)
  bodies.length = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.text())
      return new Response("{}")
    },
  })
})
afterEach(() => {
  server?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

function options(overrides: Partial<TelemetryOptions> = {}): TelemetryOptions {
  return {
    enabled: true,
    root,
    receiverURL: `http://127.0.0.1:${server?.port}`,
    node: "node22",
    idleMinutes: 30,
    subagentToolNames: ["task", "subagent"],
    ...overrides,
  }
}

/** An async iterable that tests feed by hand. */
function channel() {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let subscriptions = 0
  const iterable = (signal: AbortSignal): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]() {
      subscriptions += 1
      return {
        async next() {
          while (queue.length === 0) {
            if (signal.aborted) return { done: true, value: undefined }
            await new Promise<void>((resolve) => {
              wake = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          }
          return { done: false, value: queue.shift() }
        },
        async return() {
          return { done: true, value: undefined }
        },
      }
    },
  })
  return {
    iterable,
    push(event: unknown) {
      queue.push(event)
      wake?.()
    },
    get subscriptions() {
      return subscriptions
    },
  }
}

function fakeContext(feed: ReturnType<typeof channel>, sessions: Record<string, unknown> = {}) {
  const hooks: Record<string, (input: any) => unknown> = {}
  const looked: string[] = []
  const state = { disposed: 0 }
  const ctx = {
    location: { directory: "/work/proj" },
    event: { subscribe: (opts: { signal: AbortSignal }) => feed.iterable(opts.signal) },
    session: {
      hook: async (name: string, callback: (input: any) => unknown) => {
        hooks[name] = callback
        return {
          dispose: async () => {
            state.disposed += 1
          },
        }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        looked.push(sessionID)
        if (!(sessionID in sessions)) throw new Error("not found")
        return sessions[sessionID]
      },
    },
  }
  return { ctx: ctx as never, hooks, looked, state }
}

interface Spawned {
  command: string
  args: readonly string[]
}

function fakes(nodeVersion = "v22.12.0") {
  const hookCalls: Array<{ args: readonly string[]; input: any }> = []
  const stdinTexts: string[] = []
  const detached: Spawned[] = []
  const run: RunProcess = async (command, args, opts) => {
    if (args[0] === "--version") return { code: 0, stdout: `${nodeVersion}\n`, timedOut: false }
    stdinTexts.push(opts.input ?? "")
    hookCalls.push({ args, input: JSON.parse(opts.input ?? "null") })
    return { code: 0, stdout: "", timedOut: false }
  }
  const deps: TelemetryDeps = {
    run,
    spawnDetached: (command, args) => {
      detached.push({ command, args })
    },
    homedir: path.join(dir, "home"),
    env: { XDG_DATA_HOME: path.join(dir, "data") },
    transport: { backoffMs: [1, 1] },
    resubscribeDelayMs: 5,
    ownerRegistry: new Map<string, number>(),
    processManagerState: { spawned: false, lastSpawnAt: undefined },
  }
  return { deps, hookCalls, stdinTexts, detached }
}

function allRecords(): any[] {
  return bodies.flatMap((body) => JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords)
}

const attr = (record: any, key: string) => {
  const value = record.attributes.find((item: any) => item.key === key)?.value
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue
}

/** Sets telemetry up and waits for the background activation. */
async function boot(ctx: never, opts: TelemetryOptions, log: ReturnType<typeof createMemoryLogger>, deps: TelemetryDeps) {
  const cleanup = await setupTelemetry(ctx, opts, log, deps)
  await cleanup.ready
  return cleanup
}

describe("setupTelemetry", () => {
  test("stays off with one info log when td-telemetry is missing", async () => {
    const log = createMemoryLogger()
    const { deps, detached } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    const cleanup = await boot(ctx, options({ root: undefined }), log, deps)
    expect(detached).toEqual([])
    expect(log.lines.filter((line) => line.includes(" info "))).toHaveLength(1)
    expect(feed.subscriptions).toBe(0)
    await cleanup()
  })

  test("stays off when disabled", async () => {
    const { deps, detached } = fakes()
    const { ctx } = fakeContext(channel())
    await (await boot(ctx, options({ enabled: false }), createMemoryLogger(), deps))()
    expect(detached).toEqual([])
  })

  test("stays off with a warning when Node.js is too old", async () => {
    const log = createMemoryLogger()
    const { deps, detached } = fakes("v20.1.0")
    const feed = channel()
    const { ctx } = fakeContext(feed)
    await (await boot(ctx, options(), log, deps))()
    expect(detached).toEqual([])
    expect(feed.subscriptions).toBe(0)
    expect(log.lines.some((line) => line.includes(" warn ") && line.includes("22.5"))).toBe(true)
  })

  test("starts the runtime pair, sends events, and ends segments on cleanup", async () => {
    const { deps, hookCalls, stdinTexts, detached } = fakes()
    const feed = channel()
    const { ctx, hooks } = fakeContext(feed, {})
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    expect(detached).toEqual([{ command: "node22", args: [path.join(root, "lib", "process-manager.mjs")] }])
    expect(typeof hooks.prompt).toBe("function")

    for (const entry of loadFixture("secret-prompt.json")) {
      if (isPrompt(entry)) {
        // The real hook input carries the prompt text. The hook must return at once.
        const result = hooks.prompt?.({ sessionID: entry.sessionID, messageID: entry.messageID, prompt: entry.prompt, delivery: "immediate" })
        expect(result).toBeUndefined()
      } else {
        feed.push({ id: "evt_1", ...entry })
      }
    }
    await sleep(100)
    await cleanup()

    const records = allRecords()
    expect(records.map((record) => attr(record, "event.name")).sort()).toEqual(
      ["api_request", "skill_activated", "tool_decision", "tool_result", "user_prompt"].sort(),
    )
    expect(records.every((record) => attr(record, "session.id") === "ses_root")).toBe(true)
    expect(hookCalls.map((call) => call.input.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"])
    expect(hookCalls[0]?.input.cwd).toBe("/work/proj")
    expect(hookCalls[0]?.args).toEqual([path.join(root, "scripts", "hook-record-feature.mjs")])
    expect(hookCalls[2]?.args).toEqual([path.join(root, "scripts", "hook-session-end.mjs")])
    expect(bodies.join("\n")).not.toContain("SECRET-PROMPT-TEXT")
    expect(stdinTexts.join("\n")).not.toContain("SECRET-PROMPT-TEXT")
  })

  test("resolves a session from before the plugin through session.get", async () => {
    const { deps, hookCalls } = fakes()
    const feed = channel()
    const { ctx, looked } = fakeContext(feed, {
      ses_old_root: { id: "ses_old_root", location: { directory: "/work/proj" }, title: "Old work" },
      ses_old_child: { id: "ses_old_child", parentID: "ses_old_root", location: { directory: "/work/proj" }, agent: "explorer" },
    })
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({
      id: "evt_1",
      type: "session.step.ended",
      created: 5000,
      data: {
        sessionID: "ses_old_child",
        assistantMessageID: "msg_x",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    await sleep(100)
    await cleanup()
    expect(looked.sort()).toEqual(["ses_old_child", "ses_old_root"])
    const records = allRecords()
    expect(records).toHaveLength(1)
    expect(attr(records[0], "session.id")).toBe("ses_old_root")
    expect(attr(records[0], "query_source")).toBe("agent:builtin:explorer")
    expect(hookCalls[0]?.input).toMatchObject({ session_id: "ses_old_root", cwd: "/work/proj", hook_event_name: "SessionStart" })
  })

  test("a failed lookup treats the session as a root", async () => {
    const { deps } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed, {})
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({
      type: "session.step.ended",
      created: 5000,
      data: { sessionID: "ses_gone", assistantMessageID: "m", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    await sleep(100)
    await cleanup()
    expect(attr(allRecords()[0], "session.id")).toBe("ses_gone")
    expect(attr(allRecords()[0], "query_source")).toBe("repl_main_thread")
  })

  test("session.deleted ends the segment", async () => {
    const { deps, hookCalls } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_d", location: { directory: "/work/proj" } } })
    feed.push({ type: "session.step.started", created: 2, data: { sessionID: "ses_d", assistantMessageID: "m", agent: "build", model: { id: "x", providerID: "p" }, started: 2 } })
    feed.push({ type: "session.deleted", created: 3, data: { sessionID: "ses_d" } })
    await sleep(100)
    expect(hookCalls.map((call) => call.input.hook_event_name)).toEqual(["SessionStart", "SessionEnd"])
    await cleanup()
    expect(hookCalls).toHaveLength(2)
  })

  test("restarts the subscription after an error", async () => {
    const { deps } = fakes()
    let attempts = 0
    const feed = channel()
    const { ctx } = fakeContext(feed)
    ;(ctx as any).event.subscribe = (opts: { signal: AbortSignal }) => {
      attempts += 1
      if (attempts === 1) {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<never> {
                throw new Error("stream broke")
              },
            }
          },
        }
      }
      return feed.iterable(opts.signal)
    }
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    await sleep(80)
    feed.push({ type: "session.skill.activated", created: 9, data: { sessionID: "ses_r", id: "s", name: "x", text: "t" } })
    await sleep(100)
    await cleanup()
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(allRecords().map((record) => attr(record, "event.name"))).toEqual(["skill_activated"])
  })

  test("setup never throws when the context is broken", async () => {
    const { deps } = fakes()
    const log = createMemoryLogger()
    const cleanup = await boot({} as never, options(), log, deps)
    await cleanup()
  })
})

describe("plugin instances and session ownership", () => {
  const stepEnded = (sessionID: string) => ({
    type: "session.step.ended",
    created: 2,
    data: { sessionID, assistantMessageID: "m", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  })

  test("an instance skips a session whose alias location has an exact owner", async () => {
    const real = path.join(dir, "real")
    const alias = path.join(dir, "alias")
    mkdirSync(real)
    symlinkSync(real, alias)
    const { deps, hookCalls } = fakes()
    ;(deps.ownerRegistry as Map<string, number>).set(real, 1)
    const feed = channel()
    const { ctx } = fakeContext(feed)
    ;(ctx as any).location = { directory: alias }
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_alias", location: { directory: real } } })
    feed.push(stepEnded("ses_alias"))
    await sleep(100)
    await cleanup()
    expect(bodies).toEqual([])
    expect(hookCalls).toEqual([])
    // The other instance's entry is untouched and this instance's entry is gone.
    expect([...(deps.ownerRegistry as Map<string, number>)]).toEqual([[real, 1]])
  })

  test("a lone instance reports a session at an alias of its location", async () => {
    const real = path.join(dir, "real")
    const alias = path.join(dir, "alias")
    mkdirSync(real)
    symlinkSync(real, alias)
    const { deps } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    ;(ctx as any).location = { directory: alias }
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_lone", location: { directory: real } } })
    feed.push(stepEnded("ses_lone"))
    await sleep(100)
    await cleanup()
    expect(allRecords()).toHaveLength(1)
  })

  test("an instance whose location equals the session location reports", async () => {
    const real = path.join(dir, "real")
    mkdirSync(real)
    const { deps } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    ;(ctx as any).location = { directory: real }
    const cleanup = await boot(ctx, options(), createMemoryLogger(), deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_same", location: { directory: real } } })
    feed.push(stepEnded("ses_same"))
    await sleep(100)
    await cleanup()
    expect(allRecords()).toHaveLength(1)
  })

  test("a session from another project is skipped, with one debug line", async () => {
    const mine = path.join(dir, "mine")
    const theirs = path.join(dir, "theirs")
    mkdirSync(mine)
    mkdirSync(theirs)
    const log = createMemoryLogger()
    const { deps, hookCalls } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    ;(ctx as any).location = { directory: mine }
    const cleanup = await boot(ctx, options(), log, deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_other", location: { directory: theirs } } })
    feed.push(stepEnded("ses_other"))
    feed.push(stepEnded("ses_other"))
    await sleep(100)
    await cleanup()
    expect(bodies).toEqual([])
    expect(hookCalls).toEqual([])
    expect(log.lines.filter((line) => line.includes(" debug ") && line.includes("without a plugin instance"))).toHaveLength(1)
  })

  test("two instances for the same directory share the registry entry until both stop", async () => {
    const { deps } = fakes()
    const registry = deps.ownerRegistry as Map<string, number>
    const first = fakeContext(channel())
    const second = fakeContext(channel())
    const cleanupOne = await boot(first.ctx, options(), createMemoryLogger(), deps)
    const cleanupTwo = await boot(second.ctx, options(), createMemoryLogger(), deps)
    expect(registry.get("/work/proj")).toBe(2)
    await cleanupOne()
    expect(registry.get("/work/proj")).toBe(1)
    await cleanupTwo()
    expect(registry.size).toBe(0)
  })
})

describe("background activation", () => {
  /** A locate file system that waits until `release()` is called. */
  function gatedLocateFs() {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      release: () => release(),
      fs: {
        readdir: async () => [],
        exists: async () => {
          await gate
          return true
        },
        readFile: async () => JSON.stringify({ version: MIN_TD_TELEMETRY }),
      },
    }
  }

  const prompt = (hooks: Record<string, (input: any) => unknown>, id: number) =>
    hooks.prompt?.({ sessionID: "ses_q", messageID: `msg_${id}`, prompt: { text: "SECRET-PROMPT-TEXT" } })

  test("setup returns before locate finishes, and queued prompts are sent after activation", async () => {
    const gate = gatedLocateFs()
    const { deps, hookCalls } = fakes()
    const feed = channel()
    const { ctx, hooks } = fakeContext(feed)
    const started = Date.now()
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), { ...deps, locateFs: gate.fs })
    expect(Date.now() - started).toBeLessThan(200)
    expect(typeof hooks.prompt).toBe("function")
    expect(prompt(hooks, 1)).toBeUndefined()
    expect(prompt(hooks, 2)).toBeUndefined()
    await sleep(30)
    expect(bodies).toEqual([])
    gate.release()
    await cleanup.ready
    await sleep(100)
    await cleanup()
    const prompts = allRecords().filter((record) => attr(record, "event.name") === "user_prompt")
    expect(prompts.map((record) => attr(record, "prompt.id"))).toEqual(["msg_1", "msg_2"])
    expect(hookCalls.map((call) => call.input.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "UserPromptSubmit", "SessionEnd"])
    expect(bodies.join("")).not.toContain("SECRET-PROMPT-TEXT")
  })

  test("the queue before activation holds 100 prompts", async () => {
    const gate = gatedLocateFs()
    const { deps } = fakes()
    const { ctx, hooks } = fakeContext(channel())
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), { ...deps, locateFs: gate.fs })
    for (let index = 0; index < 130; index++) prompt(hooks, index)
    gate.release()
    await cleanup.ready
    await sleep(150)
    await cleanup()
    const ids = allRecords()
      .filter((record) => attr(record, "event.name") === "user_prompt")
      .map((record) => attr(record, "prompt.id"))
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe("msg_30")
    expect(ids.at(-1)).toBe("msg_129")
  })

  test("an inactive result drops the queue and disposes the hook", async () => {
    const { deps, detached, hookCalls } = fakes("v20.1.0")
    const { ctx, hooks, state } = fakeContext(channel())
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
    prompt(hooks, 1)
    await cleanup.ready
    expect(state.disposed).toBe(1)
    prompt(hooks, 2)
    await sleep(50)
    await cleanup()
    expect(detached).toEqual([])
    expect(hookCalls).toEqual([])
    expect(bodies).toEqual([])
  })

  test("cleanup before activation finishes starts nothing", async () => {
    const gate = gatedLocateFs()
    const { deps, detached } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), { ...deps, locateFs: gate.fs })
    await cleanup()
    gate.release()
    await cleanup.ready
    await sleep(30)
    expect(detached).toEqual([])
    expect(feed.subscriptions).toBe(0)
  })

  test("the process manager starts once per process", async () => {
    const { deps, detached } = fakes()
    const shared = { spawned: false, lastSpawnAt: undefined as number | undefined }
    const first = await boot(fakeContext(channel()).ctx, options(), createMemoryLogger(), { ...deps, processManagerState: shared })
    const second = await boot(fakeContext(channel()).ctx, options(), createMemoryLogger(), { ...deps, processManagerState: shared })
    expect(detached).toHaveLength(1)
    await first()
    await second()
  })

  test("three connection failures start the process manager again, at most once every 10 minutes", async () => {
    const { deps, detached } = fakes()
    let clock = 1_000_000
    const failing = async () => {
      throw new Error("ECONNREFUSED")
    }
    const feed = channel()
    const { ctx } = fakeContext(feed)
    const cleanup = await boot(ctx, options(), createMemoryLogger(), { ...deps, now: () => clock, fetch: failing, transport: { backoffMs: [1, 1], flushIntervalMs: 20 } })
    expect(detached).toHaveLength(1)
    const step = (n: number) => ({
      type: "session.skill.activated",
      created: clock,
      data: { sessionID: "ses_u", id: `s${n}`, name: "x", text: "t" },
    })
    // Within 10 minutes of the first start: no second start.
    feed.push(step(1))
    await sleep(150)
    expect(detached).toHaveLength(1)
    // After 10 minutes: one more start.
    clock += 11 * 60_000
    feed.push(step(2))
    await sleep(150)
    expect(detached).toHaveLength(2)
    // The restart counts as a start: no third start at once.
    feed.push(step(3))
    await sleep(150)
    expect(detached).toHaveLength(2)
    await cleanup()
  })

  test("the session lookup timer is cleared", async () => {
    const live = new Map<unknown, number>()
    const timers = {
      setTimeout(callback: () => void, ms: number) {
        const handle = setTimeout(() => {
          live.delete(handle)
          callback()
        }, ms)
        live.set(handle, ms)
        return handle
      },
      clearTimeout(handle: unknown) {
        live.delete(handle)
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
    }
    const { deps } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed, { ses_known: { id: "ses_known", location: { directory: "/work/proj" } } })
    const cleanup = await boot(ctx, options(), createMemoryLogger(), { ...deps, timers, transport: { backoffMs: [1, 1], flushIntervalMs: 20 } })
    feed.push({ type: "session.skill.activated", created: 1, data: { sessionID: "ses_known", id: "s", name: "x", text: "t" } })
    feed.push({ type: "session.skill.activated", created: 2, data: { sessionID: "ses_missing", id: "s", name: "x", text: "t" } })
    await sleep(100)
    expect([...live.values()].filter((ms) => ms === 2000)).toEqual([])
    await cleanup()
  })
})

describe("td-telemetry version gate", () => {
  const versionWarnings = (log: ReturnType<typeof createMemoryLogger>) =>
    log.lines.filter((line) => line.includes(" warn ") && line.includes(`td-telemetry ${MIN_TD_TELEMETRY} or later is required`))

  /** Call after `ready` and before cleanup: nothing started, and the prompt hook was disposed. */
  function expectOff(fake: ReturnType<typeof fakes>, feed: ReturnType<typeof channel>, state: { disposed: number }) {
    expect(fake.detached).toEqual([])
    expect(fake.hookCalls).toEqual([])
    expect(feed.subscriptions).toBe(0)
    expect(state.disposed).toBe(1)
    expect(bodies).toEqual([])
  }

  test("a configured root older than the minimum keeps telemetry off with one warning", async () => {
    installAt(root, "0.25.2")
    const log = createMemoryLogger()
    const fake = fakes()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const cleanup = await boot(ctx, options(), log, fake.deps)
    expectOff(fake, feed, state)
    const lines = versionWarnings(log)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('version="0.25.2"')
    expect(lines[0]).toContain(`root=${JSON.stringify(root)}`)
    await cleanup()
  })

  test("a root without a readable package.json keeps telemetry off with version unknown", async () => {
    rmSync(path.join(root, "package.json"))
    const log = createMemoryLogger()
    const fake = fakes()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const cleanup = await boot(ctx, options(), log, fake.deps)
    expectOff(fake, feed, state)
    const lines = versionWarnings(log)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('version="unknown"')
    expect(lines[0]).toContain(`root=${JSON.stringify(root)}`)
    await cleanup()
  })

  test("a file system error during the check keeps telemetry off with version unknown", async () => {
    const locateFs = {
      readdir: async () => [],
      exists: async () => true,
      readFile: async (): Promise<string> => {
        throw new Error("EIO")
      },
    }
    const log = createMemoryLogger()
    const fake = fakes()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const cleanup = await boot(ctx, options(), log, { ...fake.deps, locateFs })
    expectOff(fake, feed, state)
    expect(versionWarnings(log)).toHaveLength(1)
    expect(versionWarnings(log)[0]).toContain('version="unknown"')
    expect(log.lines.some((line) => line.includes("setup failed"))).toBe(false)
    await cleanup()
  })

  test("TD_TELEMETRY_ROOT gets the same check", async () => {
    installAt(root, "0.22.5")
    const parsed = parseOptions({ telemetry: { receiverURL: `http://127.0.0.1:${server?.port}`, node: "node22" } }, { TD_TELEMETRY_ROOT: root })
    expect(parsed.telemetry.root).toBe(root)
    const log = createMemoryLogger()
    const fake = fakes()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const cleanup = await boot(ctx, parsed.telemetry, log, fake.deps)
    expectOff(fake, feed, state)
    expect(versionWarnings(log)).toHaveLength(1)
    expect(versionWarnings(log)[0]).toContain('version="0.22.5"')
    expect(versionWarnings(log)[0]).toContain(`root=${JSON.stringify(root)}`)
    await cleanup()
  })

  test("the newest copy in the Claude Code plugin cache gets the same check", async () => {
    const fake = fakes()
    const cache = path.join(fake.deps.homedir as string, ".claude", "plugins", "cache", "mk", "td-telemetry")
    installAt(path.join(cache, "0.24.1"), "0.24.1")
    const newest = installAt(path.join(cache, "0.25.2"), "0.25.2")
    const log = createMemoryLogger()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const cleanup = await boot(ctx, options({ root: undefined }), log, fake.deps)
    expectOff(fake, feed, state)
    expect(versionWarnings(log)).toHaveLength(1)
    expect(versionWarnings(log)[0]).toContain('version="0.25.2"')
    expect(versionWarnings(log)[0]).toContain(`root=${JSON.stringify(newest)}`)
    await cleanup()
  })

  test("a cache copy at or above the minimum turns telemetry on", async () => {
    const fake = fakes()
    const cache = path.join(fake.deps.homedir as string, ".claude", "plugins", "cache", "mk", "td-telemetry")
    installAt(path.join(cache, "0.25.2"), "0.25.2")
    const newest = installAt(path.join(cache, "0.27.13"), "0.27.13")
    const log = createMemoryLogger()
    const { ctx } = fakeContext(channel())
    const cleanup = await boot(ctx, options({ root: undefined }), log, fake.deps)
    expect(fake.detached).toEqual([{ command: "node22", args: [path.join(newest, "lib", "process-manager.mjs")] }])
    expect(versionWarnings(log)).toEqual([])
    expect(log.lines.some((line) => line.includes("telemetry is on") && line.includes('version="0.27.13"'))).toBe(true)
    await cleanup()
  })

  test("setup returns before the version check finishes", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const locateFs = {
      readdir: async () => [],
      exists: async () => true,
      readFile: async () => {
        await gate
        return JSON.stringify({ version: "0.25.2" })
      },
    }
    const log = createMemoryLogger()
    const fake = fakes()
    const feed = channel()
    const { ctx, state } = fakeContext(feed)
    const started = Date.now()
    const cleanup = await setupTelemetry(ctx, options(), log, { ...fake.deps, locateFs })
    expect(Date.now() - started).toBeLessThan(200)
    await sleep(30)
    expect(versionWarnings(log)).toEqual([])
    release()
    await cleanup.ready
    expectOff(fake, feed, state)
    expect(versionWarnings(log)).toHaveLength(1)
    await cleanup()
  })
})
