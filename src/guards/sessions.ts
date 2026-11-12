/**
 * Session tracker: parent links and execution activity, for ancestry lookup and lifecycle tracking.
 *
 * A lookup that fails does not prove that a session has no guard. `ancestors` then reports `certain: false`, and
 * the policy applies every active guard. Depth and cycles are bounded.
 */

import type { SessionActivity } from "./schema.ts"

export const MAX_ANCESTRY_DEPTH = 32
export const MAX_TRACKED_SESSIONS = 2048

export type SessionLookup = (sessionID: string) => Promise<{ readonly parentID?: string | null } | undefined>

export interface SessionRecord {
  parentId: string | null
  activity: SessionActivity
}

export interface Ancestry {
  /** The session and its ancestors, nearest first. */
  readonly chain: readonly string[]
  readonly certain: boolean
}

export interface SessionTracker {
  noteParent(id: string, parentId: string | null): void
  setActivity(id: string, activity: SessionActivity): void
  activity(id: string): SessionActivity
  has(id: string): boolean
  /** Resolves the chain, asking the lookup for unknown parents. Never rejects. */
  ancestors(id: string): Promise<Ancestry>
  /** Known sessions whose chain (through known parents only) includes `rootId`, excluding `rootId`. */
  descendants(rootId: string): string[]
  /** Marks every tracked session as unknown. Used when event coverage is lost. */
  resetActivity(): void
  snapshot(limit: number): { id: string; parentId: string | null; activity: SessionActivity }[]
  clear(): void
}

export function createSessionTracker(lookup: SessionLookup, max = MAX_TRACKED_SESSIONS): SessionTracker {
  const records = new Map<string, SessionRecord>()

  const touch = (id: string): SessionRecord | undefined => {
    const record = records.get(id)
    if (record) {
      records.delete(id)
      records.set(id, record)
    }
    return record
  }
  const evict = () => {
    while (records.size > max) {
      let victim: string | undefined
      for (const [id, record] of records) {
        if (record.activity !== "running") {
          victim = id
          break
        }
      }
      victim ??= records.keys().next().value as string
      records.delete(victim)
    }
  }
  const ensure = (id: string, parentId: string | null | undefined): SessionRecord => {
    let record = touch(id)
    if (!record) {
      record = { parentId: parentId ?? null, activity: "unknown" }
      records.set(id, record)
      evict()
    }
    return record
  }

  const knownParent = new Set<string>() // Sessions whose parent link is confirmed (not just defaulted).

  return {
    noteParent(id, parentId) {
      const record = ensure(id, parentId)
      record.parentId = parentId
      knownParent.add(id)
    },
    setActivity(id, activity) {
      ensure(id, null).activity = activity
    },
    activity: (id) => records.get(id)?.activity ?? "unknown",
    has: (id) => records.has(id),
    async ancestors(id) {
      const chain: string[] = []
      const seen = new Set<string>()
      let current: string | null = id
      while (current !== null) {
        if (seen.has(current) || chain.length >= MAX_ANCESTRY_DEPTH) return { chain, certain: false }
        seen.add(current)
        chain.push(current)
        const record = touch(current)
        if (record && knownParent.has(current)) {
          current = record.parentId
          continue
        }
        let info: Awaited<ReturnType<SessionLookup>>
        try {
          info = await lookup(current)
        } catch {
          return { chain, certain: false }
        }
        if (typeof info !== "object" || info === null) return { chain, certain: false }
        const parent = typeof info.parentID === "string" && info.parentID !== "" ? info.parentID : null
        const entry = ensure(current, parent)
        entry.parentId = parent
        knownParent.add(current)
        current = parent
      }
      return { chain, certain: true }
    },
    descendants(rootId) {
      const result: string[] = []
      for (const [id] of records) {
        if (id === rootId) continue
        let current: string | null = records.get(id)?.parentId ?? null
        for (let depth = 0; current !== null && depth < MAX_ANCESTRY_DEPTH; depth++) {
          if (current === rootId) {
            result.push(id)
            break
          }
          current = records.get(current)?.parentId ?? null
        }
      }
      return result
    },
    resetActivity() {
      for (const record of records.values()) record.activity = "unknown"
    },
    snapshot(limit) {
      const entries = [...records].map(([id, record]) => ({ id, parentId: record.parentId, activity: record.activity }))
      entries.sort((a, b) => Number(b.activity === "running") - Number(a.activity === "running"))
      return entries.slice(0, limit)
    },
    clear() {
      records.clear()
      knownParent.clear()
    },
  }
}

/** Normalizes the result of `ctx.session.get`, which may be the session or a `{ data }` envelope. */
export function normalizeSessionInfo(result: unknown): { parentID?: string | null } | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const envelope = result as { data?: unknown; error?: unknown }
  if (envelope.error !== undefined && envelope.error !== null) return undefined
  const info = "data" in envelope && typeof envelope.data === "object" && envelope.data !== null ? envelope.data : result
  return info as { parentID?: string | null }
}
