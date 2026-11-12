/**
 * Request-scope lifecycle. Watches execution events and writes lifecycle facts. It does NOT decide enforcement.
 * Enforcement and release come only from the shared persisted log, read through `lifecycle-history.ts`: a request
 * activation is released when that log proves a clean `bound` -> `ended` sequence of one instance. This holds across
 * instances and restarts, and needs no call from the extension.
 *
 * States below are this instance's own working state: `pending` (waiting for the request to run), `bound` (the
 * request is running), `ended` (the end fact was written), `uncertain` (the backend cannot prove the request end;
 * the activation stays enforced until the user releases it). `uncertain` is final. There is no timer.
 *
 * An end needs: the root session ended, every known descendant ended, and no announced subagent spawn unseen.
 * Facts are one JSON line each. Only the instance that wrote `bound` writes `ended`.
 *
 * Limits: the tracker sees only execution events that arrive on this event stream. A restart, a lost stream, or a
 * run that started before the backend watched yields `uncertain`. A queued prompt that starts after the root ends
 * is a new request and is not covered.
 */

import type { Logger } from "../log.ts"
import type { Activation, LifecycleFact, LifecycleReason } from "./schema.ts"
import type { SessionTracker } from "./sessions.ts"

export { resolveActivationLifecycle, resolveLifecycles, type LifecyclePhase, type LifecycleResolution } from "./lifecycle-state.ts"
export { resolveLifecycleViews, releasedActivationIds, parseLifecycleText, type LifecycleReading, type LifecycleView } from "./lifecycle-history.ts"

export type RequestState = "pending" | "bound" | "ended" | "uncertain"

export interface ExecutionEvent {
  readonly type: "started" | "succeeded" | "failed" | "interrupted"
  readonly sessionId: string
  /** Event time in milliseconds. Untrusted when not a finite number. */
  readonly created: number | undefined
  readonly reason?: string
}

export interface RequestTrackerDeps {
  readonly sessions: SessionTracker
  readonly instanceId: string
  readonly now: () => Date
  readonly append: (fact: LifecycleFact) => Promise<void>
  readonly log: Logger
  /** Start of event coverage in milliseconds. */
  readonly coverageSince: number
}

export interface RequestTracker {
  /**
   * Applies the current store activations. Queued. Activations in `settled` already have a final persisted
   * outcome (`ended` or `uncertain` in the shared log) and are not tracked.
   */
  sync(activations: readonly Activation[], settled?: ReadonlySet<string>): void
  onExecution(event: ExecutionEvent): void
  onSessionCreated(sessionId: string, parentId: string | null): void
  /** A subagent action was allowed in this session. A child session should follow. */
  noteSpawn(sessionId: string): void
  /** The event stream broke. Coverage is lost. */
  streamLost(): void
  /** The event stream is live again from now on. */
  streamRestored(at: number): void
  /** Retries facts whose write failed. */
  retry(): void
  uncertainCount(): number
  states(): { id: string; state: RequestState; reason: LifecycleReason | null }[]
  /** Resolves when queued work is done. */
  idle(): Promise<void>
}

interface Record_ {
  activation: Activation
  state: RequestState
  reason: LifecycleReason | null
  claimed: boolean
  owner: boolean
  rootTerminal: { kind: ExecutionEvent["type"]; reason: string | undefined } | null
  spawnPending: number
  /** Fact that was decided but not yet written. */
  unwritten: LifecycleFact | null
  ending: boolean
}

