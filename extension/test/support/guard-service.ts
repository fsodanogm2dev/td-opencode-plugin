/**
 * An in-memory stand-in for the extension's local guard service. It follows the
 * route contract (GET /state, POST/DELETE /guards, POST/DELETE /activations),
 * replays a repeated `opId`, and can be told to fail. No files, no real service.
 */
import { resolveLifecycleViews, type LifecycleView } from "../../../src/guards/lifecycle-history.ts"
import type { Activation, Guard, GuardRuntimeReport, LifecycleFact, Rule } from "../../panel/guards/shared.ts"
import type { ServiceAnswer, ServiceCall } from "./mock-host.ts"
import { NOW } from "./fixtures.ts"

export const SESSION = "ses_root"
export const CHILD = "ses_child"
export const OTHER_SESSION = "ses_other"

export const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString()

export const COMMIT_RULE: Rule = { kind: "command", program: "git", subcommands: [["commit"]] }

export const guard = (patch: Partial<Guard> = {}): Guard => ({
  id: "g_commits",
  label: "Git commits blocked",
  summary: "Blocks git commit.",
  request: "block git commits",
  message: "A TD-Plugin guard set by the user blocks git commit. Continue with other work.",
  rules: [COMMIT_RULE],
  createdAt: iso(-3_600_000),
  updatedAt: iso(-3_600_000),
  ...patch,
})

export const runtime = (patch: Partial<GuardRuntimeReport> = {}): GuardRuntimeReport => ({
  schema: "td-guards-runtime/1",
  directory: "/work/example-project",
  instanceId: "inst_1",
  registered: true,
  recordedAt: iso(-5_000),
  storeState: "ready",
  revision: 0,
  blockedCount: 0,
  uncertainCount: 0,
  coveredActions: ["shell", "edit", "write", "patch", "subagent"],
  sessions: [
    { id: SESSION, parentId: null, activity: "running" },
    { id: CHILD, parentId: SESSION, activity: "running" },
  ],
  ...patch,
})

export type FakeState = {
  revision: number
  guards: Guard[]
  activations: Activation[]
  runtime: GuardRuntimeReport | null
  lifecycle: LifecycleFact[]
  /** Views to send as they are. Without it, the fake resolves the facts with the shared core, like the service. */
  lifecycles?: LifecycleView[]
  /** The store file is damaged: every route but recovery answers 503 STORE_CORRUPT. */
  corrupt?: boolean
}

const ok = (data: unknown, status = 200): ServiceAnswer => ({ status, body: JSON.stringify({ ok: true, data }) })
const err = (status: number, code: string, message: string): ServiceAnswer => ({
  status,
  body: JSON.stringify({ ok: false, error: { code, message } }),
})

export type FakeSession = { id: string; parentId: string | null }

