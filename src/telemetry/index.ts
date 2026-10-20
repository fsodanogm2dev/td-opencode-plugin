import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import pkg from "../../package.json" with { type: "json" }
import type { Logger } from "../log.ts"
import type { TelemetryOptions } from "../options.ts"
import { childEnv } from "./env.ts"
import { defaultLocateFs, locateRoot, resolveNode } from "./locate.ts"
import type { LocateFs } from "./locate.ts"
import { createManagerSpawner, globalProcessManagerState } from "./manager.ts"
import type { ProcessManagerState } from "./manager.ts"
import { Mapper } from "./mapper.ts"
import { createOwnership } from "./ownership.ts"
import type { OwnerRegistry } from "./ownership.ts"
import { defaultRun, defaultSpawnDetached } from "./process.ts"
import type { RunProcess, SpawnDetached } from "./process.ts"
import { Segments } from "./segments.ts"
import type { SegmentFs } from "./segments.ts"
import { Transport, realTimers } from "./transport.ts"
import type { FetchLike, Timers } from "./transport.ts"
import { errorMessage, isRecord, num, obj, str } from "./types.ts"
import type { OpenCodeEvent } from "./types.ts"

export type Cleanup = () => Promise<void> | void

/** Replaceable side effects. Tests pass fakes. */
export interface TelemetryDeps {
  readonly run?: RunProcess
  readonly spawnDetached?: SpawnDetached
  readonly fetch?: FetchLike
  readonly now?: () => number
  readonly timers?: Timers
  readonly homedir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly locateFs?: LocateFs
  readonly segmentFs?: SegmentFs
  /** Transport tuning for tests. */
  readonly transport?: { readonly backoffMs?: readonly number[]; readonly flushIntervalMs?: number }
  /** Process-wide registry of active telemetry instances by directory. Tests pass their own. */
  readonly ownerRegistry?: OwnerRegistry
  readonly realpath?: (path: string) => string
  /** Process-wide state of the process manager spawn. Tests pass their own. */
  readonly processManagerState?: ProcessManagerState
  /** Delay before the event subscription restarts after an error, in milliseconds. */
  readonly resubscribeDelayMs?: number
}

/** Event types that count as session activity (start a segment, reset the idle timer). */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.tool.called",
  "session.execution.started",
  "session.skill.activated",
])

const SESSION_LOOKUP_TIMEOUT_MS = 2000
const MAX_RESUBSCRIBE_DELAY_MS = 30_000
const MAX_PENDING_PROMPTS = 100
const CLEANUP_FLUSH_MS = 2000
const CLEANUP_END_MS = 3000

function noop(): void {}

/** Resolves after `ms`, or at once when `signal` aborts. Leaves no timer and no listener behind. */
export function delay(ms: number, timers: Timers, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      timers.clearTimeout(handle)
      resolve()
    }
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** The cleanup function. `ready` resolves when background activation has finished (or failed). */
export type TelemetryCleanup = Cleanup & { readonly ready: Promise<void> }

/**
 * Emits td-telemetry events from OpenCode session activity.
 *
 * Setup returns fast. It registers the prompt hook, then locates td-telemetry and checks Node.js in the background.
 * Prompts that arrive before activation wait in a bounded queue.
 *
 * Telemetry never breaks a session: every path catches its own errors. The emitter sends IDs, names, counts,
 * durations, and costs only. It never sends prompt text, tool input or output, skill text, or file contents.
 */
export async function setupTelemetry(
  ctx: Plugin.Context,
  options: TelemetryOptions,
  log: Logger,
  deps: TelemetryDeps = {},
): Promise<TelemetryCleanup> {
  try {
    return await start(ctx, options, log, deps)
  } catch (error) {
    log.warn("telemetry setup failed; telemetry is off", { error: errorMessage(error) })
    return Object.assign(noop, { ready: Promise.resolve() })
  }
}

interface PendingPrompt {
  readonly sessionID: string
  readonly messageID: string
}

interface Runtime {
  readonly serial: (task: () => Promise<void>) => Promise<void>
  readonly handlePrompt: (sessionID: string, messageID: string) => Promise<void>
  readonly stop: () => Promise<void>
}

