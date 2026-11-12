/**
 * Shared lifecycle INPUT and VIEW. Pure: no I/O, no node imports. The backend, the extension service, and the panel
 * all read the lifecycle log through these exports, so they release the same activations.
 *
 * Input: the text of the append-only log `lifecycle.jsonl` (usually its tail). `parseLifecycleText` returns the valid
 * facts in file order. A malformed line is skipped. An unterminated last line that is not valid JSON yet is a write in
 * flight and is ignored. Blank lines are skipped. A line that a crashed writer left half-written cannot hide a later
 * fact, because every writer starts its line with a newline.
 *
 * View: `resolveLifecycleViews` calls the pure resolver of `lifecycle-state.ts` for each activation. A malformed line
 * never vetoes a clean `bound` -> `ended` sequence of one instance. A missing `bound` never releases. `trust` is a
 * diagnostic for a UI. It does not change `phase` or `releasable`.
 */

import { parseLifecycleLine, type Activation, type LifecycleFact } from "./schema.ts"
import { resolveLifecycles, type LifecycleResolution } from "./lifecycle-state.ts"

/** Readers look at most at this many bytes from the end of the log. */
export const LIFECYCLE_TAIL_BYTES = 1024 * 1024

/** What a reader saw in the lifecycle log. `facts` are the valid lines in file order. */
export interface LifecycleReading {
  readonly facts: readonly LifecycleFact[]
  /** One entry per malformed line: the number of valid facts before it. Diagnostic only. */
  readonly gaps: readonly number[]
  /** The log is longer than the part that was read, or it could not be read. Older facts are not visible. */
  readonly truncated: boolean
  /** The log ends in an unterminated line that is not valid yet. It is ignored. */
  readonly partialTail: boolean
}

/** A log that does not exist: no facts, nothing hidden. */
export const EMPTY_READING: LifecycleReading = { facts: [], gaps: [], truncated: false, partialTail: false }

/** A log that exists but could not be read: no facts, and nothing can be proved. */
export const UNREADABLE_READING: LifecycleReading = { facts: [], gaps: [], truncated: true, partialTail: false }

/**
 * Parses log text. `truncated` says that `text` starts in the middle of the log, so its first line may be cut and
 * is dropped.
 */
export function parseLifecycleText(text: string, truncated: boolean): LifecycleReading {
  const lines = text.split("\n")
  const unterminated = !text.endsWith("\n")
  const last = unterminated ? lines.pop() : (lines.pop(), undefined)
  if (truncated) lines.shift()
  const facts: LifecycleFact[] = []
  const gaps: number[] = []
  const consume = (line: string): boolean => {
    if (line.trim() === "") return true
    const fact = parseLifecycleLine(line)
    if (fact === undefined) return false
    facts.push(fact)
    return true
  }
  for (const line of lines) if (!consume(line)) gaps.push(facts.length)
  let partialTail = false
  if (last !== undefined && last.trim() !== "") {
    // A complete JSON object without its newline still counts. Anything else is a write in flight.
    if (!consume(last)) partialTail = true
  }
  return { facts, gaps, truncated, partialTail }
}

/**
 * - `ok`: nothing unusual.
 * - `unverified-end`: an `ended` fact exists that the resolver does not accept (no bind of that instance, or another
 *   reason). The activation stays active.
 * - `history-truncated`: older facts are not visible, so a missing `bound` proves nothing. The activation stays active.
 */
export type LifecycleTrust = "ok" | "unverified-end" | "history-truncated"

export interface LifecycleView extends LifecycleResolution {
  readonly activationId: string
  readonly trust: LifecycleTrust
}

export function resolveLifecycleViews(activations: readonly Pick<Activation, "id" | "scope" | "createdAt">[], reading: LifecycleReading): LifecycleView[] {
  const resolutions = resolveLifecycles(activations, reading.facts)
  const firstVisible = reading.facts.length > 0 ? Date.parse(reading.facts[0]!.at) : Number.NaN
  return activations.map((activation) => {
    const resolution = resolutions.get(activation.id)!
    let trust: LifecycleTrust = "ok"
    if (resolution.phase !== "ended" && resolution.phase !== "session") {
      if (reading.facts.some((fact) => fact.activationId === activation.id && fact.fact === "ended")) trust = "unverified-end"
      else if (resolution.phase === "pending" && reading.truncated && !(Date.parse(activation.createdAt) >= firstVisible)) trust = "history-truncated"
    }
    return { ...resolution, activationId: activation.id, trust }
  })
}

/** Ids of activations that may be released: phase `ended` and releasable. The service prunes exactly these. */
export function releasedActivationIds(activations: readonly Pick<Activation, "id" | "scope" | "createdAt">[], reading: LifecycleReading): Set<string> {
  return new Set(
    resolveLifecycleViews(activations, reading)
      .filter((view) => view.releasable)
      .map((view) => view.activationId),
  )
}
