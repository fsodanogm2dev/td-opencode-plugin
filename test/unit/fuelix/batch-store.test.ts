import { describe, expect, test } from "bun:test"
import {
  BatchStore,
  BatchStoreError,
  MAX_PAGE_LIMIT,
  newJobID,
  normalizePage,
  parseBatchRemoteState,
  parseRecord,
  type BatchJobRecord,
  type BatchRemoteState,
  type BatchStorage,
} from "../../../src/fuelix/batch/store.ts"
import { MAX_RATE_SOURCE_LENGTH } from "../../../src/fuelix/batch/pricing.ts"
import type { BatchCost } from "../../../src/fuelix/batch/types.ts"

/** Minimal in-memory plugin storage with key-ordered scan. */
class MemoryStorage {
  readonly map = new Map<string, unknown>()
  async get(key: string) {
    return this.map.get(key)
  }
  async set(key: string, value: unknown) {
    this.map.set(key, structuredClone(value))
  }
  async remove(key: string) {
    this.map.delete(key)
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.map.keys()]
      .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
      .sort()
    const limit = options.limit ?? 100
    const page = keys.slice(0, limit)
    return {
      entries: page.map((key) => ({ key, value: this.map.get(key) })),
      ...(keys.length > limit ? { next: page[page.length - 1]! } : {}),
    }
  }
}

const asStorage = (storage: MemoryStorage) => storage as unknown as BatchStorage

function record(sessionID: string, jobID: string, overrides: Partial<BatchJobRecord> = {}): BatchJobRecord {
  return {
    version: 1,
    jobID,
    originatingSession: sessionID,
    inputPath: "/work/input.jsonl",
    snapshotPath: `/artifacts/${jobID}/requests.json`,
    snapshotSha256: "a".repeat(64),
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    submission: "submitted",
    requestCount: 2,
    models: [{ model: "claude-sonnet-4-5", count: 2 }],
    otherModels: 0,
    batchID: `msgbatch_${jobID}`,
    collection: { state: "not_collected" },
    ...overrides,
  }
}

const remote = (): BatchRemoteState => ({
  status: "ended",
  counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
  createdAt: "2026-11-05T10:00:00.123456+03:30",
  endedAt: "2026-11-05T11:00:00-04:00",
  observedAt: "2026-11-05T16:00:00Z",
})

const collected = (cost: BatchCost): BatchJobRecord["collection"] => ({
  state: "collected",
  collectedAt: "2026-11-05T16:00:00Z",
  artifacts: { requests: "/a/requests.json", results: "/a/results.jsonl", successes: "/a/successes.jsonl", failures: "/a/failures.jsonl", manifest: "/a/manifest.json" },
  counts: { succeeded: 2, errored: 0, canceled: 0, expired: 0 },
  cost,
})

