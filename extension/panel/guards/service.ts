/**
 * Talks to this extension's local service through `host.serviceRequest`.
 * The panel never writes guard files itself. Each user click gets one operation
 * ID (`opId`); a retry after an unclear failure sends the same ID again, so the
 * service can apply the change at most once.
 */
import type { GuestRequest, GuestRequestResult } from "@openchamber/sdk"

import { LIFECYCLE_REASONS, type Activation, type Draft, type Guard, type GuardRuntimeReport, type LifecycleFact, type LifecyclePhase, type LifecycleReason, type LifecycleTrust, type LifecycleView } from "./shared.ts"

export type { LifecycleView }

export type RuntimeStatus = "live" | "stale" | "missing" | "invalid"
export type BridgeStatus = "none" | "ok" | "not-found" | "unavailable"

/** Which activations the service verified for the current session through OpenCode's parent links. */
export type Effective = { sessionId: string; rootSessionId: string; activationIds: string[] }

export type LifecycleHistory = { truncated: boolean; malformedLines: number; partialTail: boolean }

export type GuardState = {
  revision: number
  guards: Guard[]
  activations: Activation[]
  /** The service sends the plugin's report only when it is fresh (under 60 seconds). */
  runtime: GuardRuntimeReport | null
  /** Absent from older services; the panel then checks the report time itself. */
  runtimeStatus?: RuntimeStatus
  /** Raw facts. Diagnostics only; the panel never derives a phase from them. */
  lifecycle: LifecycleFact[]
  /** One view per activation that the service resolved. A missing view means the end is not known. */
  lifecycles: LifecycleView[]
  lifecycleHistory?: LifecycleHistory
  effective?: Effective | null
  bridge?: BridgeStatus
}

export type ServiceTransport = { serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult> }

/**
 * - `rejected`: the service answered and refused (HTTP 400/409/503 with a reason). Nothing changed.
 * - `unclear`: no usable answer. The service may have applied the change. Retry with the same `opId`.
 * - `host`: OpenChamber refused before the service saw the request (not approved, paused, no service).
 */
export type ServiceFailure =
  | { kind: "rejected"; status: number; code: string; message: string }
  | { kind: "unclear"; code: string; message: string }
  | { kind: "host"; code: string; message: string }

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; failure: ServiceFailure }

export type ActivationRequest = {
  guardId: string
  sessionId: string
  scope: "session" | "request"
  /** Omitted unless the user chose an expiry. The service computes the end time. */
  expiresInMinutes?: number
}

/** Host error codes after which the service may still have acted. */
const UNCLEAR_CODES = new Set(["REQUEST_FAILED", "HOST_TIMEOUT", "HOST_UNAVAILABLE", "SERVICE_FAILED"])

const hostCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A random UUID v4. `crypto.randomUUID` needs a secure context, which a sandboxed frame may not be. */
export const newOpId = (random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string => {
  const bytes = random(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const parseAnswer = (result: GuestRequestResult): ServiceResult<Record<string, unknown>> => {
  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    // An answer we cannot read after a 2xx may mean the change happened.
    return result.status >= 200 && result.status < 300
      ? { ok: false, failure: { kind: "unclear", code: "BAD_ANSWER", message: "The service answer could not be read." } }
      : {
          ok: false,
          failure: { kind: "rejected", status: result.status, code: "BAD_ANSWER", message: "The service answer could not be read." },
        }
  }
  if (isRecord(body) && body.ok === true && isRecord(body.data)) return { ok: true, data: body.data }
  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "UNKNOWN"
    const message = typeof body.error.message === "string" ? body.error.message : ""
    // OUTCOME_UNKNOWN: the service wrote the change and then could not confirm it. Retry with the same opId.
    if ((result.status >= 500 && result.status !== 503) || code === "OUTCOME_UNKNOWN") return { ok: false, failure: { kind: "unclear", code, message } }
    return { ok: false, failure: { kind: "rejected", status: result.status, code, message } }
  }
  return result.status >= 200 && result.status < 300
    ? { ok: false, failure: { kind: "unclear", code: "BAD_ANSWER", message: "The service answer had an unknown shape." } }
    : { ok: false, failure: { kind: "rejected", status: result.status, code: "BAD_ANSWER", message: "The service answer had an unknown shape." } }
}

const call = async (
  transport: ServiceTransport,
  request: GuestRequest,
): Promise<ServiceResult<Record<string, unknown>>> => {
  let result: GuestRequestResult
  try {
    result = await transport.serviceRequest(request)
  } catch (error) {
    const code = hostCode(error)
    const message = error instanceof Error ? error.message : ""
    return { ok: false, failure: UNCLEAR_CODES.has(code) ? { kind: "unclear", code, message } : { kind: "host", code, message } }
  }
  return parseAnswer(result)
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** Reads the shape the service returns. Detailed checks of each entry happen in the service. */
export const toGuardState = (data: Record<string, unknown>): GuardState | null => {
  if (typeof data.revision !== "number" || !Array.isArray(data.guards) || !Array.isArray(data.activations)) return null
  return {
    revision: data.revision,
    guards: asArray<Guard>(data.guards),
    activations: asArray<Activation>(data.activations),
    runtime: isRecord(data.runtime) ? (data.runtime as unknown as GuardRuntimeReport) : null,
    lifecycle: asArray<LifecycleFact>(data.lifecycle),
    lifecycles: asArray<unknown>(data.lifecycles).flatMap((value) => {
      const view = toLifecycleView(value)
      return view ? [view] : []
    }),
    ...(toHistory(data.lifecycleHistory) ? { lifecycleHistory: toHistory(data.lifecycleHistory)! } : {}),
    ...(RUNTIME_STATUSES.includes(data.runtimeStatus as RuntimeStatus) ? { runtimeStatus: data.runtimeStatus as RuntimeStatus } : {}),
    ...(BRIDGE_STATUSES.includes(data.bridge as BridgeStatus) ? { bridge: data.bridge as BridgeStatus } : {}),
    ...("effective" in data ? { effective: toEffective(data.effective) } : {}),
  }
}

const RUNTIME_STATUSES: readonly string[] = ["live", "stale", "missing", "invalid"]
const BRIDGE_STATUSES: readonly string[] = ["none", "ok", "not-found", "unavailable"]

const PHASES: readonly string[] = ["session", "pending", "bound", "ended", "uncertain"]
const TRUST: readonly string[] = ["ok", "unverified-end", "history-truncated"]

/**
 * Checks the public shape of one service view. An invalid view is dropped, and
 * the panel then treats that activation as still enforced with an unknown end.
 */
export const toLifecycleView = (value: unknown): LifecycleView | null => {
  if (!isRecord(value)) return null
  const { activationId, phase, releasable, conflict, trust, reason, instance } = value
  if (typeof activationId !== "string" || typeof phase !== "string" || !PHASES.includes(phase)) return null
  if (typeof releasable !== "boolean" || typeof conflict !== "boolean") return null
  if (typeof trust !== "string" || !TRUST.includes(trust)) return null
  // Only a proven end may be releasable.
  if (releasable && phase !== "ended") return null
  return {
    activationId,
    phase: phase as LifecyclePhase,
    releasable,
    conflict,
    trust: trust as LifecycleTrust,
    reason: typeof reason === "string" && (LIFECYCLE_REASONS as readonly string[]).includes(reason) ? (reason as LifecycleReason) : null,
    instance: typeof instance === "string" ? instance : null,
  }
}

const toHistory = (value: unknown): LifecycleHistory | null => {
  if (!isRecord(value)) return null
  return {
    truncated: value.truncated === true,
    malformedLines: typeof value.malformedLines === "number" ? value.malformedLines : 0,
    partialTail: value.partialTail === true,
  }
}

const toEffective = (value: unknown): Effective | null => {
  if (!isRecord(value)) return null
  if (typeof value.sessionId !== "string" || typeof value.rootSessionId !== "string" || !Array.isArray(value.activationIds)) return null
  return {
    sessionId: value.sessionId,
    rootSessionId: value.rootSessionId,
    activationIds: value.activationIds.filter((id): id is string => typeof id === "string"),
  }
}

/** A change the service applied. `data` is the rest of its answer. */
export type Mutation = { revision: number; data: Record<string, unknown> }

/** The exact confirmation the service needs before it resets the global guard store. */
export const RECOVER_CONFIRMATION = "reset-global-guards"

export type GuardService = {
  state: (context: { sessionId: string | null; directory: string | null }) => Promise<ServiceResult<GuardState>>
  saveGuard: (opId: string, draft: Draft) => Promise<ServiceResult<Mutation>>
  deleteGuard: (opId: string, guardId: string) => Promise<ServiceResult<Mutation>>
  activate: (opId: string, request: ActivationRequest) => Promise<ServiceResult<Mutation>>
  release: (opId: string, activationId: string) => Promise<ServiceResult<Mutation>>
  /** Resets every saved guard and activation. Only after the user confirms in the panel. */
  recoverStore: (opId: string) => Promise<ServiceResult<Mutation>>
}

const mutation = (data: Record<string, unknown>): ServiceResult<Mutation> =>
  typeof data.revision === "number"
    ? { ok: true, data: { revision: data.revision, data } }
    : { ok: false, failure: { kind: "unclear", code: "BAD_ANSWER", message: "The service answer had no revision." } }

export const createGuardService = (transport: ServiceTransport): GuardService => {
  const mutate = async (request: GuestRequest) => {
    const answer = await call(transport, request)
    return answer.ok ? mutation(answer.data) : answer
  }
  return {
    state: async ({ sessionId, directory }) => {
      const query: Record<string, string> = {}
      if (sessionId) query.sessionId = sessionId
      if (directory) query.directory = directory
      const answer = await call(transport, { method: "GET", path: "/state", query })
      if (!answer.ok) return answer
      const state = toGuardState(answer.data)
      return state
        ? { ok: true, data: state }
        : { ok: false, failure: { kind: "rejected", status: 200, code: "BAD_ANSWER", message: "The service answer had an unknown shape." } }
    },
    saveGuard: (opId, draft) => mutate({ method: "POST", path: "/guards", body: JSON.stringify({ opId, draft }) }),
    // A DELETE carries the opId in the query too, for hosts that drop a DELETE body.
    deleteGuard: (opId, guardId) =>
      mutate({ method: "DELETE", path: `/guards/${encodeURIComponent(guardId)}`, query: { opId }, body: JSON.stringify({ opId }) }),
    activate: (opId, request) => mutate({ method: "POST", path: "/activations", body: JSON.stringify({ opId, ...request }) }),
    release: (opId, activationId) =>
      mutate({ method: "DELETE", path: `/activations/${encodeURIComponent(activationId)}`, query: { opId }, body: JSON.stringify({ opId }) }),
    recoverStore: (opId) =>
      mutate({ method: "POST", path: "/store/recover", body: JSON.stringify({ opId, confirmation: RECOVER_CONFIRMATION }) }),
  }
}
