/**
 * Model-change history. The plugin keeps the lists of model IDs that it observed from the gateway, so a later
 * unchanged check cannot hide an earlier addition or removal.
 *
 * Storage is `ctx.storage`, which is shared by every location of the plugin. Each observed list is ONE key:
 * `fuelix/model-history/v1/<fetchedAt>/<digest>`. Different lists use different keys, so concurrent writers cannot
 * lose an update. The same list at the same `fetchedAt` is the same key, so a repeat is idempotent.
 *
 * `fetchedAt` is the time the plugin fetched the list from the gateway. It is not an announcement time and not the
 * first release of a model. The history starts at the oldest retained snapshot. Nothing earlier is implied.
 *
 * The history holds model IDs only. A list that contains a known key, a rotated key, or secret-like text is not
 * recorded at all. An ID is never changed or cut short.
 */

import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { redact, type Logger } from "../log.ts"
import { MAX_HISTORY_ENTRIES, type ModelHistory, type ModelHistoryEntry, type ModelHistorySource } from "./status.ts"

export const HISTORY_PREFIX = "fuelix/model-history/v1/"
/** Persistent flag. It is written only as `true`, and only before a prune removes a snapshot. */
export const HISTORY_META_KEY = "fuelix/model-history-meta/v1"
/** Snapshots kept in storage. */
export const MAX_HISTORY_SNAPSHOTS = 200
/** A list above this size is rejected as a whole. */
export const MAX_SNAPSHOT_IDS = 5000
export const MAX_SNAPSHOT_ID_LENGTH = 512
/** Approximate size budget for the entries of one report, in characters. The report limit is 1,000,000 bytes. */
export const MAX_PROJECTION_CHARS = 400_000
const SCAN_PAGE = 100

export { MAX_HISTORY_ENTRIES }
export type { ModelHistory, ModelHistoryEntry, ModelHistorySource }

export interface ModelHistoryObservation {
  /** ISO time (`Date.prototype.toISOString` form) at which the plugin fetched the list. */
  readonly fetchedAt: string
  readonly source: ModelHistorySource
  /** Every ID of the list, complete. */
  readonly ids: readonly string[]
  /** ISO time of the write. Defaults to `fetchedAt` in the storage adapter. */
  readonly recordedAt?: string
}

export interface ModelHistorySnapshot {
  readonly key: string
  readonly fetchedAt: string
  readonly recordedAt: string
  readonly source: ModelHistorySource
  /** Sorted, unique, complete. */
  readonly ids: readonly string[]
  /** SHA-256 of the sorted ID list. */
  readonly digest: string
}

export interface ModelHistoryRead {
  /** Valid snapshots, sorted by `fetchedAt`, then `digest`. */
  readonly snapshots: readonly ModelHistorySnapshot[]
  /** `true` when a prune has ever removed an older snapshot from the store. */
  readonly truncated: boolean
}

export type ModelHistoryAppendResult = "appended" | "exists" | "rejected"

export interface ModelHistoryStore {
  /** Reads every page of the store. Rejects when storage fails. */
  list(): Promise<ModelHistoryRead>
  /** Writes one snapshot. A repeat of the same snapshot writes nothing. A list that is not valid is `rejected`. */
  append(observation: ModelHistoryObservation): Promise<ModelHistoryAppendResult>
  /** Keeps the newest `keep` snapshots. Returns the number of removed snapshots. */
  prune(keep: number): Promise<number>
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SOURCES: readonly string[] = ["discovery", "cache"]

/** The value when it is an ISO time in the exact form that `toISOString` writes. */
export function canonicalISO(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) return undefined
  const time = Date.parse(value)
  return !Number.isNaN(time) && new Date(time).toISOString() === value ? value : undefined
}

/** Sorted, unique IDs, or `undefined` when the list is empty, too long, or holds an invalid ID. */
export function normalizeIDs(ids: readonly unknown[]): string[] | undefined {
  if (!Array.isArray(ids)) return undefined
  const unique = new Set<string>()
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || id.length > MAX_SNAPSHOT_ID_LENGTH) return undefined
    unique.add(id)
  }
  if (unique.size === 0 || unique.size > MAX_SNAPSHOT_IDS) return undefined
  return [...unique].sort()
}

/** SHA-256 of `JSON.stringify` of the sorted IDs, as 64 hex characters. */
export function modelHistoryDigest(sortedIDs: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(sortedIDs), "utf8").digest("hex")
}

export function modelHistoryKey(fetchedAt: string, digest: string): string {
  return `${HISTORY_PREFIX}${fetchedAt}/${digest}`
}

