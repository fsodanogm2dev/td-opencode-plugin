/**
 * Read-only session lookups through the host's OpenCode bridge.
 *
 * Only `GET /api/session/<id>` is requested. The id is validated and URL-encoded, the base URL must be a
 * loopback address, redirects are refused, and the response size and time are bounded.
 */
import { ApiError } from "./contract.ts"

export interface SessionInfo {
  readonly id: string
  readonly parentId: string | null
  readonly directory: string | null
}

export interface SessionBridge {
  /** `null` when OpenCode has no such session. Throws `ApiError` when the lookup cannot finish. */
  get(sessionId: string): Promise<SessionInfo | null>
}

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_DEPTH = 32
const MAX_RESPONSE_BYTES = 1024 * 1024

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value)
}

function loopbackBase(raw: string | undefined): URL | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]"
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== "") return null
  return url
}

function pick(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  // The API may answer the session itself or wrap it in `data`.
  if (typeof record.id === "string") return record
  const inner = record.data
  if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>).id === "string") {
    return inner as Record<string, unknown>
  }
  return null
}

export type BridgeEnv = Readonly<Record<string, string | undefined>>

export function createSessionBridge(
  env: BridgeEnv,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): SessionBridge | null {
  const base = loopbackBase(env.OPENCHAMBER_OPENCODE_URL)
  const token = env.OPENCHAMBER_SERVICE_TOKEN
  if (!base || !token) return null
  return {
    async get(sessionId) {
      if (!isSessionId(sessionId)) throw new ApiError("INVALID_REQUEST")
      const url = new URL(`/api/session/${encodeURIComponent(sessionId)}`, base)
      if (url.origin !== base.origin || !url.pathname.startsWith("/api/session/")) {
        throw new ApiError("SESSION_BRIDGE_UNAVAILABLE")
      }
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED")
      }
      if (response.status === 404) return null
      if (response.status === 401 || response.status === 403) throw new ApiError("SESSION_BRIDGE_UNAVAILABLE")
      if (!response.ok) throw new ApiError("SESSION_LOOKUP_FAILED")
      let text: string
      try {
        text = await response.text()
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED")
      }
      if (text.length > MAX_RESPONSE_BYTES) throw new ApiError("SESSION_LOOKUP_FAILED")
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED")
      }
      const record = pick(json)
      if (!record || record.id !== sessionId) throw new ApiError("SESSION_LOOKUP_FAILED")
      const parent = record.parentID
      if (parent !== undefined && parent !== null && !isSessionId(parent)) throw new ApiError("SESSION_LOOKUP_FAILED")
      const directory = typeof record.directory === "string" && record.directory.length > 0 ? record.directory : null
      return { id: sessionId, parentId: typeof parent === "string" ? parent : null, directory }
    },
  }
}

export interface SessionChain {
  /** The selected session first, the root last. */
  readonly chain: readonly SessionInfo[]
  readonly root: SessionInfo
  readonly selected: SessionInfo
}

/** Walk `parentID` up to the true root. A missing ancestor or a cycle is a failed lookup. */
export async function resolveChain(bridge: SessionBridge, sessionId: string): Promise<SessionChain | null> {
  const first = await bridge.get(sessionId)
  if (first === null) return null
  const chain: SessionInfo[] = [first]
  const seen = new Set([first.id])
  let current = first
  while (current.parentId !== null) {
    if (chain.length >= MAX_DEPTH || seen.has(current.parentId)) throw new ApiError("SESSION_LOOKUP_FAILED")
    const parent = await bridge.get(current.parentId)
    if (parent === null) throw new ApiError("SESSION_LOOKUP_FAILED")
    chain.push(parent)
    seen.add(parent.id)
    current = parent
  }
  return { chain, root: current, selected: first }
}