async function start(ctx: Plugin.Context, options: TelemetryOptions, log: Logger, deps: TelemetryDeps): Promise<TelemetryCleanup> {
  if (!options.enabled) {
    log.debug("telemetry is disabled")
    return Object.assign(noop, { ready: Promise.resolve() })
  }

  let phase: "pending" | "active" | "inactive" = "pending"
  let stopped = false
  let runtime: Runtime | undefined
  const pending: PendingPrompt[] = []

  // The prompt hook blocks prompt admission. Do only synchronous bookkeeping: queue the work and return.
  let registration: { dispose?: () => Promise<void> } | undefined
  try {
    registration = (await ctx.session.hook("prompt", (input) => {
      try {
        const sessionID = str(input, "sessionID")
        const messageID = str(input, "messageID")
        if (!sessionID || !messageID) return
        if (phase === "active" && runtime) {
          const active = runtime
          void active.serial(() => active.handlePrompt(sessionID, messageID))
        } else if (phase === "pending") {
          if (pending.length >= MAX_PENDING_PROMPTS) pending.shift()
          pending.push({ sessionID, messageID })
        }
      } catch (error) {
        log.debug("telemetry prompt hook failed", { error: errorMessage(error) })
      }
    })) as typeof registration
  } catch (error) {
    log.warn("telemetry could not register the prompt hook", { error: errorMessage(error) })
  }

  const deactivate = (): void => {
    phase = "inactive"
    pending.length = 0
    void Promise.resolve(registration?.dispose?.()).catch(() => {})
  }

  const ready = (async () => {
    try {
      const started = await activate(ctx, options, log, deps, () => stopped)
      if (!started) {
        deactivate()
        return
      }
      runtime = started
      if (stopped) {
        // Cleanup ran while activation was in progress.
        phase = "inactive"
        await started.stop()
        return
      }
      phase = "active"
      const queued = pending.splice(0)
      for (const prompt of queued) void started.serial(() => started.handlePrompt(prompt.sessionID, prompt.messageID))
    } catch (error) {
      log.warn("telemetry setup failed; telemetry is off", { error: errorMessage(error) })
      deactivate()
    }
  })()

  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    stopped = true
    pending.length = 0
    const timers = deps.timers ?? realTimers
    try {
      await Promise.race([ready, delay(500, timers)])
      phase = "inactive"
      void Promise.resolve(registration?.dispose?.()).catch(() => {})
      await runtime?.stop()
    } catch (error) {
      log.debug("telemetry cleanup failed", { error: errorMessage(error) })
    }
  }
  return Object.assign(cleanup, { ready })
}

