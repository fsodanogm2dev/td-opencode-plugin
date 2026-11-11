import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { resolve } from "node:path"
import { BatchArtifactError, type BatchArtifacts } from "./artifacts.ts"
import { estimateBatchCost, type BatchRateCard } from "./pricing.ts"
import { BatchRequestError, DEFAULT_MAX_INPUT_BYTES, normalizeBatchRequests, parseBatchRequests } from "./requests.ts"
import {
  BatchStore,
  BatchStoreError,
  MAX_MODEL_ENTRIES,
  isValidID,
  newJobID,
  parseBatchRemoteState,
  normalizePage,
  type BatchArtifactPaths,
  type BatchCollectionCounts,
  type BatchCollectionState,
  type BatchJobRecord,
  type BatchRemoteState,
  type BatchStorage,
  type ModelCount,
  type PageOptions,
  type SubmissionState,
} from "./store.ts"
import {
  parseBatchResultLine,
  type BatchCost,
  type BatchRequest,
  type BatchRequestCounts,
  type BatchResult,
  type RemoteBatch,
} from "./types.ts"

/** Narrow client contract. `BatchClient` satisfies it; tests replace it. */
export interface BatchClientLike {
  submit(requests: readonly BatchRequest[], signal?: AbortSignal): Promise<RemoteBatch>
  status(id: string, signal?: AbortSignal): Promise<RemoteBatch>
  cancel(id: string, signal?: AbortSignal): Promise<RemoteBatch>
  results(batch: RemoteBatch, signal?: AbortSignal): Promise<string>
}

export interface BatchServiceOptions {
  readonly storage: BatchStorage
  readonly artifacts: BatchArtifacts
  readonly client: BatchClientLike
  /** Directory against which relative input paths resolve. */
  readonly directory: string
  readonly now?: () => Date
  /** Active key material. Content that contains any of these strings is never saved or returned. */
  readonly secrets?: () => Promise<readonly string[]>
  /** Verified batch rates. Without them the cost is unavailable. */
  readonly rates?: BatchRateCard
}

export type BatchServiceErrorCode =
  | "invalid_argument"
  | "not_found"
  | "invalid_input"
  | "input_unreadable"
  | "secret_detected"
  | "secrets_unavailable"
  | "storage_failed"
  | "artifact_error"
  | "aborted"
  | "submission_rejected"
  | "submission_unknown"
  | "record_not_saved"
  | "remote_error"
  | "invalid_remote"
  | "results_unavailable"
  | "invalid_results"
  | "snapshot_invalid"
  | "duplicate_submission"

/** Error with a message that is safe to show: it never contains prompts, results, keys, or remote bodies. */
export class BatchServiceError extends Error {
  readonly code: BatchServiceErrorCode
  readonly jobID: string | undefined
  readonly batchID: string | undefined
  readonly details: Readonly<Record<string, number | string>> | undefined
  /** True when a submission may have reached the gateway and may be billed. Set on `submission_unknown`. */
  readonly ambiguous: boolean | undefined

  constructor(
    code: BatchServiceErrorCode,
    message: string,
    extra: { jobID?: string; batchID?: string; details?: Record<string, number | string>; ambiguous?: boolean } = {},
  ) {
    super(message)
    this.name = "BatchServiceError"
    this.code = code
    this.jobID = extra.jobID
    this.batchID = extra.batchID
    this.details = extra.details
    this.ambiguous = extra.ambiguous
  }
}

export interface BatchSubmitOptions {
  /** Sends the same normalized requests again although an unresolved submission of them exists in this session. */
  readonly allowDuplicate?: boolean
}

export interface BatchJobSummary {
  readonly jobID: string
  readonly batchID?: string
  readonly submission: SubmissionState
  readonly httpStatus?: number
  readonly note?: string
  readonly inputPath: string
  /** Protected path of the request snapshot. */
  readonly requestsPath: string
  readonly createdAt: string
  readonly elapsedMs: number
  readonly requests: { readonly count: number; readonly models: readonly ModelCount[]; readonly otherModels: number }
  readonly remote?: {
    readonly status: BatchRemoteState["status"]
    readonly counts: BatchRequestCounts
    readonly createdAt: string
    readonly endedAt: string | null
    readonly observedAt: string
    /** Milliseconds between the last remote observation and now. */
    readonly staleMs: number
  }
  readonly collection: {
    readonly state: BatchCollectionState["state"]
    readonly collectedAt?: string
    readonly counts?: BatchCollectionCounts
    readonly artifacts?: BatchArtifactPaths
  }
  readonly cost: BatchCost
}

export interface BatchListResult {
  readonly jobs: BatchJobSummary[]
  readonly next?: string
  /** Stored entries that could not be read as job records. */
  readonly invalid: number
}

export interface BatchRequestMeta {
  readonly index: number
  readonly custom_id: string
  readonly model: string
  readonly max_tokens: number
}

export interface BatchInspectResult {
  readonly job: BatchJobSummary
  readonly requests: {
    readonly total: number
    readonly items: BatchRequestMeta[]
    readonly next?: string
    readonly note?: string
  }
}

