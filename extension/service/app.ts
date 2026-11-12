/**
 * Routes and operations of the guard service. Transport-free: `handle` takes a parsed request and
 * returns a status and JSON body, so tests need no sockets.
 *
 * The service is the only writer of guard intent. Nothing here executes, interprets, or broadens rules.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import {
  ApiError,
  type Activation,
  type ActivationScope,
  type Guard,
  type GuardDraft,
  type GuardStoreDocument,
  type SchemaPort,
} from "./contract.ts"
import type { Runtime } from "./ports.ts"
import { releasedActivationIds, resolveLifecycleViews } from "../../src/guards/lifecycle-history.ts"
import { readLifecycle, readRuntime } from "./runtime-reader.ts"
import { isSessionId, resolveChain, type SessionBridge, type SessionChain } from "./session.ts"
import { Store, type Draft, type OperationContext } from "./store.ts"

export const MAX_BODY_BYTES = 64 * 1024
export const RESET_CONFIRMATION = "reset-global-guards"
const MAX_EXPIRY_MINUTES = 60 * 24 * 30
const MAX_DIRECTORY_LENGTH = 4096
const OP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

export interface AppRequest {
  readonly method: string
  /** Path and query, as received. */
  readonly url: string
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** Raw body text, or `null` when none was read. */
  readonly body: string | null
}

export interface AppResponse {
  readonly status: number
  readonly body: unknown
}

export interface AppOptions {
  readonly runtime: Runtime
  readonly schema: SchemaPort
  readonly root: string
  readonly token: string
  /** `null` when the host gave no OpenCode access: viewing and releasing still work. */
  readonly bridge: SessionBridge | null
  readonly lockTimeoutMs?: number
  readonly log?: (code: string) => void
}

export interface App {
  handle(request: AppRequest): Promise<AppResponse>
  readonly store: Store
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

function authorized(header: string | undefined, token: string): boolean {
  const supplied = header !== undefined && header.startsWith("Bearer ") ? header.slice(7) : ""
  // Digests have equal length, so the comparison does not leak the token length.
  const ok = timingSafeEqual(digest(supplied), digest(token))
  return ok && supplied.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure(error: ApiError): AppResponse {
  return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } }
}

function success(data: Record<string, unknown>): AppResponse {
  return { status: 200, body: { ok: true, data } }
}

function parseJsonObject(body: string | null): Record<string, unknown> {
  if (body === null || body.trim() === "") throw new ApiError("INVALID_REQUEST")
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE")
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new ApiError("INVALID_JSON")
  }
  if (!isRecord(json)) throw new ApiError("INVALID_REQUEST")
  return json
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new ApiError("INVALID_REQUEST")
}

function readOpId(record: Record<string, unknown>): string {
  const { opId } = record
  if (typeof opId !== "string" || !OP_ID_PATTERN.test(opId)) throw new ApiError("INVALID_REQUEST")
  return opId
}

function readExpectedRevision(record: Record<string, unknown>): number | undefined {
  const value = record.expectedRevision
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ApiError("INVALID_REQUEST")
  return value
}