export const createFakeGuardService = (initial: Partial<FakeState> & { bridge?: FakeSession[] | null } = {}) => {
  const { bridge: bridgeOption, ...rest } = initial
  const state: FakeState = { revision: 0, guards: [], activations: [], runtime: runtime(), lifecycle: [], ...rest }
  // What OpenCode's session API would answer. `null` means the bridge is unavailable.
  const bridge: FakeSession[] | null =
    bridgeOption === undefined
      ? [
          { id: SESSION, parentId: null },
          { id: CHILD, parentId: SESSION },
          { id: OTHER_SESSION, parentId: null },
        ]
      : bridgeOption
  const chainOf = (sessionId: string): FakeSession[] | null => {
    if (!bridge) return null
    const byId = new Map(bridge.map((s) => [s.id, s]))
    const chain: FakeSession[] = []
    let current = byId.get(sessionId)
    while (current && chain.length < 32) {
      chain.push(current)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return chain.length > 0 && chain[chain.length - 1]!.parentId === null ? chain : null
  }
  const applied = new Map<string, ServiceAnswer>()
  /** Answers to send instead of the normal one, in order. */
  const queued: Array<ServiceAnswer | ((call: ServiceCall) => ServiceAnswer | Promise<ServiceAnswer>)> = []
  let counter = 0

  const bump = () => {
    state.revision += 1
    if (state.runtime) state.runtime = { ...state.runtime, revision: state.revision }
  }

  const mutate = (opId: string, change: () => ServiceAnswer): ServiceAnswer => {
    const previous = applied.get(opId)
    if (previous) return previous
    const result = change()
    if ("status" in result && result.status < 300) applied.set(opId, result)
    return result
  }

  const normal = (call: ServiceCall): ServiceAnswer => {
    const body = call.body ? (JSON.parse(call.body) as Record<string, unknown>) : {}
    const opId = String(body.opId ?? "")
    if (call.method === "POST" && call.path === "/store/recover") {
      return mutate(opId, () => {
        if (body.confirmation !== "reset-global-guards") return err(400, "INVALID_REQUEST", "The request is not valid.")
        if (!state.corrupt) return err(409, "RECOVERY_NOT_NEEDED", "The guard store is valid. Nothing was reset.")
        state.corrupt = false
        state.guards = []
        state.activations = []
        state.revision = 1
        return ok({ revision: state.revision, recovered: true, backup: "guards.corrupt-20261112T150000Z.json" })
      })
    }
    if (state.corrupt) return err(503, "STORE_CORRUPT", "The guard store file is not valid. The service did not change it.")
    if (call.method === "GET" && call.path === "/state") {
      // Like the real service: the report is sent only while fresh, with the service's own verdict.
      const fresh = state.runtime !== null && NOW - Date.parse(state.runtime.recordedAt) <= 60_000
      const sessionId = call.query?.sessionId ?? null
      const chain = sessionId ? chainOf(sessionId) : null
      const views =
        state.lifecycles ??
        resolveLifecycleViews(state.activations, { facts: state.lifecycle, gaps: [], truncated: false, partialTail: false })
      const ended = new Set(views.filter((v) => v.phase === "ended" && v.releasable).map((v) => v.activationId))
      return ok({
        revision: state.revision,
        guards: state.guards,
        activations: state.activations,
        runtime: fresh ? state.runtime : null,
        runtimeStatus: state.runtime === null ? "missing" : fresh ? "live" : "stale",
        lifecycle: state.lifecycle,
        lifecycles: views,
        lifecycleHistory: { truncated: false, malformedLines: 0, partialTail: false },
        effective:
          chain === null
            ? null
            : {
                sessionId: chain[0]!.id,
                rootSessionId: chain[chain.length - 1]!.id,
                activationIds: state.activations
                  .filter((a) => !ended.has(a.id) && chain.some((s) => s.id === a.sessionId))
                  .map((a) => a.id),
              },
        bridge: sessionId === null ? "none" : bridge === null ? "unavailable" : chain === null ? "not-found" : "ok",
      })
    }
    if (call.method === "POST" && call.path === "/guards") {
      return mutate(opId, () => {
        const draft = body.draft as Omit<Guard, "id" | "createdAt" | "updatedAt">
        const created: Guard = { ...draft, id: `g_${++counter}`, createdAt: iso(), updatedAt: iso() }
        state.guards.push(created)
        bump()
        return ok({ revision: state.revision, guard: created })
      })
    }
    const guardMatch = call.path.match(/^\/guards\/(.+)$/)
    if (call.method === "DELETE" && guardMatch) {
      return mutate(opId, () => {
        const id = decodeURIComponent(guardMatch[1]!)
        if (!state.guards.some((g) => g.id === id)) return err(409, "GUARD_NOT_FOUND", "The guard does not exist.")
        state.guards = state.guards.filter((g) => g.id !== id)
        state.activations = state.activations.filter((a) => a.guardId !== id)
        bump()
        return ok({ revision: state.revision })
      })
    }
    if (call.method === "POST" && call.path === "/activations") {
      return mutate(opId, () => {
        const minutes = typeof body.expiresInMinutes === "number" ? body.expiresInMinutes : null
        const activation: Activation = {
          id: `a_${++counter}`,
          guardId: String(body.guardId),
          sessionId: String(body.sessionId),
          scope: body.scope === "request" ? "request" : "session",
          createdAt: iso(),
          expiresAt: minutes === null ? null : iso(minutes * 60_000),
        }
        state.activations.push(activation)
        bump()
        return ok({ revision: state.revision, activation })
      })
    }
    const activationMatch = call.path.match(/^\/activations\/(.+)$/)
    if (call.method === "DELETE" && activationMatch) {
      return mutate(opId, () => {
        const id = decodeURIComponent(activationMatch[1]!)
        state.activations = state.activations.filter((a) => a.id !== id)
        bump()
        return ok({ revision: state.revision })
      })
    }
    return err(404, "NOT_FOUND", "No such route.")
  }

  return {
    state,
    applied,
    queued,
    handle: async (call: ServiceCall): Promise<ServiceAnswer> => {
      const next = queued.shift()
      if (next) return typeof next === "function" ? next(call) : next
      return normal(call)
    },
    /** Answers normally; use in `queued` to keep a place in line. */
    pass: (call: ServiceCall): ServiceAnswer => normal(call),
    /** Applies the call, then answers as if the connection broke. */
    applyThenDrop: (): ((call: ServiceCall) => ServiceAnswer) => (call) => {
      normal(call)
      return { code: "REQUEST_FAILED" }
    },
    error: err,
  }
}