export const MAX_RESULTS_CHARS = 512 * 1024 * 1024
const UNAVAILABLE_COST: BatchCost = {
  kind: "unavailable",
  reason: "No verified Fuel iX batch pricing is available, so no cost is reported.",
}
const UNSAFE_COST_REASON = "The rate source cannot be stored safely, so no cost is reported."
const SNAPSHOT_MAX_BYTES = DEFAULT_MAX_INPUT_BYTES * 2
const NOTE_UNKNOWN =
  "Submission outcome is unknown. The batch was not resubmitted. Check the gateway before submitting the work again."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberField(error: unknown, ...names: string[]): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  for (const name of names) {
    const value = (error as Record<string, unknown>)[name]
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value
  }
  return undefined
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** Conservative decoder for JSON `\uXXXX` and `\/` escapes. It may over-decode, which only adds false alarms. */
const JSON_ESCAPE = /\\u([0-9a-fA-F]{4})|\\\//g
const decodeJsonEscapes = (text: string) =>
  text.replace(JSON_ESCAPE, (_match, hex: string | undefined) => (hex === undefined ? "/" : String.fromCharCode(parseInt(hex, 16))))

function toTime(text: string | null | undefined): number | undefined {
  if (!text) return undefined
  const value = Date.parse(text)
  return Number.isFinite(value) ? value : undefined
}

function modelCounts(requests: readonly BatchRequest[]): { models: ModelCount[]; otherModels: number } {
  const counts = new Map<string, number>()
  for (const request of requests) counts.set(request.params.model, (counts.get(request.params.model) ?? 0) + 1)
  const sorted = [...counts.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || (a.model < b.model ? -1 : 1))
  return { models: sorted.slice(0, MAX_MODEL_ENTRIES), otherModels: Math.max(0, sorted.length - MAX_MODEL_ENTRIES) }
}

/** Encodes a string with JSON escapes but without quotes, to find escaped key material in JSON text. */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

const SHARED_LOCKS = new Map<string, Promise<void>>()
const SHARED_INFLIGHT = new Set<string>()
/** In-flight submissions per fingerprint (artifact root, session, request digest). Every submission owns a member. */
const SHARED_FINGERPRINTS = new Map<string, Set<string>>()

export class BatchService {
  private readonly store: BatchStore
  private readonly artifacts: BatchArtifacts
  private readonly client: BatchClientLike
  private readonly directory: string
  private readonly now: () => Date
  private readonly secrets: () => Promise<readonly string[]>
  private readonly rates: BatchRateCard | undefined
  // Process-wide, so that services created per tool call still serialize one job and see its running submission.
  private readonly locks = SHARED_LOCKS
  private readonly inflight = SHARED_INFLIGHT
  private readonly fingerprints = SHARED_FINGERPRINTS

  constructor(options: BatchServiceOptions) {
    this.store = new BatchStore(options.storage)
    this.artifacts = options.artifacts
    this.client = options.client
    this.directory = resolve(options.directory)
    this.now = options.now ?? (() => new Date())
    this.secrets = options.secrets ?? (async () => [])
    this.rates = options.rates
  }

  // ---------------------------------------------------------------------------------------------- public API

  /**
   * Reads the input file, saves a protected snapshot and a durable local record, then sends one POST.
   * The POST is never retried. Ambiguous failures keep a `submission_unknown` record. Without
   * `options.allowDuplicate`, the same normalized requests are not sent again while an earlier submission of them is
   * unresolved in this session.
   */
  async submit(
    sessionID: string,
    inputPath: string,
    signal?: AbortSignal,
    options?: BatchSubmitOptions,
  ): Promise<BatchJobSummary> {
    this.requireSession(sessionID)
    if (typeof inputPath !== "string" || inputPath === "" || inputPath.includes("\0")) {
      throw new BatchServiceError("invalid_argument", "inputPath must be a non-empty path.")
    }
    this.throwIfAborted(signal)
    const secrets = await this.activeSecrets()
    const resolved = resolve(this.directory, inputPath)
    this.assertNoSecret(resolved, secrets, "The input path")
    this.assertNoSecret(this.artifacts.root, secrets, "The artifact location")
    const text = await this.readInput(resolved, signal)
    this.assertNoSecret(text, secrets, "The input file")
    let requests: BatchRequest[]
    try {
      requests = parseBatchRequests(text)
    } catch (error) {
      if (error instanceof BatchRequestError) throw new BatchServiceError("invalid_input", error.message)
      throw new BatchServiceError("invalid_input", "The input file is not valid batch input.")
    }
    return this.submitNormalized(sessionID, resolved, requests, secrets, signal, options)
  }