describe("newJobID", () => {
  test("later jobs sort first and IDs are artifact-safe", () => {
    const early = newJobID(new Date("2026-11-05T10:00:00.000Z"), () => "aaaaaaaa")
    const late = newJobID(new Date("2026-11-05T10:00:00.001Z"), () => "aaaaaaaa")
    expect(late < early).toBe(true)
    expect(early).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("BatchStore keys", () => {
  test("hash the session ID and separate sessions", () => {
    const store = new BatchStore(asStorage(new MemoryStorage()))
    const a = store.key("ses_secret_name", "job-1")
    const b = store.key("ses_other", "job-1")
    expect(a).not.toBe(b)
    expect(a).not.toContain("ses_secret_name")
    expect(a.startsWith(store.prefix("ses_secret_name"))).toBe(true)
    expect(() => store.prefix("")).toThrow(BatchStoreError)
    expect(() => store.key("ses_a", "../escape")).toThrow(BatchStoreError)
  })
})

describe("BatchStore records", () => {
  test("round-trips records and keeps them private to the session", async () => {
    const storage = new MemoryStorage()
    const store = new BatchStore(asStorage(storage))
    const saved = record("ses_a", "job-1")
    await store.put(saved)
    expect(await store.get("ses_a", "job-1")).toEqual(saved)
    expect(await store.get("ses_b", "job-1")).toBeUndefined()
    // A record planted under another session's key is still rejected.
    storage.map.set(store.key("ses_b", "job-1"), structuredClone(saved))
    expect(await store.get("ses_b", "job-1")).toBeUndefined()
  })

  test("stores plain JSON only", async () => {
    const storage = new MemoryStorage()
    const store = new BatchStore(asStorage(storage))
    await store.put(record("ses_a", "job-1", { httpStatus: undefined }))
    const stored = storage.map.get(store.key("ses_a", "job-1"))
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
    expect(Object.keys(stored as object)).not.toContain("httpStatus")
  })

  test("rejects invalid and oversized records", async () => {
    const store = new BatchStore(asStorage(new MemoryStorage()))
    await expect(store.put(record("ses_a", "job-1", { submission: "bogus" as never }))).rejects.toThrow(BatchStoreError)
    await expect(store.put(record("ses_a", "job-1", { requestCount: -1 }))).rejects.toThrow(BatchStoreError)
    const huge = "x".repeat(70 * 1024)
    await expect(store.put(record("ses_a", "job-1", { inputPath: huge }))).rejects.toThrow(BatchStoreError)
  })

  test("parseRecord validates the nested shapes", () => {
    const good = record("ses_a", "job-1")
    expect(parseRecord(good)).toBeDefined()
    expect(parseRecord({ ...good, version: 2 })).toBeUndefined()
    expect(parseRecord({ ...good, batchID: "bad id" })).toBeUndefined()
    expect(parseRecord({ ...good, collection: { state: "collected" } })).toBeUndefined()
    expect(
      parseRecord({
        ...good,
        remote: {
          status: "ended",
          counts: { processing: 0, succeeded: 1, errored: -1, canceled: 0, expired: 0 },
          createdAt: "x",
          endedAt: null,
          observedAt: "x",
        },
      }),
    ).toBeUndefined()
    expect(parseRecord(null)).toBeUndefined()
    expect(parseRecord("text")).toBeUndefined()
  })

  test("accepts rate-card sources up to 2048 characters and finite nonnegative costs", async () => {
    const store = new BatchStore(asStorage(new MemoryStorage()))
    for (const sourceLength of [1500, MAX_RATE_SOURCE_LENGTH]) {
      for (const kind of ["actual", "estimate"] as const) {
        const cost: BatchCost = kind === "actual" ? { kind, source: "s".repeat(sourceLength), currency: "USD", amount: 0 } : {
          kind, source: "s".repeat(sourceLength), currency: "USD", amount: 1,
          succeeded: 2, excluded: { errored: 0, canceled: 0, expired: 0 },
        }
        const saved = record("ses_a", `job-${kind}-${sourceLength}`, { collection: collected(cost) })
        await store.put(saved)
        expect((await store.get("ses_a", saved.jobID))?.collection.cost).toEqual(cost)
      }
    }
    const tooLong = collected({ kind: "actual", source: "s".repeat(MAX_RATE_SOURCE_LENGTH + 1), currency: "USD", amount: 1 })
    expect(parseRecord(record("ses_a", "job-too-long", { collection: tooLong }))).toBeUndefined()
    for (const amount of [-1, Number.NaN, Infinity, -Infinity]) {
      for (const kind of ["actual", "estimate"] as const) {
        const cost: BatchCost = kind === "actual" ? { kind, source: "s", currency: "USD", amount } : {
          kind, source: "s", currency: "USD", amount, succeeded: 2, excluded: { errored: 0, canceled: 0, expired: 0 },
        }
        const saved = record("ses_a", "job-invalid", { collection: collected(cost) })
        expect(parseRecord(saved)).toBeUndefined()
        await expect(store.put(saved)).rejects.toThrow(BatchStoreError)
      }
    }
  })

  test("rebuilds records and nested metadata without raw prompts or extra fields", async () => {
    const storage = new MemoryStorage()
    const store = new BatchStore(asStorage(storage))
    const state = remote()
    const cost = { kind: "actual", source: "fake invoice", currency: "USD", amount: 1 } as const
    const saved = {
      ...record("ses_a", "job-1", { remote: state, collection: collected(cost) }),
      prompt: "SECRET-PROMPT",
      models: [{ model: "m", count: 2, prompt: "SECRET-PROMPT" }],
      remote: { ...state, prompt: "SECRET-PROMPT", counts: { ...state.counts, prompt: "SECRET-PROMPT" } },
      collection: { ...collected(cost), prompt: "SECRET-PROMPT", cost: { ...cost, prompt: "SECRET-PROMPT" } },
    }
    expect(JSON.stringify(parseRecord(saved))).not.toContain("SECRET-PROMPT")
    await store.put(saved)
    expect(JSON.stringify(storage.map.get(store.key("ses_a", "job-1")))).not.toContain("SECRET-PROMPT")
  })
})

describe("parseBatchRemoteState", () => {
  test("accepts timestamp formats and copies only remote metadata", () => {
    const state = remote()
    const parsed = parseBatchRemoteState({ ...state, prompt: "SECRET-PROMPT", counts: { ...state.counts, prompt: "SECRET-PROMPT" } })
    expect(parsed).toEqual(state)
    expect(parsed?.counts).not.toBe(state.counts)
    expect(parseBatchRemoteState({ ...state, endedAt: null })).toBeDefined()
  })

  test("requires every timestamp and all five bounded request counts", () => {
    for (const field of ["createdAt", "endedAt", "observedAt"]) {
      for (const value of ["sk-test-not-a-real-key 2026-11-05", "2026-02-29T00:00:00Z", "2026-11-05", undefined]) {
        const state = { ...remote(), [field]: value }
        expect(parseBatchRemoteState(state)).toBeUndefined()
        expect(parseRecord({ ...record("ses_a", "job-1"), remote: state })).toBeUndefined()
      }
    }
    for (const field of ["processing", "succeeded", "errored", "canceled", "expired"]) {
      for (const value of [undefined, -1, 0.5, Number.NaN, Infinity]) {
        expect(parseBatchRemoteState({ ...remote(), counts: { ...remote().counts, [field]: value } })).toBeUndefined()
      }
    }
    expect(parseBatchRemoteState({ ...remote(), counts: { ...remote().counts, processing: 100_000 } })).toBeUndefined()
  })
})

describe("BatchStore pagination", () => {
  async function seeded(count: number) {
    const storage = new MemoryStorage()
    const store = new BatchStore(asStorage(storage))
    for (let i = 0; i < count; i++) {
      // Later times produce smaller IDs, so the newest job is listed first.
      const jobID = newJobID(new Date(Date.UTC(2026, 10, 5, 10, 0, i)), () => "00000000")
      await store.put(record("ses_a", jobID))
    }
    await store.put(record("ses_b", "job-foreign", { batchID: "msgbatch_foreign" }))
    return { storage, store }
  }

  test("pages through only the session's jobs, newest first", async () => {
    const { store } = await seeded(5)
    const first = await store.list("ses_a", { limit: 2 })
    expect(first.records).toHaveLength(2)
    expect(first.next).toBeDefined()
    const second = await store.list("ses_a", { limit: 2, after: first.next! })
    const third = await store.list("ses_a", { limit: 2, after: second.next! })
    expect(third.records).toHaveLength(1)
    expect(third.next).toBeUndefined()
    const all = [...first.records, ...second.records, ...third.records].map((r) => r.jobID)
    expect(new Set(all).size).toBe(5)
    expect([...all].sort()).toEqual(all)
    expect(all.every((id) => id !== "job-foreign")).toBe(true)
  })

  test("counts invalid entries and rejects foreign cursors", async () => {
    const { storage, store } = await seeded(2)
    storage.map.set(`${store.prefix("ses_a")}broken`, { nope: true })
    const page = await store.list("ses_a", { limit: 10 })
    expect(page.records).toHaveLength(2)
    expect(page.invalid).toBe(1)
    const foreign = (await store.list("ses_b", { limit: 1 })).records
    expect(foreign).toHaveLength(1)
    await expect(store.list("ses_a", { after: `${store.prefix("ses_b")}job-foreign` })).rejects.toThrow(BatchStoreError)
  })

  test("limits are positive bounded integers", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, MAX_PAGE_LIMIT + 1, Infinity]) {
      expect(() => normalizePage({ limit })).toThrow(BatchStoreError)
    }
    expect(() => normalizePage({ after: "" })).toThrow(BatchStoreError)
    expect(() => normalizePage({ after: "x".repeat(600) })).toThrow(BatchStoreError)
    expect(normalizePage(undefined)).toEqual({ limit: 20, after: undefined })
    expect(normalizePage({ limit: MAX_PAGE_LIMIT }).limit).toBe(MAX_PAGE_LIMIT)
  })

  test("resolve finds local and remote IDs inside the session only", async () => {
    const { store } = await seeded(3)
    const first = (await store.list("ses_a", { limit: 1 })).records[0]!
    expect((await store.resolve("ses_a", first.jobID))?.jobID).toBe(first.jobID)
    expect((await store.resolve("ses_a", first.batchID!))?.jobID).toBe(first.jobID)
    expect(await store.resolve("ses_a", "msgbatch_foreign")).toBeUndefined()
    expect(await store.resolve("ses_a", "job-foreign")).toBeUndefined()
    expect(await store.resolve("ses_b", first.batchID!)).toBeUndefined()
    expect(await store.resolve("ses_a", "not a valid id")).toBeUndefined()
  })

  test("resolve scans past 2000 jobs to find the oldest remote handle", async () => {
    const { storage, store } = await seeded(2101)
    const oldestID = newJobID(new Date(Date.UTC(2026, 10, 5, 10, 0, 0)), () => "00000000")
    const limits: number[] = []
    const scan = storage.scan.bind(storage)
    storage.scan = async (options) => {
      limits.push(options.limit!)
      return scan(options)
    }
    expect((await store.resolve("ses_a", `msgbatch_${oldestID}`))?.jobID).toBe(oldestID)
    expect(limits).toHaveLength(22)
    expect(limits.every((limit) => limit === MAX_PAGE_LIMIT)).toBe(true)
    expect(await store.resolve("ses_a", "msgbatch_foreign")).toBeUndefined()
  })

  test("findUnresolved matches only own unresolved records with the same snapshot digest", async () => {
    const storage = new MemoryStorage()
    const store = new BatchStore(asStorage(storage))
    const digest = "a".repeat(64)
    await store.put(record("ses_a", "job-submitted"))
    await store.put(record("ses_a", "job-rejected", { submission: "rejected" }))
    await store.put(record("ses_a", "job-other-snapshot", { submission: "submitting", snapshotSha256: "b".repeat(64) }))
    await store.put(record("ses_b", "job-foreign", { submission: "submission_unknown" }))
    storage.map.set(store.key("ses_a", "job-planted"), record("ses_b", "job-planted", { submission: "submitting" }))
    expect(await store.findUnresolved("ses_a", digest)).toBeUndefined()
    for (const submission of ["submitting", "submission_unknown"] as const) {
      const saved = record("ses_a", "job-unresolved", { submission, batchID: undefined })
      await store.put(saved)
      expect(await store.findUnresolved("ses_a", digest)).toEqual(saved)
      expect(await store.findUnresolved("ses_a", "c".repeat(64))).toBeUndefined()
    }
  })

  test("findUnresolved scans beyond 2000 records", async () => {
    const { store } = await seeded(2101)
    const oldestID = newJobID(new Date(Date.UTC(2026, 10, 5, 10, 0, 0)), () => "00000000")
    await store.put(record("ses_a", oldestID, { submission: "submission_unknown" }))
    expect((await store.findUnresolved("ses_a", "a".repeat(64)))?.jobID).toBe(oldestID)
  })

  test("cursor cycles fail with a fixed safe error in both scans", async () => {
    for (const sequence of [["secret-a", "secret-a"], ["secret-a", "secret-b", "secret-a"]]) {
      for (const operation of ["resolve", "findUnresolved"] as const) {
        class CycleStorage extends MemoryStorage {
          scans = 0
          override async scan(options: { prefix: string; after?: string; limit?: number }) {
            expect(options.limit).toBe(MAX_PAGE_LIMIT)
            return { entries: [], next: `${options.prefix}${sequence[this.scans++]}` }
          }
        }
        const storage = new CycleStorage()
        const store = new BatchStore(asStorage(storage))
        try {
          await store[operation]("ses_a", operation === "resolve" ? "msgbatch_missing" : "a".repeat(64))
          throw new Error("Expected rejection")
        } catch (error) {
          expect(error).toBeInstanceOf(BatchStoreError)
          expect(String(error)).toBe("BatchStoreError: Batch storage returned a repeated cursor.")
          expect(String(error)).not.toContain("secret")
        }
        expect(storage.scans).toBe(sequence.length)
      }
    }
  })
})