function readDirectory(value: string | null): string | null {
  if (value === null || value === "") return null
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
  if (!absolute || value.length > MAX_DIRECTORY_LENGTH || value.includes("\0")) throw new ApiError("INVALID_REQUEST")
  return value
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function createApp(options: AppOptions): App {
  const { runtime, schema, root, token, bridge } = options
  const store = new Store({ runtime, schema, root, lockTimeoutMs: options.lockTimeoutMs })
  // Read under the lock, so pruning sees the latest facts.
  const endedIds = async (activations: readonly Activation[]) =>
    releasedActivationIds(activations, await readLifecycle(runtime, schema, root))

  async function mutate<T extends object>(
    record: Record<string, unknown>,
    fingerprintSource: unknown,
    apply: (draft: Draft, context: OperationContext) => T,
    retry?: {
      record: (result: T) => unknown
      replay: (stored: unknown, doc: GuardStoreDocument) => T
    },
  ): Promise<AppResponse> {
    const outcome = await store.transact(
      {
        opId: readOpId(record),
        fingerprint: stable(fingerprintSource),
        expectedRevision: readExpectedRevision(record),
        apply,
        record: retry?.record,
        replay: retry?.replay,
      },
      endedIds,
    )
    return success({ revision: outcome.revision, ...outcome.result, ...(outcome.replayed ? { replayed: true } : {}) })
  }

  async function createGuard(body: string | null): Promise<AppResponse> {
    const record = parseJsonObject(body)
    onlyKeys(record, ["opId", "expectedRevision", "draft"])
    readOpId(record)
    const parsed = schema.parseDraft(record.draft)
    if (!parsed.ok) throw new ApiError("INVALID_DRAFT")
    const draft: GuardDraft = parsed.value
    return mutate(record, { kind: "create", draft }, (state, context) => {
      if (state.guards.length >= schema.maxGuards) throw new ApiError("LIMIT_REACHED")
      const at = context.now.toISOString()
      // A saved guard is inactive until an explicit activation.
      const guard: Guard = { ...draft, id: runtime.uuid(), createdAt: at, updatedAt: at }
      state.guards.push(guard)
      state.changed = true
      return { guard }
    }, {
      // Keep the retry record small. A retry rebuilds the guard from the store.
      record: (result) => ({ guardId: result.guard.id }),
      replay: (stored, doc) => {
        const guardId = isRecord(stored) ? stored.guardId : undefined
        return { guard: doc.guards.find((guard) => guard.id === guardId) ?? null } as unknown as { guard: Guard }
      },
    })
  }

  async function deleteGuard(id: string, record: Record<string, unknown>): Promise<AppResponse> {
    return mutate(record, { kind: "delete-guard", id }, (state) => {
      const found = state.guards.some((guard) => guard.id === id)
      const endedActivationIds = state.activations.filter((a) => a.guardId === id).map((a) => a.id)
      if (found || endedActivationIds.length > 0) {
        state.guards = state.guards.filter((guard) => guard.id !== id)
        state.activations = state.activations.filter((a) => a.guardId !== id)
        state.changed = true
      }
      return { guardId: id, removed: found, endedActivationIds }
    }, {
      record: (result) => ({ ...result, endedActivationIds: result.endedActivationIds.slice(0, 32) }),
      replay: (stored) => stored as { guardId: string; removed: boolean; endedActivationIds: string[] },
    })
  }

  async function activate(body: string | null): Promise<AppResponse> {
    const record = parseJsonObject(body)
    onlyKeys(record, ["opId", "expectedRevision", "guardId", "sessionId", "scope", "expiresInMinutes"])
    readOpId(record)
    const { guardId, sessionId, scope, expiresInMinutes } = record
    if (typeof guardId !== "string" || !ID_PATTERN.test(guardId)) throw new ApiError("INVALID_REQUEST")
    if (!isSessionId(sessionId)) throw new ApiError("INVALID_REQUEST")
    if (scope !== "session" && scope !== "request") throw new ApiError("INVALID_REQUEST")
    if (expiresInMinutes !== undefined && expiresInMinutes !== null) {
      if (
        typeof expiresInMinutes !== "number" ||
        !Number.isInteger(expiresInMinutes) ||
        expiresInMinutes < 1 ||
        expiresInMinutes > MAX_EXPIRY_MINUTES
      ) {
        throw new ApiError("INVALID_REQUEST")
      }
    }
    const minutes = typeof expiresInMinutes === "number" ? expiresInMinutes : null
    // Enabling needs a verified session. Without the bridge the request is refused.
    if (bridge === null) throw new ApiError("SESSION_BRIDGE_UNAVAILABLE")
    const chain = await resolveChain(bridge, sessionId)
    if (chain === null) throw new ApiError("SESSION_NOT_FOUND")
    const activationScope: ActivationScope = scope
    // A request guard anchors to the true root, so subagents and later steps inherit it.
    const anchor = activationScope === "request" ? chain.root.id : sessionId
    return mutate(record, { kind: "activate", guardId, sessionId, scope, minutes }, (state, context) => {
      const guard = state.guards.find((candidate) => candidate.id === guardId)
      if (!guard) throw new ApiError("GUARD_NOT_FOUND")
      const existing = state.activations.find(
        (a) => a.guardId === guardId && a.sessionId === anchor && a.scope === activationScope,
      )
      // The same guard is already active here. Keep it; do not silently change its expiry.
      if (existing) return { activation: existing, alreadyActive: true }
      if (state.activations.length >= schema.maxActivations) throw new ApiError("LIMIT_REACHED")
      const activation: Activation = {
        id: runtime.uuid(),
        guardId,
        sessionId: anchor,
        scope: activationScope,
        createdAt: context.now.toISOString(),
        expiresAt: minutes === null ? null : new Date(context.now.getTime() + minutes * 60_000).toISOString(),
        // Freeze what the user previewed. Later edits to the guard cannot change this activation.
        guardUpdatedAt: guard.updatedAt,
        snapshot: { label: guard.label, message: guard.message, rules: guard.rules },
      }
      state.activations.push(activation)
      state.changed = true
      return { activation, alreadyActive: false }
    })
  }

  async function recoverStore(body: string | null): Promise<AppResponse> {
    const record = parseJsonObject(body)
    onlyKeys(record, ["opId", "confirmation"])
    const opId = readOpId(record)
    // The panel sends this only after the user confirmed the reset for all projects.
    if (record.confirmation !== RESET_CONFIRMATION) throw new ApiError("CONFIRMATION_REQUIRED")
    const outcome = await store.recover({ opId, fingerprint: stable({ kind: "recover" }) })
    return success({ revision: outcome.revision, ...outcome.result, ...(outcome.replayed ? { replayed: true } : {}) })
  }

  async function releaseActivation(id: string, record: Record<string, unknown>): Promise<AppResponse> {
    return mutate(record, { kind: "release", id }, (state) => {
      const found = state.activations.some((a) => a.id === id)
      if (found) {
        state.activations = state.activations.filter((a) => a.id !== id)
        state.changed = true
      }
      return { activationId: id, removed: found }
    })
  }

  async function state(query: URLSearchParams): Promise<AppResponse> {
    const sessionIdParam = query.get("sessionId")
    if (sessionIdParam !== null && sessionIdParam !== "" && !isSessionId(sessionIdParam)) {
      throw new ApiError("INVALID_REQUEST")
    }
    const sessionId = sessionIdParam === "" ? null : sessionIdParam
    let directory = readDirectory(query.get("directory"))
    const doc = await store.read()

    let chain: SessionChain | null = null
    let bridgeStatus: "none" | "ok" | "not-found" | "unavailable" = "none"
    if (sessionId !== null) {
      if (bridge === null) {
        bridgeStatus = "unavailable"
      } else {
        try {
          chain = await resolveChain(bridge, sessionId)
          bridgeStatus = chain === null ? "not-found" : "ok"
        } catch {
          bridgeStatus = "unavailable"
        }
      }
    }
    // The verified session directory outranks the one the panel sent.
    if (chain?.selected.directory) directory = chain.selected.directory

    const nowMs = runtime.now()
    const activations = doc.activations.filter((a) => a.expiresAt === null || Date.parse(a.expiresAt) > nowMs)
    const ids = new Set(activations.map((a) => a.id))
    const [snapshot, reading] = await Promise.all([
      readRuntime(runtime, schema, root, directory),
      readLifecycle(runtime, schema, root),
    ])
    // One resolver serves pruning and state. A row that is proven ended is not effective.
    const lifecycles = resolveLifecycleViews(activations, reading)
    const ended = new Set(lifecycles.filter((view) => view.releasable).map((view) => view.activationId))
    const effective =
      chain === null
        ? null
        : {
            sessionId: chain.selected.id,
            rootSessionId: chain.root.id,
            activationIds: activations
              .filter((a) => !ended.has(a.id) && chain.chain.some((s) => s.id === a.sessionId))
              .map((a) => a.id),
          }
    return success({
      revision: doc.revision,
      guards: doc.guards,
      activations,
      runtime: snapshot.report,
      runtimeStatus: snapshot.status,
      lifecycle: reading.facts.filter((fact) => ids.has(fact.activationId)),
      lifecycles,
      lifecycleHistory: {
        truncated: reading.truncated,
        malformedLines: reading.gaps.length,
        partialTail: reading.partialTail,
      },
      effective,
      bridge: bridgeStatus,
    })
  }

  async function route(request: AppRequest, url: URL): Promise<AppResponse> {
    const { pathname } = url
    const method = request.method.toUpperCase()
    const allowed = (...methods: string[]): void => {
      if (!methods.includes(method)) throw new ApiError("METHOD_NOT_ALLOWED")
    }
    if (pathname === "/health") {
      allowed("GET")
      return { status: 200, body: { ok: true } }
    }
    if (pathname === "/state") {
      allowed("GET")
      return state(url.searchParams)
    }
    if (pathname === "/guards") {
      allowed("POST")
      return createGuard(request.body)
    }
    if (pathname === "/store/recover") {
      allowed("POST")
      return recoverStore(request.body)
    }
    if (pathname === "/activations") {
      allowed("POST")
      return activate(request.body)
    }
    const guardMatch = /^\/guards\/([^/]+)$/.exec(pathname)
    const activationMatch = /^\/activations\/([^/]+)$/.exec(pathname)
    if (guardMatch || activationMatch) {
      allowed("DELETE")
      const id = (guardMatch ?? activationMatch)?.[1] ?? ""
      if (!ID_PATTERN.test(id)) throw new ApiError("INVALID_REQUEST")
      // The opId travels in the body, or in the query when the caller cannot send a DELETE body.
      const record =
        request.body !== null && request.body.trim() !== ""
          ? parseJsonObject(request.body)
          : { opId: url.searchParams.get("opId") ?? undefined }
      onlyKeys(record, ["opId", "expectedRevision"])
      readOpId(record)
      return guardMatch ? deleteGuard(id, record) : releaseActivation(id, record)
    }
    throw new ApiError("NOT_FOUND")
  }

  return {
    store,
    async handle(request) {
      try {
        if (!authorized(request.headers.authorization, token)) throw new ApiError("UNAUTHORIZED")
        let url: URL
        try {
          url = new URL(request.url, "http://127.0.0.1")
        } catch {
          throw new ApiError("INVALID_REQUEST")
        }
        return await route(request, url)
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status >= 500) options.log?.(error.code)
          return failure(error)
        }
        options.log?.("INTERNAL_ERROR")
        return failure(new ApiError("INTERNAL_ERROR"))
      }
    },
  }
}
