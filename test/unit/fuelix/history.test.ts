import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import {
  canonicalISO,
  createModelHistoryTracker,
  createStorageModelHistory,
  MAX_PENDING_OBSERVATIONS,
  HISTORY_META_KEY,
  HISTORY_PREFIX,
  MAX_SNAPSHOT_IDS,
  modelHistoryDigest,
  modelHistoryKey,
  parseSnapshot,
  projectModelHistory,
  type ModelHistoryRead,
  type ModelHistorySnapshot,
  type ModelHistoryStore,
} from "../../../src/fuelix/history.ts"
import { sanitizeReport, type FuelixStatusReport } from "../../../src/fuelix/status.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const T0 = "2026-11-12T10:00:00.000Z"
const T1 = "2026-11-12T11:00:00.000Z"
const T2 = "2026-11-12T12:00:00.000Z"
const KEY = "sk-test-not-a-real-key"

function memory() {
  const fake = createFakeCtx()
  return { fake, storage: fake.ctx.storage, map: fake.storage, state: fake.state }
}

function snapshot(fetchedAt: string, ids: string[], source: "discovery" | "cache" = "discovery"): ModelHistorySnapshot {
  const sorted = [...new Set(ids)].sort()
  const digest = modelHistoryDigest(sorted)
  return { key: modelHistoryKey(fetchedAt, digest), fetchedAt, recordedAt: fetchedAt, source, ids: sorted, digest }
}

const all = () => true
const warnings = (log: { lines: string[] }) => log.lines.filter((line) => line.includes(" warn "))

describe("keys and validation", () => {
  test("digest is the SHA-256 of the sorted JSON list and the key holds fetchedAt and digest", async () => {
    const { storage, map } = memory()
    const store = createStorageModelHistory(storage)
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: ["b", "a", "b"] })).toBe("appended")
    const digest = createHash("sha256").update(JSON.stringify(["a", "b"])).digest("hex")
    expect(digest).toHaveLength(64)
    const key = `${HISTORY_PREFIX}${T0}/${digest}`
    expect([...map.keys()]).toEqual([key])
    expect(map.get(key)).toEqual({ v: 1, fetchedAt: T0, recordedAt: T0, source: "discovery", ids: ["a", "b"] })
  })

  test("the same observation is idempotent and writes nothing twice", async () => {
    const { storage, state } = memory()
    const store = createStorageModelHistory(storage)
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: ["a", "b"] })).toBe("appended")
    expect(await store.append({ fetchedAt: T0, source: "cache", ids: ["b", "a"] })).toBe("exists")
    expect(state.storageWrites).toBe(1)
    expect((await store.list()).snapshots).toHaveLength(1)
  })

  test("different lists use different keys and nothing is lost", async () => {
    const { storage } = memory()
    const store = createStorageModelHistory(storage)
    await Promise.all([
      store.append({ fetchedAt: T0, source: "discovery", ids: ["a"] }),
      store.append({ fetchedAt: T0, source: "discovery", ids: ["a", "b"] }),
      store.append({ fetchedAt: T1, source: "discovery", ids: ["a"] }),
    ])
    expect((await store.list()).snapshots).toHaveLength(3)
  })

  test("a list that is empty, too large, or has an invalid ID or time is rejected as a whole", async () => {
    const { storage, state } = memory()
    const store = createStorageModelHistory(storage)
    const many = Array.from({ length: MAX_SNAPSHOT_IDS + 1 }, (_, index) => `m-${index}`)
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: [] })).toBe("rejected")
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: many })).toBe("rejected")
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: ["a", ""] })).toBe("rejected")
    expect(await store.append({ fetchedAt: "yesterday", source: "discovery", ids: ["a"] })).toBe("rejected")
    expect(await store.append({ fetchedAt: "2026-11-12T10:00:00Z", source: "discovery", ids: ["a"] })).toBe("rejected")
    expect(state.storageWrites).toBe(0)
    const exact = many.slice(0, MAX_SNAPSHOT_IDS)
    expect(await store.append({ fetchedAt: T0, source: "discovery", ids: exact })).toBe("appended")
    expect((await store.list()).snapshots[0]!.ids).toHaveLength(MAX_SNAPSHOT_IDS)
  })

  test("parseSnapshot recomputes the digest and checks the whole key", () => {
    const good = snapshot(T0, ["a", "b"])
    const value = { v: 1, fetchedAt: T0, recordedAt: T0, source: "cache", ids: ["a", "b"] }
    expect(parseSnapshot(good.key, value)).toMatchObject({ source: "cache", digest: good.digest, ids: ["a", "b"] })
    expect(parseSnapshot(good.key, { ...value, ids: ["a", "c"] })).toBeUndefined()
    expect(parseSnapshot(good.key, { ...value, ids: ["b", "a"] })).toBeUndefined()
    expect(parseSnapshot(good.key, { ...value, fetchedAt: T1 })).toBeUndefined()
    expect(parseSnapshot(good.key, { ...value, v: 2 })).toBeUndefined()
    expect(parseSnapshot(good.key, { ...value, source: "other" })).toBeUndefined()
    expect(parseSnapshot(`${HISTORY_PREFIX}${T0}/short`, value)).toBeUndefined()
    expect(parseSnapshot(`${good.key}/extra`, value)).toBeUndefined()
    expect(parseSnapshot(good.key, null)).toBeUndefined()
    expect(parseSnapshot(good.key, { ...value, extra: "dropped" })).not.toHaveProperty("extra")
  })

  test("canonicalISO accepts only toISOString form", () => {
    expect(canonicalISO(T0)).toBe(T0)
    expect(canonicalISO("2026-11-12T10:00:00Z")).toBeUndefined()
    expect(canonicalISO("2026-02-31T10:00:00.000Z")).toBeUndefined()
    expect(canonicalISO("")).toBeUndefined()
    expect(canonicalISO(undefined)).toBeUndefined()
  })
})

