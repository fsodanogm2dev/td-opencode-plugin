import type { Logger } from "../log.ts"
import { buildOtlpPayload } from "./otlp.ts"
import type { TelemetryRecord } from "./types.ts"
import { errorMessage } from "./types.ts"

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export interface TransportOptions {
  readonly receiverURL: string
  readonly log: Logger
  readonly serviceVersion: string
  readonly fetch?: FetchLike
  readonly now?: () => number
  readonly timers?: Timers
  /** Resolves when the session's segment exists. Records of a session wait for it (bounded). */
  readonly ready?: (sessionID: string) => Promise<void>
  readonly maxQueue?: number
  readonly flushAt?: number
  readonly flushIntervalMs?: number
  readonly maxBatch?: number
  readonly timeoutMs?: number
  readonly retries?: number
  readonly backoffMs?: readonly number[]
  readonly readyWaitMs?: number
}

export class Transport {
  private queue: TelemetryRecord[] = []
  private timer: unknown
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  private inflight: AbortController | undefined
  private droppedTotal = 0
  private sentTotal = 0
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private readonly timers: Timers
  private readonly maxQueue: number
  private readonly flushAt: number
  private readonly flushIntervalMs: number
  private readonly maxBatch: number
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly backoffMs: readonly number[]
  private readonly readyWaitMs: number

  constructor(private readonly options: TransportOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? realTimers
    this.maxQueue = options.maxQueue ?? 1000
    this.flushAt = options.flushAt ?? 25
    this.flushIntervalMs = options.flushIntervalMs ?? 2000
    this.maxBatch = options.maxBatch ?? 100
    this.timeoutMs = options.timeoutMs ?? 2000
    this.retries = options.retries ?? 2
    this.backoffMs = options.backoffMs ?? [250, 1000]
    this.readyWaitMs = options.readyWaitMs ?? 5000
  }

  get dropped(): number {
    return this.droppedTotal
  }

  get sent(): number {
    return this.sentTotal
  }

  get pending(): number {
    return this.queue.length
  }

  enqueue(records: readonly TelemetryRecord[]): void {
    if (this.closing || records.length === 0) return
    for (const record of records) {
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift()
        this.droppedTotal += 1
        if (this.droppedTotal === 1 || this.droppedTotal % 100 === 0) {
          this.options.log.debug("telemetry queue is full; dropped oldest records", { dropped: this.droppedTotal })
        }
      }
      this.queue.push(record)
    }
    if (this.queue.length >= this.flushAt) {
      void this.flush()
    } else if (this.timer === undefined) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.flushIntervalMs)
    }
  }

  /** Sends all queued records. Resolves when the queue is empty or dropped. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.chain = this.chain.then(() => this.drain()).catch(() => {})
    return this.chain
  }

  /** Flushes and stops. Stops waiting after `budgetMs`. */
  async close(budgetMs: number): Promise<void> {
    const flushed = this.flush()
    let handle: unknown
    const budget = new Promise<void>((resolve) => {
      handle = this.timers.setTimeout(resolve, budgetMs)
    })
    await Promise.race([flushed, budget])
    this.timers.clearTimeout(handle)
    this.closing = true
    this.inflight?.abort()
    this.queue = []
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closing) {
      const batch = this.queue.splice(0, this.maxBatch)
      await this.waitReady(batch)
      await this.send(batch)
    }
  }

  private async waitReady(batch: readonly TelemetryRecord[]): Promise<void> {
    const ready = this.options.ready
    if (!ready) return
    const sessions = [...new Set(batch.map((record) => record.sessionID))]
    let handle: unknown
    const limit = new Promise<void>((resolve) => {
      handle = this.timers.setTimeout(resolve, this.readyWaitMs)
    })
    try {
      await Promise.race([Promise.all(sessions.map((id) => ready(id).catch(() => {}))), limit])
    } finally {
      this.timers.clearTimeout(handle)
    }
  }

  private async send(batch: readonly TelemetryRecord[]): Promise<void> {
    const body = JSON.stringify(
      buildOtlpPayload(batch, { serviceVersion: this.options.serviceVersion, observedMs: this.now() }),
    )
    const url = `${this.options.receiverURL}/v1/logs`
    let lastError = "unknown error"
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this.closing) break
      if (attempt > 0) await this.sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0)
      if (this.closing) break
      const controller = new AbortController()
      this.inflight = controller
      const handle = this.timers.setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        })
        if (response.ok) {
          this.sentTotal += batch.length
          return
        }
        lastError = `HTTP ${response.status}`
        // A client error will not succeed on retry.
        if (response.status >= 400 && response.status < 500) break
      } catch (error) {
        lastError = controller.signal.aborted ? "timeout" : errorMessage(error)
      } finally {
        this.timers.clearTimeout(handle)
        if (this.inflight === controller) this.inflight = undefined
      }
    }
    this.droppedTotal += batch.length
    this.options.log.debug("telemetry batch dropped", { records: batch.length, error: lastError })
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.timers.setTimeout(resolve, ms)
    })
  }
}