export function createRequestTracker(deps: RequestTrackerDeps): RequestTracker {
  const records = new Map<string, Record_>()
  let queue: Promise<void> = Promise.resolve()
  let coverageSince = deps.coverageSince
  let coverageLost = false

  const enqueue = (work: () => Promise<void>) => {
    // A runtime error can carry text from the environment. Log a fixed message only.
    queue = queue.then(work).catch(() => {
      deps.log.warn("guard lifecycle step failed")
    })
  }

  const subtree = async (sessionId: string): Promise<Record_[]> => {
    const { chain } = await deps.sessions.ancestors(sessionId)
    return [...records.values()].filter((record) => record.claimed && chain.includes(record.activation.sessionId))
  }

  const write = async (record: Record_, fact: LifecycleFact) => {
    try {
      await deps.append(fact)
      record.unwritten = null
      return true
    } catch {
      record.unwritten = fact
      deps.log.warn("guard lifecycle write failed")
      return false
    }
  }

  const emit = async (record: Record_, kind: LifecycleFact["fact"], reason: LifecycleReason) => {
    const fact: LifecycleFact = { activationId: record.activation.id, fact: kind, at: deps.now().toISOString(), reason, instance: deps.instanceId }
    if (kind === "bound") {
      record.state = "bound"
      record.owner = true
      record.reason = reason
      await write(record, fact)
    } else if (kind === "uncertain") {
      record.state = "uncertain"
      record.reason = reason
      await write(record, fact)
    } else {
      record.ending = true
      record.reason = reason
      // The state changes to `ended` only after the fact is written, so enforcement continues until then.
      if (await write(record, fact)) {
        record.state = "ended"
        record.ending = false
      }
    }
  }

  const claim = async (record: Record_) => {
    if (record.claimed) return
    const { certain } = await deps.sessions.ancestors(record.activation.sessionId)
    if (!certain) return
    record.claimed = true
    const root = record.activation.sessionId
    const activity = deps.sessions.activity(root)
    if (activity === "running") await emit(record, "bound", "running-tracked")
    else if (activity === "unknown" && Date.parse(record.activation.createdAt) < coverageSince) {
      await emit(record, "uncertain", coverageLost ? "event-stream-lost" : "plugin-restarted")
    }
  }

  const evaluateRelease = async (record: Record_) => {
    if (record.state !== "bound" || !record.rootTerminal) return
    const root = record.activation.sessionId
    if (deps.sessions.activity(root) !== "idle") {
      record.rootTerminal = null
      return
    }
    const descendants = deps.sessions.descendants(root)
    if (descendants.some((id) => deps.sessions.activity(id) === "running")) return
    if (descendants.some((id) => deps.sessions.activity(id) === "unknown")) {
      if (record.rootTerminal.kind === "succeeded") return // A child may still start.
      await emit(record, "uncertain", "descendant-never-started")
      return
    }
    if (record.spawnPending > 0) {
      await emit(record, "uncertain", "subagent-spawn-unobserved")
      return
    }
    await emit(record, "ended", "request-completed")
  }

  const claimAll = async () => {
    for (const record of records.values()) await claim(record)
  }

  return {
    sync(activations, settled) {
      enqueue(async () => {
        const wanted = new Set<string>()
        for (const activation of activations) {
          if (activation.scope !== "request" || settled?.has(activation.id)) continue
          wanted.add(activation.id)
          const existing = records.get(activation.id)
          if (existing) existing.activation = activation
          else {
            records.set(activation.id, {
              activation,
              state: "pending",
              reason: null,
              claimed: false,
              owner: false,
              rootTerminal: null,
              spawnPending: 0,
              unwritten: null,
              ending: false,
            })
          }
        }
        for (const id of [...records.keys()]) if (!wanted.has(id)) records.delete(id)
        await claimAll()
      })
    },
    onExecution(event) {
      enqueue(async () => {
        const known = deps.sessions.has(event.sessionId)
        const sessions = deps.sessions
        // Only the event's own finite time counts. A missing time is never replaced by the current time.
        const created = typeof event.created === "number" && Number.isFinite(event.created) ? event.created : undefined
        if (event.type === "started") {
          sessions.setActivity(event.sessionId, "running")
          await claimAll()
          for (const record of await subtree(event.sessionId)) {
            const root = record.activation.sessionId
            if (event.sessionId !== root && !known && record.spawnPending > 0) record.spawnPending--
            if (event.sessionId === root) record.rootTerminal = null
            if (record.state !== "pending") continue
            if (event.sessionId === root) {
              if (created === undefined) await emit(record, "uncertain", "event-time-unknown")
              else if (created >= Date.parse(record.activation.createdAt)) await emit(record, "bound", "observed-start")
              // An older start is a run that began before the activation. It does not bind the activation.
            } else await emit(record, "bound", "running-tracked")
          }
          return
        }
        if (event.type === "interrupted" && event.reason === "superseded") {
          sessions.setActivity(event.sessionId, "running") // A new execution replaces this one.
          return
        }
        const previous = sessions.activity(event.sessionId)
        sessions.setActivity(event.sessionId, "idle")
        await claimAll()
        for (const record of await subtree(event.sessionId)) {
          const root = record.activation.sessionId
          if (created === undefined && (record.state === "bound" || record.state === "pending")) {
            await emit(record, "uncertain", "event-time-unknown")
            continue
          }
          // An end that predates the activation belongs to a run that finished before the user enabled the guard.
          if (created !== undefined && created < Date.parse(record.activation.createdAt)) continue
          if (event.type === "interrupted" && event.reason === "shutdown" && (record.state === "bound" || record.state === "pending")) {
            await emit(record, "uncertain", "shutdown")
            continue
          }
          if (event.sessionId === root) {
            if (record.state === "pending") {
              if (previous === "unknown") await emit(record, "uncertain", "run-start-unobserved")
              continue
            }
            if (record.state === "bound") record.rootTerminal = { kind: event.type, reason: event.reason }
          }
          await evaluateRelease(record)
        }
      })
    },
    onSessionCreated(sessionId, parentId) {
      enqueue(async () => {
        const known = deps.sessions.has(sessionId)
        deps.sessions.noteParent(sessionId, parentId)
        if (known || parentId === null) return
        for (const record of await subtree(parentId)) {
          if (record.spawnPending > 0) record.spawnPending--
        }
      })
    },
    noteSpawn(sessionId) {
      enqueue(async () => {
        await claimAll()
        for (const record of await subtree(sessionId)) {
          if (record.state === "pending" || record.state === "bound") record.spawnPending++
        }
      })
    },
    streamLost() {
      enqueue(async () => {
        coverageLost = true
        deps.sessions.resetActivity()
        for (const record of records.values()) {
          if (record.claimed && (record.state === "bound" || record.state === "pending")) await emit(record, "uncertain", "event-stream-lost")
        }
      })
    },
    streamRestored(at) {
      enqueue(async () => {
        coverageSince = at
      })
    },
    retry() {
      enqueue(async () => {
        for (const record of records.values()) {
          if (record.unwritten && (await write(record, record.unwritten)) && record.ending) {
            record.state = "ended"
            record.ending = false
          }
        }
      })
    },
    uncertainCount: () => [...records.values()].filter((record) => record.state === "uncertain").length,
    states: () => [...records.values()].map((record) => ({ id: record.activation.id, state: record.state, reason: record.reason })),
    idle: async () => {
      let seen: Promise<void>
      do {
        seen = queue
        await seen
      } while (seen !== queue)
    },
  }
}