describe("paged scan and prune", () => {
  test("list reads every page, sorted, and skips invalid entries", async () => {
    const { storage, map } = memory()
    const store = createStorageModelHistory(storage)
    for (let index = 0; index < 130; index++) {
      const at = new Date(Date.parse(T0) + index * 60_000).toISOString()
      await store.append({ fetchedAt: at, source: "discovery", ids: [`m-${index}`] })
    }
    map.set(`${HISTORY_PREFIX}garbage`, { nope: true })
    let pages = 0
    const target = storage as unknown as { scan: typeof storage.scan }
    const scan = target.scan
    target.scan = (async (options: Parameters<typeof scan>[0]) => {
      pages++
      return scan(options)
    }) as typeof scan
    const read = await store.list()
    expect(pages).toBeGreaterThan(1)
    expect(read.snapshots).toHaveLength(130)
    expect(read.snapshots.map((item) => item.fetchedAt)).toEqual([...read.snapshots.map((item) => item.fetchedAt)].sort())
    expect(read.truncated).toBe(false)
  })

  test("prune keeps the newest snapshots and sets the truncation flag before removing", async () => {
    const { storage, map } = memory()
    const store = createStorageModelHistory(storage)
    for (const [index, at] of [T0, T1, T2].entries()) await store.append({ fetchedAt: at, source: "discovery", ids: [`m-${index}`] })
    expect(await store.prune(5)).toBe(0)
    expect(map.has(HISTORY_META_KEY)).toBe(false)
    expect(await store.prune(2)).toBe(1)
    const read = await store.list()
    expect(read.snapshots.map((item) => item.fetchedAt)).toEqual([T1, T2])
    expect(read.truncated).toBe(true)
    expect(map.get(HISTORY_META_KEY)).toEqual({ v: 1, truncated: true })
    // The flag stays true.
    expect(await store.prune(2)).toBe(0)
    expect((await store.list()).truncated).toBe(true)
  })

  test("a failed flag write removes nothing", async () => {
    const { storage, map } = memory()
    const store = createStorageModelHistory(storage)
    for (const [index, at] of [T0, T1, T2].entries()) await store.append({ fetchedAt: at, source: "discovery", ids: [`m-${index}`] })
    const target = storage as unknown as { set: typeof storage.set }
    const set = target.set
    target.set = (async (key: string, value: never) => {
      if (key === HISTORY_META_KEY) throw new Error("denied")
      return set(key, value)
    }) as typeof set
    await expect(store.prune(1)).rejects.toThrow()
    expect([...map.keys()].filter((key) => key.startsWith(HISTORY_PREFIX))).toHaveLength(3)
    expect(map.has(HISTORY_META_KEY)).toBe(false)
  })
})

