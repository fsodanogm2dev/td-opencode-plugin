import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMemoryLogger } from "../../../src/log.ts"
import type { RunProcess } from "../../../src/telemetry/process.ts"
import { Segments } from "../../../src/telemetry/segments.ts"
import { createFakeTimers } from "./helpers.ts"

interface Call {
  command: string
  args: readonly string[]
  input: any
  timeoutMs: number
  detached: boolean | undefined
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "td-segments-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(runImpl?: RunProcess) {
  const calls: Call[] = []
  const run: RunProcess =
    runImpl ??
    (async (command, args, options) => {
      calls.push({ command, args, input: JSON.parse(options.input ?? "null"), timeoutMs: options.timeoutMs, detached: options.detached })
      return { code: 0, stdout: "", timedOut: false }
    })
  const timers = createFakeTimers()
  const segments = new Segments({
    root: "/td",
    node: "node22",
    idleMinutes: 30,
    log: createMemoryLogger(),
    run,
    defaultDirectory: "/default",
    env: { XDG_DATA_HOME: dir },
    homedir: "/nonexistent-home",
    timers,
  })
  return { segments, calls, timers }
}

const events = (calls: Call[]) => calls.map((call) => call.input.hook_event_name)

describe("segments", () => {
  test("SessionStart once, then UserPromptSubmit per prompt, with exact stdin", async () => {
    const { segments, calls } = setup()
    segments.prompt("ses_a", { directory: "/work/a" })
    segments.prompt("ses_a", { directory: "/work/a" })
    await segments.ready("ses_a")
    expect(events(calls)).toEqual(["SessionStart", "UserPromptSubmit", "UserPromptSubmit"])
    expect(calls[0]).toEqual({
      command: "node22",
      args: ["/td/scripts/hook-record-feature.mjs"],
      input: { session_id: "ses_a", cwd: "/work/a", transcript_path: null, hook_event_name: "SessionStart" },
      timeoutMs: 15000,
      detached: true,
    })
  })

  test("the prompt call does not wait for the child process", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { segments } = setup(async () => {
      await gate
      return { code: 0, stdout: "", timedOut: false }
    })
    const started = Date.now()
    segments.prompt("ses_a", {})
    expect(Date.now() - started).toBeLessThan(50)
    release()
    await segments.ready("ses_a")
  })

  test("activity without a prompt starts the segment once", async () => {
    const { segments, calls } = setup()
    segments.touch("ses_a", {})
    segments.touch("ses_a", {})
    await segments.ready("ses_a")
    expect(events(calls)).toEqual(["SessionStart"])
    expect(calls[0]?.input.cwd).toBe("/default")
  })

  test("idle runs SessionEnd, and the next activity starts a new segment", async () => {
    const { segments, calls, timers } = setup()
    segments.prompt("ses_a", { directory: "/work/a" })
    await segments.ready("ses_a")
    expect(timers.active()).toEqual([30 * 60_000])
    timers.fire(30 * 60_000)
    await Bun.sleep(10)
    expect(events(calls)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"])
    expect(calls[2]?.args).toEqual(["/td/scripts/hook-session-end.mjs"])
    expect(segments.isActive("ses_a")).toBe(false)
    segments.prompt("ses_a", { directory: "/work/a" })
    await segments.ready("ses_a")
    expect(events(calls).slice(3)).toEqual(["SessionStart", "UserPromptSubmit"])
  })

  test("activity resets the idle timer", () => {
    const { segments, timers } = setup()
    segments.touch("ses_a", {})
    segments.touch("ses_a", {})
    expect(timers.active()).toHaveLength(1)
  })

  test("end runs SessionEnd once", async () => {
    const { segments, calls } = setup()
    segments.touch("ses_a", {})
    await segments.end("ses_a")
    await segments.end("ses_a")
    expect(events(calls)).toEqual(["SessionStart", "SessionEnd"])
  })

  test("endAll ends every active segment with a short timeout", async () => {
    const { segments, calls } = setup()
    segments.touch("ses_a", {})
    segments.touch("ses_b", {})
    await segments.endAll(3000)
    expect(calls.filter((call) => call.input.hook_event_name === "SessionEnd").map((call) => [call.input.session_id, call.timeoutMs])).toEqual([
      ["ses_a", 3000],
      ["ses_b", 3000],
    ])
  })

  test("endAll gives up after its budget", async () => {
    const { segments, timers } = setup(() => new Promise(() => {}))
    segments.touch("ses_a", {})
    const done = segments.endAll(50)
    timers.fire(50)
    await done
  })

  test("a failing child process never throws", async () => {
    const { segments } = setup(async () => {
      throw new Error("spawn failed")
    })
    segments.prompt("ses_a", {})
    await segments.ready("ses_a")
    await segments.end("ses_a")
  })

  test("writes the title file with mode 0600 and passes its path", async () => {
    const { segments, calls } = setup()
    segments.prompt("ses_a", { directory: "/work/a", title: "Fix the parser" })
    await segments.ready("ses_a")
    const file = path.join(dir, "td-opencode-plugin", "transcripts", "ses_a.jsonl")
    expect(calls[0]?.input.transcript_path).toBe(file)
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify({ type: "ai-title", aiTitle: "Fix the parser" })}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("rewrites the title file when the title changes", async () => {
    const { segments, calls } = setup()
    segments.touch("ses_a", { title: "First" })
    segments.setTitle("ses_a", "Second")
    await segments.end("ses_a")
    const file = path.join(dir, "td-opencode-plugin", "transcripts", "ses_a.jsonl")
    expect(JSON.parse(readFileSync(file, "utf8")).aiTitle).toBe("Second")
    expect(calls.at(-1)?.input.transcript_path).toBe(file)
  })

  test("a session without a title passes a null transcript path", async () => {
    const { segments, calls } = setup()
    segments.touch("ses_a", {})
    await segments.ready("ses_a")
    expect(calls[0]?.input.transcript_path).toBeNull()
  })

  test("an unsafe session ID gets no title file", async () => {
    const { segments, calls } = setup()
    segments.touch("../evil", { title: "x" })
    await segments.ready("../evil")
    expect(calls[0]?.input.transcript_path).toBeNull()
  })

  test("deletes title files older than 30 days and keeps the rest", async () => {
    const { segments } = setup()
    const transcripts = path.join(dir, "td-opencode-plugin", "transcripts")
    mkdirSync(transcripts, { recursive: true })
    const old = path.join(transcripts, "ses_old.jsonl")
    const fresh = path.join(transcripts, "ses_fresh.jsonl")
    const other = path.join(transcripts, "notes.txt")
    for (const file of [old, fresh, other]) writeFileSync(file, "x")
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000)
    utimesSync(old, days(31), days(31))
    utimesSync(other, days(90), days(90))
    utimesSync(fresh, days(29), days(29))
    expect(await segments.pruneTranscripts()).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  test("pruning a missing directory does nothing", async () => {
    const { segments } = setup()
    expect(await segments.pruneTranscripts()).toBe(0)
  })
})
