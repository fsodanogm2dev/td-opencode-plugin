import { createHash, randomBytes } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { MAX_RATE_SOURCE_LENGTH } from "./pricing.ts"
import { MAX_BATCH_MODEL_LENGTH, MAX_BATCH_REQUESTS } from "./requests.ts"
import { isBatchTimestamp, type BatchCost, type BatchProcessingStatus, type BatchRequestCounts } from "./types.ts"

export type BatchStorage = Plugin.Context["storage"]

export const SUBMISSION_STATES = ["submitting", "submitted", "submission_unknown", "rejected"] as const
export type SubmissionState = (typeof SUBMISSION_STATES)[number]
export type CollectionStateName = "not_collected" | "collected"

export const MAX_PAGE_LIMIT = 100
export const DEFAULT_PAGE_LIMIT = 20
export const MAX_MODEL_ENTRIES = 50
const MAX_RECORD_BYTES = 64 * 1024
const MAX_CURSOR_LENGTH = 512
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const STORE_PREFIX = "fuelix-batch/v1/s/"
const PROCESSING: readonly string[] = ["in_progress", "canceling", "ended"]

export interface ModelCount {
  readonly model: string
  readonly count: number
}

export interface BatchRemoteState {
  readonly status: BatchProcessingStatus
  readonly counts: BatchRequestCounts
  readonly createdAt: string
  readonly endedAt: string | null
  readonly observedAt: string
}

export interface BatchArtifactPaths {
  readonly requests: string
  readonly results: string
  readonly successes: string
  readonly failures: string
  readonly manifest: string
}

export interface BatchCollectionCounts {
  readonly succeeded: number
  readonly errored: number
  readonly canceled: number
  readonly expired: number
}

export interface BatchCollectionState {
  readonly state: CollectionStateName
  readonly collectedAt?: string
  readonly artifacts?: BatchArtifactPaths
  readonly counts?: BatchCollectionCounts
  readonly cost?: BatchCost
}

/**
 * Persistent job record. It holds identifiers, paths, counts, and states only. It never holds prompts, results,
 * keys, or result URLs. Prompts live in the protected `requests.json` snapshot.
 */
export interface BatchJobRecord {
  readonly version: 1
  readonly jobID: string
  readonly originatingSession: string
  /** Resolved path of the user's input file. */
  readonly inputPath: string
  /** Absolute path of the protected request snapshot. */
  readonly snapshotPath: string
  readonly snapshotSha256: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly submission: SubmissionState
  /** HTTP status of a rejected submission. */
  readonly httpStatus?: number
  readonly requestCount: number
  readonly models: readonly ModelCount[]
  readonly otherModels: number
  readonly batchID?: string
  readonly remote?: BatchRemoteState
  readonly collection: BatchCollectionState
}

export class BatchStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BatchStoreError"
  }
}

export function isValidID(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}

/**
 * New job ID. The time part is inverted so that a key-ordered scan lists the newest job first. The random part
 * keeps IDs unique within one millisecond.
 */
export function newJobID(now: Date, random: () => string = () => randomBytes(4).toString("hex")): string {
  const ms = Math.min(Math.max(now.getTime(), 0), 36 ** 9 - 1)
  const inverted = (36 ** 9 - 1 - ms).toString(36).padStart(9, "0")
  return `job-${inverted}-${random()}`
}