describe("projection", () => {
  const read = (snapshots: ModelHistorySnapshot[], truncated = false): ModelHistoryRead => ({ snapshots, truncated })

  test("is null without a snapshot", () => {
    expect(projectModelHistory(read([]), { isEligible: all })).toBeNull()
  })

  test("the first list is the baseline and changes are newest first", () => {
    const result = projectModelHistory(
      read([snapshot(T0, ["a", "b"], "cache"), snapshot(T1, ["a", "b", "c"]), snapshot(T2, ["a", "c", "d"])]),
      { isEligible: all },
    )
    expect(result).toEqual({
      since: T0,
      truncated: false,
      entries: [
        { kind: "change", fetchedAt: T2, source: "discovery", totalIDs: 3, eligible: 3, added: ["d"], removed: ["b"] },
        { kind: "change", fetchedAt: T1, source: "discovery", totalIDs: 3, eligible: 3, added: ["c"], removed: [] },
        { kind: "baseline", fetchedAt: T0, source: "cache", totalIDs: 2, eligible: 2, added: [], removed: [] },
      ],
    })
  })

  test("consecutive equal lists collapse into the first, and the store is not changed", () => {
    const input = read([snapshot(T0, ["a"]), snapshot(T1, ["a", "b"]), snapshot(T2, ["a", "b"])])
    const result = projectModelHistory(input, { isEligible: all })!
    expect(result.entries.map((entry) => entry.fetchedAt)).toEqual([T1, T0])
    expect(input.snapshots).toHaveLength(3)
  })

  test("changes of IDs that the location ignores are hidden but counted in the totals", () => {
    const eligible = (id: string) => !id.startsWith("embed-")
    const result = projectModelHistory(
      read([snapshot(T0, ["a", "embed-1"]), snapshot(T1, ["a", "embed-1", "embed-2"]), snapshot(T2, ["a", "b", "embed-1", "embed-2"])]),
      { isEligible: eligible },
    )!
    expect(result.entries.map((entry) => entry.fetchedAt)).toEqual([T2, T0])
    expect(result.entries[0]).toMatchObject({ added: ["b"], removed: [], totalIDs: 4, eligible: 2 })
    expect(result.entries[1]).toMatchObject({ kind: "baseline", totalIDs: 2, eligible: 1 })
  })

  test("an out-of-order older observation sorts into place and does not look like a removal and re-addition", () => {
    // S1 was stored first; the older S0 arrives later. The key order, not the write order, defines the history.
    const result = projectModelHistory(read([snapshot(T1, ["a", "b", "c"]), snapshot(T0, ["a", "b"], "cache")]), { isEligible: all })!
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ kind: "change", fetchedAt: T1, added: ["c"], removed: [] })
    expect(result.entries[1]).toMatchObject({ kind: "baseline", fetchedAt: T0 })
    // The same list again at a later time is a repeat, not a new change.
    const repeated = projectModelHistory(read([snapshot(T0, ["a", "b"]), snapshot(T1, ["a", "b", "c"]), snapshot(T2, ["a", "b", "c"])]), { isEligible: all })!
    expect(repeated.entries.filter((entry) => entry.removed.length > 0)).toHaveLength(0)
  })

  test("at most 50 entries show; omitted entries set truncated and the baseline leaves the window", () => {
    const snapshots = Array.from({ length: 60 }, (_, index) =>
      snapshot(new Date(Date.parse(T0) + index * 60_000).toISOString(), Array.from({ length: index + 1 }, (_, item) => `m-${item}`)),
    )
    const result = projectModelHistory(read(snapshots), { isEligible: all })!
    expect(result.entries).toHaveLength(50)
    expect(result.truncated).toBe(true)
    expect(result.since).toBe(snapshots[0]!.fetchedAt)
    expect(result.entries.some((entry) => entry.kind === "baseline")).toBe(false)
    expect(result.entries[0]!.fetchedAt).toBe(snapshots[59]!.fetchedAt)
    const small = projectModelHistory(read(snapshots.slice(0, 50)), { isEligible: all })!
    expect(small.truncated).toBe(false)
    expect(small.entries[49]!.kind).toBe("baseline")
  })

  test("the stored truncation flag is carried and the character budget omits older entries", () => {
    const store = projectModelHistory(read([snapshot(T0, ["a"])], true), { isEligible: all })!
    expect(store.truncated).toBe(true)
    const big = Array.from({ length: 200 }, (_, index) => `model-${index}`)
    const result = projectModelHistory(
      read([snapshot(T0, ["a"]), snapshot(T1, ["a", ...big]), snapshot(T2, ["a"])]),
      { isEligible: all, maxChars: 1500 },
    )!
    expect(result.entries.length).toBeLessThan(3)
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.truncated).toBe(true)
  })

  test("an eligibility function that throws does not break the projection", () => {
    const result = projectModelHistory(read([snapshot(T0, ["a"])]), {
      isEligible: () => {
        throw new Error("boom")
      },
    })!
    expect(result.entries[0]).toMatchObject({ totalIDs: 1, eligible: 0 })
  })
})

