import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatchArtifacts } from "../../../src/fuelix/batch/artifacts.ts"
import {
  BatchService,
  BatchServiceError,
  type BatchClientLike,
  type BatchServiceOptions,
} from "../../../src/fuelix/batch/service.ts"
import type { BatchStorage } from "../../../src/fuelix/batch/store.ts"
import type { BatchRequest, RemoteBatch } from "../../../src/fuelix/batch/types.ts"

const KEY = "sk-test-not-a-real-key"
const RESULT_URL = "https://results.example.test/private/path"
const SESSION = "ses_a"
const OTHER = "ses_b"

class MemoryStorage {
  readonly map = new Map<string, unknown>()
  setCalls = 0
  failSet: ((key: string, value: any) => boolean) | undefined
  beforeSet: ((key: string, value: any) => Promise<void>) | undefined
  async get(key: string) {
    return this.map.get(key)
  }
  async set(key: string, value: unknown) {
    this.setCalls++
    await this.beforeSet?.(key, value)
    if (this.failSet?.(key, value)) throw new Error(`storage down ${KEY} secret-body`)
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

function remote(overrides: Partial<RemoteBatch> = {}): RemoteBatch {
  return {
    id: "msgbatch_1",
    type: "message_batch",
    processing_status: "in_progress",
    request_counts: { processing: 4, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: "2026-11-05T10:00:00.000Z",
    ended_at: null,
    results_url: RESULT_URL,
    ...overrides,
  }
}

function ended(counts: Partial<RemoteBatch["request_counts"]> = {}, id = "msgbatch_1"): RemoteBatch {
  return remote({
    id,
    processing_status: "ended",
    request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 1, expired: 1, ...counts },
    ended_at: "2026-11-05T10:05:00.000Z",
  })
}

class FakeClient implements BatchClientLike {
  submits: BatchRequest[][] = []
  statuses: string[] = []
  cancels: string[] = []
  downloads = 0
  active = 0
  maxActive = 0
  nextID = 1
  current: RemoteBatch = remote()
  resultsText = ""
  submitImpl: ((requests: readonly BatchRequest[]) => Promise<RemoteBatch>) | undefined
  statusImpl: (() => Promise<void>) | undefined

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      return await fn()
    } finally {
      this.active--
    }
  }

  async submit(requests: readonly BatchRequest[]): Promise<RemoteBatch> {
    this.submits.push(structuredClone([...requests]))
    if (this.submitImpl) return this.submitImpl(requests)
    this.current = remote({ id: `msgbatch_${this.nextID++}` })
    return this.current
  }
  async status(id: string): Promise<RemoteBatch> {
    this.statuses.push(id)
    return this.track(async () => {
      await this.statusImpl?.()
      return { ...this.current, id }
    })
  }
  async cancel(id: string): Promise<RemoteBatch> {
    this.cancels.push(id)
    this.current = { ...this.current, id, processing_status: "canceling" }
    return this.current
  }
  async results(): Promise<string> {
    this.downloads++
    return this.track(async () => this.resultsText)
  }
}

const REQUESTS = ["a", "b", "c", "d"].map((id) => ({
  custom_id: id,
  params: {
    model: "fuelix-anthropic/claude-sonnet-4-5",
    max_tokens: 100 + id.charCodeAt(0),
    messages: [{ role: "user", content: `PROMPT-${id}` }],
  },
}))

const message = (text: string) => ({
  type: "message",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text }],
  usage: { input_tokens: 1, output_tokens: 1 },
})
const line = (custom_id: string, result: unknown) => JSON.stringify({ custom_id, result })
const RESULT = {
  a: line("a", { type: "succeeded", message: message("RESULT-A") }),
  b: line("b", { type: "errored", error: { type: "error", error: { type: "api_error", message: "boom" } } }),
  c: line("c", { type: "canceled" }),
  d: line("d", { type: "expired" }),
}
const jsonl = (...items: string[]) => items.join("\n") + "\n"

let base: string
let work: string
let artifactRoot: string
let storage: MemoryStorage
let client: FakeClient
let time: number
let secrets: string[]

const makeService = (overrides: Partial<BatchServiceOptions> = {}, shared = true) =>
  new BatchService({
    storage: (shared ? storage : new MemoryStorage()) as unknown as BatchStorage,
    artifacts: new BatchArtifacts(artifactRoot),
    client,
    directory: work,
    now: () => new Date(time),
    secrets: async () => secrets,
    ...overrides,
  })

let service: BatchService

async function writeInput(name = "input.jsonl", requests: unknown[] = REQUESTS) {
  const path = join(work, name)
  await writeFile(path, requests.map((r) => JSON.stringify(r)).join("\n"))
  return path
}

async function submit(who = SESSION, svc = service) {
  time += 1000
  return svc.submit(who, await writeInput())
}

async function expectError(promise: Promise<unknown>, code: string): Promise<BatchServiceError> {
  const error = await promise.then(
    () => undefined,
    (e) => e,
  )
  expect(error).toBeInstanceOf(BatchServiceError)
  expect(String((error as BatchServiceError).code)).toBe(code)
  return error as BatchServiceError
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await filesUnder(path)))
    else out.push(path)
  }
  return out
}