function isStrictlySorted(ids: readonly string[]): boolean {
  for (let index = 1; index < ids.length; index++) {
    if (!(ids[index - 1]! < ids[index]!)) return false
  }
  return true
}

/** Validates a stored value against its key and rebuilds it from known fields. */
export function parseSnapshot(key: string, value: unknown): ModelHistorySnapshot | undefined {
  if (!key.startsWith(HISTORY_PREFIX)) return undefined
  const [fetchedAt, digest, extra] = key.slice(HISTORY_PREFIX.length).split("/")
  if (extra !== undefined || fetchedAt === undefined || digest === undefined) return undefined
  if (canonicalISO(fetchedAt) === undefined || !DIGEST_PATTERN.test(digest)) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.v !== 1 || record.fetchedAt !== fetchedAt) return undefined
  const recordedAt = canonicalISO(record.recordedAt)
  if (recordedAt === undefined) return undefined
  if (typeof record.source !== "string" || !SOURCES.includes(record.source)) return undefined
  const ids = record.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SNAPSHOT_IDS) return undefined
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || id.length > MAX_SNAPSHOT_ID_LENGTH) return undefined
  }
  if (!isStrictlySorted(ids as string[])) return undefined
  if (modelHistoryDigest(ids as string[]) !== digest) return undefined
  return { key, fetchedAt, recordedAt, source: record.source as ModelHistorySource, ids: [...(ids as string[])], digest }
}

function compareSnapshots(a: ModelHistorySnapshot, b: ModelHistorySnapshot): number {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt < b.fetchedAt ? -1 : 1
  if (a.digest !== b.digest) return a.digest < b.digest ? -1 : 1
  return 0
}

export interface ProjectionOptions {
  /** Whether this location registers the model. Changes of other IDs stay out of the entries. */
  readonly isEligible: (id: string) => boolean
  readonly maxEntries?: number
  readonly maxChars?: number
}

/**
 * Builds the report projection from the stored snapshots. The store is not changed.
 *
 * Consecutive snapshots with the same list collapse into the first one. The first retained list is the baseline.
 * Each later entry shows the eligible IDs that differ from the previous list. A list that differs only in IDs that
 * this location ignores has no entry. The result is `null` when the store has no valid snapshot.
 */