  /**
   * Submits requests that the caller built in memory, for example from an inline command. The requests pass the same
   * validation, secret checks, durable record, duplicate guard, and once-only POST as `submit`. `source` is a label
   * that is stored as the job input and is not a path.
   */
  async submitRequests(
    sessionID: string,
    requests: readonly unknown[],
    source: string,
    signal?: AbortSignal,
  ): Promise<BatchJobSummary> {
    this.requireSession(sessionID)
    if (typeof source !== "string" || source === "" || source.length > 256 || source.includes("\0")) {
      throw new BatchServiceError("invalid_argument", "source must be a short non-empty label.")
    }
    this.throwIfAborted(signal)
    const secrets = await this.activeSecrets()
    this.assertNoSecret(source, secrets, "The input source label")
    this.assertNoSecret(this.artifacts.root, secrets, "The artifact location")
    let raw: string
    try {
      raw = JSON.stringify(requests)
    } catch {
      throw new BatchServiceError("invalid_input", "The requests are not valid batch input.")
    }
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > DEFAULT_MAX_INPUT_BYTES) {
      throw new BatchServiceError("invalid_input", `Input is larger than ${DEFAULT_MAX_INPUT_BYTES} bytes.`)
    }
    this.assertNoSecret(raw, secrets, "The input")
    let normalized: BatchRequest[]
    try {
      normalized = normalizeBatchRequests(requests)
    } catch (error) {
      if (error instanceof BatchRequestError) throw new BatchServiceError("invalid_input", error.message)
      throw new BatchServiceError("invalid_input", "The input is not valid batch input.")
    }
    return this.submitNormalized(sessionID, source, normalized, secrets, signal)
  }

  private async submitNormalized(
    sessionID: string,
    source: string,
    requests: BatchRequest[],
    secrets: readonly string[],
    signal: AbortSignal | undefined,
    options?: BatchSubmitOptions,
  ): Promise<BatchJobSummary> {
    const snapshot = JSON.stringify({ requests })
    this.assertNoSecret(snapshot, secrets, "The normalized requests")

    const created = this.now()
    const jobID = newJobID(created)
    const digest = sha256(snapshot)
    const allowDuplicate = options?.allowDuplicate === true
    const fingerprint = `${this.artifacts.root}\0${sessionID}\0${digest}`
    const lockKey = this.lockKey(sessionID, jobID)
    // Registered before any write, so a concurrent inspect never settles this job as stale.
    this.inflight.add(lockKey)
    try {
      // Check and reserve without awaiting in between: this closes the window before the first persisted record.
      let members = this.fingerprints.get(fingerprint)
      if (members !== undefined && !allowDuplicate) throw this.duplicate([...members][0]!)
      if (members === undefined) {
        members = new Set()
        this.fingerprints.set(fingerprint, members)
      }
      members.add(jobID)
      if (!allowDuplicate) {
        const prior = await this.guard(() => this.findUnresolved(sessionID, digest))
        if (prior) throw this.duplicate(prior)
      }
      this.throwIfAborted(signal)

      const { models, otherModels } = modelCounts(requests)
      const iso = created.toISOString()
      let record: BatchJobRecord
      try {
        const snapshotPath = await this.artifacts.write(jobID, "requests.json", snapshot)
        record = {
          version: 1,
          jobID,
          originatingSession: sessionID,
          inputPath: source,
          snapshotPath,
          snapshotSha256: digest,
          createdAt: iso,
          updatedAt: iso,
          submission: "submitting",
          requestCount: requests.length,
          models,
          otherModels,
          collection: { state: "not_collected" },
        }
        await this.artifacts.write(jobID, "manifest.json", this.manifestText(record))
        await this.store.put(record)
      } catch {
        await this.artifacts.remove(jobID, "manifest.json").catch(() => undefined)
        await this.artifacts.remove(jobID, "requests.json").catch(() => undefined)
        throw new BatchServiceError(
          "storage_failed",
          "Could not save the job record before sending. Nothing was submitted.",
          { jobID },
        )
      }

      try {
        let batch: RemoteBatch
        try {
          // The caller may have aborted while the record was saved. Nothing has been sent yet.
          if (signal?.aborted) throw { code: "aborted", ambiguous: false }
          batch = await this.client.submit(requests, signal)
        } catch (error) {
          throw await this.afterSubmitFailure(record, error, secrets)
        }
        return await this.afterAccepted(record, batch, secrets)
      } catch (error) {
        if (error instanceof BatchServiceError) throw error
        throw new BatchServiceError("submission_unknown", NOTE_UNKNOWN, { jobID, ambiguous: true })
      }
    } finally {
      this.inflight.delete(lockKey)
      const members = this.fingerprints.get(fingerprint)
      if (members) {
        members.delete(jobID)
        if (members.size === 0) this.fingerprints.delete(fingerprint)
      }
    }
  }

  /** Local history of this session. Makes no remote call. */
  async list(sessionID: string, options?: PageOptions): Promise<BatchListResult> {
    this.requireSession(sessionID)
    const page = await this.guard(() => this.store.list(sessionID, options))
    return {
      jobs: page.records.map((record) => this.summarize(record)),
      invalid: page.invalid,
      ...(page.next === undefined ? {} : { next: page.next }),
    }
  }

  /** Local summary of one job with bounded per-request metadata. Makes no remote call. */
  async inspect(sessionID: string, jobRef: string, options?: PageOptions): Promise<BatchInspectResult> {
    this.requireSession(sessionID)
    const page = this.guardSync(() => normalizePage(options, 25))
    let start = 0
    if (page.after !== undefined) {
      if (!/^\d{1,9}$/.test(page.after)) {
        throw new BatchServiceError("invalid_argument", "after must be a cursor returned by a previous call.")
      }
      start = Number(page.after)
    }
    return this.locked(sessionID, jobRef, async (record) => {
      const job = this.summarize(record)
      let items: BatchRequestMeta[] = []
      let note: string | undefined
      let next: string | undefined
      try {
        const requests = await this.readSnapshot(record)
        items = requests
          .slice(start, start + page.limit)
          .map((request, offset) => ({
            index: start + offset,
            custom_id: request.custom_id,
            model: request.params.model,
            max_tokens: request.params.max_tokens,
          }))
        if (start + page.limit < requests.length) next = String(start + page.limit)
      } catch (error) {
        note = error instanceof BatchServiceError ? error.message : "The request snapshot could not be read."
      }
      return {
        job,
        requests: {
          total: record.requestCount,
          items,
          ...(next === undefined ? {} : { next }),
          ...(note === undefined ? {} : { note }),
        },
      }
    })
  }

  /** Reads the remote status and stores it. This is the explicit remote read. */
  async status(sessionID: string, jobRef: string, signal?: AbortSignal): Promise<BatchJobSummary> {
    this.requireSession(sessionID)
    return this.locked(sessionID, jobRef, async (record) => {
      if (!record.batchID || this.isInflight(record)) return this.summarize(record)
      const { next } = await this.refresh(record, signal)
      return this.summarize(next)
    })
  }

  /** Requests cancellation. The batch is final only when a later status shows `ended`. */
  async cancel(sessionID: string, jobRef: string, signal?: AbortSignal): Promise<BatchJobSummary> {
    this.requireSession(sessionID)
    return this.locked(sessionID, jobRef, async (record) => {
      if (!record.batchID || this.isInflight(record)) return this.summarize(record)
      if (record.remote?.status === "ended") {
        return this.summarize(record, "The batch already ended. Nothing to cancel.")
      }
      this.throwIfAborted(signal)
      let batch: RemoteBatch
      try {
        batch = await this.client.cancel(record.batchID, signal)
      } catch (error) {
        throw this.remoteFailure("Cancel request", error, record)
      }
      const remote = this.remoteState(batch, record.batchID, record)
      const next = await this.save({ ...record, remote })
      return this.summarize(next)
    })
  }

  /**
   * Refreshes the remote status. When the batch ended, downloads, validates, and splits results into protected
   * artifacts. A collected job returns its artifacts without any remote call.
   */
  async collect(sessionID: string, jobRef: string, signal?: AbortSignal): Promise<BatchJobSummary> {
    this.requireSession(sessionID)
    return this.locked(sessionID, jobRef, async (record) => {
      if (record.collection.state === "collected" && (await this.artifactsPresent(record))) {
        return this.summarize(record)
      }
      if (!record.batchID || this.isInflight(record)) return this.summarize(record)
      const { next: current, batch } = await this.refresh(record, signal)
      if (current.remote?.status !== "ended") {
        return this.summarize(current, "The batch has not ended. Results are not downloaded yet.")
      }
      return this.summarize(await this.collectEnded(current, batch, signal))
    })
  }

  // ------------------------------------------------------------------------------------------- submission

  private duplicate(priorJobID: string): BatchServiceError {
    return new BatchServiceError(
      "duplicate_submission",
      `The same requests are already being submitted or have an unresolved submission (job ${priorJobID}). ` +
        "That batch may exist and may be billed. Nothing was sent. Check the earlier job first. " +
        "To send the same requests again on purpose, submit with allowDuplicate set to true.",
      { jobID: priorJobID },
    )
  }

  /** Finds a job of this session with the same request digest whose submission is not settled. */
  private async findUnresolved(sessionID: string, digest: string): Promise<string | undefined> {
    return (await this.store.findUnresolved(sessionID, digest))?.jobID
  }

  /** Active keys plus the keys seen now, so that a rotated key echoed by the gateway is still caught. */
  private async freshSecrets(initial: readonly string[]): Promise<readonly string[]> {
    try {
      const later = (await this.secrets()).filter((key) => typeof key === "string" && key.length > 0)
      return [...new Set([...initial, ...later])]
    } catch {
      return initial
    }
  }

  private async persistUnknown(record: BatchJobRecord, candidate: string | undefined): Promise<BatchJobRecord> {
    const next: BatchJobRecord = {
      ...record,
      submission: "submission_unknown",
      ...(candidate === undefined ? {} : { batchID: candidate }),
      updatedAt: this.now().toISOString(),
    }
    await this.withLock(this.lockKey(record.originatingSession, record.jobID), async () => {
      await this.artifacts.write(record.jobID, "manifest.json", this.manifestText(next)).catch(() => undefined)
      await this.store.put(next).catch(() => undefined)
    })
    return next
  }

  private async afterSubmitFailure(
    record: BatchJobRecord,
    error: unknown,
    secrets: readonly string[],
  ): Promise<BatchServiceError> {
    const status = numberField(error, "status", "statusCode")
    const flagged = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
    // The client proved that nothing was sent for these codes when `ambiguous` is false.
    const notSent =
      flagged.ambiguous === false &&
      ["no_key", "invalid_argument", "invalid_base_url", "aborted", "timeout", "too_large"].includes(String(flagged.code))
    const rejected =
      flagged.ambiguous !== true &&
      (notSent || (status !== undefined && status >= 400 && status < 500 && status !== 408))
    if (rejected) {
      const next: BatchJobRecord = {
        ...record,
        submission: "rejected",
        ...(status === undefined ? {} : { httpStatus: status }),
        updatedAt: this.now().toISOString(),
      }
      await this.withLock(this.lockKey(record.originatingSession, record.jobID), async () => {
        await this.artifacts.write(record.jobID, "manifest.json", this.manifestText(next)).catch(() => undefined)
        await this.store.put(next).catch(() => undefined)
      })
      return new BatchServiceError(
        "submission_rejected",
        status === undefined
          ? `The submission was not sent. Nothing was created. Job ${record.jobID} keeps the record.`
          : `The gateway rejected the submission (HTTP ${status}). Nothing was created. Job ${record.jobID} keeps the record.`,
        {
          jobID: record.jobID,
          ambiguous: false,
          ...(status === undefined ? {} : { details: { httpStatus: status } }),
        },
      )
    }
    // A malformed 2xx answer may carry the batch ID. Keep it only when it is a safe ID that holds no key.
    let candidate: string | undefined
    if (isValidID(flagged.batchID)) {
      const seen = await this.freshSecrets(secrets)
      if (!this.hasSecret(flagged.batchID, seen)) candidate = flagged.batchID
    }
    await this.persistUnknown(record, candidate)
    return new BatchServiceError("submission_unknown", `${NOTE_UNKNOWN} Job: ${record.jobID}.`, {
      jobID: record.jobID,
      ambiguous: true,
      ...(candidate === undefined ? {} : { batchID: candidate }),
    })
  }

  private async afterAccepted(
    record: BatchJobRecord,
    batch: RemoteBatch,
    secrets: readonly string[],
  ): Promise<BatchJobSummary> {
    const jobID = record.jobID
    const seen = await this.freshSecrets(secrets)
    const candidate = isRecord(batch) && isValidID(batch.id) && !this.hasSecret(batch.id, seen) ? batch.id : undefined
    let accepted: BatchJobRecord
    try {
      if (candidate === undefined) throw new Error("invalid batch id")
      const remote = this.remoteState(batch, candidate, record)
      accepted = {
        ...record,
        submission: "submitted",
        batchID: candidate,
        remote,
        updatedAt: this.now().toISOString(),
      }
    } catch {
      // The gateway answered, but the answer cannot be trusted or stored. Keep the unknown state and any safe handle.
      await this.persistUnknown(record, candidate)
      throw new BatchServiceError(
        "submission_unknown",
        `The gateway answered with an unusable batch. ${NOTE_UNKNOWN} Job: ${jobID}.`,
        { jobID, ambiguous: true, ...(candidate === undefined ? {} : { batchID: candidate }) },
      )
    }
    const batchID = accepted.batchID!
    return this.withLock(this.lockKey(record.originatingSession, jobID), async () => {
      // Recovery data first: the manifest keeps the remote batch ID even when the storage write fails.
      let manifestSaved = true
      try {
        await this.artifacts.write(jobID, "manifest.json", this.manifestText(accepted))
      } catch {
        manifestSaved = false
      }
      try {
        await this.store.put(accepted)
      } catch {
        throw new BatchServiceError(
          "record_not_saved",
          `The batch was accepted as ${batchID} (job ${jobID}), but the local record update failed. ` +
            (manifestSaved
              ? "Run status with the job ID to recover the record. Do not resubmit."
              : "Keep this batch ID. Do not resubmit."),
          { jobID, batchID },
        )
      }
      return this.summarize(accepted)
    })
  }

  // ------------------------------------------------------------------------------------ remote operations

  private async refresh(
    record: BatchJobRecord,
    signal?: AbortSignal,
  ): Promise<{ next: BatchJobRecord; batch: RemoteBatch }> {
    this.throwIfAborted(signal)
    let batch: RemoteBatch
    try {
      batch = await this.client.status(record.batchID!, signal)
    } catch (error) {
      throw this.remoteFailure("Status request", error, record)
    }
    const remote = this.remoteState(batch, record.batchID!, record)
    // Only the remote part changes, so collected paths and cost of the fresh record stay intact. A validated answer
    // for the recorded batch ID settles an unknown submission.
    const next = await this.save({
      ...record,
      remote,
      ...(record.submission === "submission_unknown" ? { submission: "submitted" as const } : {}),
    })
    return { next, batch }
  }

  private async collectEnded(
    record: BatchJobRecord,
    batch: RemoteBatch,
    signal?: AbortSignal,
  ): Promise<BatchJobRecord> {
    const jobID = record.jobID
    const requests = await this.readSnapshot(record)
    this.throwIfAborted(signal)
    let text: string
    try {
      text = await this.client.results(batch, signal)
    } catch (error) {
      throw this.remoteFailure("Results download", error, record, "results_unavailable")
    }
    if (typeof text !== "string" || text.length > MAX_RESULTS_CHARS) {
      throw new BatchServiceError("invalid_results", "The results download was not usable text.", { jobID })
    }
    const secrets = await this.activeSecrets()
    this.assertNoSecret(this.artifacts.root, secrets, "The artifact location")
    // Raw and decoded text, malformed lines included, are checked before anything is written.
    this.assertNoSecret(text, secrets, "The results")

    let resultsPath: string
    try {
      resultsPath = await this.artifacts.write(jobID, "results.jsonl", text)
    } catch (error) {
      throw this.artifactFailure(error, jobID)
    }

    const expected = new Map<string, number>()
    requests.forEach((request, index) => expected.set(request.custom_id, index))
    const found = new Map<string, { line: string; result: BatchResult }>()
    let malformed = 0
    let duplicates = 0
    let unexpected = 0
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.endsWith("\r") ? lines[i]!.slice(0, -1) : lines[i]!
      if (raw.trim() === "") continue
      let parsed: BatchResult
      try {
        parsed = parseBatchResultLine(raw, i + 1)
      } catch (error) {
        malformed++
        continue
      }
      if (!expected.has(parsed.custom_id)) unexpected++
      else if (found.has(parsed.custom_id)) duplicates++
      else found.set(parsed.custom_id, { line: raw, result: parsed })
    }
    const missing = requests.length - found.size
    if (malformed + duplicates + unexpected + missing > 0) {
      throw new BatchServiceError(
        "invalid_results",
        `The results are invalid or incomplete: ${malformed} malformed lines, ${duplicates} duplicate IDs, ` +
          `${unexpected} unexpected IDs, ${missing} missing IDs. The job is not marked collected. ` +
          `Raw output is kept at ${resultsPath}.`,
        { jobID, details: { malformed, duplicates, unexpected, missing } },
      )
    }

    const ordered = requests.map((request) => found.get(request.custom_id)!)
    const successLines: string[] = []
    const failureLines: string[] = []
    const counts = { succeeded: 0, errored: 0, canceled: 0, expired: 0 }
    for (const entry of ordered) {
      const type = entry.result.result.type
      counts[type]++
      if (type === "succeeded") successLines.push(entry.line)
      else failureLines.push(entry.line)
    }
    const expectedCounts = record.remote?.counts
    if (
      expectedCounts !== undefined &&
      (expectedCounts.succeeded !== counts.succeeded ||
        expectedCounts.errored !== counts.errored ||
        expectedCounts.canceled !== counts.canceled ||
        expectedCounts.expired !== counts.expired)
    ) {
      throw new BatchServiceError(
        "invalid_results",
        `The result types do not match the counts of the ended batch (found ${counts.succeeded} succeeded, ` +
          `${counts.errored} errored, ${counts.canceled} canceled, ${counts.expired} expired; ` +
          `expected ${expectedCounts.succeeded}, ${expectedCounts.errored}, ${expectedCounts.canceled}, ` +
          `${expectedCounts.expired}). The job is not marked collected. Raw output is kept at ${resultsPath}.`,
        {
          jobID,
          details: {
            succeeded: counts.succeeded,
            errored: counts.errored,
            canceled: counts.canceled,
            expired: counts.expired,
            expectedSucceeded: expectedCounts.succeeded,
            expectedErrored: expectedCounts.errored,
            expectedCanceled: expectedCounts.canceled,
            expectedExpired: expectedCounts.expired,
          },
        },
      )
    }
    let cost = estimateBatchCost(
      ordered.map((entry) => entry.result),
      this.rates,
    )
    // A rate source that holds key material must not reach storage or output. Collection still succeeds.
    if (this.hasSecret(JSON.stringify(cost), secrets)) cost = { kind: "unavailable", reason: UNSAFE_COST_REASON }
    const collectedAt = this.now().toISOString()
    try {
      const successes = await this.artifacts.write(jobID, "successes.jsonl", joinLines(successLines))
      const failures = await this.artifacts.write(jobID, "failures.jsonl", joinLines(failureLines))
      const collected: BatchJobRecord = {
        ...record,
        updatedAt: collectedAt,
        collection: {
          state: "collected",
          collectedAt,
          counts,
          cost,
          artifacts: {
            requests: record.snapshotPath,
            results: resultsPath,
            successes,
            failures,
            manifest: await this.artifacts.path(jobID, "manifest.json"),
          },
        },
      }
      const manifest = {
        ...JSON.parse(this.manifestText(collected)),
        collection: {
          collectedAt,
          counts,
          cost,
          order: ordered.map((entry, index) => ({
            index,
            custom_id: requests[index]!.custom_id,
            type: entry.result.result.type,
          })),
        },
      }
      await this.artifacts.write(jobID, "manifest.json", JSON.stringify(manifest))
      try {
        await this.store.put(collected)
      } catch {
        throw new BatchServiceError(
          "storage_failed",
          `Results were saved for job ${jobID}, but the local record update failed. Run collect again.`,
          { jobID },
        )
      }
      return collected
    } catch (error) {
      if (error instanceof BatchServiceError) throw error
      throw this.artifactFailure(error, jobID)
    }
  }

  // ------------------------------------------------------------------------------------------ helpers

  private requireSession(sessionID: string): void {
    if (typeof sessionID !== "string" || sessionID === "") {
      throw new BatchServiceError("invalid_argument", "A session ID is required.")
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new BatchServiceError("aborted", "The operation was aborted.")
  }

  private lockKey(sessionID: string, jobID: string): string {
    return `${this.artifacts.root}\0${sessionID}\0${jobID}`
  }

  private isInflight(record: BatchJobRecord): boolean {
    return this.inflight.has(this.lockKey(record.originatingSession, record.jobID))
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const tail = previous.then(() => gate)
    this.locks.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  /** Resolves the job, takes its lock, re-reads the record, and reconciles a stale submission. */
  private async locked<T>(
    sessionID: string,
    jobRef: string,
    fn: (record: BatchJobRecord) => Promise<T>,
  ): Promise<T> {
    if (!isValidID(jobRef)) throw new BatchServiceError("invalid_argument", "The job or batch ID is not valid.")
    const found = await this.guard(() => this.store.resolve(sessionID, jobRef))
    if (!found) throw new BatchServiceError("not_found", `No batch job ${jobRef} exists in this session.`)
    return this.withLock(this.lockKey(sessionID, found.jobID), async () => {
      const fresh = await this.guard(() => this.store.get(sessionID, found.jobID))
      if (!fresh) throw new BatchServiceError("not_found", `No batch job ${jobRef} exists in this session.`)
      return fn(await this.reconcile(fresh))
    })
  }

  /** Stale `submitting` records are settled from the manifest. Nothing is ever resubmitted. */
  private async reconcile(record: BatchJobRecord): Promise<BatchJobRecord> {
    if (record.submission !== "submitting" || this.isInflight(record)) return record
    let seen: readonly string[]
    try {
      seen = (await this.secrets()).filter((key) => typeof key === "string" && key.length > 0)
    } catch {
      // Recovered data cannot be checked for key material, so nothing is persisted. A later call retries.
      return { ...record, submission: "submission_unknown" }
    }
    let next: BatchJobRecord = { ...record, submission: "submission_unknown" }
    try {
      const manifest: unknown = JSON.parse(await this.artifacts.read(record.jobID, "manifest.json"))
      if (isRecord(manifest) && manifest.jobID === record.jobID && manifest.originatingSession === record.originatingSession) {
        const batchID =
          isValidID(manifest.batchID) && !this.hasSecret(manifest.batchID, seen) ? manifest.batchID : undefined
        if (manifest.submission === "submitted" && batchID !== undefined) {
          next = { ...record, submission: "submitted", batchID }
          const remote = parseBatchRemoteState(manifest.remote)
          if (remote !== undefined) next = { ...next, remote }
        } else if (manifest.submission === "submission_unknown" && batchID !== undefined) {
          next = { ...record, submission: "submission_unknown", batchID }
        } else if (manifest.submission === "rejected") {
          const httpStatus = numberField(manifest, "httpStatus")
          next = { ...record, submission: "rejected", ...(httpStatus === undefined ? {} : { httpStatus }) }
        }
      }
    } catch {
      // No usable manifest: the outcome stays unknown.
    }
    return this.save(next).catch(() => next)
  }

  private async save(record: BatchJobRecord): Promise<BatchJobRecord> {
    const next = { ...record, updatedAt: this.now().toISOString() }
    try {
      await this.store.put(next)
    } catch {
      throw new BatchServiceError("storage_failed", "The local job record could not be saved.", {
        jobID: record.jobID,
        ...(record.batchID === undefined ? {} : { batchID: record.batchID }),
      })
    }
    return next
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof BatchServiceError) throw error
      if (error instanceof BatchStoreError) throw new BatchServiceError("invalid_argument", error.message)
      throw new BatchServiceError("storage_failed", "The local job store could not be read.")
    }
  }

  private guardSync<T>(fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      if (error instanceof BatchStoreError) throw new BatchServiceError("invalid_argument", error.message)
      throw new BatchServiceError("invalid_argument", "The request is not valid.")
    }
  }

  private artifactFailure(error: unknown, jobID: string): BatchServiceError {
    if (error instanceof BatchServiceError) return error
    if (error instanceof BatchArtifactError) return new BatchServiceError("artifact_error", error.message, { jobID })
    return new BatchServiceError("artifact_error", "A protected batch file could not be written or read.", { jobID })
  }

  private remoteFailure(
    action: string,
    error: unknown,
    record: BatchJobRecord,
    code: BatchServiceErrorCode = "remote_error",
  ): BatchServiceError {
    if (error instanceof BatchServiceError) return error
    const status = numberField(error, "status", "statusCode")
    const how = isAbortLike(error) ? "was aborted or timed out" : status ? `failed (HTTP ${status})` : "failed"
    return new BatchServiceError(code, `${action} for job ${record.jobID} ${how}. The local record is unchanged.`, {
      jobID: record.jobID,
      ...(record.batchID === undefined ? {} : { batchID: record.batchID }),
      ...(status === undefined ? {} : { details: { httpStatus: status } }),
    })
  }

  private async activeSecrets(): Promise<readonly string[]> {
    try {
      const keys = await this.secrets()
      return keys.filter((key) => typeof key === "string" && key.length > 0)
    } catch {
      throw new BatchServiceError("secrets_unavailable", "Active credentials could not be checked. Nothing was saved.")
    }
  }

  private hasSecret(text: string, secrets: readonly string[]): boolean {
    if (secrets.length === 0) return false
    const found = (value: string) => secrets.some((key) => value.includes(key) || value.includes(jsonEscaped(key)))
    if (found(text)) return true
    // Unicode and slash escapes can hide a key from a plain search.
    return /\\u|\\\//.test(text) && found(decodeJsonEscapes(text))
  }

  private assertNoSecret(text: string, secrets: readonly string[], subject: string): void {
    if (this.hasSecret(text, secrets)) {
      throw new BatchServiceError("secret_detected", `${subject} contains active API key material. Nothing was saved.`)
    }
  }

  /**
   * Reads the input file with checks on the open handle, so the checks and the read see one file. The open does not
   * block on a FIFO. Anything but a regular file is refused, and the bytes read must equal the size at the check.
   */
  private async readInput(path: string, signal?: AbortSignal): Promise<string> {
    this.throwIfAborted(signal)
    let handle
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
    } catch {
      throw new BatchServiceError("input_unreadable", "The input file could not be opened.")
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new BatchServiceError("input_unreadable", "The input path is not a regular file.")
      if (stat.size > DEFAULT_MAX_INPUT_BYTES) {
        throw new BatchServiceError("invalid_input", `Input is larger than ${DEFAULT_MAX_INPUT_BYTES} bytes.`)
      }
      // One byte more than the size detects a file that grew.
      const buffer = Buffer.alloc(stat.size + 1)
      let total = 0
      while (total < buffer.length) {
        this.throwIfAborted(signal)
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
        if (bytesRead === 0) break
        total += bytesRead
      }
      this.throwIfAborted(signal)
      if (total !== stat.size) {
        throw new BatchServiceError("input_unreadable", "The input file changed while it was read.")
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))
      } catch {
        throw new BatchServiceError("invalid_input", "The input file is not valid UTF-8.")
      }
    } catch (error) {
      if (error instanceof BatchServiceError) throw error
      throw new BatchServiceError("input_unreadable", "The input file could not be read.")
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /** Reads the protected snapshot and checks it against the recorded digest. */
  private async readSnapshot(record: BatchJobRecord): Promise<BatchRequest[]> {
    let text: string
    try {
      text = await this.artifacts.read(record.jobID, "requests.json")
    } catch {
      throw new BatchServiceError("snapshot_invalid", "The request snapshot is missing or unreadable.", {
        jobID: record.jobID,
      })
    }
    if (sha256(text) !== record.snapshotSha256) {
      throw new BatchServiceError("snapshot_invalid", "The request snapshot changed after submission.", {
        jobID: record.jobID,
      })
    }
    try {
      return parseBatchRequests(text, { maxBytes: SNAPSHOT_MAX_BYTES })
    } catch {
      throw new BatchServiceError("snapshot_invalid", "The request snapshot is not valid.", { jobID: record.jobID })
    }
  }

  private async artifactsPresent(record: BatchJobRecord): Promise<boolean> {
    const paths = record.collection.artifacts
    if (!paths) return false
    try {
      for (const [name, file] of [
        ["results.jsonl", paths.results],
        ["successes.jsonl", paths.successes],
        ["failures.jsonl", paths.failures],
        ["manifest.json", paths.manifest],
        ["requests.json", paths.requests],
      ] as const) {
        const expected = await this.artifacts.path(record.jobID, name)
        if (expected !== file) return false
        if (!(await lstat(expected)).isFile()) return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Validates a remote batch and reduces it to the stored state. Result URLs are dropped. */
  private remoteState(batch: RemoteBatch, expectedID: string | undefined, record: BatchJobRecord): BatchRemoteState {
    const bad = () =>
      new BatchServiceError("invalid_remote", `The gateway returned an unusable batch object for job ${record.jobID}.`, {
        jobID: record.jobID,
      })
    if (!isRecord(batch)) throw bad()
    if (!isValidID(batch.id) || (expectedID !== undefined && batch.id !== expectedID)) throw bad()
    // The stored state is rebuilt fieldwise with strict timestamps and counts. Result URLs and extras are dropped.
    const remote = parseBatchRemoteState({
      status: batch.processing_status,
      counts: batch.request_counts,
      createdAt: batch.created_at,
      endedAt: batch.ended_at,
      observedAt: this.now().toISOString(),
    })
    if (!remote) throw bad()
    return remote
  }

  private manifestText(record: BatchJobRecord): string {
    return JSON.stringify({
      version: 1,
      jobID: record.jobID,
      originatingSession: record.originatingSession,
      inputPath: record.inputPath,
      snapshotSha256: record.snapshotSha256,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      submission: record.submission,
      ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
      requestCount: record.requestCount,
      models: record.models,
      otherModels: record.otherModels,
      ...(record.batchID === undefined ? {} : { batchID: record.batchID }),
      ...(record.remote === undefined ? {} : { remote: record.remote }),
    })
  }

  private summarize(record: BatchJobRecord, extraNote?: string): BatchJobSummary {
    const nowMs = this.now().getTime()
    const startMs = toTime(record.remote?.createdAt) ?? toTime(record.createdAt) ?? nowMs
    const endMs =
      record.remote?.status === "ended" ? (toTime(record.remote.endedAt) ?? nowMs) : nowMs
    const elapsedMs = Math.max(0, endMs - startMs)
    let note = extraNote
    if (record.submission === "submitting") {
      note ??= this.isInflight(record)
        ? "Submission is in progress."
        : "Submission did not finish. Inspect or check status with the job ID to reconcile it."
    } else if (record.submission === "submission_unknown") {
      note ??= NOTE_UNKNOWN
    } else if (record.submission === "rejected") {
      note ??= record.httpStatus
        ? `The gateway rejected the submission (HTTP ${record.httpStatus}). Nothing was created.`
        : "The submission was not accepted. Nothing was created."

    } else if (record.remote?.status === "canceling") {
      note ??= "Cancellation was requested. The batch is final only when its status shows ended."
    }
    const remote = record.remote
    return {
      jobID: record.jobID,
      ...(record.batchID === undefined ? {} : { batchID: record.batchID }),
      submission: record.submission,
      ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
      ...(note === undefined ? {} : { note }),
      inputPath: record.inputPath,
      requestsPath: record.snapshotPath,
      createdAt: record.createdAt,
      elapsedMs,
      requests: { count: record.requestCount, models: record.models, otherModels: record.otherModels },
      ...(remote === undefined
        ? {}
        : {
            remote: {
              status: remote.status,
              counts: remote.counts,
              createdAt: remote.createdAt,
              endedAt: remote.endedAt,
              observedAt: remote.observedAt,
              staleMs: Math.max(0, nowMs - (toTime(remote.observedAt) ?? nowMs)),
            },
          }),
      collection: {
        state: record.collection.state,
        ...(record.collection.collectedAt === undefined ? {} : { collectedAt: record.collection.collectedAt }),
        ...(record.collection.counts === undefined ? {} : { counts: record.collection.counts }),
        ...(record.collection.artifacts === undefined ? {} : { artifacts: record.collection.artifacts }),
      },
      cost: record.collection.cost ?? UNAVAILABLE_COST,
    }
  }
}

function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}
