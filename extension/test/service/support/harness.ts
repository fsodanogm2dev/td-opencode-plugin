import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, type App, type AppResponse } from "../../../service/app.ts"
import { backendSchema } from "../../../service/backend-port.ts"
import { nodeFs, type ProcessPort, type Runtime } from "../../../service/ports.ts"
import { ApiError } from "../../../service/contract.ts"
import type { SessionBridge, SessionInfo } from "../../../service/session.ts"

export const TOKEN = "test-token-not-a-real-secret"
export const START = Date.parse("2026-11-12T10:00:00.000Z")

export interface Clock {
  now(): number
  advance(ms: number): void
}

export function makeClock(start = START): Clock {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

export class FakeProcesses implements ProcessPort {
  readonly alive = new Set<number>()
  readonly tokens = new Map<number, string>()
  constructor(readonly pid: number) {
    this.alive.add(pid)
    this.tokens.set(pid, `start-${pid}`)
  }
  isAlive(pid: number): boolean {
    return this.alive.has(pid)
  }
  startToken(pid: number): string | null {
    return this.tokens.get(pid) ?? null
  }
}

export interface Env {
  readonly root: string
  readonly clock: Clock
  readonly procs: FakeProcesses
  runtime(overrides?: Partial<Runtime>): Runtime
  cleanup(): void
}

let counter = 0

export function makeEnv(pid = 4242): Env {
  const root = mkdtempSync(join(tmpdir(), "td-guards-service-"))
  const clock = makeClock()
  const procs = new FakeProcesses(pid)
  return {
    root,
    clock,
    procs,
    runtime: (overrides = {}) => ({
      fs: nodeFs,
      proc: procs,
      now: clock.now,
      // Time only moves when the test moves it, except for sleeps, which advance it.
      sleep: async (ms) => {
        clock.advance(ms)
      },
      uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
      token: () => `tok${String(++counter).padStart(8, "0")}`,
      ...overrides,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export class FakeBridge implements SessionBridge {
  readonly sessions = new Map<string, SessionInfo>()
  failWith: ApiError | null = null
  calls: string[] = []
  add(id: string, parentId: string | null = null, directory: string | null = "/work/project"): this {
    this.sessions.set(id, { id, parentId, directory })
    return this
  }
  async get(id: string): Promise<SessionInfo | null> {
    this.calls.push(id)
    if (this.failWith) throw this.failWith
    return this.sessions.get(id) ?? null
  }
}

export function makeApp(env: Env, options: { bridge?: SessionBridge | null; runtime?: Runtime; lockTimeoutMs?: number } = {}): App {
  return createApp({
    runtime: options.runtime ?? env.runtime(),
    schema: backendSchema,
    root: env.root,
    token: TOKEN,
    bridge: options.bridge === undefined ? new FakeBridge() : options.bridge,
    lockTimeoutMs: options.lockTimeoutMs,
  })
}

export const goodDraft = {
  label: "No git commits",
  summary: "Blocks git commit commands.",
  request: "Never commit for me.",
  message: "Commits are blocked by a TD-Plugin guard.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
}

let opCounter = 0
export function opId(): string {
  return `op-test-${String(++opCounter).padStart(6, "0")}`
}

export async function call(
  app: App,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string | undefined> = { authorization: `Bearer ${TOKEN}` },
): Promise<AppResponse & { body: any }> {
  const response = await app.handle({
    method,
    url,
    headers,
    body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
  })
  return response as AppResponse & { body: any }
}

export async function createGuard(app: App, draft: unknown = goodDraft, extra: Record<string, unknown> = {}) {
  return call(app, "POST", "/guards", { opId: opId(), draft, ...extra })
}

export async function enable(
  app: App,
  guardId: string,
  sessionId: string,
  scope: "session" | "request" = "session",
  extra: Record<string, unknown> = {},
) {
  return call(app, "POST", "/activations", { opId: opId(), guardId, sessionId, scope, ...extra })
}
