/** Shared types of the Jev module. No runtime behavior except constants. */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type Env = Readonly<Record<string, string | undefined>>

/** `off` does nothing. `shadow` evaluates and records but changes nothing. `enforce` applies the decision. */
export type JevMode = "off" | "shadow" | "enforce"

export const JEV_POINT_NAMES = ["safetyPreCheck", "testCompression", "skillPruning", "reasoningBudget"] as const
export type JevPointName = (typeof JEV_POINT_NAMES)[number]

/** Where the TypeSafe key came from. */
export type JevKeySource = "keychain" | "credential-store" | "env"

export interface JevKey {
  readonly key: string
  readonly source: JevKeySource
}

/** Resolves the TypeSafe key. Returns `undefined` when none is available. Never throws. */
export interface JevKeyProvider {
  resolve(): Promise<JevKey | undefined>
}

// -- Questions -------------------------------------------------------------------------------------------------

export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
}

export interface ChoiceQuestion {
  readonly type: "choice"
  readonly instructions: string
  /** Option name to description. At most 255 options. */
  readonly criteria: Readonly<Record<string, string>>
}

export interface ScoreQuestion {
  readonly type: "score"
  readonly instructions: string
  /** One description per level, lowest first. At most 10 levels. The score lies from 0 to `criteria.length - 1`. */
  readonly criteria: readonly string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type JevQuestions = Readonly<Record<string, JevQuestion>>

// -- Answers ---------------------------------------------------------------------------------------------------

export interface NoulAnswer {
  readonly type: "noul"
  /** Probability from 0 to 1 that the answer is true. */
  readonly noul: number
}

export interface ChoiceAnswer {
  readonly type: "choice"
  /** One of the option names of the question. */
  readonly choice: string
  /** Option name to probability. Present when the upstream reply carries it. Names are options of the question. */
  readonly probabilities?: Readonly<Record<string, number>>
  readonly confidence?: number
}

export interface ScoreAnswer {
  readonly type: "score"
  readonly score: number
  /** Present when the upstream reply carries it. The official schema does not require it for scores. */
  readonly probabilities?: Readonly<Record<string, number>>
  readonly confidence?: number
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** The part of a decision that the cache keeps. */
export interface JevDecisionData {
  /** The model that answered: `response.model` of the upstream reply, not the requested name. */
  readonly model: string
  readonly answers: Readonly<Record<string, JevAnswer>>
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface JevDecision extends JevDecisionData {
  /** The model name that the plugin asked for. It can be an alias such as `jev-latest`. */
  readonly requestedModel: string
  /** True when the answer came from the cache. A caller that joins a request in flight gets `false`. */
  readonly cached: boolean
  readonly latencyMs: number
}

// -- Errors ----------------------------------------------------------------------------------------------------

export const JEV_ERROR_CODES = [
  "no-key",
  "invalid-request",
  "timeout",
  "aborted",
  "busy",
  "disposed",
  "network",
  "bad-request",
  "unauthorized",
  "payload-too-large",
  "unsupported-media-type",
  "unprocessable",
  "rate-limited",
  "overloaded",
  "http-error",
  "invalid-json",
  "invalid-response",
] as const

export type JevErrorCode = (typeof JEV_ERROR_CODES)[number]

/** A failure. Carries a code and an HTTP status only, never upstream text, request text, or a key. */
export interface JevFailure {
  readonly code: JevErrorCode
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number
}

export type JevOutcome = { readonly ok: true; readonly value: JevDecision } | { readonly ok: false; readonly error: JevFailure }

export interface JevRequest {
  /** JSON state. The client redacts every string in it before the request leaves the process. */
  readonly state: JsonValue
  readonly questions: JevQuestions
  /** Total time for the call, including queue wait. The client limits it to 50 ms to 30,000 ms. */
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface JevClient {
  /** Asks the questions. Never throws and never rejects. A failure is a value. */
  decide(request: JevRequest): Promise<JevOutcome>
  /** Aborts every call in flight. Later calls fail with `disposed`. The process-wide cache stays. */
  dispose(): void
}