describe("tracker", () => {
  function tracker(store: ModelHistoryStore, extra: { secrets?: () => (string | undefined)[]; keep?: number } = {}) {
    const log = createMemoryLogger()
    const instance = createModelHistoryTracker({
      store,
      log,
      now: () => new Date(T2),
      isEligible: all,
      secrets: extra.secrets ?? (() => [KEY]),
      ...(extra.keep === undefined ? {} : { keep: extra.keep }),
    })
    return { instance, log }
  }

  test("seed records the cache as a cache baseline at its own fetchedAt and nothing else", async () => {
    const { storage, map } = memory()
    const { instance } = tracker(createStorageModelHistory(storage))
    const result = await instance.seed({ fetchedAt: T0, ids: ["b", "a"] })
    expect(result).toEqual({
      since: T0,
      truncated: false,
      entries: [{ kind: "baseline", fetchedAt: T0, source: "cache", totalIDs: 2, eligible: 2, added: [], removed: [] }],
    })
    expect([...map.keys()]).toHaveLength(1)
    expect([...map.values()][0]).toMatchObject({ recordedAt: T2, source: "cache" })
  })

  test("seed without a valid fetchedAt, or without a cache, records nothing and invents no time", async () => {
    const { storage, state } = memory()
    const { instance } = tracker(createStorageModelHistory(storage))
    expect(await instance.seed({ fetchedAt: "", ids: ["a"] })).toBeNull()
    expect(await instance.seed({ fetchedAt: "not a date", ids: ["a"] })).toBeNull()
    expect(await instance.seed({ fetchedAt: 42, ids: ["a"] })).toBeNull()
    expect(await instance.seed(undefined)).toBeNull()
    expect(state.storageWrites).toBe(0)
  })

  test("seed writes nothing when the latest stored list equals the cache and appends when it differs", async () => {
    const { storage, state } = memory()
    const store = createStorageModelHistory(storage)
    await store.append({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })
    const { instance } = tracker(store)
    await instance.seed({ fetchedAt: T1, ids: ["a", "b"] })
    await instance.seed({ fetchedAt: T1, ids: ["a", "b"] })
    expect(state.storageWrites).toBe(1)
    // An older cache with a different list, from an old plugin, still lands in order.
    const result = await instance.seed({ fetchedAt: T0, ids: ["a"] })
    expect(result!.entries.map((entry) => [entry.kind, entry.fetchedAt, entry.source])).toEqual([
      ["change", T1, "discovery"],
      ["baseline", T0, "cache"],
    ])
  })

  test("record skips a repeat of the latest list and appends a new one", async () => {
    const { storage, state } = memory()
    const { instance } = tracker(createStorageModelHistory(storage))
    await instance.seed({ fetchedAt: T0, ids: ["a"] })
    expect(state.storageWrites).toBe(1)
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    expect(state.storageWrites).toBe(1)
    const result = await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })
    expect(state.storageWrites).toBe(2)
    expect(result!.entries[0]).toMatchObject({ kind: "change", added: ["b"] })
  })

  test("two trackers over one store record the same list once in the projection", async () => {
    const { storage } = memory()
    const store = createStorageModelHistory(storage)
    const one = tracker(store).instance
    const two = tracker(store).instance
    await one.seed({ fetchedAt: T0, ids: ["a"] })
    await Promise.all([
      one.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] }),
      two.record({ fetchedAt: "2026-11-12T11:00:00.500Z", source: "discovery", ids: ["a", "b"] }),
    ])
    const result = (await one.refresh())!
    expect(result.entries.map((entry) => entry.kind)).toEqual(["change", "baseline"])
  })

  test("calls of one tracker run in order", async () => {
    const { storage } = memory()
    const { instance } = tracker(createStorageModelHistory(storage))
    await Promise.all([
      instance.record({ fetchedAt: T0, source: "discovery", ids: ["a"] }),
      instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] }),
      instance.record({ fetchedAt: T2, source: "discovery", ids: ["b"] }),
    ])
    const result = instance.current()!
    expect(result.entries.map((entry) => [entry.kind, entry.added, entry.removed])).toEqual([
      ["change", [], ["a"]],
      ["change", ["b"], []],
      ["baseline", [], []],
    ])
  })

  test("a list with a current key, a rotated key, or a secret-like ID is skipped whole, with one fixed warning", async () => {
    const { storage, state } = memory()
    let keys: (string | undefined)[] = [KEY]
    const { instance, log } = tracker(createStorageModelHistory(storage), { secrets: () => keys })
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a", `model-${KEY}`] })
    keys = ["sk-test-rotated-key-2"]
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a", `model-${KEY}-x`] })
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a", "model-sk-test-rotated-key-2"] })
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a", "sk-abcdefghijk"] })
    keys = ["a"] // A short known key matches whatever contains it.
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a"] })
    expect(state.storageWrites).toBe(0)
    const warned = warnings(log)
    expect(warned).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
    expect(log.lines.join("\n")).not.toContain("rotated")
    expect(log.lines.join("\n")).not.toContain("sk-abcdefghijk")
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["x-1"] })
    expect(state.storageWrites).toBe(1)
  })

  test("a store failure is nonfatal, keeps the previous projection, and warns once per streak", async () => {
    const { storage } = memory()
    const real = createStorageModelHistory(storage)
    let broken = false
    const store: ModelHistoryStore = {
      list: () => (broken ? Promise.reject(new Error(`list failed ${KEY}`)) : real.list()),
      append: (observation) => (broken ? Promise.reject(new Error("append failed")) : real.append(observation)),
      prune: (keep) => real.prune(keep),
    }
    const { instance, log } = tracker(store)
    expect(await instance.seed({ fetchedAt: T0, ids: ["a"] })).not.toBeNull()
    const good = instance.current()
    broken = true
    expect(await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })).toEqual(good)
    expect(await instance.refresh()).toEqual(good)
    expect(warnings(log)).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
    broken = false
    expect((await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] }))!.entries).toHaveLength(2)
    broken = true
    await instance.refresh()
    expect(warnings(log)).toHaveLength(2)
  })

  test("a store that is unreadable from the start gives null", async () => {
    const store: ModelHistoryStore = {
      list: () => Promise.reject(new Error("no")),
      append: () => Promise.reject(new Error("no")),
      prune: () => Promise.reject(new Error("no")),
    }
    const { instance } = tracker(store)
    expect(await instance.seed({ fetchedAt: T0, ids: ["a"] })).toBeNull()
  })

  test("a failed prune keeps the snapshot and the projection", async () => {
    const { storage } = memory()
    const real = createStorageModelHistory(storage)
    const store: ModelHistoryStore = { ...real, list: () => real.list(), append: (o) => real.append(o), prune: () => Promise.reject(new Error("no")) }
    const { instance, log } = tracker(store)
    const result = await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a"] })
    expect(result!.entries).toHaveLength(1)
    expect(warnings(log)).toHaveLength(1)
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })
    expect(warnings(log)).toHaveLength(1)
  })

  test("append prunes to the keep count and marks the projection truncated", async () => {
    const { storage } = memory()
    const { instance } = tracker(createStorageModelHistory(storage), { keep: 2 })
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a"] })
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })
    const result = (await instance.record({ fetchedAt: T2, source: "discovery", ids: ["b"] }))!
    expect(result.truncated).toBe(true)
    expect(result.since).toBe(T1)
    expect(result.entries.map((entry) => entry.kind)).toEqual(["change", "baseline"])
  })

  test("close stops all storage access", async () => {
    const { storage, state } = memory()
    const { instance } = tracker(createStorageModelHistory(storage))
    await instance.record({ fetchedAt: T0, source: "discovery", ids: ["a"] })
    const before = instance.current()
    instance.close()
    expect(await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })).toEqual(before)
    expect(state.storageWrites).toBe(1)
  })
})