function sessionHash(sessionID: string): string {
  return createHash("sha256").update(sessionID, "utf8").digest("hex").slice(0, 32)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function validCounts(value: unknown): value is BatchRequestCounts {
  return (
    isRecord(value) &&
    isCount(value.processing) &&
    isCount(value.succeeded) &&
    isCount(value.errored) &&
    isCount(value.canceled) &&
    isCount(value.expired)
  )
}

/** Validates remote state and rebuilds only safe metadata fields. */
export function parseBatchRemoteState(value: unknown): BatchRemoteState | undefined {
  if (!isRecord(value) || typeof value.status !== "string" || !PROCESSING.includes(value.status)) return undefined
  if (!validCounts(value.counts) || !isBatchTimestamp(value.createdAt) || !isBatchTimestamp(value.observedAt)) return undefined
  if (value.endedAt !== null && !isBatchTimestamp(value.endedAt)) return undefined
  const { processing, succeeded, errored, canceled, expired } = value.counts
  if (processing + succeeded + errored + canceled + expired > MAX_BATCH_REQUESTS) return undefined
  return {
    status: value.status as BatchProcessingStatus,
    counts: { processing, succeeded, errored, canceled, expired },
    createdAt: value.createdAt,
    endedAt: value.endedAt,
    observedAt: value.observedAt,
  }
}

function validArtifacts(value: unknown): value is BatchArtifactPaths {
  return (
    isRecord(value) &&
    isText(value.requests) &&
    isText(value.results) &&
    isText(value.successes) &&
    isText(value.failures) &&
    isText(value.manifest)
  )
}

function validCost(value: unknown): value is BatchCost {
  if (!isRecord(value)) return false
  if (value.kind === "unavailable") return isText(value.reason, 1000)
  if (value.kind === "actual" || value.kind === "estimate") {
    if (!isText(value.source, MAX_RATE_SOURCE_LENGTH) || value.currency !== "USD" ||
      typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0) return false
    return value.kind === "actual" || (
      isCount(value.succeeded) && isRecord(value.excluded) &&
      isCount(value.excluded.errored) && isCount(value.excluded.canceled) && isCount(value.excluded.expired)
    )
  }
  return false
}

function validCollection(value: unknown): value is BatchCollectionState {
  if (!isRecord(value)) return false
  if (value.state === "not_collected") return true
  if (value.state !== "collected") return false
  return (
    isBatchTimestamp(value.collectedAt) &&
    validArtifacts(value.artifacts) &&
    isRecord(value.counts) &&
    isCount(value.counts.succeeded) &&
    isCount(value.counts.errored) &&
    isCount(value.counts.canceled) &&
    isCount(value.counts.expired) &&
    validCost(value.cost)
  )
}

/** Validates a record and rebuilds known fields so untrusted extra content cannot enter storage. */
export function parseRecord(value: unknown): BatchJobRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (!isValidID(value.jobID) || !isText(value.originatingSession, 1024)) return undefined
  if (!isText(value.inputPath) || !isText(value.snapshotPath) || !isText(value.snapshotSha256, 64)) return undefined
  if (!isBatchTimestamp(value.createdAt) || !isBatchTimestamp(value.updatedAt)) return undefined
  if (!SUBMISSION_STATES.includes(value.submission as SubmissionState)) return undefined
  if (value.httpStatus !== undefined && !isCount(value.httpStatus)) return undefined
  if (!isCount(value.requestCount) || !isCount(value.otherModels)) return undefined
  if (!Array.isArray(value.models) || value.models.length > MAX_MODEL_ENTRIES) return undefined
  for (const entry of value.models) {
    if (!isRecord(entry) || !isText(entry.model, MAX_BATCH_MODEL_LENGTH) || !isCount(entry.count)) return undefined
  }
  if (value.batchID !== undefined && !isValidID(value.batchID)) return undefined
  const remote = value.remote === undefined ? undefined : parseBatchRemoteState(value.remote)
  if (value.remote !== undefined && remote === undefined) return undefined
  if (!validCollection(value.collection)) return undefined
  const record = value as unknown as BatchJobRecord
  const collection = record.collection
  let safeCollection: BatchCollectionState = { state: "not_collected" }
  if (collection.state === "collected") {
    const { requests, results, successes, failures, manifest } = collection.artifacts!
    const { succeeded, errored, canceled, expired } = collection.counts!
    const cost = collection.cost!
    const safeCost: BatchCost = cost.kind === "unavailable" ? { kind: cost.kind, reason: cost.reason } : {
      kind: cost.kind,
      source: cost.source,
      currency: cost.currency,
      amount: cost.amount,
      ...(cost.kind === "estimate" ? { succeeded: cost.succeeded, excluded: {
        errored: cost.excluded.errored, canceled: cost.excluded.canceled, expired: cost.excluded.expired,
      } } : {}),
    } as BatchCost
    safeCollection = {
      state: "collected",
      collectedAt: collection.collectedAt,
      artifacts: { requests, results, successes, failures, manifest },
      counts: { succeeded, errored, canceled, expired },
      cost: safeCost,
    }
  }
  return {
    version: 1,
    jobID: record.jobID,
    originatingSession: record.originatingSession,
    inputPath: record.inputPath,
    snapshotPath: record.snapshotPath,
    snapshotSha256: record.snapshotSha256,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    submission: record.submission,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
    requestCount: record.requestCount,
    models: record.models.map(({ model, count }) => ({ model, count })),
    otherModels: record.otherModels,
    ...(record.batchID === undefined ? {} : { batchID: record.batchID }),
    ...(remote === undefined ? {} : { remote }),
    collection: safeCollection,
  }
}

export interface PageOptions {
  readonly limit?: number
  readonly after?: string
}

