/**
 * TypeSafe System One client: `POST {baseURL}/v1/systemone` with a Bearer key.
 *
 * - `decide` never throws. A failure is a `JevFailure` with an allowlisted code and, for HTTP errors, a status.
 *   No upstream text, request text, or key appears in a failure.
 * - Every string of the state and the questions is redacted before the request leaves the process, including the
 *   literal active key.
 * - The response is validated per question type: probabilities and scores are finite and bounded, a choice is one of
 *   the requested options. The decision carries the upstream `response.model`.
 * - Successful decisions are cached (see `cache.ts`). Failures are not. Identical calls in flight share one request.
 *   At most `maxConcurrent` requests run at once. More wait in a bounded queue, inside the call timeout.
 * - The key goes only into the `Authorization` header of this request. Redirects are refused.
 */

import { credentialFingerprint, globalJevCache, jevCacheKey, type JevCache } from "./cache.ts"
import { redactJson } from "./redact.ts"
import type {
  JevAnswer,
  JevClient,
  JevDecision,
  JevDecisionData,
  JevErrorCode,
  JevFailure,
  JevKeyProvider,
  JevOutcome,
  JevQuestion,
  JevQuestions,
  JevRequest,
  JsonValue,
} from "./types.ts"

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

export const MIN_TIMEOUT_MS = 50
export const MAX_TIMEOUT_MS = 30_000
export const MAX_REQUEST_BYTES = 256 * 1024
export const MAX_RESPONSE_BYTES = 1024 * 1024
export const MAX_QUESTIONS = 16
export const DEFAULT_MAX_CONCURRENT = 4
export const DEFAULT_MAX_QUEUED = 32

const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

export interface JevClientOptions {
  /** Origin without a path, already validated by `resolveJevBaseURL`. */
  readonly baseURL: string
  /** Requested model name or alias. */
  readonly model: string
  readonly keys: JevKeyProvider
  /** Scope of the OpenCode location. Part of the cache identity, so locations never share a decision. */
  readonly locationScope: string
  readonly fetch?: FetchFn
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
  /** Defaults to the process-wide cache. */
  readonly cache?: JevCache
  /** Requests in flight at once, 1 to 16. Default 4. */
  readonly maxConcurrent?: number
  /** Calls that may wait for a slot. More fail with `busy`. Default 32. */
  readonly maxQueued?: number
}

const fail = (code: JevErrorCode, status?: number): JevOutcome => ({ ok: false, error: status === undefined ? { code } : { code, status } })

function statusFailure(status: number): JevFailure {
  switch (status) {
    case 400:
      return { code: "bad-request", status }
    case 401:
      return { code: "unauthorized", status }
    case 413:
      return { code: "payload-too-large", status }
    case 415:
      return { code: "unsupported-media-type", status }
    case 422:
      return { code: "unprocessable", status }
    case 429:
      return { code: "rate-limited", status }
    case 529:
      return { code: "overloaded", status }
    default:
      return { code: "http-error", status }
  }
}

// -- Request validation ----------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** True when the questions have a valid shape. Exported for tests. */
export function validQuestions(questions: unknown): questions is JevQuestions {
  if (!isRecord(questions)) return false
  const ids = Object.keys(questions)
  if (ids.length === 0 || ids.length > MAX_QUESTIONS) return false
  return ids.every((id) => QUESTION_ID.test(id) && validQuestion(questions[id]))
}

function validQuestion(question: unknown): question is JevQuestion {
  if (!isRecord(question) || typeof question.instructions !== "string" || question.instructions === "") return false
  if (question.type === "noul") {
    const criteria = question.criteria
    if (criteria === undefined) return true
    return isRecord(criteria) && Object.values(criteria).every((value) => value === undefined || typeof value === "string")
  }
  if (question.type === "choice") {
    if (!isRecord(question.criteria)) return false
    const entries = Object.entries(question.criteria)
    return entries.length > 0 && entries.length <= 255 && entries.every(([name, text]) => name !== "" && typeof text === "string")
  }
  if (question.type === "score") {
    return Array.isArray(question.criteria) && question.criteria.length >= 1 && question.criteria.length <= 10 && question.criteria.every((text) => typeof text === "string")
  }
  return false
}

// -- Response validation ---------------------------------------------------------------------------------------

const isProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1

function validProbabilities(value: unknown, allowed: ReadonlySet<string> | undefined, maxKeys: number): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > maxKeys) return undefined
  const out: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [key, probability] of entries) {
    if (!isProbability(probability)) return undefined
    if (allowed && !allowed.has(key)) return undefined
    out[key] = probability
  }
  return out
}

