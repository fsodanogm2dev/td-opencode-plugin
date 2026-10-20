/**
 * Helpers for the td-telemetry integration test: a scratch td-telemetry (receiver and dashboard on free ports with a
 * scratch store), a mock FueliX chat endpoint, and read-only access to the scratch store.
 *
 * Nothing here touches `~/.td-telemetry` or ports 4418 and 4419.
 */

import { Database } from "bun:sqlite"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { waitFor } from "./harness.ts"
import type { RecordedRequest } from "./fuelix-helpers.ts"

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("could not read a free port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export interface ScratchTelemetry {
  readonly root: string
  readonly home: string
  readonly dataDir: string
  readonly dbFile: string
  readonly receiverPort: number
  readonly dashboardPort: number
  /** The environment that makes a process use this scratch pair. */
  readonly env: Record<string, string>
  logs(): string
  stop(): Promise<void>
}

async function waitForVersion(port: number, label: string, isDead: () => string | undefined): Promise<void> {
  await waitFor(
    async () => {
      const dead = isDead()
      if (dead) throw new Error(dead)
      const response = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(2000) })
      return response.ok ? true : undefined
    },
    30_000,
    `${label} GET /version on port ${port}`,
  )
}

/** Starts `receiver.mjs` and `dashboard-server.mjs` from the td-telemetry checkout `ref`, in a scratch store. */
export async function startScratchTelemetry(ref: string): Promise<ScratchTelemetry> {
  const root = await mkdtemp(join(tmpdir(), "td-telemetry-it-"))
  const home = join(root, "home")
  const dataDir = join(root, "store")
  await mkdir(home, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const receiverPort = await freePort()
  let dashboardPort = await freePort()
  while (dashboardPort === receiverPort) dashboardPort = await freePort()
  if ([4418, 4419].includes(receiverPort) || [4418, 4419].includes(dashboardPort)) {
    throw new Error("refusing to use the default td-telemetry ports")
  }

  // No enrollment file in the scratch store, so nothing is ever pushed.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TD_DATA_DIR: dataDir,
    TD_RECEIVER_PORT: String(receiverPort),
    TD_DASHBOARD_PORT: String(dashboardPort),
    TD_RUNTIME_REPLACE: "never",
  }

  let output = ""
  const children: ChildProcess[] = []
  const exited = new Map<string, string>()
  const start = (name: string, script: string) => {
    const child = spawn("node", [join(ref, "lib", script)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
    const capture = (chunk: Buffer) => {
      output += `[${name}] ${chunk.toString()}`
      if (output.length > 100_000) output = output.slice(-100_000)
    }
    child.stdout?.on("data", capture)
    child.stderr?.on("data", capture)
    child.once("exit", (code, signal) => exited.set(name, `${name} exited early (code ${code}, signal ${signal})`))
    children.push(child)
  }

  let stopped: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve()
              child.once("exit", () => resolve())
              child.kill("SIGTERM")
              setTimeout(() => child.kill("SIGKILL"), 3000).unref()
            }),
        ),
      )
      if (process.env.KEEP_TMP !== "1") await rm(root, { recursive: true, force: true })
    })()
    return stopped
  }

  try {
    start("receiver", "receiver.mjs")
    start("dashboard", "dashboard-server.mjs")
    await waitForVersion(receiverPort, "receiver", () => exited.get("receiver"))
    await waitForVersion(dashboardPort, "dashboard", () => exited.get("dashboard"))
  } catch (error) {
    const logs = output
    await stop()
    throw new Error(`scratch td-telemetry did not start: ${String(error)}\n${logs}`)
  }

  return {
    root,
    home,
    dataDir,
    dbFile: join(dataDir, "data", "events.sqlite"),
    receiverPort,
    dashboardPort,
    env,
    logs: () => output,
    stop,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock FueliX chat completions
// ---------------------------------------------------------------------------------------------------------------------

export const CHAT_USAGE = { prompt_tokens: 12000, completion_tokens: 3, total_tokens: 12003, prompt_tokens_details: { cached_tokens: 0 } }

function chunk(model: string, choices: unknown[], extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model, choices, ...extra })}\n\n`
}

/** A valid OpenAI Chat Completions SSE stream: role, content "OK", stop, usage, `[DONE]`. */
export function chatStream(model: string): string {
  return [
    chunk(model, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunk(model, [{ index: 0, delta: { content: "OK" }, finish_reason: null }]),
    chunk(model, [{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk(model, [], { usage: CHAT_USAGE }),
    "data: [DONE]\n\n",
  ].join("")
}

export function chatCompletionJSON(model: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: CHAT_USAGE,
  }
}

export const TOOL_CALL_ID = "call_td_it_read_1"
export const TOOL_STEP_USAGE = [
  { prompt_tokens: 12000, completion_tokens: 20, total_tokens: 12020, prompt_tokens_details: { cached_tokens: 0 } },
  { prompt_tokens: 12500, completion_tokens: 5, total_tokens: 12505, prompt_tokens_details: { cached_tokens: 0 } },
] as const

function sse(chunks: string[]): Response {
  return new Response([...chunks, "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

/** Streams an OpenAI tool call for OpenCode's `read` tool (input `{ path }`). */
export function toolCallStream(model: string, filePath: string): string[] {
  return [
    chunk(model, [
      {
        index: 0,
        delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: { name: "read", arguments: "" } }] },
        finish_reason: null,
      },
    ]),
    chunk(model, [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: filePath }) } }] }, finish_reason: null }]),
    chunk(model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
    chunk(model, [], { usage: TOOL_STEP_USAGE[0] }),
  ]
}

export function finalTextStream(model: string, text: string): string[] {
  return [
    chunk(model, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunk(model, [{ index: 0, delta: { content: text }, finish_reason: null }]),
    chunk(model, [{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk(model, [], { usage: TOOL_STEP_USAGE[1] }),
  ]
}

/**
 * Handler for `startMockFuelix`. Accepts `/chat/completions` with or without a `/v1` prefix.
 *
 * - `text`: every request streams "OK" with `CHAT_USAGE`.
 * - `tool`: a request that has tools (the agent loop) streams a `read` tool call until the request carries a tool
 *   result, then streams "done". A request without tools (title generation) streams "OK".
 */
export function chatHandler(requests: RecordedRequest[], options: { mode?: "text" | "tool"; filePath?: () => string } = {}) {
  return (request: RecordedRequest): Response | undefined => {
    if (request.method !== "POST" || !request.path.endsWith("/chat/completions")) return undefined
    requests.push(request)
    const model = typeof request.body?.model === "string" ? request.body.model : "gemini-2.5-flash-lite"
    if (options.mode === "tool" && Array.isArray(request.body?.tools) && request.body.tools.length > 0) {
      const hasResult = Array.isArray(request.body?.messages) && request.body.messages.some((message: any) => message?.role === "tool")
      return sse(hasResult ? finalTextStream(model, "done") : toolCallStream(model, options.filePath?.() ?? ""))
    }
    if (request.body?.stream === true) {
      return new Response(chatStream(model), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    }
    return Response.json(chatCompletionJSON(model))
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scratch store (read-only)
// ---------------------------------------------------------------------------------------------------------------------

export interface SegmentRow {
  id: string
  session_id: string
  project_id: string
  project_root: string
  feature_key: string
  feature_label: string
  started_at: number
  ended_at: number | null
  conversation_title: string | null
  turns: number
  kind: string
}

export interface EventRow {
  id: number
  type: string
  session_id: string
  segment_id: string | null
  request_id: string | null
  ts: number
  payload_json: string
  kind: string
}

export class ScratchStore {
  private db: Database | undefined

  constructor(private readonly file: string) {}

  private open(): Database {
    this.db ??= new Database(this.file, { readonly: true })
    return this.db
  }

  /** Runs `fn` and returns `undefined` while the store does not exist yet. */
  private safe<T>(fn: (db: Database) => T): T | undefined {
    try {
      return fn(this.open())
    } catch {
      this.close()
      return undefined
    }
  }

  segments(sessionID?: string): SegmentRow[] {
    return (
      this.safe((db) =>
        (sessionID
          ? db.query("SELECT * FROM segments WHERE session_id = ? ORDER BY started_at").all(sessionID)
          : db.query("SELECT * FROM segments ORDER BY started_at").all()) as SegmentRow[],
      ) ?? []
    )
  }

  events(sessionID?: string): EventRow[] {
    return (
      this.safe((db) =>
        (sessionID
          ? db.query("SELECT * FROM events WHERE session_id = ? ORDER BY id").all(sessionID)
          : db.query("SELECT * FROM events ORDER BY id").all()) as EventRow[],
      ) ?? []
    )
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const row of this.events()) counts[row.type] = (counts[row.type] ?? 0) + 1
    return counts
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // Already closed.
    }
    this.db = undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Git fixture
// ---------------------------------------------------------------------------------------------------------------------

export const TEST_BRANCH = "feat/telemetry-test"

/**
 * Turns `dir` into a git repo on `TEST_BRANCH` with one empty commit. The repo has no remote. The user name and email
 * are set in the repo only, and the global and system git configuration is ignored.
 */
export function initGitRepo(dir: string): void {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
  git("init", "-b", "main")
  git("config", "user.name", "Telemetry Test")
  git("config", "user.email", "telemetry-test@example.invalid")
  git("config", "commit.gpgsign", "false")
  git("commit", "--allow-empty", "-m", "initial commit")
  git("checkout", "-b", TEST_BRANCH)
}