/** Locates td-telemetry and starts the mapper, transport, and event subscription. Returns `undefined` when inactive. */
async function activate(
  ctx: Plugin.Context,
  options: TelemetryOptions,
  log: Logger,
  deps: TelemetryDeps,
  isStopped: () => boolean,
): Promise<Runtime | undefined> {
  const run = deps.run ?? defaultRun
  const sourceEnv = deps.env ?? process.env
  const hookEnv = childEnv(sourceEnv, "hook")
  const managerEnv = childEnv(sourceEnv, "manager")
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? realTimers

  const located = await locateRoot({
    explicitRoot: options.root,
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    fs: deps.locateFs ?? defaultLocateFs,
  })
  if (located.root === undefined) {
    log.info(`telemetry is off: ${located.reason}`)
    return undefined
  }
  const root = located.root
  const resolved = await resolveNode(run, options.node, managerEnv)
  if (!resolved.ok) {
    log.warn("telemetry is off: Node.js 22.5 or later is required to run td-telemetry", { node: options.node, detail: resolved.detail })
    return undefined
  }
  const node = resolved.node
  log.debug("telemetry uses Node.js", { node, version: resolved.detail })
  if (isStopped()) return undefined

  const manager = createManagerSpawner({
    root,
    node,
    env: managerEnv,
    spawn: deps.spawnDetached ?? defaultSpawnDetached,
    now,
    log,
    state: deps.processManagerState ?? globalProcessManagerState(),
  })
  // Start the receiver and dashboard pair once per process. The script always exits 0 and runs detached.
  manager.ensure()
  log.info("telemetry is on", { root, directory: ctx.location?.directory })

  const mapper = new Mapper({ subagentToolNames: options.subagentToolNames, now })
  const segments = new Segments({
    root,
    node,
    idleMinutes: options.idleMinutes,
    log,
    run,
    defaultDirectory: ctx.location?.directory ?? process.cwd(),
    env: hookEnv,
    now,
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
    ...(deps.segmentFs ? { fs: deps.segmentFs } : {}),
    timers,
  })
  void segments.pruneTranscripts()
  const transport = new Transport({
    receiverURL: options.receiverURL,
    log,
    serviceVersion: pkg.version,
    now,
    timers,
    ready: (sessionID) => segments.ready(sessionID),
    onUnreachable: () => {
      if (!isStopped()) manager.restart()
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.transport?.backoffMs ? { backoffMs: deps.transport.backoffMs } : {}),
    ...(deps.transport?.flushIntervalMs !== undefined ? { flushIntervalMs: deps.transport.flushIntervalMs } : {}),
  })

  // Work is serialized so that lookups and mapping keep the order of arrival.
  let chain: Promise<void> = Promise.resolve()
  const serial = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task).catch((error) => {
      log.debug("telemetry task failed", { error: errorMessage(error) })
    })
    chain = next
    return next
  }

  /** Learns the parent and directory of a session that started before the plugin. A failed lookup means root. */
  const ensureKnown = async (sessionID: string, depth = 0): Promise<void> => {
    if (mapper.knows(sessionID) || depth > 8) return
    let info: Record<string, unknown> | undefined
    let timeout: unknown
    try {
      const limit = new Promise<undefined>((resolve) => {
        timeout = timers.setTimeout(() => resolve(undefined), SESSION_LOOKUP_TIMEOUT_MS)
      })
      const result = await Promise.race([ctx.session.get({ sessionID } as never) as Promise<unknown>, limit])
      // The client returns the session info. Accept a `{ data }` wrapper too.
      info = isRecord(result) ? (isRecord(result.data) && result.id === undefined ? result.data : result) : undefined
    } catch (error) {
      log.debug("telemetry session lookup failed", { error: errorMessage(error) })
    } finally {
      if (timeout !== undefined) timers.clearTimeout(timeout)
    }
    const parentID = str(info, "parentID")
    mapper.registerSession(sessionID, {
      parentID,
      directory: str(obj(info, "location"), "directory"),
      title: str(info, "title"),
      agent: str(info, "agent"),
    })
    if (parentID) await ensureKnown(parentID, depth + 1)
  }

  const ownership = createOwnership({
    ownDirectory: ctx.location?.directory,
    ...(deps.ownerRegistry ? { registry: deps.ownerRegistry } : {}),
    ...(deps.realpath ? { realpath: deps.realpath } : {}),
    onNoOwner: (directory, sessionID) =>
      log.debug("telemetry skips a session from a location without a plugin instance", { directory, sessionID }),
  })
  ownership.register()
  const ownsSession = (directory: string | undefined, sessionID: string) => ownership.owns(directory, sessionID)

  const segmentInfo = (rootID: string) => ({ directory: mapper.directoryOf(rootID), title: mapper.titleOf(rootID) })

  const handleEvent = async (event: OpenCodeEvent): Promise<void> => {
    const data = isRecord(event.data) ? event.data : {}
    const sessionID = str(data, "sessionID")
    if (!sessionID) return
    if (event.type === "session.created") {
      const parentID = str(data, "parentID")
      if (parentID) await ensureKnown(parentID)
    } else {
      await ensureKnown(sessionID)
    }
    const records = mapper.event(event)
    const rootID = mapper.rootOf(sessionID)
    if (!ownsSession(mapper.directoryOf(rootID), rootID)) return
    const isRoot = rootID === sessionID
    if (event.type === "session.renamed" && isRoot) {
      const title = mapper.titleOf(sessionID)
      if (title) segments.setTitle(sessionID, title)
    }
    if (ACTIVITY_TYPES.has(event.type) || records.length > 0) segments.touch(rootID, segmentInfo(rootID))
    transport.enqueue(records)
    if (event.type === "session.deleted") {
      if (isRoot) {
        void segments.end(rootID)
        segments.forgetTitle(rootID)
      }
      mapper.forget(sessionID)
    }
  }

  const handlePrompt = async (sessionID: string, messageID: string): Promise<void> => {
    await ensureKnown(sessionID)
    const rootID = mapper.rootOf(sessionID)
    if (rootID !== sessionID) return
    if (!ownsSession(mapper.directoryOf(rootID), rootID)) return
    segments.prompt(rootID, segmentInfo(rootID))
    transport.enqueue(mapper.promptHook(sessionID, messageID, now()))
  }

  const controller = new AbortController()
  const baseDelay = deps.resubscribeDelayMs ?? 1000
  const loop = (async () => {
    let wait = baseDelay
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          wait = baseDelay
          const type = typeof event?.type === "string" ? event.type : undefined
          if (!type) continue
          const created = num(event, "created")
          const parsed: OpenCodeEvent = {
            type,
            ...(created !== undefined ? { created } : {}),
            ...(isRecord((event as { data?: unknown }).data) ? { data: (event as { data: Record<string, unknown> }).data } : {}),
          }
          await serial(() => handleEvent(parsed))
        }
      } catch (error) {
        if (controller.signal.aborted) break
        log.debug("telemetry event subscription failed", { error: errorMessage(error) })
      }
      if (controller.signal.aborted) break
      await delay(wait, timers, controller.signal)
      wait = Math.min(wait * 2, MAX_RESUBSCRIBE_DELAY_MS)
    }
  })().catch(() => {})

  return {
    serial,
    handlePrompt,
    stop: async () => {
      ownership.unregister()
      controller.abort()
      try {
        await Promise.race([loop, delay(500, timers)])
        await Promise.race([chain, delay(500, timers)])
        // Send events before the segment ends, so that the receiver stores them while the segment is open.
        await transport.close(CLEANUP_FLUSH_MS)
        await segments.endAll(CLEANUP_END_MS)
        segments.dispose()
      } catch (error) {
        log.debug("telemetry cleanup failed", { error: errorMessage(error) })
      }
    },
  }
}
