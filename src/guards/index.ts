/**
 * Guard enforcement setup. Registers the permission `evaluate` hook and watches execution events.
 *
 * Guarantees (see docs): a guarded action that passes through `ctx.permission` evaluation is denied before it runs,
 * whatever the earlier effect was. Not covered: tools that never ask for permission, scripts, and any action by the
 * same operating-system user outside OpenCode. The matcher for commands is a convenience guard.
 */

import { randomBytes } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import { resolveLifecycleViews, type LifecycleView } from "./lifecycle-history.ts"
import { createRequestTracker, type ExecutionEvent } from "./lifecycle.ts"
import { decide } from "./policy.ts"
import { createRuntimeReporter, type RuntimeReporter } from "./report.ts"
import { FAIL_CLOSED_MESSAGE, MUTATING_ACTIONS, type LifecycleFact } from "./schema.ts"
import { createSessionTracker, normalizeSessionInfo } from "./sessions.ts"
import { createLifecycleReader, createNodeGuardFs, createStoreReader, defaultHome, guardPaths, type GuardFs, type StoreSnapshot } from "./store.ts"

export type Cleanup = () => Promise<void> | void

/** Permission actions with runtime proof that the hook receives them and a denial blocks them. */
export const COVERED_ACTIONS: readonly string[] = ["shell", "subagent"]

export const HEARTBEAT_MS = 15_000