export interface NormalizedPage {
  readonly limit: number
  readonly after: string | undefined
}

/** Validates a page request. Limits are positive integers up to `MAX_PAGE_LIMIT`. */
export function normalizePage(options: PageOptions | undefined, defaultLimit = DEFAULT_PAGE_LIMIT): NormalizedPage {
  const limit = options?.limit ?? defaultLimit
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new BatchStoreError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`)
  }
  const after = options?.after
  if (after !== undefined && (typeof after !== "string" || after.length === 0 || after.length > MAX_CURSOR_LENGTH)) {
    throw new BatchStoreError("after must be a cursor returned by a previous call.")
  }
  return { limit, after }
}

export interface RecordPage {
  readonly records: BatchJobRecord[]
  readonly next?: string
  /** Stored entries that did not have a valid shape. */
  readonly invalid: number
}

/** Session-scoped persistence of batch job records in plugin storage. Keys hash the session ID. */
export class BatchStore {
  constructor(private readonly storage: BatchStorage) {}

  prefix(sessionID: string): string {
    if (typeof sessionID !== "string" || sessionID.length === 0) throw new BatchStoreError("Session ID is required.")
    return `${STORE_PREFIX}${sessionHash(sessionID)}/job/`
  }

  key(sessionID: string, jobID: string): string {
    if (!isValidID(jobID)) throw new BatchStoreError("Invalid job ID.")
    return `${this.prefix(sessionID)}${jobID}`
  }

  async get(sessionID: string, jobID: string): Promise<BatchJobRecord | undefined> {
    const value = await this.storage.get(this.key(sessionID, jobID))
    const record = parseRecord(value)
    if (!record || record.originatingSession !== sessionID || record.jobID !== jobID) return undefined
    return record
  }

  /** Writes the record. The stored value is a plain JSON copy, so it is serializable by construction. */
  async put(record: BatchJobRecord): Promise<void> {
    const text = JSON.stringify(record)
    if (text.length > MAX_RECORD_BYTES) throw new BatchStoreError("Batch record is too large.")
    const safeRecord = parseRecord(JSON.parse(text))
    if (!safeRecord) throw new BatchStoreError("Batch record is invalid.")
    await this.storage.set(this.key(safeRecord.originatingSession, safeRecord.jobID), JSON.parse(JSON.stringify(safeRecord)))
  }

  async list(sessionID: string, options?: PageOptions): Promise<RecordPage> {
    const page = normalizePage(options)
    const prefix = this.prefix(sessionID)
    if (page.after !== undefined && !page.after.startsWith(prefix)) {
      throw new BatchStoreError("after is not a cursor for this session.")
    }
    const result = await this.storage.scan({
      prefix,
      limit: page.limit,
      ...(page.after === undefined ? {} : { after: page.after }),
    })
    const records: BatchJobRecord[] = []
    let invalid = 0
    for (const entry of result.entries) {
      if (!entry.key.startsWith(prefix)) continue
      const record = parseRecord(entry.value)
      if (!record || record.originatingSession !== sessionID) invalid++
      else records.push(record)
    }
    return {
      records,
      invalid,
      ...(result.next !== undefined && result.next.startsWith(prefix) ? { next: result.next } : {}),
    }
  }

  /** Finds a job of this session by local job ID or by remote batch ID. Foreign IDs resolve to undefined. */
  async resolve(sessionID: string, ref: string): Promise<BatchJobRecord | undefined> {
    if (!isValidID(ref)) return undefined
    const direct = await this.get(sessionID, ref)
    if (direct) return direct
    for await (const record of this.#ownRecords(sessionID)) {
      if (record.batchID === ref) return record
    }
    return undefined
  }

  /** Finds an unresolved submission for the same protected request snapshot in this session. */
  async findUnresolved(sessionID: string, digest: string): Promise<BatchJobRecord | undefined> {
    for await (const record of this.#ownRecords(sessionID)) {
      if (record.snapshotSha256 === digest && (record.submission === "submitting" || record.submission === "submission_unknown")) return record
    }
    return undefined
  }

  async *#ownRecords(sessionID: string): AsyncGenerator<BatchJobRecord> {
    let after: string | undefined
    const cursors = new Set<string>()
    for (;;) {
      const page = await this.list(sessionID, { limit: MAX_PAGE_LIMIT, ...(after === undefined ? {} : { after }) })
      for (const record of page.records) yield record
      if (page.next === undefined) return
      if (cursors.has(page.next)) throw new BatchStoreError("Batch storage returned a repeated cursor.")
      cursors.add(page.next)
      after = page.next
    }
  }
}