export function projectModelHistory(read: ModelHistoryRead, options: ProjectionOptions): ModelHistory | null {
  if (read.snapshots.length === 0) return null
  const maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES
  const maxChars = options.maxChars ?? MAX_PROJECTION_CHARS
  const sorted = [...read.snapshots].sort(compareSnapshots)
  const eligibility = new Map<string, boolean>()
  const eligible = (id: string): boolean => {
    let known = eligibility.get(id)
    if (known === undefined) {
      try {
        known = options.isEligible(id) === true
      } catch {
        known = false
      }
      eligibility.set(id, known)
    }
    return known
  }

  const chronological: ModelHistoryEntry[] = []
  let previousDigest: string | undefined
  let previous: ReadonlySet<string> | undefined
  for (const snapshot of sorted) {
    if (snapshot.digest === previousDigest) continue
    previousDigest = snapshot.digest
    const current = new Set(snapshot.ids.filter(eligible))
    if (previous === undefined) {
      chronological.push({
        kind: "baseline",
        fetchedAt: snapshot.fetchedAt,
        source: snapshot.source,
        totalIDs: snapshot.ids.length,
        eligible: current.size,
        added: [],
        removed: [],
      })
    } else {
      const added = [...current].filter((id) => !previous!.has(id)).sort()
      const removed = [...previous].filter((id) => !current.has(id)).sort()
      if (added.length > 0 || removed.length > 0) {
        chronological.push({
          kind: "change",
          fetchedAt: snapshot.fetchedAt,
          source: snapshot.source,
          totalIDs: snapshot.ids.length,
          eligible: current.size,
          added,
          removed,
        })
      }
    }
    previous = current
  }

  const entries: ModelHistoryEntry[] = []
  let chars = 0
  for (let index = chronological.length - 1; index >= 0; index--) {
    const entry = chronological[index]!
    const size = JSON.stringify(entry).length
    if (entries.length >= maxEntries || (entries.length > 0 && chars + size > maxChars)) break
    entries.push(entry)
    chars += size
  }
  return {
    since: sorted[0]!.fetchedAt,
    truncated: read.truncated || entries.length < chronological.length,
    entries,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage adapter

type HistoryStorage = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">

/** The store on `ctx.storage`. Nothing here is per location. */
export function createStorageModelHistory(storage: HistoryStorage): ModelHistoryStore {
  const scanAll = async (): Promise<ModelHistorySnapshot[]> => {
    const found: ModelHistorySnapshot[] = []
    let after: string | undefined
    for (;;) {
      const page = await storage.scan({ prefix: HISTORY_PREFIX, limit: SCAN_PAGE, ...(after === undefined ? {} : { after }) })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(HISTORY_PREFIX)) continue
        const snapshot = parseSnapshot(entry.key, entry.value)
        if (snapshot) found.push(snapshot)
      }
      const next = page.next
      // A cursor that does not advance would loop forever.
      if (typeof next !== "string" || next === "" || (after !== undefined && next <= after)) break
      after = next
    }
    return found.sort(compareSnapshots)
  }

  const readTruncated = async (): Promise<boolean> => {
    const meta = (await storage.get(HISTORY_META_KEY)) as { v?: unknown; truncated?: unknown } | undefined
    return typeof meta === "object" && meta !== null && meta.v === 1 && meta.truncated === true
  }

  return {
    async list() {
      const snapshots = await scanAll()
      return { snapshots, truncated: await readTruncated() }
    },
    async append(observation) {
      const fetchedAt = canonicalISO(observation.fetchedAt)
      const recordedAt = canonicalISO(observation.recordedAt ?? observation.fetchedAt)
      const ids = normalizeIDs(observation.ids)
      if (!fetchedAt || !recordedAt || !ids || !SOURCES.includes(observation.source)) return "rejected"
      const digest = modelHistoryDigest(ids)
      const key = modelHistoryKey(fetchedAt, digest)
      if (parseSnapshot(key, await storage.get(key))) return "exists"
      await storage.set(key, { v: 1, fetchedAt, recordedAt, source: observation.source, ids })
      return "appended"
    },
    async prune(keep) {
      const limit = Math.max(1, Math.floor(keep))
      const snapshots = await scanAll()
      const excess = snapshots.length - limit
      if (excess <= 0) return 0
      // The flag goes first. A failure after it leaves a true statement. A failure before it removes nothing.
      await storage.set(HISTORY_META_KEY, { v: 1, truncated: true })
      for (const snapshot of snapshots.slice(0, excess)) await storage.remove(snapshot.key)
      return excess
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tracker

/** Applied lists that wait in memory for a successful write. A full queue drops its oldest list. */
export const MAX_PENDING_OBSERVATIONS = 20

export interface ModelHistoryTrackerInput {
  readonly store: ModelHistoryStore
  readonly log: Logger
  readonly now: () => Date
  /** Whether this location registers the model. */
  readonly isEligible: (id: string) => boolean
  /** Known keys now. The tracker also remembers earlier values, so a rotated key stays out of the store. */
  readonly secrets: () => readonly (string | undefined)[]
  readonly keep?: number
}

export interface CachedListInput {
  readonly fetchedAt: unknown
  readonly ids: readonly string[]
}

export interface ModelHistoryTracker {
  /**
   * Startup. Queues the cached list at its own `fetchedAt`; it is written when the store is empty or its latest list
   * differs. A cache without a valid `fetchedAt` records nothing. Returns the projection.
   */
  seed(cached: CachedListInput | undefined): Promise<ModelHistory | null>
  /**
   * Queues an applied list, writes every queued list oldest `fetchedAt` first, and returns the projection. A list whose
   * write fails stays queued with its original `fetchedAt`, and the next call retries it before it does anything else.
   */
  record(observation: ModelHistoryObservation): Promise<ModelHistory | null>
  /** Retries the queued lists, then reads and projects. */
  refresh(): Promise<ModelHistory | null>
  /** The latest projection that was read, or `null` when none was. */
  current(): ModelHistory | null
  /**
   * Forgets the remembered keys and the queue. Later calls return the latest projection and touch no storage. Lists that
   * were still queued at that time are lost. A store that fails until a restart cannot be backfilled afterwards.
   */
  close(): void
}

interface PendingItem {
  readonly key: string
  readonly fetchedAt: string
  readonly digest: string
  readonly source: ModelHistorySource
  readonly ids: readonly string[]
  /** `seed`: skip when the latest stored list has the same digest. `record`: skip a later repeat of the latest list. */
  readonly mode: "seed" | "record"
}

/**
 * Serializes every read, append, prune, and projection of one plugin instance. A storage failure never throws: it logs
 * one fixed warning per streak and returns the previous good projection, or `null` when there is none.
 *
 * A list that was applied but not yet stored waits in a bounded queue in memory (`MAX_PENDING_OBSERVATIONS`). A write
 * failure keeps it with its original `fetchedAt`. A list that is invalid, rejected by the store, or secret-like leaves
 * the queue at once and is never retried.
 */
export function createModelHistoryTracker(input: ModelHistoryTrackerInput): ModelHistoryTracker {
  const keep = input.keep ?? MAX_HISTORY_SNAPSHOTS
  const seen = new Set<string>()
  let chain: Promise<unknown> = Promise.resolve()
  let pending: PendingItem[] = []
  let closed = false
  let last: ModelHistory | null = null
  let failing = false
  let hadFailure = false
  let warnedSecret = false
  let warnedInvalid = false
  let warnedOverflow = false

  const remember = (): void => {
    try {
      for (const value of input.secrets()) {
        if (typeof value === "string" && value !== "") seen.add(value)
      }
    } catch {
      // Keep what is known.
    }
  }

  const unsafe = (ids: readonly string[]): boolean => {
    remember()
    return ids.some((id) => redact(id) !== id || [...seen].some((secret) => id.includes(secret)))
  }

  const warnInvalid = (): void => {
    if (warnedInvalid) return
    warnedInvalid = true
    input.log.warn("FueliX model history skipped a model list that is empty, too large, or invalid")
  }

  const warnSecret = (): void => {
    if (warnedSecret) return
    warnedSecret = true
    input.log.warn("FueliX model history skipped a model list that contains secret-like text")
  }

  const fail = (): void => {
    hadFailure = true
    if (failing) return
    failing = true
    input.log.warn("FueliX model history could not be read or written; discovery continues")
  }

  const project = async (): Promise<ModelHistory | null> => {
    last = projectModelHistory(await input.store.list(), { isEligible: input.isEligible })
    return last
  }

  /** Adds a safe, valid list to the queue. An unsafe or invalid list never enters it. */
  const enqueue = (observation: ModelHistoryObservation, mode: PendingItem["mode"]): void => {
    const fetchedAt = canonicalISO(observation.fetchedAt)
    if (!fetchedAt) return
    const ids = normalizeIDs(observation.ids)
    if (!ids) return warnInvalid()
    if (unsafe(ids)) return warnSecret()
    const digest = modelHistoryDigest(ids)
    const key = modelHistoryKey(fetchedAt, digest)
    if (pending.some((item) => item.key === key)) return
    pending.push({ key, fetchedAt, digest, source: observation.source, ids, mode })
    pending.sort((a, b) => (a.fetchedAt === b.fetchedAt ? (a.digest < b.digest ? -1 : 1) : a.fetchedAt < b.fetchedAt ? -1 : 1))
    if (pending.length > MAX_PENDING_OBSERVATIONS) {
      pending.shift()
      if (!warnedOverflow) {
        warnedOverflow = true
        input.log.warn("FueliX model history queue is full; the oldest list that was not stored is dropped")
      }
    }
  }

  /**
   * Writes the queue, oldest first. An item leaves the queue only when the store confirms it (`appended` or `exists`),
   * or when it is invalid or unsafe. A failure keeps the item and every newer one, so a later retry keeps the order.
   */
  const drain = async (): Promise<void> => {
    while (pending.length > 0 && !closed) {
      const item = pending[0]!
      try {
        if (unsafe(item.ids)) {
          warnSecret()
        } else {
          const { snapshots } = await input.store.list()
          const latest = snapshots[snapshots.length - 1]
          const repeated =
            latest !== undefined &&
            latest.digest === item.digest &&
            (item.mode === "seed" || latest.fetchedAt <= item.fetchedAt)
          if (!repeated) {
            const result = await input.store.append({
              fetchedAt: item.fetchedAt,
              recordedAt: input.now().toISOString(),
              source: item.source,
              ids: item.ids,
            })
            if (result === "rejected") warnInvalid()
            else if (result === "appended") {
              try {
                await input.store.prune(keep)
              } catch {
                fail() // The list is stored. The next append prunes again.
              }
            }
          }
        }
      } catch {
        fail()
        return
      }
      if (pending[0] === item) pending.shift()
    }
  }

  const guarded = (task: () => Promise<ModelHistory | null>): Promise<ModelHistory | null> => {
    const run = chain.then(async () => {
      if (closed) return last
      try {
        const result = await task()
        failing = hadFailure
        hadFailure = false
        return result
      } catch {
        fail()
        hadFailure = false
        return last
      }
    })
    chain = run
    return run
  }

  return {
    seed: (cached) =>
      guarded(async () => {
        const fetchedAt = cached ? canonicalISO(cached.fetchedAt) : undefined
        if (cached && fetchedAt) enqueue({ fetchedAt, source: "cache", ids: cached.ids }, "seed")
        await drain()
        return project()
      }),
    record: (observation) =>
      guarded(async () => {
        enqueue(observation, "record")
        await drain()
        return project()
      }),
    refresh: () =>
      guarded(async () => {
        await drain()
        return project()
      }),
    current: () => last,
    close() {
      closed = true
      pending = []
      seen.clear()
    },
  }
}
