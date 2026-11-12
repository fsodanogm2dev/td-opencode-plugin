/**
 * Process-wide decision cache. Entries live 60 seconds at most, and at most 2,000 stay. Only successful decisions
 * enter the cache. A failure is never cached.
 *
 * One cache serves every plugin instance in the process (OpenCode runs one instance per location). The identity
 * therefore includes the endpoint, a fingerprint of the credential, the location scope, the model, the state, and
 * the questions (`jevCacheKey`), so one account or location never reads the decision of another.
 */

import { createHash } from "node:crypto"
import type { JevDecisionData, JsonValue } from "./types.ts"

export const CACHE_TTL_MS = 60_000
export const CACHE_MAX_ENTRIES = 2_000

export interface JevCacheOptions {
  /** Lifetime in milliseconds. Values above `CACHE_TTL_MS` are lowered to it. */
  readonly ttlMs?: number
  /** Entry limit. Values above `CACHE_MAX_ENTRIES` are lowered to it. */
  readonly maxEntries?: number
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
}

export interface JevCache {
  /** Returns a private copy of a live entry, or `undefined`. */
  get(key: string): JevCachedDecision | undefined
  set(key: string, value: JevCachedDecision): void
  clear(): void
  readonly size: number
}

export type JevCachedDecision = JevDecisionData

export function createJevCache(options: JevCacheOptions = {}): JevCache {
  const ttlMs = Math.min(CACHE_TTL_MS, Math.max(1, options.ttlMs ?? CACHE_TTL_MS))
  const maxEntries = Math.min(CACHE_MAX_ENTRIES, Math.max(1, Math.floor(options.maxEntries ?? CACHE_MAX_ENTRIES)))
  const now = options.now ?? Date.now
  const entries = new Map<string, { readonly expiresAt: number; readonly value: JevCachedDecision }>()

  const sweep = (): void => {
    const time = now()
    for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key)
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }
      return structuredClone(entry.value)
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, { expiresAt: now() + ttlMs, value: structuredClone(value) })
      if (entries.size <= maxEntries) return
      sweep()
      // Map iteration follows insertion order, so the first keys are the oldest.
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break
        entries.delete(oldest)
      }
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

const GLOBAL_KEY = Symbol.for("td-opencode-plugin.jev.cache")

/** The cache shared by every plugin instance in this process. */
export function globalJevCache(): JevCache {
  const holder = globalThis as unknown as Record<symbol, JevCache | undefined>
  let cache = holder[GLOBAL_KEY]
  if (!cache) {
    cache = createJevCache()
    holder[GLOBAL_KEY] = cache
  }
  return cache
}

/** SHA-256 of a credential. Only the hash goes into a cache identity. */
export function credentialFingerprint(key: string): string {
  return createHash("sha256").update("td-opencode-plugin.jev.credential\0").update(key).digest("hex")
}

export interface JevCacheIdentity {
  /** Full request URL of the endpoint. */
  readonly endpoint: string
  /** `credentialFingerprint` of the key that signs the request. */
  readonly credential: string
  /** Scope of the OpenCode location (for example, its directory). */
  readonly location: string
  readonly model: string
  readonly state: JsonValue
  readonly questions: JsonValue
}

/** SHA-256 over the whole identity. Parts are length-delimited by JSON encoding, so none can run into another. */
export function jevCacheKey(identity: JevCacheIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "jev-cache-v1",
        identity.endpoint,
        identity.credential,
        identity.location,
        identity.model,
        identity.state,
        identity.questions,
      ]),
    )
    .digest("hex")
}