describe("tracker queue of applied lists", () => {
  /** A store over real storage whose failures a test switches on and off, and whose calls it counts. */
  function flaky() {
    const { storage, map } = memory()
    const real = createStorageModelHistory(storage)
    const mode = { list: false, append: false, appendAfterWrite: false, prune: false, syncList: false, rejectAppend: false }
    const calls: string[] = []
    const store: ModelHistoryStore = {
      list: () => {
        if (mode.syncList) throw new Error(`sync ${KEY}`)
        return mode.list ? Promise.reject(new Error(`list ${KEY}`)) : real.list()
      },
      append: async (observation) => {
        calls.push(`append:${observation.fetchedAt}:${observation.ids.length}`)
        if (mode.append) throw new Error(`append ${KEY}`)
        if (mode.rejectAppend) return "rejected"
        const result = await real.append(observation)
        if (mode.appendAfterWrite) throw new Error("lost the answer")
        return result
      },
      prune: (keep) => (mode.prune ? Promise.reject(new Error("prune")) : real.prune(keep)),
    }
    const log = createMemoryLogger()
    let keys: (string | undefined)[] = [KEY]
    const instance = createModelHistoryTracker({ store, log, now: () => new Date(T2), isEligible: all, secrets: () => keys })
    return { instance, log, mode, calls, map, real, setKeys: (next: (string | undefined)[]) => void (keys = next) }
  }
  const keysOf = (map: Map<string, unknown>) => [...map.keys()].filter((key) => key.startsWith(HISTORY_PREFIX))

  test("a failed append keeps the list; the next record stores S1 and S2 with their own times", async () => {
    const { instance, mode, map, log } = flaky()
    await instance.seed({ fetchedAt: T0, ids: ["a"] })
    mode.append = true
    const stale = await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "x1"] })
    expect(stale!.entries.map((entry) => entry.kind)).toEqual(["baseline"]) // The old projection, not S1.
    mode.append = false
    const result = await instance.record({ fetchedAt: T2, source: "discovery", ids: ["a", "x1", "x2"] })
    expect(keysOf(map)).toHaveLength(3)
    expect(result!.entries.map((entry) => [entry.kind, entry.fetchedAt, entry.added])).toEqual([
      ["change", T2, ["x2"]],
      ["change", T1, ["x1"]],
      ["baseline", T0, []],
    ])
    expect(warnings(log)).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a retry writes the oldest fetchedAt first, whatever the arrival order", async () => {
    const { instance, mode, calls } = flaky()
    mode.append = true
    await instance.record({ fetchedAt: T2, source: "discovery", ids: ["a", "b"] })
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    mode.append = false
    calls.length = 0
    await instance.refresh()
    expect(calls).toEqual([`append:${T1}:1`, `append:${T2}:2`])
  })

  test("a failing list read keeps the item without an append, and a later read stores it once", async () => {
    const { instance, mode, calls, map } = flaky()
    mode.list = true
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    await instance.refresh()
    expect(calls).toEqual([])
    mode.list = false
    await instance.refresh()
    await instance.refresh()
    expect(calls).toHaveLength(1)
    expect(keysOf(map)).toHaveLength(1)
  })

  test("a synchronous throw from the store is nonfatal", async () => {
    const { instance, mode, log } = flaky()
    mode.syncList = true
    expect(await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })).toBeNull()
    expect(await instance.refresh()).toBeNull()
    expect(warnings(log)).toHaveLength(1)
    mode.syncList = false
    expect((await instance.refresh())!.entries).toHaveLength(1)
  })

  test("an append that wrote but failed to answer is confirmed as stored on retry and leaves the queue once", async () => {
    const { instance, mode, calls, map } = flaky()
    mode.appendAfterWrite = true
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    expect(keysOf(map)).toHaveLength(1)
    mode.appendAfterWrite = false
    await instance.refresh()
    await instance.refresh()
    expect(calls).toHaveLength(1) // The retry finds the list stored and removes it from the queue without a second write.
    expect(keysOf(map)).toHaveLength(1)
  })

  test("a failed prune does not return the stored list to the queue", async () => {
    const { instance, mode, calls } = flaky()
    mode.prune = true
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    await instance.refresh()
    expect(calls).toHaveLength(1)
  })

  test("a list that the store rejects, or that is secret-like, is dropped and never retried", async () => {
    const { instance, mode, calls, log, setKeys } = flaky()
    mode.rejectAppend = true
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    mode.rejectAppend = false
    await instance.refresh()
    expect(calls).toHaveLength(1)
    // A secret-like list never enters the queue.
    await instance.record({ fetchedAt: T1, source: "discovery", ids: [`m-${KEY}`] })
    await instance.refresh()
    expect(calls).toHaveLength(1)
    // A list that waits while the store fails, and then holds a key that is known by then, is dropped.
    mode.append = true
    await instance.record({ fetchedAt: T2, source: "discovery", ids: ["m-later-rotated-key"] })
    setKeys(["later-rotated-key"])
    mode.append = false
    await instance.refresh()
    await instance.refresh()
    expect(calls).toHaveLength(2)
    expect(log.lines.join("\n")).not.toContain("later-rotated-key")
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("the queue is bounded; overflow drops the oldest lists with one fixed warning", async () => {
    const { instance, mode, map, log } = flaky()
    mode.append = true
    const total = MAX_PENDING_OBSERVATIONS + 5
    for (let index = 0; index < total; index++) {
      const at = new Date(Date.parse(T0) + index * 60_000).toISOString()
      await instance.record({ fetchedAt: at, source: "discovery", ids: [`secret-looking-id-${index}`] })
    }
    const overflow = warnings(log).filter((line) => line.includes("queue is full"))
    expect(overflow).toHaveLength(1)
    expect(log.lines.join("\n")).not.toContain("secret-looking-id")
    mode.append = false
    const result = (await instance.refresh())!
    expect(keysOf(map)).toHaveLength(MAX_PENDING_OBSERVATIONS)
    expect(result.since).toBe(new Date(Date.parse(T0) + 5 * 60_000).toISOString())
  })

  test("close clears the queue and later calls touch no storage", async () => {
    const { instance, mode, calls } = flaky()
    mode.append = true
    await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a"] })
    instance.close()
    mode.append = false
    calls.length = 0
    await instance.refresh()
    await instance.record({ fetchedAt: T2, source: "discovery", ids: ["a", "b"] })
    expect(calls).toEqual([])
  })

  test("a queued cache baseline from seed is retried like any other list", async () => {
    const { instance, mode, map } = flaky()
    mode.append = true
    expect(await instance.seed({ fetchedAt: T0, ids: ["a"] })).toBeNull()
    mode.append = false
    const result = await instance.record({ fetchedAt: T1, source: "discovery", ids: ["a", "b"] })
    expect(keysOf(map)).toHaveLength(2)
    expect(result!.entries.map((entry) => [entry.kind, entry.source, entry.fetchedAt])).toEqual([
      ["change", "discovery", T1],
      ["baseline", "cache", T0],
    ])
  })
})