async function everythingPersisted(): Promise<string> {
  const parts = [JSON.stringify([...storage.map.entries()])]
  for (const file of await filesUnder(artifactRoot)) parts.push(await readFile(file, "utf8"))
  return parts.join("\n")
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "td-batch-service-"))
  work = join(base, "work")
  artifactRoot = join(base, "state", "batch")
  await mkdir(work, { recursive: true })
  storage = new MemoryStorage()
  client = new FakeClient()
  time = Date.parse("2026-11-05T10:00:00.000Z")
  secrets = [KEY]
  service = makeService()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("submit", () => {
  test("persists a private snapshot and record before the POST", async () => {
    let seen: { record: any; snapshot: string; mode: number } | undefined
    client.submitImpl = async () => {
      const record: any = [...storage.map.values()][0]
      const path = join(artifactRoot, record.jobID, "requests.json")
      seen = {
        record,
        snapshot: await readFile(path, "utf8"),
        mode: (await lstat(path)).mode & 0o777,
      }
      return remote()
    }
    const summary = await submit()
    expect(seen?.record.submission).toBe("submitting")
    expect(seen?.record.batchID).toBeUndefined()
    expect(seen?.mode).toBe(0o600)
    // The snapshot holds the normalized body: the model prefix is stripped.
    expect(JSON.parse(seen!.snapshot).requests[0].params.model).toBe("claude-sonnet-4-5")

    expect(summary.submission).toBe("submitted")
    expect(summary.batchID).toBe("msgbatch_1")
    expect(summary.jobID).toMatch(/^job-/)
    expect(summary.requests).toEqual({ count: 4, models: [{ model: "claude-sonnet-4-5", count: 4 }], otherModels: 0 })
    expect(summary.remote?.counts.processing).toBe(4)
    expect(summary.cost.kind).toBe("unavailable")
    expect(summary.collection.state).toBe("not_collected")
    expect(client.submits).toHaveLength(1)
    expect(client.submits[0]![0]!.params.model).toBe("claude-sonnet-4-5")
  })

  test("stores no prompts, results, keys, or result URLs in plugin storage", async () => {
    await submit()
    const stored = JSON.stringify([...storage.map.entries()])
    expect(stored).not.toContain("PROMPT-")
    expect(stored).not.toContain(KEY)
    expect(stored).not.toContain("results.example.test")
    expect(JSON.parse(stored)).toBeArray()
    const record: any = [...storage.map.values()][0]
    expect(record.originatingSession).toBe(SESSION)
    expect(record.inputPath).toBe(join(work, "input.jsonl"))
    expect(await readFile(record.snapshotPath, "utf8")).toContain("PROMPT-a")
  })

  test("resolves a relative input path against the service directory", async () => {
    await writeInput("rel.jsonl")
    const summary = await service.submit(SESSION, "rel.jsonl")
    expect(summary.inputPath).toBe(join(work, "rel.jsonl"))
  })

  test("validates input before any paid send", async () => {
    await expectError(service.submit(SESSION, join(work, "missing.jsonl")), "input_unreadable")
    await expectError(service.submit(SESSION, work), "input_unreadable")
    await expectError(service.submit(SESSION, ""), "invalid_argument")
    await expectError(service.submit("", "x"), "invalid_argument")
    const bad = join(work, "bad.json")
    await writeFile(bad, JSON.stringify({ requests: [{ custom_id: "a", params: { model: "m" } }] }))
    const error = await expectError(service.submit(SESSION, bad), "invalid_input")
    expect(error.message).toContain("Request 1")
    await writeFile(join(work, "empty.json"), "")
    await expectError(service.submit(SESSION, join(work, "empty.json")), "invalid_input")
    await writeFile(join(work, "binary.json"), Buffer.from([0xff, 0xfe, 0xfd]))
    await expectError(service.submit(SESSION, join(work, "binary.json")), "invalid_input")
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("rejects an input over 32 MiB by size before reading it", async () => {
    const big = join(work, "big.jsonl")
    await writeFile(big, "")
    await truncate(big, 32 * 1024 * 1024 + 1)
    const error = await expectError(service.submit(SESSION, big), "invalid_input")
    expect(error.message).toContain("larger")
    expect(client.submits).toHaveLength(0)
  })

  test("rejects input that contains an active key", async () => {
    const requests = [{ ...REQUESTS[0]!, params: { ...REQUESTS[0]!.params, messages: [{ role: "user", content: KEY }] } }]
    const path = await writeInput("leak.jsonl", requests)
    const error = await expectError(service.submit(SESSION, path), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("fails closed when secrets cannot be listed", async () => {
    const svc = makeService({
      secrets: async () => {
        throw new Error(KEY)
      },
    })
    const error = await expectError(svc.submit(SESSION, await writeInput()), "secrets_unavailable")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
  })

  test("honors an aborted signal before saving or sending", async () => {
    const controller = new AbortController()
    controller.abort()
    await expectError(service.submit(SESSION, await writeInput(), controller.signal), "aborted")
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
  })

  test("does not send when the record cannot be stored", async () => {
    storage.failSet = () => true
    const error = await expectError(service.submit(SESSION, await writeInput()), "storage_failed")
    expect(error.message).not.toContain(KEY)
    expect(error.message).not.toContain("secret-body")
    expect(client.submits).toHaveLength(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("keeps the snapshot independent of later changes to the input file", async () => {
    const summary = await submit()
    await writeInput("input.jsonl", [{ ...REQUESTS[0]!, custom_id: "changed" }])
    const inspected = await service.inspect(SESSION, summary.jobID)
    expect(inspected.requests.items.map((item) => item.custom_id)).toEqual(["a", "b", "c", "d"])
    expect(await readFile(summary.requestsPath, "utf8")).not.toContain("changed")
  })
})

describe("submission failures", () => {
  const dirtyError = (extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`remote body: ${KEY} <script>`), extra)

  test("an ambiguous failure keeps an unknown record and never resubmits", async () => {
    client.submitImpl = async () => {
      throw dirtyError()
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.jobID).toMatch(/^job-/)
    expect(error.message).toContain(error.jobID!)
    expect(error.message).not.toContain(KEY)
    expect(error.message).not.toContain("script")
    const { jobs } = await service.list(SESSION)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.submission).toBe("submission_unknown")
    expect(jobs[0]!.batchID).toBeUndefined()
    // Status has no remote batch to ask about and does not resubmit.
    const status = await service.status(SESSION, error.jobID!)
    expect(status.submission).toBe("submission_unknown")
    await service.collect(SESSION, error.jobID!)
    await service.cancel(SESSION, error.jobID!)
    expect(client.submits).toHaveLength(1)
    expect(client.statuses).toHaveLength(0)
    expect(client.cancels).toHaveLength(0)
    expect(await everythingPersisted()).not.toContain(KEY)
  })

  test.each([408, 500, 502, 503])("HTTP %d is ambiguous", async (status) => {
    client.submitImpl = async () => {
      throw dirtyError({ status })
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect((await service.list(SESSION)).jobs[0]!.submission).toBe("submission_unknown")
  })

  test("an abort during the POST is ambiguous", async () => {
    client.submitImpl = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" })
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
  })

  test("an HTTP rejection stays visible as rejected", async () => {
    client.submitImpl = async () => {
      throw dirtyError({ status: 400 })
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_rejected")
    expect(error.message).toContain("HTTP 400")
    expect(error.message).not.toContain(KEY)
    const { jobs } = await service.list(SESSION)
    expect(jobs[0]).toMatchObject({ submission: "rejected", httpStatus: 400 })
    expect(jobs[0]!.note).toContain("Nothing was created")
  })

  test("client error flags decide between not sent and ambiguous", async () => {
    client.submitImpl = async () => {
      throw dirtyError({ code: "no_key", ambiguous: false })
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_rejected")
    expect((await service.list(SESSION)).jobs[0]).toMatchObject({ submission: "rejected" })
    client.submitImpl = async () => {
      throw dirtyError({ status: 400, ambiguous: true })
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
  })

  test("an unusable accepted batch keeps the unknown state", async () => {
    client.submitImpl = async () => remote({ id: `bad id ${KEY}` })
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.message).not.toContain(KEY)
    expect(await everythingPersisted()).not.toContain(KEY)
  })

  test("a failed record update after acceptance reports the batch ID and recovers later", async () => {
    storage.failSet = (_key, value) => value.submission === "submitted"
    const error = await expectError(service.submit(SESSION, await writeInput()), "record_not_saved")
    expect(error.batchID).toBe("msgbatch_1")
    expect(error.message).toContain("msgbatch_1")
    expect(error.message).toContain(error.jobID!)
    expect(error.message).not.toContain(KEY)
    const manifest = JSON.parse(await readFile(join(artifactRoot, error.jobID!, "manifest.json"), "utf8"))
    expect(manifest.batchID).toBe("msgbatch_1")

    storage.failSet = undefined
    // A new service instance recovers the record from the manifest without resubmitting.
    const restarted = makeService()
    const status = await restarted.status(SESSION, error.jobID!)
    expect(status.submission).toBe("submitted")
    expect(status.batchID).toBe("msgbatch_1")
    expect(client.submits).toHaveLength(1)
    expect(client.statuses).toEqual(["msgbatch_1"])
  })

  test("a running submission is visible as in progress to another service instance", async () => {
    let release!: (value: RemoteBatch) => void
    client.submitImpl = () => new Promise<RemoteBatch>((resolve) => (release = resolve))
    const pending = service.submit(SESSION, await writeInput())
    for (let i = 0; i < 50 && storage.map.size === 0; i++) await new Promise((r) => setTimeout(r, 2))
    const record: any = [...storage.map.values()][0]
    expect(record.submission).toBe("submitting")
    const other = makeService()
    expect((await other.inspect(SESSION, record.jobID)).job.submission).toBe("submitting")
    expect((await other.list(SESSION)).jobs[0]!.note).toContain("in progress")
    release(remote())
    expect((await pending).submission).toBe("submitted")
    expect(client.statuses).toHaveLength(0)
  })

  test("a stale submitting record without a batch ID becomes unknown on inspect", async () => {
    const mine = await submit()
    const key = [...storage.map.keys()][0]!
    const stale: any = structuredClone(storage.map.get(key))
    stale.submission = "submitting"
    delete stale.batchID
    delete stale.remote
    storage.map.set(key, stale)
    const artifacts = new BatchArtifacts(artifactRoot)
    const manifest = JSON.parse(await artifacts.read(mine.jobID, "manifest.json"))
    delete manifest.batchID
    delete manifest.remote
    manifest.submission = "submitting"
    await artifacts.write(mine.jobID, "manifest.json", JSON.stringify(manifest))

    const inspected = await makeService().inspect(SESSION, mine.jobID)
    expect(inspected.job.submission).toBe("submission_unknown")
    expect(client.statuses).toHaveLength(0)
    expect(client.submits).toHaveLength(1)
  })

  test("persisted failure data holds no error text or cause", async () => {
    const hostile = "HOSTILE-ERROR-TEXT <b>x</b>"
    client.submitImpl = async () => {
      throw Object.assign(new Error(hostile, { cause: new Error(hostile) }), { status: 502, body: hostile })
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.cause).toBeUndefined()
    expect(await everythingPersisted()).not.toContain("HOSTILE")
    expect(JSON.stringify(await service.list(SESSION))).not.toContain("HOSTILE")
  })
})

describe("session isolation", () => {
  test("every method refuses a foreign job without a remote call", async () => {
    const mine = await submit(SESSION)
    const calls = () => client.statuses.length + client.cancels.length + client.downloads
    for (const ref of [mine.jobID, mine.batchID!]) {
      await expectError(service.inspect(OTHER, ref), "not_found")
      await expectError(service.status(OTHER, ref), "not_found")
      await expectError(service.cancel(OTHER, ref), "not_found")
      await expectError(service.collect(OTHER, ref), "not_found")
    }
    expect(calls()).toBe(0)
    expect((await service.list(OTHER)).jobs).toEqual([])
    expect((await service.list(SESSION)).jobs).toHaveLength(1)
  })

  test("an unknown remote batch ID is never queried", async () => {
    await submit(SESSION)
    for (const ref of ["msgbatch_unknown", "job-unknown"]) {
      await expectError(service.status(SESSION, ref), "not_found")
      await expectError(service.cancel(SESSION, ref), "not_found")
      await expectError(service.collect(SESSION, ref), "not_found")
      await expectError(service.inspect(SESSION, ref), "not_found")
    }
    await expectError(service.status(SESSION, "../etc/passwd"), "invalid_argument")
    expect(client.statuses).toHaveLength(0)
    expect(client.cancels).toHaveLength(0)
    expect(client.downloads).toBe(0)
  })

  test("a session can look up its own job by remote batch ID", async () => {
    const mine = await submit(SESSION)
    await submit(OTHER)
    const status = await service.status(SESSION, mine.batchID!)
    expect(status.jobID).toBe(mine.jobID)
    expect(client.statuses).toEqual([mine.batchID!])
  })

  test("a list cursor from another session is refused", async () => {
    for (let i = 0; i < 3; i++) await submit(OTHER)
    const page = await service.list(OTHER, { limit: 1 })
    expect(page.next).toBeDefined()
    await expectError(service.list(SESSION, { after: page.next! }), "invalid_argument")
  })
})

describe("list and inspect", () => {
  test("list is local, paginated, and newest first", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push((await submit()).jobID)
    const before = client.statuses.length
    const first = await service.list(SESSION, { limit: 2 })
    const second = await service.list(SESSION, { limit: 2, after: first.next! })
    const third = await service.list(SESSION, { limit: 2, after: second.next! })
    expect(client.statuses.length).toBe(before)
    const all = [...first.jobs, ...second.jobs, ...third.jobs].map((job) => job.jobID)
    expect(all).toEqual([...ids].reverse())
    expect(third.next).toBeUndefined()
    for (const limit of [0, -3, 1.5, 101, Number.NaN]) {
      await expectError(service.list(SESSION, { limit }), "invalid_argument")
    }
    await expectError(service.list(SESSION, { after: "" }), "invalid_argument")
  })

  test("history survives a restart that shares storage", async () => {
    const mine = await submit()
    const restarted = makeService({ artifacts: new BatchArtifacts(artifactRoot) })
    const { jobs } = await restarted.list(SESSION)
    expect(jobs.map((job) => job.jobID)).toEqual([mine.jobID])
    const inspected = await restarted.inspect(SESSION, mine.jobID)
    expect(inspected.job.batchID).toBe(mine.batchID)
    expect(inspected.job.requestsPath).toBe(mine.requestsPath)
  })

  test("inspect pages bounded per-request metadata and never returns prompts", async () => {
    const mine = await submit()
    const first = await service.inspect(SESSION, mine.jobID, { limit: 3 })
    expect(first.requests.total).toBe(4)
    expect(first.requests.items.map((item) => item.custom_id)).toEqual(["a", "b", "c"])
    expect(first.requests.items[0]).toEqual({ index: 0, custom_id: "a", model: "claude-sonnet-4-5", max_tokens: 197 })
    expect(first.requests.next).toBe("3")
    const second = await service.inspect(SESSION, mine.jobID, { limit: 3, after: first.requests.next })
    expect(second.requests.items.map((item) => item.custom_id)).toEqual(["d"])
    expect(second.requests.next).toBeUndefined()
    expect(JSON.stringify(first)).not.toContain("PROMPT-")
    await expectError(service.inspect(SESSION, mine.jobID, { limit: 0 }), "invalid_argument")
    await expectError(service.inspect(SESSION, mine.jobID, { after: "abc" }), "invalid_argument")
    await expectError(service.inspect(SESSION, mine.jobID, { after: "-1" }), "invalid_argument")
  })

  test("inspect reports a tampered snapshot without throwing", async () => {
    const mine = await submit()
    await writeFile(mine.requestsPath, "{}", { mode: 0o600 })
    const inspected = await service.inspect(SESSION, mine.jobID)
    expect(inspected.requests.items).toEqual([])
    expect(inspected.requests.note).toContain("changed")
  })
})

describe("status and cancel", () => {
  test("status is the explicit remote read and reports elapsed time and staleness", async () => {
    const mine = await submit()
    time += 60_000
    const status = await service.status(SESSION, mine.jobID)
    expect(client.statuses).toEqual([mine.batchID!])
    expect(status.remote).toMatchObject({ status: "in_progress", staleMs: 0 })
    expect(status.elapsedMs).toBe(time - Date.parse("2026-11-05T10:00:00.000Z"))
    // Listing reads the stored observation and reports its age.
    time += 5000
    const listed = (await service.list(SESSION)).jobs[0]!
    expect(listed.remote?.staleMs).toBe(5000)
    expect(listed.elapsedMs).toBe(status.elapsedMs + 5000)
  })

  test("an ended batch freezes elapsed time at ended_at", async () => {
    const mine = await submit()
    client.current = ended()
    time = Date.parse("2026-11-06T10:00:00.000Z")
    const status = await service.status(SESSION, mine.jobID)
    expect(status.elapsedMs).toBe(5 * 60_000)
  })

  test("elapsed time is clamped at zero", async () => {
    const mine = await submit()
    client.current = ended({}, mine.batchID!)
    client.current = { ...client.current, created_at: "2026-11-05T11:00:00.000Z" }
    const status = await service.status(SESSION, mine.jobID)
    expect(status.elapsedMs).toBe(0)
  })

  test("rejects a remote object for another batch or with malformed fields", async () => {
    const mine = await submit()
    client.status = async () => remote({ id: "msgbatch_other" })
    await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
    client.status = async () => remote({ id: mine.batchID!, request_counts: { processing: -1 } as any })
    await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
    client.status = async () => remote({ id: mine.batchID!, created_at: "not a date" })
    await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
    expect((await service.list(SESSION)).jobs[0]!.remote?.status).toBe("in_progress")
  })

  test("remote failures are reported safely and leave the record unchanged", async () => {
    const mine = await submit()
    client.status = async () => {
      throw Object.assign(new Error(`body ${KEY}`), { status: 503 })
    }
    const error = await expectError(service.status(SESSION, mine.jobID), "remote_error")
    expect(error.message).toContain("HTTP 503")
    expect(error.message).not.toContain(KEY)
  })

  test("cancel is not final until a later status shows ended", async () => {
    const mine = await submit()
    const canceled = await service.cancel(SESSION, mine.jobID)
    expect(client.cancels).toEqual([mine.batchID!])
    expect(canceled.remote?.status).toBe("canceling")
    expect(canceled.note).toContain("final only when")
    const collected = await service.collect(SESSION, mine.jobID)
    expect(collected.collection.state).toBe("not_collected")
    expect(client.downloads).toBe(0)

    client.current = ended()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const done = await service.collect(SESSION, mine.jobID)
    expect(done.collection.state).toBe("collected")
    // Cancel after the end makes no remote call.
    const again = await service.cancel(SESSION, mine.jobID)
    expect(client.cancels).toHaveLength(1)
    expect(again.note).toContain("already ended")
  })
})

describe("collect", () => {
  async function ready() {
    const mine = await submit()
    client.current = ended()
    return mine
  }

  test("an unfinished batch returns its status without downloading", async () => {
    const mine = await submit()
    const summary = await service.collect(SESSION, mine.jobID)
    expect(summary.collection.state).toBe("not_collected")
    expect(summary.note).toContain("not ended")
    expect(summary.remote?.status).toBe("in_progress")
    expect(client.downloads).toBe(0)
  })

  test("splits out-of-order results in input order and counts every outcome", async () => {
    const mine = await ready()
    client.resultsText = jsonl(RESULT.d, RESULT.b, RESULT.a, RESULT.c)
    const summary = await service.collect(SESSION, mine.jobID)
    expect(summary.collection.state).toBe("collected")
    expect(summary.collection.counts).toEqual({ succeeded: 1, errored: 1, canceled: 1, expired: 1 })
    const paths = summary.collection.artifacts!
    expect(paths.requests).toBe(mine.requestsPath)
    expect(await readFile(paths.results, "utf8")).toBe(client.resultsText)
    expect(await readFile(paths.successes, "utf8")).toBe(jsonl(RESULT.a))
    expect(await readFile(paths.failures, "utf8")).toBe(jsonl(RESULT.b, RESULT.c, RESULT.d))
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"))
    expect(manifest.batchID).toBe(mine.batchID)
    expect(manifest.collection.counts).toEqual({ succeeded: 1, errored: 1, canceled: 1, expired: 1 })
    expect(manifest.collection.order).toEqual([
      { index: 0, custom_id: "a", type: "succeeded" },
      { index: 1, custom_id: "b", type: "errored" },
      { index: 2, custom_id: "c", type: "canceled" },
      { index: 3, custom_id: "d", type: "expired" },
    ])
    expect(JSON.stringify(manifest)).not.toContain("RESULT-A")
    expect(JSON.stringify(summary)).not.toContain("RESULT-A")
    expect(JSON.stringify(summary)).not.toContain(RESULT_URL)
    for (const file of Object.values(paths)) expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect(summary.cost.kind).toBe("unavailable")
    expect(await everythingPersisted()).not.toContain("results.example.test")
  })

  test("collects only what the snapshot expects, with an all-success output", async () => {
    const mine = await submit()
    client.current = ended({ succeeded: 4, errored: 0, canceled: 0, expired: 0 })
    client.resultsText = jsonl(
      line("d", { type: "succeeded", message: message("x") }),
      line("c", { type: "succeeded", message: message("x") }),
      line("b", { type: "succeeded", message: message("x") }),
      line("a", { type: "succeeded", message: message("x") }),
    )
    const summary = await service.collect(SESSION, mine.jobID)
    const successes = (await readFile(summary.collection.artifacts!.successes, "utf8")).trim().split("\n")
    expect(successes.map((entry) => JSON.parse(entry).custom_id)).toEqual(["a", "b", "c", "d"])
    expect(await readFile(summary.collection.artifacts!.failures, "utf8")).toBe("")
  })

  test("is idempotent: a collected job is not downloaded again", async () => {
    const mine = await ready()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const first = await service.collect(SESSION, mine.jobID)
    const statuses = client.statuses.length
    const second = await service.collect(SESSION, mine.jobID)
    expect(client.downloads).toBe(1)
    expect(client.statuses.length).toBe(statuses)
    expect(second.collection).toEqual(first.collection)
    // A restart sees the same collected state.
    const restarted = makeService()
    expect((await restarted.collect(SESSION, mine.jobID)).collection).toEqual(first.collection)
    expect(client.downloads).toBe(1)
  })

  test("downloads again when collected artifacts disappeared", async () => {
    const mine = await ready()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const first = await service.collect(SESSION, mine.jobID)
    await rm(first.collection.artifacts!.successes)
    const again = await service.collect(SESSION, mine.jobID)
    expect(client.downloads).toBe(2)
    expect(await readFile(again.collection.artifacts!.successes, "utf8")).toBe(jsonl(RESULT.a))
  })

  test.each([
    ["duplicate IDs", () => jsonl(RESULT.a, RESULT.a, RESULT.b, RESULT.c, RESULT.d), { duplicates: 1, missing: 0 }],
    ["missing IDs", () => jsonl(RESULT.a, RESULT.b), { missing: 2, malformed: 0 }],
    ["unexpected IDs", () => jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d, line("zzz", { type: "canceled" })), { unexpected: 1 }],
    ["truncated output", () => jsonl(RESULT.a, RESULT.b, RESULT.c) + RESULT.d.slice(0, 20), { malformed: 1, missing: 1 }],
    ["malformed schema", () => jsonl(RESULT.a, RESULT.b, RESULT.c, line("d", { type: "weird" })), { malformed: 1, missing: 1 }],
    ["empty output", () => "", { missing: 4 }],
  ])("%s is rejected and not marked collected", async (_name, text, expectedDetails) => {
    const mine = await ready()
    client.resultsText = text()
    const error = await expectError(service.collect(SESSION, mine.jobID), "invalid_results")
    expect(error.details).toMatchObject(expectedDetails)
    expect(error.message).not.toContain("RESULT-A")
    const job = (await service.list(SESSION)).jobs[0]!
    expect(job.collection.state).toBe("not_collected")
    // The raw output stays for diagnosis. Split files do not exist.
    expect(await readFile(join(artifactRoot, mine.jobID, "results.jsonl"), "utf8")).toBe(text())
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "successes.jsonl"))
    // A later complete download succeeds.
    client.resultsText = jsonl(RESULT.c, RESULT.d, RESULT.a, RESULT.b)
    expect((await service.collect(SESSION, mine.jobID)).collection.state).toBe("collected")
  })

  test("a results download that fails keeps the job uncollected", async () => {
    const mine = await ready()
    client.results = async () => {
      throw Object.assign(new Error(`body ${KEY}`), { status: 500 })
    }
    const error = await expectError(service.collect(SESSION, mine.jobID), "results_unavailable")
    expect(error.message).not.toContain(KEY)
    expect((await service.list(SESSION)).jobs[0]!.collection.state).toBe("not_collected")
  })

  test("results with an active key are neither saved nor returned", async () => {
    const mine = await ready()
    client.resultsText = jsonl(
      line("a", { type: "succeeded", message: message(`leaked ${KEY}`) }),
      RESULT.b,
      RESULT.c,
      RESULT.d,
    )
    const error = await expectError(service.collect(SESSION, mine.jobID), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "results.jsonl"))
    expect(await everythingPersisted()).not.toContain(KEY)
    expect((await service.list(SESSION)).jobs[0]!.collection.state).toBe("not_collected")
  })

  test("a tampered snapshot blocks collection", async () => {
    const mine = await ready()
    await writeFile(mine.requestsPath, JSON.stringify({ requests: REQUESTS.slice(0, 1) }), { mode: 0o600 })
    client.resultsText = jsonl(RESULT.a)
    await expectError(service.collect(SESSION, mine.jobID), "snapshot_invalid")
    expect(client.downloads).toBe(0)
  })

  test("a failed record update after saving results asks for a new collect", async () => {
    const mine = await ready()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    storage.failSet = (_key, value) => value.collection?.state === "collected"
    await expectError(service.collect(SESSION, mine.jobID), "storage_failed")
    expect((await service.list(SESSION)).jobs[0]!.collection.state).toBe("not_collected")
    storage.failSet = undefined
    expect((await service.collect(SESSION, mine.jobID)).collection.state).toBe("collected")
  })

  test("computes an estimate only from an explicit rate card", async () => {
    const mine = await submit()
    client.current = ended()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const priced = makeService({
      rates: {
        source: "Test price sheet 2026-11-05",
        currency: "USD",
        models: { "claude-sonnet-4-5": { input: 1, output: 2 } },
      },
    })
    const summary = await priced.collect(SESSION, mine.jobID)
    expect(summary.cost).toMatchObject({ kind: "estimate", source: "Test price sheet 2026-11-05", amount: 0.000003 })
  })
})

describe("concurrency", () => {
  test("status and collect for one job are serialized and never undo collection", async () => {
    const mine = await submit()
    client.current = ended()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    let gate!: () => void
    const blocked = new Promise<void>((resolve) => (gate = resolve))
    let first = true
    client.statusImpl = async () => {
      if (first) {
        first = false
        await blocked
      }
    }
    const results = Promise.all([
      service.status(SESSION, mine.jobID),
      service.collect(SESSION, mine.jobID),
      service.status(SESSION, mine.jobID),
      service.collect(SESSION, mine.jobID),
    ])
    await new Promise((r) => setTimeout(r, 20))
    gate()
    const [, collected, afterStatus, again] = await results
    expect(client.maxActive).toBe(1)
    expect(client.downloads).toBe(1)
    expect(collected.collection.state).toBe("collected")
    // The status that ran after collection kept the collected paths and cost.
    expect(afterStatus.collection).toEqual(collected.collection)
    expect(again.collection).toEqual(collected.collection)
    const job = (await service.list(SESSION)).jobs[0]!
    expect(job.collection).toEqual(collected.collection)
    expect(job.remote?.status).toBe("ended")
  })

  test("services created per call still serialize one job", async () => {
    const mine = await submit()
    let gate!: () => void
    const blocked = new Promise<void>((resolve) => (gate = resolve))
    let first = true
    client.statusImpl = async () => {
      if (first) {
        first = false
        await blocked
      }
    }
    const calls = [makeService(), makeService(), makeService()].map((svc) => svc.status(SESSION, mine.jobID))
    await new Promise((r) => setTimeout(r, 20))
    gate()
    await Promise.all(calls)
    expect(client.maxActive).toBe(1)
    expect(client.statuses).toHaveLength(3)
  })

  test("different jobs do not block each other", async () => {
    const one = await submit()
    const two = await submit()
    let gate!: () => void
    const blocked = new Promise<void>((resolve) => (gate = resolve))
    let calls = 0
    client.statusImpl = async () => {
      if (calls++ === 0) await blocked
    }
    const slow = service.status(SESSION, one.jobID)
    const fast = await service.status(SESSION, two.jobID)
    expect(fast.jobID).toBe(two.jobID)
    gate()
    expect((await slow).jobID).toBe(one.jobID)
  })
})

describe("secrets", () => {
  test("a hostile remote batch ID or error text never reaches storage, files, or output", async () => {
    client.submitImpl = async () => remote({ id: `msgbatch_${KEY}` })
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.message).not.toContain(KEY)
    expect(JSON.stringify(await service.list(SESSION))).not.toContain(KEY)
    expect(await everythingPersisted()).not.toContain(KEY)
  })

  test("escaped key material in JSON text is detected", async () => {
    const tricky = 'sk-test"quote\\slash'
    secrets = [tricky]
    const requests = [{ ...REQUESTS[0]!, params: { ...REQUESTS[0]!.params, messages: [{ role: "user", content: tricky }] } }]
    await expectError(service.submit(SESSION, await writeInput("tricky.jsonl", requests)), "secret_detected")
  })

  test("artifact directories are private", async () => {
    const mine = await submit()
    const dir = join(artifactRoot, mine.jobID)
    expect((await lstat(dir)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(dir, "requests.json"))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(dir, "manifest.json"))).mode & 0o777).toBe(0o600)
  })
})

// ------------------------------------------------------------------------------------------ recovery lane

const dirty = (extra: Record<string, unknown> = {}) => Object.assign(new Error(`remote body: ${KEY}`), extra)
const mkfifo = (path: string) => {
  const result = Bun.spawnSync(["mkfifo", path])
  expect(result.exitCode).toBe(0)
}

describe("duplicate submission guard", () => {
  test("an ambiguous submission blocks a default repeat and allowDuplicate permits one more POST", async () => {
    client.submitImpl = async () => {
      throw dirty()
    }
    const first = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(first.ambiguous).toBe(true)
    const repeat = await expectError(service.submit(SESSION, await writeInput()), "duplicate_submission")
    expect(repeat.jobID).toBe(first.jobID!)
    expect(repeat.message).toContain(first.jobID!)
    expect(repeat.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(1)
    expect((await service.list(SESSION)).jobs).toHaveLength(1)

    client.submitImpl = undefined
    const forced = await service.submit(SESSION, await writeInput(), undefined, { allowDuplicate: true })
    expect(forced.submission).toBe("submitted")
    expect(client.submits).toHaveLength(2)
    expect((await service.list(SESSION)).jobs).toHaveLength(2)
    // The explicit override is not remembered: the first job is still unresolved.
    await expectError(service.submit(SESSION, await writeInput()), "duplicate_submission")
    expect(client.submits).toHaveLength(2)
  })

  test("other sessions and other requests are not blocked", async () => {
    client.submitImpl = async () => {
      throw dirty()
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    client.submitImpl = undefined
    expect((await service.submit(OTHER, await writeInput())).submission).toBe("submitted")
    const changed = await writeInput("other.jsonl", [REQUESTS[0]!])
    expect((await service.submit(SESSION, changed)).submission).toBe("submitted")
    expect(client.submits).toHaveLength(3)
  })

  test("settled submissions do not block a repeat", async () => {
    await submit()
    await submit()
    client.submitImpl = async () => {
      throw dirty({ status: 400 })
    }
    await expectError(service.submit(SESSION, await writeInput()), "submission_rejected")
    await expectError(service.submit(SESSION, await writeInput()), "submission_rejected")
    expect(client.submits).toHaveLength(4)
  })

  test("a blocked first persist rejects a concurrent default repeat and sends one POST", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let blocked = false
    storage.beforeSet = async () => {
      if (!blocked) {
        blocked = true
        await gate
      }
    }
    const path = await writeInput()
    const first = service.submit(SESSION, path)
    for (let i = 0; i < 100 && !blocked; i++) await new Promise((r) => setTimeout(r, 2))
    expect(blocked).toBe(true)
    const second = await expectError(makeService().submit(SESSION, path), "duplicate_submission")
    expect(second.jobID).toMatch(/^job-/)
    release()
    // The first call still succeeds, and the rejected repeat made no record.
    expect((await first).submission).toBe("submitted")
    expect(client.submits).toHaveLength(1)
    expect((await service.list(SESSION)).jobs).toHaveLength(1)
    // The reservation is gone after success.
    expect((await service.submit(SESSION, path)).submission).toBe("submitted")
    expect(client.submits).toHaveLength(2)
  })

  test("an explicit override keeps the reservation after the first submission finishes", async () => {
    const path = await writeInput()
    let releaseA!: (value: RemoteBatch) => void
    let postsStarted = 0
    client.submitImpl = () => {
      postsStarted++
      if (postsStarted === 1) return new Promise<RemoteBatch>((resolve) => (releaseA = resolve))
      return Promise.resolve(remote({ id: `msgbatch_${postsStarted}` }))
    }
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
      expect(check()).toBe(true)
    }
    // A: default submission, POST pending.
    const a = service.submit(SESSION, path)
    await waitFor(() => postsStarted === 1)

    // B: explicit override, its initial persistence is gated.
    let releaseB!: () => void
    const gateB = new Promise<void>((resolve) => (releaseB = resolve))
    let bBlocked = false
    storage.beforeSet = async () => {
      bBlocked = true
      await gateB
    }
    const b = service.submit(SESSION, path, undefined, { allowDuplicate: true })
    await waitFor(() => bBlocked)
    storage.beforeSet = undefined

    // A finishes while B is still persisting. B must keep the fingerprint reserved.
    releaseA(remote({ id: "msgbatch_a" }))
    expect((await a).submission).toBe("submitted")

    // C: default repeat must be rejected and must not send a third POST.
    await expectError(makeService().submit(SESSION, path), "duplicate_submission")
    expect(postsStarted).toBe(1)

    releaseB()
    expect((await b).submission).toBe("submitted")
    expect(client.submits).toHaveLength(2)
    expect((await service.list(SESSION)).jobs).toHaveLength(2)

    // Both resolved: an ordinary submission is allowed again.
    expect((await service.submit(SESSION, path)).submission).toBe("submitted")
    expect(client.submits).toHaveLength(3)
  })

  test("the reservation is released when the first persist fails or the input is rejected", async () => {
    const path = await writeInput()
    storage.failSet = () => true
    await expectError(service.submit(SESSION, path), "storage_failed")
    storage.failSet = undefined
    expect((await service.submit(SESSION, path)).submission).toBe("submitted")
    expect(client.submits).toHaveLength(1)
  })

  test("a stale submitting record of the same requests blocks a repeat", async () => {
    const mine = await submit()
    const key = [...storage.map.keys()][0]!
    const stale: any = structuredClone(storage.map.get(key))
    stale.submission = "submitting"
    delete stale.batchID
    delete stale.remote
    storage.map.set(key, stale)
    const error = await expectError(service.submit(SESSION, await writeInput()), "duplicate_submission")
    expect(error.jobID).toBe(mine.jobID)
    expect(client.submits).toHaveLength(1)
  })
})

describe("input reading", () => {
  test("a FIFO is refused without blocking, a POST, or a record", async () => {
    const fifo = join(work, "pipe.jsonl")
    mkfifo(fifo)
    const error = await expectError(service.submit(SESSION, fifo), "input_unreadable")
    expect(error.message).toContain("not a regular file")
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("an abort while the record is saved sends nothing and keeps a rejected record", async () => {
    const controller = new AbortController()
    storage.beforeSet = async () => controller.abort()
    const error = await expectError(service.submit(SESSION, await writeInput(), controller.signal), "submission_rejected")
    expect(error.message).toContain("not sent")
    expect(client.submits).toHaveLength(0)
    expect((await service.list(SESSION)).jobs[0]!.submission).toBe("rejected")
  })
})

describe("submission failure classification", () => {
  test.each(["no_key", "invalid_argument", "invalid_base_url", "aborted", "timeout", "too_large"])(
    "%s with ambiguous false was not sent",
    async (code) => {
      client.submitImpl = async () => {
        throw dirty({ code, ambiguous: false })
      }
      const error = await expectError(service.submit(SESSION, await writeInput()), "submission_rejected")
      expect(error.message).toContain("not sent")
      expect(error.ambiguous).toBe(false)
      const job = (await service.list(SESSION)).jobs[0]!
      expect(job.submission).toBe("rejected")
      expect(job.httpStatus).toBeUndefined()
    },
  )

  test.each(["aborted", "timeout", "too_large", "network", "malformed_response"])(
    "%s with ambiguous true is unknown and flagged ambiguous",
    async (code) => {
      client.submitImpl = async () => {
        throw dirty({ code, ambiguous: true })
      }
      const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
      expect(error.ambiguous).toBe(true)
      expect((await service.list(SESSION)).jobs[0]!.submission).toBe("submission_unknown")
    },
  )

  test("a plain AbortError is unknown", async () => {
    client.submitImpl = async () => {
      throw Object.assign(new Error("x"), { name: "AbortError" })
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.ambiguous).toBe(true)
  })

  test("every unknown error carries ambiguous true", async () => {
    client.submitImpl = async () => remote({ id: "bad id" })
    expect((await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")).ambiguous).toBe(true)
  })
})

describe("batch ID handles after an unusable answer", () => {
  test("a safe candidate ID from a malformed answer is kept and settled by status", async () => {
    client.submitImpl = async () => {
      throw dirty({ code: "malformed_response", ambiguous: true, batchID: "msgbatch_paid" })
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.batchID).toBe("msgbatch_paid")
    const job = (await service.list(SESSION)).jobs[0]!
    expect(job).toMatchObject({ submission: "submission_unknown", batchID: "msgbatch_paid" })
    const manifest = JSON.parse(await readFile(join(artifactRoot, error.jobID!, "manifest.json"), "utf8"))
    expect(manifest.batchID).toBe("msgbatch_paid")
    const status = await service.status(SESSION, "msgbatch_paid")
    expect(status.submission).toBe("submitted")
    expect(client.statuses).toEqual(["msgbatch_paid"])
    expect(client.submits).toHaveLength(1)
  })

  test("a candidate ID that holds a key is never stored or returned", async () => {
    client.submitImpl = async () => {
      throw dirty({ code: "malformed_response", ambiguous: true, batchID: `msgbatch_${KEY}` })
    }
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.batchID).toBeUndefined()
    expect(error.message).not.toContain(KEY)
    expect((await service.list(SESSION)).jobs[0]!.batchID).toBeUndefined()
    expect(await everythingPersisted()).not.toContain(KEY)
  })

  test("a candidate ID with a rotated key seen only after the POST is dropped", async () => {
    const rotated = "sk-test-rotated-key"
    let calls = 0
    const svc = makeService({ secrets: async () => (calls++ === 0 ? [KEY] : [KEY, rotated]) })
    client.submitImpl = async () => remote({ id: `msgbatch_${rotated}` })
    const error = await expectError(svc.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.batchID).toBeUndefined()
    expect(await everythingPersisted()).not.toContain(rotated)
  })

  test("a failed re-resolution after the POST does not drop a good batch", async () => {
    let calls = 0
    const svc = makeService({
      secrets: async () => {
        if (calls++ > 0) throw new Error(KEY)
        return [KEY]
      },
    })
    const summary = await svc.submit(SESSION, await writeInput())
    expect(summary).toMatchObject({ submission: "submitted", batchID: "msgbatch_1" })
  })

  test("a valid ID with a malformed remote object keeps the paid handle", async () => {
    client.submitImpl = async () => remote({ id: "msgbatch_keep", request_counts: { processing: -1 } as any })
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.batchID).toBe("msgbatch_keep")
    expect((await service.list(SESSION)).jobs[0]).toMatchObject({ submission: "submission_unknown", batchID: "msgbatch_keep" })
  })

  test("a key-prefixed timestamp is rejected and the safe handle stays", async () => {
    client.submitImpl = async () => remote({ id: "msgbatch_keep", created_at: `${KEY} 2026-11-05T10:00:00.000Z` })
    const error = await expectError(service.submit(SESSION, await writeInput()), "submission_unknown")
    expect(error.batchID).toBe("msgbatch_keep")
    expect(await everythingPersisted()).not.toContain(KEY)
  })
})

describe("strict remote state", () => {
  test.each(["2026-11-05", "2026-02-30T10:00:00Z", "2026-11-05 10:00:00Z", "2026-11-05T25:00:00Z", "2026-11-05T10:00:00", `${KEY}2026-11-05T10:00:00Z`])(
    "rejects the timestamp %s and keeps the record",
    async (created) => {
      const mine = await submit()
      client.status = async () => remote({ id: mine.batchID!, created_at: created })
      await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
      client.status = async () => ended({}, mine.batchID!)
      client.status = async () => remote({ id: mine.batchID!, ended_at: created })
      await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
      const job = (await service.list(SESSION)).jobs[0]!
      expect(job.remote).toMatchObject({ status: "in_progress", createdAt: "2026-11-05T10:00:00.000Z" })
    },
  )

  test("rejects a missing count field and a fractional count", async () => {
    const mine = await submit()
    client.status = async () => remote({ id: mine.batchID!, request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0 } as any })
    await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
    client.status = async () => remote({ id: mine.batchID!, request_counts: { processing: 1.5, succeeded: 0, errored: 0, canceled: 0, expired: 0 } })
    await expectError(service.status(SESSION, mine.jobID), "invalid_remote")
  })
})

describe("reconcile from the manifest", () => {
  async function staleWith(patch: (manifest: any) => void) {
    const mine = await submit()
    const key = [...storage.map.keys()][0]!
    const stale: any = structuredClone(storage.map.get(key))
    stale.submission = "submitting"
    delete stale.batchID
    delete stale.remote
    storage.map.set(key, stale)
    const artifacts = new BatchArtifacts(artifactRoot)
    const manifest = JSON.parse(await artifacts.read(mine.jobID, "manifest.json"))
    patch(manifest)
    await artifacts.write(mine.jobID, "manifest.json", JSON.stringify(manifest))
    return { mine, key }
  }

  test("rebuilds the remote state fieldwise and drops extras", async () => {
    const { mine, key } = await staleWith((manifest) => {
      manifest.remote = {
        status: "in_progress",
        counts: { processing: 4, succeeded: 0, errored: 0, canceled: 0, expired: 0, extra: 9 },
        createdAt: "2026-11-05T10:00:00.000Z",
        endedAt: null,
        observedAt: "2026-11-05T10:00:01.000Z",
        resultsUrl: RESULT_URL,
        note: "EXTRA-METADATA",
      }
    })
    const inspected = await makeService().inspect(SESSION, mine.jobID)
    expect(inspected.job.submission).toBe("submitted")
    const stored: any = storage.map.get(key)
    expect(Object.keys(stored.remote).sort()).toEqual(["counts", "createdAt", "endedAt", "observedAt", "status"])
    expect(Object.keys(stored.remote.counts).sort()).toEqual(["canceled", "errored", "expired", "processing", "succeeded"])
    expect(JSON.stringify([...storage.map.values()])).not.toContain("EXTRA-METADATA")
  })

  test("drops a remote state with an invalid time but keeps the batch ID", async () => {
    const { mine, key } = await staleWith((manifest) => {
      manifest.remote = {
        status: "in_progress",
        counts: { processing: 4, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        createdAt: "yesterday",
        endedAt: null,
        observedAt: "2026-11-05T10:00:01.000Z",
      }
    })
    await makeService().inspect(SESSION, mine.jobID)
    const stored: any = storage.map.get(key)
    expect(stored.submission).toBe("submitted")
    expect(stored.batchID).toBe(mine.batchID)
    expect(stored.remote).toBeUndefined()
  })

  test("a recovered batch ID that holds a key is not persisted", async () => {
    const { mine, key } = await staleWith((manifest) => {
      manifest.batchID = `msgbatch_${KEY}`
    })
    const inspected = await makeService().inspect(SESSION, mine.jobID)
    expect(inspected.job.submission).toBe("submission_unknown")
    expect((storage.map.get(key) as any).batchID).toBeUndefined()
    expect(JSON.stringify([...storage.map.values()])).not.toContain(KEY)
  })

  test("without a way to check keys nothing is persisted", async () => {
    const { mine, key } = await staleWith(() => undefined)
    const svc = makeService({
      secrets: async () => {
        throw new Error(KEY)
      },
    })
    const inspected = await svc.inspect(SESSION, mine.jobID)
    expect(inspected.job.batchID).toBeUndefined()
    expect((storage.map.get(key) as any).submission).toBe("submitting")
  })

  test("recovers a stored unknown state with a safe candidate ID", async () => {
    const { mine, key } = await staleWith((manifest) => {
      manifest.submission = "submission_unknown"
      manifest.batchID = "msgbatch_paid"
    })
    await makeService().inspect(SESSION, mine.jobID)
    expect(storage.map.get(key)).toMatchObject({ submission: "submission_unknown", batchID: "msgbatch_paid" })
  })
})

describe("secret paths", () => {
  test("a key in the input file name stops everything before any write or POST", async () => {
    const path = join(work, `${KEY}.jsonl`)
    await writeFile(path, REQUESTS.map((r) => JSON.stringify(r)).join("\n"))
    const error = await expectError(service.submit(SESSION, path), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("a key in the artifact root stops submission before any write", async () => {
    const root = join(base, "state", KEY)
    const svc = makeService({ artifacts: new BatchArtifacts(root) })
    const error = await expectError(svc.submit(SESSION, await writeInput()), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
    expect(storage.map.size).toBe(0)
    expect(await filesUnder(root)).toEqual([])
  })

  async function ended4() {
    const mine = await submit()
    client.current = ended()
    return mine
  }

  test("an escaped active key in a valid line is detected before results.jsonl is written", async () => {
    const mine = await ended4()
    const escaped = KEY.replace("s", "\\u0073")
    const poisoned = RESULT.a.replace("RESULT-A", `x ${escaped}`)
    expect(poisoned).toContain("\\u0073")
    client.resultsText = jsonl(poisoned, RESULT.b, RESULT.c, RESULT.d)
    const error = await expectError(service.collect(SESSION, mine.jobID), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "results.jsonl"))
    expect(await everythingPersisted()).not.toContain(KEY)
    expect((await service.list(SESSION)).jobs[0]!.collection.state).toBe("not_collected")
  })

  test("an escaped active key in a malformed line is detected too", async () => {
    const mine = await ended4()
    const escaped = KEY.replace("s", "\\u0073")
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, `{"custom_id":"d","oops":"${escaped}`)
    await expectError(service.collect(SESSION, mine.jobID), "secret_detected")
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "results.jsonl"))
  })

  test("an escaped slash in a key is detected", async () => {
    secrets = ["sk/test/key"]
    const mine = await ended4()
    client.resultsText = jsonl(RESULT.a.replace("RESULT-A", "sk\\/test\\/key"), RESULT.b, RESULT.c, RESULT.d)
    await expectError(service.collect(SESSION, mine.jobID), "secret_detected")
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "results.jsonl"))
  })

  test("a rate source with 1500 characters collects", async () => {
    const mine = await ended4()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const source = `Price sheet ${"x".repeat(1488)}`
    expect(source).toHaveLength(1500)
    const priced = makeService({
      rates: { source, currency: "USD", models: { "claude-sonnet-4-5": { input: 1, output: 2 } } },
    })
    const summary = await priced.collect(SESSION, mine.jobID)
    expect(summary.collection.state).toBe("collected")
    expect(summary.cost).toMatchObject({ kind: "estimate", source })
  })

  test("a rate source that matches the key gives an unavailable cost and still collects", async () => {
    const mine = await ended4()
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const priced = makeService({
      rates: { source: `sheet ${KEY}`, currency: "USD", models: { "claude-sonnet-4-5": { input: 1, output: 2 } } },
    })
    const summary = await priced.collect(SESSION, mine.jobID)
    expect(summary.collection.state).toBe("collected")
    expect(summary.cost.kind).toBe("unavailable")
    expect(JSON.stringify(summary)).not.toContain(KEY)
    expect(await everythingPersisted()).not.toContain(KEY)
  })
})

describe("collection counts", () => {
  test("result types that differ from the ended batch counts are rejected with the raw output kept", async () => {
    const mine = await submit()
    client.current = ended({ succeeded: 2, errored: 0, canceled: 1, expired: 1 })
    client.resultsText = jsonl(RESULT.a, RESULT.b, RESULT.c, RESULT.d)
    const error = await expectError(service.collect(SESSION, mine.jobID), "invalid_results")
    expect(error.message).toContain("do not match")
    expect(error.message).not.toContain("RESULT-A")
    expect((await service.list(SESSION)).jobs[0]!.collection.state).toBe("not_collected")
    expect(await readFile(join(artifactRoot, mine.jobID, "results.jsonl"), "utf8")).toBe(client.resultsText)
    expect(await filesUnder(join(artifactRoot, mine.jobID))).not.toContain(join(artifactRoot, mine.jobID, "successes.jsonl"))
    // Matching counts later collect fine.
    client.current = ended()
    expect((await service.collect(SESSION, mine.jobID)).collection.state).toBe("collected")
  })
})

describe("submitRequests (inline input)", () => {
  const SOURCE = "inline:/fuelix-batch"
  const inline = (content = "INLINE-PROMPT", id = "prompt") => [
    { custom_id: id, params: { model: "claude-haiku-5-5-anthropic", max_tokens: 4096, messages: [{ role: "user", content }] } },
  ]

  test("sends one validated request, keeps the exact payload, and labels the source without a file", async () => {
    const content = "  keep \"quotes\"\n\tand spaces  "
    const job = await service.submitRequests(SESSION, inline(content), SOURCE)
    expect(job.submission).toBe("submitted")
    expect(job.inputPath).toBe(SOURCE)
    expect(client.submits).toHaveLength(1)
    expect(client.submits[0]).toEqual(inline(content))
    expect(job.requests).toEqual({ count: 1, models: [{ model: "claude-haiku-5-5-anthropic", count: 1 }], otherModels: 0 })
    const snapshot = JSON.parse(await readFile(job.requestsPath, "utf8"))
    expect(snapshot).toEqual({ requests: inline(content) })
    const manifest = await readFile(join(artifactRoot, job.jobID, "manifest.json"), "utf8")
    expect(JSON.parse(manifest).inputPath).toBe(SOURCE)
    // Same session inspects it.
    const inspected = await service.inspect(SESSION, job.jobID)
    expect(inspected.requests.items).toEqual([{ index: 0, custom_id: "prompt", model: "claude-haiku-5-5-anthropic", max_tokens: 4096 }])
    // Other sessions cannot see it.
    await expectError(service.inspect(OTHER, job.jobID), "not_found")
  })

  test("invalid requests are rejected before anything is saved or sent", async () => {
    for (const bad of [[], [{ custom_id: "bad id", params: {} }], [{ nope: 1 }], "x" as unknown as unknown[]]) {
      const error = await expectError(service.submitRequests(SESSION, bad, SOURCE), "invalid_input")
      expect(error.message).not.toContain(KEY)
    }
    expect(client.submits).toHaveLength(0)
    expect(storage.setCalls).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("active key material in the source label is rejected before storage, artifacts, or the client", async () => {
    const error = await expectError(service.submitRequests(SESSION, inline(), `inline:${KEY}`), "secret_detected")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
    expect(storage.setCalls).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("a bad source label is rejected", async () => {
    await expectError(service.submitRequests(SESSION, inline(), ""), "invalid_argument")
    await expectError(service.submitRequests("", inline(), SOURCE), "invalid_argument")
    expect(client.submits).toHaveLength(0)
  })

  test("active key material in the content, plain or escaped, is never saved or sent", async () => {
    const escaped = [...KEY].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
    for (const content of [`please use ${KEY}`, JSON.parse(`"${escaped}"`) as string]) {
      const error = await expectError(service.submitRequests(SESSION, inline(content), SOURCE), "secret_detected")
      expect(error.message).not.toContain(KEY)
    }
    expect(client.submits).toHaveLength(0)
    expect(storage.setCalls).toBe(0)
    expect(await filesUnder(artifactRoot)).toEqual([])
  })

  test("secrets that cannot be checked fail closed", async () => {
    const failing = makeService({
      secrets: async () => {
        throw new Error("down")
      },
    })
    await expectError(failing.submitRequests(SESSION, inline(), SOURCE), "secrets_unavailable")
    expect(client.submits).toHaveLength(0)
    expect(storage.setCalls).toBe(0)
  })

  test("an ambiguous failure keeps an unknown record, never resubmits, and blocks the same requests", async () => {
    client.submitImpl = async () => {
      throw Object.assign(new Error(`remote body: ${KEY}`), {})
    }
    const error = await expectError(service.submitRequests(SESSION, inline(), SOURCE), "submission_unknown")
    expect(error.ambiguous).toBe(true)
    expect(client.submits).toHaveLength(1)
    const duplicate = await expectError(service.submitRequests(SESSION, inline(), SOURCE), "duplicate_submission")
    expect(duplicate.jobID).toBe(error.jobID)
    expect(client.submits).toHaveLength(1)
    // Different content is a different digest and may go out.
    client.submitImpl = undefined
    await service.submitRequests(SESSION, inline("OTHER"), SOURCE)
    expect(client.submits).toHaveLength(2)
    expect(await everythingPersisted()).not.toContain(KEY)
  })

  test("concurrent identical inline submissions send once", async () => {
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    client.submitImpl = async () => {
      await gate
      return remote({ id: "msgbatch_slow" })
    }
    const first = service.submitRequests(SESSION, inline(), SOURCE)
    await new Promise((done) => setTimeout(done, 5))
    await expectError(service.submitRequests(SESSION, inline(), SOURCE), "duplicate_submission")
    release()
    expect((await first).batchID).toBe("msgbatch_slow")
    expect(client.submits).toHaveLength(1)
  })

  test("a record failure before sending sends nothing", async () => {
    storage.failSet = () => true
    const error = await expectError(service.submitRequests(SESSION, inline(), SOURCE), "storage_failed")
    expect(error.message).not.toContain(KEY)
    expect(client.submits).toHaveLength(0)
  })
})
