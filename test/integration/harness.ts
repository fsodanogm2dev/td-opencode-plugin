/**
 * Isolated OpenCode server harness.
 *
 * Starts `opencode serve` with temporary XDG directories, a temporary HOME, and a project directory
 * outside $HOME. The user's real OpenCode configuration and data are never read or written.
 */

import { randomBytes } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** One server-sent event from `GET /api/event`. `data` is the parsed OpenCode event (`type`, `data`, ...). */
export interface ServerEvent {
  readonly type: string
  readonly data: any
  readonly raw: any
}

export interface EventFeed {
  readonly events: ServerEvent[]
  /** Resolves with the first collected event (past or future) that matches `predicate`. */
  waitFor(predicate: (event: ServerEvent) => boolean, timeoutMs?: number, label?: string): Promise<ServerEvent>
  close(): void
}

export interface IsolatedServer {
  readonly url: string
  readonly dirs: {
    root: string
    config: string
    data: string
    state: string
    cache: string
    home: string
    project: string
  }
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>
  /** Subscribes to `GET /api/event` and collects events until `close()` or `stop()`. */
  subscribe(): Promise<EventFeed>
  logs(): string
  stop(): Promise<void>
}

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
}

/**
 * Config entry that loads this repository as a local plugin.
 *
 * OpenCode 2.0.32 accepts only a directory as a local plugin target, and it resolves that directory through
 * `<dir>/server.*` or `<dir>/index.*` only (it ignores package.json `exports`). The repository root has `index.ts`
 * for this reason, so the entry points at the repository itself: tests exercise the real local install path.
 */
export function pluginEntry(options: Record<string, unknown> = {}): { package: string; options: Record<string, unknown> } {
  return { package: repoRoot(), options }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
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
      server.close(() => resolvePort(port))
    })
  })
}

/** Calls `fn` until it returns a value that is not `undefined`; throws on timeout. */
export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function startIsolatedServer(input: {
  config?: Record<string, unknown>
  env?: Record<string, string>
  isolateHome?: boolean
  startupTimeoutMs?: number
} = {}): Promise<IsolatedServer> {
  const root = await mkdtemp(join(tmpdir(), "td-opencode-it-"))
  const dirs = {
    root,
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
    cache: join(root, "cache"),
    home: join(root, "home"),
    project: join(root, "project"),
  }
  await Promise.all(
    [dirs.config, dirs.data, dirs.state, dirs.cache, dirs.home, dirs.project].map((d) => mkdir(d, { recursive: true })),
  )

  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const isolateHome = input.isolateHome ?? true
  const config = { $schema: "https://opencode.ai/config.json", ...input.config }

  // OpenCode generates and prints a random password when none is set. The harness sets its own
  // throwaway password per run and sends it as Basic auth (user name "opencode"). It is never written to disk.
  const password = randomBytes(18).toString("hex")
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    OPENCODE_CONFIG_DIR: join(dirs.config, "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_PASSWORD: password,
    ...(isolateHome ? { HOME: dirs.home } : process.env.HOME ? { HOME: process.env.HOME } : {}),
    // The plugin honors a custom FueliX base URL only with this opt-in. Tests point it at a local mock gateway.
    TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL: "1",
    ...input.env,
  }

  let output = ""
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const child: ChildProcess = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: dirs.project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = (chunk: Buffer) => {
    output += chunk.toString()
    if (output.length > 200_000) output = output.slice(-200_000)
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  child.once("exit", (code, signal) => {
    exited = { code, signal }
  })

  let stopped: Promise<void> | undefined
  const exitHook = () => {
    if (!exited) child.kill("SIGKILL")
  }
  process.once("exit", exitHook)

  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      process.off("exit", exitHook)
      if (!exited) {
        const done = new Promise<void>((r) => child.once("exit", () => r()))
        child.kill("SIGTERM")
        const timer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL")
        }, 5000)
        await done
        clearTimeout(timer)
      }
      if (process.env.KEEP_TMP !== "1") await rm(root, { recursive: true, force: true })
    })()
    return stopped
  }

  const api: IsolatedServer["api"] = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json: unknown = undefined
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = text
      }
    }
    return { status: response.status, json: json as never }
  }

  const deadline = Date.now() + (input.startupTimeoutMs ?? 60_000)
  let ready = false
  while (Date.now() < deadline) {
    if (exited) {
      await stop()
      throw new Error(`opencode exited early (${JSON.stringify(exited)}). Logs:\n${output}`)
    }
    try {
      const response = await fetch(`${url}/api/info`, { headers: { authorization }, signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // not ready yet
    }
    await sleep(200)
  }
  if (!ready) {
    const logs = output
    await stop()
    throw new Error(`opencode did not answer on ${url} in time. Logs:\n${logs}`)
  }

  const feeds: EventFeed[] = []
  const subscribe: IsolatedServer["subscribe"] = async () => {
    const controller = new AbortController()
    const response = await fetch(`${url}/api/event`, {
      headers: { authorization, accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`GET /api/event failed with HTTP ${response.status}`)
    const events: ServerEvent[] = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      let buffer = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index = buffer.indexOf("\n\n")
          while (index >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            index = buffer.indexOf("\n\n")
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (data === "") continue
            try {
              let parsed: any = JSON.parse(data)
              if (typeof parsed === "string") parsed = JSON.parse(parsed)
              events.push({ type: String(parsed?.type ?? ""), data: parsed?.data, raw: parsed })
            } catch {
              // Ignore frames that are not JSON.
            }
          }
        }
      } catch {
        // The feed closed.
      }
    })()
    const feed: EventFeed = {
      events,
      waitFor: async (predicate, timeoutMs = 60_000, label = "event") => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const found = events.find(predicate)
          if (found) return found
          await sleep(100)
        }
        throw new Error(`timed out waiting for ${label}. Seen: ${[...new Set(events.map((e) => e.type))].join(", ")}`)
      },
      close: () => controller.abort(),
    }
    feeds.push(feed)
    return feed
  }
  const stopAll = stop
  const stopWithFeeds = async () => {
    for (const feed of feeds) feed.close()
    await stopAll()
  }

  return { url, dirs, api, subscribe, logs: () => output, stop: stopWithFeeds }
}
