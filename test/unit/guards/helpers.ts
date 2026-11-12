import type { Plugin } from "@opencode/plugin"
import { createMemoryLogger } from "../../../src/log.ts"
import type { Activation, Guard, GuardStore, Rule } from "../../../src/guards/schema.ts"
import { guardPaths, type FileSignature, type GuardFs } from "../../../src/guards/store.ts"

export const HOME = "/fake/home"
export const PATHS = guardPaths(HOME)

export interface MemoryFs extends GuardFs {
  readonly files: Map<string, string>
  readonly appended: string[]
  failures: { stat?: boolean; read?: boolean; append?: boolean; write?: boolean; readTail?: boolean; statPaths?: string[] }
  /** Writes a file and bumps its signature, as the service does. */
  put(path: string, data: string): void
  remove(path: string): void
}

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>()
  const signatures = new Map<string, FileSignature>()
  const appended: string[] = []
  let counter = 1
  const fs: MemoryFs = {
    files,
    appended,
    failures: {},
    put(path, data) {
      files.set(path, data)
      signatures.set(path, { mtimeMs: counter++, size: data.length, ino: counter })
    },
    remove(path) {
      files.delete(path)
      signatures.delete(path)
    },
    async stat(path) {
      if (fs.failures.stat && (!fs.failures.statPaths || fs.failures.statPaths.includes(path))) throw new Error("stat failed")
      return signatures.get(path) ?? null
    },
    async readFile(path) {
      if (fs.failures.read) throw new Error("read failed")
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return data
    },
    async readTail(path, maxBytes) {
      if (fs.failures.readTail) throw new Error("tail failed")
      const data = files.get(path)
      if (data === undefined) return null
      const bytes = Buffer.from(data, "utf8")
      if (bytes.length <= maxBytes) return { text: data, truncated: false }
      return { text: bytes.subarray(bytes.length - maxBytes).toString("utf8"), truncated: true }
    },
    async appendFile(path, data) {
      if (fs.failures.append) throw new Error("append failed")
      appended.push(data)
      fs.put(path, (files.get(path) ?? "") + data)
    },
    async writeFileAtomic(path, data) {
      if (fs.failures.write) throw new Error("write failed")
      fs.put(path, data)
    },
  }
  return fs
}

export const T0 = "2026-11-12T10:00:00.000Z"

export function guard(id: string, rules: Rule[], message = `blocked by ${id}`): Guard {
  return { id, label: id, summary: "s", request: "r", message, rules, createdAt: T0, updatedAt: T0 }
}

export function activation(id: string, guardId: string, sessionId: string, extra: Partial<Activation> = {}): Activation {
  return { id, guardId, sessionId, scope: "session", createdAt: T0, expiresAt: null, ...extra }
}

export function storeOf(guards: Guard[], activations: Activation[], revision = 1): GuardStore {
  return { schema: "td-guards/1", revision, guards, activations }
}

export const commitRule: Rule = { kind: "command", program: "git", subcommands: [["commit"]] }

export interface GuardCtxOptions {
  /** Parent by session ID. `null` is a root. A missing ID makes `session.get` reject. */
  readonly sessions?: Record<string, string | null>
  readonly failHook?: boolean
  readonly directory?: string
  readonly noEvents?: boolean
}

export function createGuardCtx(options: GuardCtxOptions = {}) {
  const sessions = { ...(options.sessions ?? {}) }
  const hooks: ((event: any) => Promise<void> | void)[] = []
  const queue: any[] = []
  let wake: (() => void) | undefined
  let streamError: Error | undefined
  let ended = false
  let subscribes = 0
  const lookups: string[] = []
  const state = { disposed: 0 }

  const ctx = {
    location: { directory: options.directory ?? "/fake/project" },
    session: {
      get: async (input: { sessionID: string }) => {
        lookups.push(input.sessionID)
        if (!(input.sessionID in sessions)) throw new Error("not found")
        const parent = sessions[input.sessionID]
        return parent ? { id: input.sessionID, parentID: parent } : { id: input.sessionID }
      },
    },
    permission: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        if (options.failHook) throw new Error("hook unavailable")
        if (name === "evaluate") hooks.push(callback)
        return { dispose: async () => void state.disposed++ }
      },
    },
    event: options.noEvents
      ? undefined
      : {
          subscribe: (opts?: { signal?: AbortSignal }) => ({
            async *[Symbol.asyncIterator]() {
              subscribes++
              ended = false
              streamError = undefined
              opts?.signal?.addEventListener("abort", () => wake?.(), { once: true })
              while (true) {
                if (opts?.signal?.aborted) return
                if (streamError) throw streamError
                if (ended) return
                const next = queue.shift()
                if (next) {
                  yield next
                  continue
                }
                await new Promise<void>((resolve) => (wake = resolve))
              }
            },
          }),
        },
  }

  const poke = () => wake?.()
  return {
    ctx: ctx as unknown as Plugin.Context,
    sessions,
    lookups,
    state,
    subscribes: () => subscribes,
    /** Runs the registered evaluate hooks as OpenCode does and returns the mutated event. */
    evaluate: async (input: { sessionID: string; action: string; resources: string[]; effect?: string; metadata?: Record<string, unknown> }) => {
      const event: any = { agent: "build", effect: "allow", ...input }
      for (const hook of hooks) await hook(event)
      return event as { effect: string; message?: string }
    },
    hookCount: () => hooks.length,
    emit: (event: { type: string; created?: number; data: Record<string, unknown> }) => {
      queue.push(event)
      poke()
    },
    breakStream: (error = new Error("stream broke")) => {
      streamError = error
      poke()
    },
    endStream: () => {
      ended = true
      poke()
    },
  }
}

export function logger() {
  return createMemoryLogger()
}

export async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("until timed out")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 3))
}