describe("report sanitizing of the history", () => {
  const base = sanitizeReport({
    version: 1,
    pluginVersion: "0",
    directory: null,
    startedAt: T0,
    recordedAt: T0,
    checking: false,
    configuration: {
      refreshMinutes: 60,
      includeNonChatModels: false,
      authSource: "none",
      activation: "auto",
      shellKeyScrubbing: "enabled",
      batchTools: "registered",
      authHooks: { sessionProviders: [], aiSdk: false },
    },
    models: { source: "cache", providers: [] },
    lastCheck: null,
    lastSuccessfulCheckAt: null,
    lastChange: null,
  })
  const withHistory = (modelHistory: FuelixStatusReport["modelHistory"]): FuelixStatusReport => ({ ...base, modelHistory })

  test("an older report has no modelHistory key, null stays null", () => {
    expect(base).not.toHaveProperty("modelHistory")
    expect(sanitizeReport(withHistory(null)).modelHistory).toBeNull()
  })

  test("every history string loses known keys, entries are rebuilt, and a baseline has no IDs", () => {
    const report = sanitizeReport(
      withHistory({
        since: T0,
        truncated: false,
        entries: [
          { kind: "change", fetchedAt: T1, source: "discovery", totalIDs: 3, eligible: 2, added: [`m-${KEY}`, "ok"], removed: ["old"] },
          { kind: "baseline", fetchedAt: T0, source: "cache", totalIDs: 1, eligible: 1, added: ["x"], removed: ["y"], extra: 1 } as never,
        ],
      }),
      [KEY],
    )
    expect(JSON.stringify(report)).not.toContain(KEY)
    expect(report.modelHistory!.entries[0]).toMatchObject({ added: ["m-[redacted]", "ok"], removed: ["old"] })
    expect(report.modelHistory!.entries[1]).toEqual({ kind: "baseline", fetchedAt: T0, source: "cache", totalIDs: 1, eligible: 1, added: [], removed: [] })
  })

  test("more than 50 entries are cut to 50 and marked truncated", () => {
    const entry = { kind: "change", fetchedAt: T1, source: "discovery", totalIDs: 1, eligible: 1, added: ["a"], removed: [] } as const
    const report = sanitizeReport(withHistory({ since: T0, truncated: false, entries: Array.from({ length: 55 }, () => entry) }))
    expect(report.modelHistory!.entries).toHaveLength(50)
    expect(report.modelHistory!.truncated).toBe(true)
  })
})