export interface GuardsDeps {
  readonly fs?: GuardFs
  readonly home?: () => string
  readonly now?: () => Date
  readonly instanceId?: string
  readonly heartbeatMs?: number
  readonly setInterval?: (callback: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  /** Waits between event stream reconnects. Resolves early when the signal aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })
}

function readExecutionEvent(event: any): { execution?: ExecutionEvent; created?: { sessionId: string; parentId: string | null } } {
  const type = typeof event?.type === "string" ? event.type : ""
  const data = event?.data
  const sessionId = typeof data?.sessionID === "string" ? data.sessionID : undefined
  if (!sessionId) return {}
  if (type === "session.created") {
    const parent = data?.parentID ?? data?.info?.parentID
    return { created: { sessionId, parentId: typeof parent === "string" && parent !== "" ? parent : null } }
  }
  const match = /^session\.execution\.(started|succeeded|failed|interrupted)$/.exec(type)
  if (!match) return {}
  return {
    execution: {
      type: match[1] as ExecutionEvent["type"],
      sessionId,
      created: typeof event?.created === "number" ? event.created : undefined,
      reason: typeof data?.reason === "string" ? data.reason : undefined,
    },
  }
}

export async function setupGuards(ctx: Plugin.Context, log: Logger, deps: GuardsDeps = {}): Promise<Cleanup> {
  const fs = deps.fs ?? createNodeGuardFs()
  const now = deps.now ?? (() => new Date())
  const paths = guardPaths((deps.home ?? defaultHome)())
  const instanceId = deps.instanceId ?? `i${randomBytes(6).toString("hex")}`
  const directory = typeof ctx.location?.directory === "string" && ctx.location.directory !== "" ? ctx.location.directory : null
  const startedAt = now().getTime()

  const sessions = createSessionTracker(async (sessionID) => normalizeSessionInfo(await ctx.session.get({ sessionID } as never)))
  const requests = createRequestTracker({
    sessions,
    instanceId,
    now,
    log,
    coverageSince: startedAt,
    // A leading newline keeps a half-written line of a crashed writer from swallowing this fact.
    append: (fact: LifecycleFact) => fs.appendFile(paths.lifecycle, `\n${JSON.stringify(fact)}\n`),
  })
  const reader = createStoreReader({ fs, path: paths.store })
  const lifecycleReader = createLifecycleReader({ fs, path: paths.lifecycle })

  let registered = false
  let blocked = 0
  let syncedKey = ""
  let views = new Map<string, LifecycleView>()
  let viewsKey = ""
  let closed = false
  const state = () => {
    const snapshot = reader.current()
    return {
      registered,
      storeState: snapshot.state,
      revision: snapshot.revision,
      blockedCount: blocked,
      uncertainCount: [...views.values()].filter((view) => view.phase === "uncertain").length,
      coveredActions: [...COVERED_ACTIONS],
      sessions: sessions.snapshot(256),
    }
  }
  const reporter: RuntimeReporter = createRuntimeReporter({ fs, runtimeDir: paths.runtimeDir, directory, instanceId, now, log, state })

  const refresh = async (): Promise<StoreSnapshot> => {
    const [snapshot, lifecycle] = await Promise.all([reader.refresh(), lifecycleReader.refresh()])
    const key = `${snapshot.version}:${lifecycle.version}`
    if (key !== viewsKey) {
      viewsKey = key
      views = new Map(resolveLifecycleViews(snapshot.store.activations, lifecycle.reading).map((view) => [view.activationId, view]))
    }
    if (key !== syncedKey) {
      syncedKey = key
      requests.sync(
        snapshot.store.activations,
        new Set([...views.values()].filter((view) => view.releasable).map((view) => view.activationId)),
      )
      reporter.update()
      if (snapshot.state === "invalid" || snapshot.state === "unavailable") {
        log.warn(snapshot.failClosed ? "guard store unusable; mutating actions are blocked" : "guard store unusable; keeping the last good store", { state: snapshot.state })
      }
    }
    return snapshot
  }

  await refresh()

  // The hook only ever denies. It never writes `allow`.
  let registration: { dispose?: () => Promise<void> | void } | undefined
  try {
    registration = await ctx.permission.hook("evaluate", async (event) => {
      try {
        const snapshot = await refresh()
        const decision = await decide(
          snapshot,
          { sessionId: String(event.sessionID), action: event.action, resources: event.resources, metadata: event.metadata },
          { sessions, isReleased: (id) => views.get(id)?.releasable === true, now },
        )
        if (decision.deny) {
          if (event.effect !== "deny") {
            event.effect = "deny"
            event.message = decision.message
            blocked++
            reporter.update()
          }
        } else if (event.action === "subagent" && event.effect !== "deny") {
          requests.noteSpawn(String(event.sessionID))
        }
      } catch {
        if ((MUTATING_ACTIONS as readonly string[]).includes(event.action) && event.effect !== "deny") {
          event.effect = "deny"
          event.message = FAIL_CLOSED_MESSAGE
          blocked++
        }
      }
    })
    registered = true
  } catch {
    registered = false
    reporter.update()
    await reporter.flush()
    throw new Error("guard permission hook registration failed; guards are NOT enforced")
  }
  reporter.update()

  // Event stream: lifecycle only. Enforcement does not depend on it.
  const abort = new AbortController()
  const sleep = deps.sleep ?? defaultSleep
  const pump = (async () => {
    let delay = 500
    let first = true
    while (!closed) {
      try {
        if (!ctx.event || typeof ctx.event.subscribe !== "function") throw new Error("no event stream")
        if (!first) requests.streamRestored(now().getTime())
        first = false
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (closed) return
          delay = 500
          const parsed = readExecutionEvent(event)
          if (!parsed.execution && !parsed.created) continue
          await refresh()
          if (parsed.created) requests.onSessionCreated(parsed.created.sessionId, parsed.created.parentId)
          if (parsed.execution) requests.onExecution(parsed.execution)
          reporter.update()
        }
      } catch {
        // Fall through to the lost-coverage handling.
      }
      if (closed) return
      requests.streamLost()
      reporter.update()
      log.warn("guard event stream lost; request-scope activations stay enforced")
      await sleep(delay, abort.signal)
      delay = Math.min(delay * 2, 30_000)
    }
  })()
  pump.catch(() => {})

  const setIntervalFn = deps.setInterval ?? ((callback, ms) => {
    const handle = setInterval(callback, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  })
  const clearIntervalFn = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  // The heartbeat refreshes health. It never expires a guard.
  const heartbeat = setIntervalFn(() => {
    void refresh().catch(() => {})
    requests.retry()
    reporter.update()
  }, deps.heartbeatMs ?? HEARTBEAT_MS)

  return async () => {
    closed = true
    clearIntervalFn(heartbeat)
    abort.abort()
    registered = false
    reporter.update()
    await reporter.flush()
    reporter.close()
    await requests.idle()
    try {
      await registration?.dispose?.()
    } catch {
      // Disposal failure is nonfatal.
    }
  }
}
