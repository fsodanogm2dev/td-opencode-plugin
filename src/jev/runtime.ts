/**
 * What the decision points need from the Jev module, and the helpers that they share.
 *
 * `JevPointRuntime` is a structural interface. Points depend on it and never on the client, the key provider, or the
 * files directly, so tests replace it with a small fake. `createJevRuntime` builds the real one.
 *
 * Lifecycle: `dispose()` aborts every request and background task, and later calls do nothing. A point checks
 * `runtime.disposed` before it acts.
 */

import { createHash } from "node:crypto"
import type { Logger } from "../log.ts"
import type { JevArtifacts } from "./artifacts.ts"
import type { JevTelemetry, JevTelemetryEvent } from "./telemetry.ts"
import type { JevClient, JevFailure, JevKeyProvider, JevOutcome, JevQuestions, JsonValue } from "./types.ts"

export interface JevDecideRequest {
  readonly state: JsonValue
  readonly questions: JevQuestions
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface ModelRef {
  readonly providerID: string
  readonly id: string
}

export interface JevPointRuntime {
  readonly log: Logger
  readonly now: () => number
  /** True after `dispose`. */
  readonly disposed: boolean
  /** Asks TypeSafe. Never throws or rejects. A failure is a value. Aborts when the runtime is disposed. */
  decide(request: JevDecideRequest): Promise<JevOutcome>
  /** The active TypeSafe key, for literal redaction. Empty when there is no key, no answer within the provider budget, or after dispose. Never throws. */
  secrets(): Promise<readonly string[]>
  /** Queues one telemetry row. Never throws. */
  record(event: JevTelemetryEvent): void
  /** Writes a redacted private log and returns its path. Rejects when the write fails or no store exists. */
  writeLog(sessionID: string, callID: string, content: string): Promise<string>
  /** Variant IDs of a model, or `undefined` when unknown. Never throws. */
  modelVariants(model: ModelRef, signal?: AbortSignal): Promise<readonly string[] | undefined>
  /** Background tasks that dispose cancels. */
  readonly tasks: TaskTracker
}

// -- Helpers -----------------------------------------------------------------------------------------------------

/** Insertion-ordered map with a size limit. `get` and `set` mark an entry as the newest. */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(
    private readonly max: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.entries().next().value as [K, V]
      this.map.delete(oldest[0])
      this.onEvict?.(oldest[0], oldest[1])
    }
  }

  delete(key: K): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

export interface TaskTracker {
  /**
   * Starts a cancellable background task. Returns `false` and runs nothing when the tracker is disposed or has
   * `limit` tasks running. A throw or rejection of the task is swallowed.
   */
  start(task: (signal: AbortSignal) => Promise<void>): boolean
  readonly size: number
  /** Aborts every running task and refuses new ones. */
  dispose(): void
}

export function createTaskTracker(limit: number): TaskTracker {
  const running = new Set<AbortController>()
  let disposed = false
  return {
    start(task) {
      if (disposed || running.size >= limit) return false
      const controller = new AbortController()
      running.add(controller)
      let promise: Promise<void>
      try {
        promise = task(controller.signal)
      } catch {
        running.delete(controller)
        return true
      }
      void promise.catch(() => undefined).finally(() => running.delete(controller))
      return true
    },
    get size() {
      return running.size
    },
    dispose() {
      disposed = true
      for (const controller of running) controller.abort()
      running.clear()
    },
  }
}

/** The text of the latest user message and a key that names it. `undefined` when it has no text. */
export function latestUserRequest(messages: unknown): { readonly key: string; readonly text: string } | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { id?: unknown; role?: unknown; content?: unknown } | null
    if (!message || message.role !== "user") continue
    const content = message.content
    const parts: unknown[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []
    const text = parts
      .map((part) => {
        const candidate = part as { type?: unknown; text?: unknown } | null
        return candidate?.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
      })
      .filter((value) => value !== "")
      .join("\n")
    if (text.trim() === "") return undefined
    const key = typeof message.id === "string" && message.id !== "" ? `id:${message.id}` : `fp:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`
    return { key, text }
  }
  return undefined
}

/** Telemetry fields of a failed call. */
export function failureFields(error: JevFailure): { readonly errorCode: JevFailure["code"]; readonly status?: number } {
  return error.status === undefined ? { errorCode: error.code } : { errorCode: error.code, status: error.status }
}