function validateAnswer(question: JevQuestion, answer: unknown): JevAnswer | undefined {
  if (!isRecord(answer) || answer.type !== question.type) return undefined
  const confidence = answer.confidence
  if (confidence !== undefined && !isProbability(confidence)) return undefined
  const extra = confidence === undefined ? {} : { confidence }
  switch (question.type) {
    case "noul":
      return isProbability(answer.noul) ? { type: "noul", noul: answer.noul } : undefined
    case "choice": {
      const options = new Set(Object.keys(question.criteria))
      if (typeof answer.choice !== "string" || !options.has(answer.choice)) return undefined
      if (answer.probabilities === undefined) return { type: "choice", choice: answer.choice, ...extra }
      const probabilities = validProbabilities(answer.probabilities, options, options.size)
      return probabilities ? { type: "choice", choice: answer.choice, probabilities, ...extra } : undefined
    }
    case "score": {
      const max = question.criteria.length - 1
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > max) return undefined
      if (answer.probabilities === undefined) return { type: "score", score: answer.score, ...extra }
      const probabilities = validProbabilities(answer.probabilities, undefined, question.criteria.length + 1)
      return probabilities ? { type: "score", score: answer.score, probabilities, ...extra } : undefined
    }
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : undefined
}

/**
 * Validates a parsed System One response against the requested questions. Returns `undefined` when the response has
 * no valid `model`, or any requested answer is missing, has the wrong type, or has a value out of range. Exported
 * for tests.
 */
export function validateResponse(body: unknown, questions: JevQuestions): JevDecisionData | undefined {
  if (!isRecord(body) || typeof body.model !== "string" || !MODEL_NAME.test(body.model) || !isRecord(body.answers)) return undefined
  const answers: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>
  for (const [id, question] of Object.entries(questions)) {
    const answer = validateAnswer(question, body.answers[id])
    if (!answer) return undefined
    answers[id] = answer
  }
  const usage = isRecord(body.usage) ? body.usage : undefined
  const inputTokens = tokenCount(usage?.input_tokens)
  const outputTokens = tokenCount(usage?.output_tokens)
  return {
    model: body.model,
    answers,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}

/** The probability of a `noul` question in a decision. Throws only on a programming error (wrong id or type). */
export function noulProbability(decision: Pick<JevDecisionData, "answers">, id: string): number {
  const answer = decision.answers[id]
  if (answer?.type !== "noul") throw new TypeError(`Answer ${id} is not a noul answer`)
  return answer.noul
}

/** The chosen option of a `choice` question in a decision. */
export function chosenOption(decision: Pick<JevDecisionData, "answers">, id: string): string {
  const answer = decision.answers[id]
  if (answer?.type !== "choice") throw new TypeError(`Answer ${id} is not a choice answer`)
  return answer.choice
}

/** The score of a `score` question in a decision. */
export function scoreValue(decision: Pick<JevDecisionData, "answers">, id: string): number {
  const answer = decision.answers[id]
  if (answer?.type !== "score") throw new TypeError(`Answer ${id} is not a score answer`)
  return answer.score
}

// -- Concurrency -----------------------------------------------------------------------------------------------

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}

  /** Resolves with a release function, or `undefined` when the queue is full. Rejects when `signal` aborts. */
  async acquire(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (signal.aborted) throw new Error("aborted")
    if (this.active < this.limit) {
      this.active++
      return this.releaser()
    }
    if (this.waiters.length >= this.maxQueued) return undefined
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort)
        this.active++
        resolve(this.releaser())
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error("aborted"))
      }
      this.waiters.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiters.shift()?.()
    }
  }
}

interface Flight {
  readonly controller: AbortController
  readonly promise: Promise<JevOutcome>
  waiters: number
}

