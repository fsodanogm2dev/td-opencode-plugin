import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMemoryLogger } from "../../../src/log.ts"
import type { TelemetryOptions } from "../../../src/options.ts"
import { setupTelemetry } from "../../../src/telemetry/index.ts"
import type { TelemetryDeps } from "../../../src/telemetry/index.ts"
import type { RunProcess } from "../../../src/telemetry/process.ts"
import { isPrompt, loadFixture, sleep } from "./helpers.ts"

let dir: string
let root: string
let server: ReturnType<typeof Bun.serve> | undefined
const bodies: string[] = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "td-index-"))
  root = path.join(dir, "td")
  mkdirSync(path.join(root, "scripts"), { recursive: true })
  mkdirSync(path.join(root, "lib"), { recursive: true })
  writeFileSync(path.join(root, "scripts", "hook-record-feature.mjs"), "")
  writeFileSync(path.join(root, "lib", "process-manager.mjs"), "")
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
  const ctx = {
    location: { directory: "/work/proj" },
    event: { subscribe: (opts: { signal: AbortSignal }) => feed.iterable(opts.signal) },
    session: {
      hook: async (name: string, callback: (input: any) => unknown) => {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        looked.push(sessionID)
        if (!(sessionID in sessions)) throw new Error("not found")
        return sessions[sessionID]
      },
    },
  }
  return { ctx: ctx as never, hooks, looked }
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

describe("setupTelemetry", () => {
  test("stays off with one info log when td-telemetry is missing", async () => {
    const log = createMemoryLogger()
    const { deps, detached } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed)
    const cleanup = await setupTelemetry(ctx, options({ root: undefined }), log, deps)
    expect(detached).toEqual([])
    expect(log.lines.filter((line) => line.includes(" info "))).toHaveLength(1)
    expect(feed.subscriptions).toBe(0)
    await cleanup()
  })

  test("stays off when disabled", async () => {
    const { deps, detached } = fakes()
    const { ctx } = fakeContext(channel())
    await (await setupTelemetry(ctx, options({ enabled: false }), createMemoryLogger(), deps))()
    expect(detached).toEqual([])
  })

  test("stays off with a warning when Node.js is too old", async () => {
    const log = createMemoryLogger()
    const { deps, detached } = fakes("v20.1.0")
    const feed = channel()
    const { ctx } = fakeContext(feed)
    await (await setupTelemetry(ctx, options(), log, deps))()
    expect(detached).toEqual([])
    expect(feed.subscriptions).toBe(0)
    expect(log.lines.some((line) => line.includes(" warn ") && line.includes("22.5"))).toBe(true)
  })

  test("starts the runtime pair, sends events, and ends segments on cleanup", async () => {
    const { deps, hookCalls, stdinTexts, detached } = fakes()
    const feed = channel()
    const { ctx, hooks } = fakeContext(feed, {})
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
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
      ses_old_root: { id: "ses_old_root", location: { directory: "/old/root" }, title: "Old work" },
      ses_old_child: { id: "ses_old_child", parentID: "ses_old_root", location: { directory: "/old/root" }, agent: "explorer" },
    })
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
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
    expect(hookCalls[0]?.input).toMatchObject({ session_id: "ses_old_root", cwd: "/old/root", hook_event_name: "SessionStart" })
  })

  test("a failed lookup treats the session as a root", async () => {
    const { deps } = fakes()
    const feed = channel()
    const { ctx } = fakeContext(feed, {})
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
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
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
    feed.push({ type: "session.created", created: 1, data: { sessionID: "ses_d", location: { directory: "/d" } } })
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
    const cleanup = await setupTelemetry(ctx, options(), createMemoryLogger(), deps)
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
    const cleanup = await setupTelemetry({} as never, options(), log, deps)
    await cleanup()
  })
})