// -- Real runtime ------------------------------------------------------------------------------------------------

export interface ModelListEntry {
  readonly id: string
  readonly modelID?: string
  readonly providerID: string
  readonly variants: ReadonlyArray<{ readonly id: string }>
}

export interface JevRuntimeInput {
  readonly client: JevClient
  readonly keys: JevKeyProvider
  readonly telemetry: JevTelemetry
  /** Absent when the private store is unavailable. `writeLog` then rejects. */
  readonly artifacts?: Pick<JevArtifacts, "writeLog">
  readonly listModels?: () => Promise<readonly ModelListEntry[]>
  readonly log: Logger
  readonly now?: () => number
  /** Limit of background tasks that run at once. Default 8. */
  readonly maxTasks?: number
}

const MODEL_LIST_TIMEOUT_MS = 2000
/** Longest wait for a key resolution. The Keychain lookup alone has a 3 s limit. */
export const SECRETS_TIMEOUT_MS = 4000

/**
 * Runs `start` and rejects at the deadline or when `signal` aborts, whichever comes first. The timer and the abort
 * listener are removed when the race settles, not when `start` settles, so a hung promise holds nothing. With a
 * signal that is already aborted, `start` does not run. A late result of `start` is dropped.
 */
export function withDeadline<T>(start: () => Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"))
  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      settle()
    }
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), ms)
    const onAbort = (): void => finish(() => reject(new Error("aborted")))
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      start().then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

export interface JevRuntime extends JevPointRuntime {
  /** Aborts everything, disposes the client, and flushes telemetry. Safe to call twice. */
  dispose(): Promise<void>
}

export function createJevRuntime(input: JevRuntimeInput): JevRuntime {
  const lifecycle = new AbortController()
  const tasks = createTaskTracker(input.maxTasks ?? 8)
  const now = input.now ?? Date.now
  let disposed = false
  /** `undefined` when the key could not be resolved in time or the runtime was disposed. No key gives `[]`. */
  const resolveSecrets = async (): Promise<readonly string[] | undefined> => {
    if (disposed) return undefined
    try {
      const key = await withDeadline(() => input.keys.resolve(), SECRETS_TIMEOUT_MS, lifecycle.signal)
      return disposed ? undefined : key ? [key.key] : []
    } catch {
      return undefined
    }
  }
  const secrets = async (): Promise<readonly string[]> => (await resolveSecrets()) ?? []

  return {
    log: input.log,
    now,
    get disposed() {
      return disposed
    },
    tasks,
    async decide(request) {
      try {
        if (disposed) return { ok: false, error: { code: "disposed" } }
        const signals = [lifecycle.signal, ...(request.signal ? [request.signal] : [])]
        const signal = signals.length === 1 ? lifecycle.signal : AbortSignal.any(signals)
        return await input.client.decide({ state: request.state, questions: request.questions, timeoutMs: request.timeoutMs, signal })
      } catch {
        return { ok: false, error: { code: "network" } }
      }
    },
    secrets,
    record(event) {
      if (disposed) return
      try {
        input.telemetry.record(event)
      } catch {
        // Telemetry never throws into a point.
      }
    },
    async writeLog(sessionID, callID, content) {
      const artifacts = input.artifacts
      if (!artifacts || disposed) throw new Error("no private store")
      // Without the literal key, an opaque key could reach the file. A failed resolution therefore writes nothing.
      const resolved = await resolveSecrets()
      if (resolved === undefined || disposed) throw new Error("secrets unavailable")
      return artifacts.writeLog(sessionID, callID, content, { secrets: resolved })
    },
    async modelVariants(model, signal) {
      const listModels = input.listModels
      if (!listModels) return undefined
      try {
        const signals = signal ? [lifecycle.signal, signal] : [lifecycle.signal]
        const models = await withDeadline(() => listModels(), MODEL_LIST_TIMEOUT_MS, signals.length === 1 ? lifecycle.signal : AbortSignal.any(signals))
        const found = models.find((entry) => entry.providerID === model.providerID && (entry.modelID === model.id || entry.id === model.id))
        return found ? found.variants.map((variant) => variant.id) : undefined
      } catch {
        return undefined
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      tasks.dispose()
      lifecycle.abort()
      try {
        input.client.dispose()
      } catch {
        // Nothing to do.
      }
      try {
        await input.telemetry.dispose()
      } catch {
        // Nothing to do.
      }
    },
  }
}