/** Rejects when `signal` aborts, even if `promise` ignores the signal. A late result of `promise` is dropped. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(new Error("aborted"))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

async function readBounded(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!response.body) {
    const text = await response.text()
    return text.length > maxBytes ? undefined : text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function createJevClient(options: JevClientOptions): JevClient {
  const fetchFn: FetchFn = options.fetch ?? ((input, init) => fetch(input, init))
  const now = options.now ?? Date.now
  const cache = options.cache ?? globalJevCache()
  const endpoint = `${options.baseURL.replace(/\/+$/, "")}/v1/systemone`
  const semaphore = new Semaphore(
    Math.min(16, Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))),
    Math.max(0, Math.floor(options.maxQueued ?? DEFAULT_MAX_QUEUED)),
  )
  const flights = new Map<string, Flight>()
  let disposed = false

  const startFlight = (body: string, key: string, questions: JevQuestions, timeoutMs: number, secret: string): Flight => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const classify = (): JevOutcome => (timedOut ? fail("timeout") : disposed ? fail("disposed") : fail("aborted"))
    const run = async (): Promise<JevOutcome> => {
      let release: (() => void) | undefined
      try {
        release = await semaphore.acquire(controller.signal)
        if (!release) return fail("busy")
        const response = await abortable(
          Promise.resolve().then(() =>
            fetchFn(endpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
              body,
              signal: controller.signal,
              redirect: "error",
            }),
          ),
          controller.signal,
        )
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return { ok: false, error: statusFailure(response.status) }
        }
        const text = await abortable(readBounded(response, MAX_RESPONSE_BYTES), controller.signal)
        if (text === undefined) return fail("invalid-response")
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return fail("invalid-json")
        }
        const data = validateResponse(parsed, questions)
        if (!data) return fail("invalid-response")
        cache.set(key, data)
        return { ok: true, value: { ...data, requestedModel: options.model, cached: false, latencyMs: 0 } }
      } catch {
        return controller.signal.aborted ? classify() : fail("network")
      } finally {
        release?.()
        clearTimeout(timer)
      }
    }
    return { controller, promise: run(), waiters: 0 }
  }

  /** Waits for a flight, bounded by the call signal. `reason()` names why the call signal aborted. */
  const settle = (
    flight: Flight,
    signal: AbortSignal,
    reason: () => JevErrorCode | undefined,
    startedAt: number,
  ): Promise<JevOutcome> =>
    new Promise((resolve) => {
      let done = false
      const finish = (outcome: JevOutcome): void => {
        if (done) return
        done = true
        signal.removeEventListener("abort", onAbort)
        resolve(outcome.ok ? { ok: true, value: { ...structuredClone(outcome.value), latencyMs: Math.max(0, now() - startedAt) } } : outcome)
      }
      const onAbort = (): void => {
        if (done) return
        flight.waiters--
        if (flight.waiters <= 0) flight.controller.abort()
        finish(fail(reason() ?? "aborted"))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
      void flight.promise.then((outcome) => {
        if (!done) flight.waiters--
        finish(outcome)
      })
    })

  /** Abort functions of the calls in progress, so `dispose` can settle callers that wait for the key. */
  const calls = new Set<(why: JevErrorCode) => void>()

  const decide = async (request: JevRequest): Promise<JevOutcome> => {
    const startedAt = now()
    if (disposed) return fail("disposed")
    if (!request || typeof request.timeoutMs !== "number" || !Number.isFinite(request.timeoutMs) || !validQuestions(request.questions)) {
      return fail("invalid-request")
    }
    if (request.signal?.aborted) return fail("aborted")
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(request.timeoutMs)))

    // One deadline and one abort signal cover the whole call: key resolution, queue wait, request, and response.
    const call = new AbortController()
    let why: JevErrorCode | undefined
    const abort = (code: JevErrorCode): void => {
      if (why) return
      why = code
      call.abort()
    }
    const timer = setTimeout(() => abort("timeout"), timeoutMs)
    const onCallerAbort = (): void => abort("aborted")
    request.signal?.addEventListener("abort", onCallerAbort, { once: true })
    calls.add(abort)
    try {
      const resolved = await abortable(
        Promise.resolve().then(() => options.keys.resolve()),
        call.signal,
      ).catch(() => undefined)
      // A key that arrives after the deadline, a caller abort, or a dispose starts nothing.
      if (why) return fail(why)
      if (!resolved) return fail("no-key")

      // Input that redaction could not process whole (an oversize string, a cut-off structure) is never sent.
      let incomplete = false
      const redaction = { secrets: [resolved.key], onIncomplete: () => void (incomplete = true) }
      const state = redactJson(request.state, redaction)
      const questions = redactJson(request.questions, { ...redaction, sensitiveKeys: false })
      if (incomplete) return fail("invalid-request")
      const body = JSON.stringify({ model: options.model, state, questions })
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return fail("invalid-request")

      const key = jevCacheKey({
        endpoint,
        credential: credentialFingerprint(resolved.key),
        location: options.locationScope,
        model: options.model,
        state,
        questions,
      })
      const hit = cache.get(key)
      if (hit) {
        return { ok: true, value: { ...hit, requestedModel: options.model, cached: true, latencyMs: Math.max(0, now() - startedAt) } }
      }

      // Identical calls in flight share one request. Each caller stays bounded by its own deadline.
      let flight = flights.get(key)
      if (!flight) {
        // The shared request lives up to the maximum timeout. Each caller keeps its own deadline, and the request
        // aborts when its last caller leaves, so a short first caller never cuts a longer one.
        const created = startFlight(body, key, request.questions, MAX_TIMEOUT_MS, resolved.key)
        flight = created
        flights.set(key, created)
        void created.promise.then(() => {
          if (flights.get(key) === created) flights.delete(key)
        })
      }
      flight.waiters++
      return await settle(flight, call.signal, () => why, startedAt)
    } catch {
      return why ? fail(why) : fail("network")
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener("abort", onCallerAbort)
      calls.delete(abort)
    }
  }

  return {
    decide,
    dispose() {
      disposed = true
      for (const abort of [...calls]) abort("disposed")
      for (const flight of flights.values()) flight.controller.abort()
      flights.clear()
    },
  }
}

export type { JsonValue }
