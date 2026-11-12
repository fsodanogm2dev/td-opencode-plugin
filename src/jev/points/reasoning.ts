/**
 * Reasoning-level point. Shadow only: it scores the latest user request from 0 to 3 and records the model variant
 * (`low`, `medium`, `high`, `max`) that it would choose among the variants that the current model really has. It
 * never edits the request, the options, or the variant. A model with no variants is skipped without an upstream call.
 *
 * Trigger: `session.context`, with the same rules as the skill point. The callback returns at once, one background
 * task asks TypeSafe, and the task is cancelled on dispose. A request that already has an explicit variant is
 * skipped, because the user chose it.
 */

import { scoreValue } from "../client.ts"
import type { ReasoningBudgetOptions } from "../options.ts"
import { REASONING_QUESTION_ID, reasoningQuestions } from "../questions.ts"
import { redactText } from "../redact.ts"
import { BoundedMap, failureFields, latestUserRequest, type JevPointRuntime } from "../runtime.ts"
import { disposeAll, type HookHost, type Registration } from "./safety.ts"
import type { ContextEvent } from "./skills.ts"

export const MAX_REQUEST_CHARS = 2000
export const MIN_REQUEST_CHARS = 5
const MAX_SESSIONS = 128

/** Variant names by score, lowest first. */
export const VARIANT_LEVELS = ["low", "medium", "high", "max"] as const

/** Rounds a score to a level from 0 to 3. */
export function levelOf(score: number): number {
  return Math.min(VARIANT_LEVELS.length - 1, Math.max(0, Math.round(score)))
}

/**
 * The variant for `level`. An exact match wins. Otherwise the nearest of `low`, `medium`, `high`, `max` that the model
 * has, the lower one on a tie. `undefined` when the model has none of them or when its variants are unknown.
 */
export function pickVariant(level: number, variants: readonly string[] | undefined): string | undefined {
  if (!variants || variants.length === 0) return undefined
  const available = new Set(variants)
  const target = Math.min(VARIANT_LEVELS.length - 1, Math.max(0, Math.floor(level)))
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  VARIANT_LEVELS.forEach((name, index) => {
    if (!available.has(name)) return
    const distance = Math.abs(index - target)
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  })
  return best
}

const hasExplicitVariant = (variant: unknown): boolean => typeof variant === "string" && variant !== "" && variant !== "default"

export function createReasoningHandler(runtime: JevPointRuntime, options: ReasoningBudgetOptions): (event: ContextEvent) => void {
  const sessions = new BoundedMap<string, string>(MAX_SESSIONS)
  return (event) => {
    try {
      if (runtime.disposed || options.mode === "off" || typeof event.sessionID !== "string") return
      if (hasExplicitVariant(event.model?.variant)) return
      const request = latestUserRequest(event.messages)
      if (!request || request.text.trim().length < MIN_REQUEST_CHARS) return
      const previousKey = sessions.get(event.sessionID)
      if (previousKey === request.key) return
      sessions.set(event.sessionID, request.key)

      const sessionID = event.sessionID
      const rawRequest = request.text
      const providerID = event.model?.providerID
      const modelID = event.model?.id
      const model = typeof providerID === "string" && typeof modelID === "string" ? { providerID, id: modelID } : undefined

      const accepted = runtime.tasks.start(async (signal) => {
        // A model that is known to have no variants cannot use a level. No upstream call is made for it.
        const variants = model ? await runtime.modelVariants(model, signal) : undefined
        if (runtime.disposed || (variants !== undefined && variants.length === 0)) return
        // Redact the whole request with the literal key before the cap.
        const secrets = await runtime.secrets()
        if (runtime.disposed || signal.aborted) return
        const text = redactText(rawRequest, { secrets }).slice(0, MAX_REQUEST_CHARS)
        const outcome = await runtime.decide({ state: text, questions: reasoningQuestions(), timeoutMs: options.timeoutMs, signal })
        // A result for an older request is dropped.
        if (runtime.disposed || sessions.get(sessionID) !== request.key) return
        const base = { point: "reasoningBudget", mode: "shadow", sessionID } as const
        if (!outcome.ok) {
          runtime.record({ ...base, applied: false, ...failureFields(outcome.error) })
          return
        }
        const score = scoreValue(outcome.value, REASONING_QUESTION_ID)
        const choice = pickVariant(levelOf(score), variants)
        runtime.record({
          ...base,
          model: outcome.value.model,
          score,
          ...(choice === undefined ? {} : { choice }),
          applied: false,
          cached: outcome.value.cached,
          latencyMs: outcome.value.latencyMs,
          inputChars: text.length,
        })
      })
      // A task that did not start must not mark the request as seen.
      if (!accepted && sessions.get(sessionID) === request.key) {
        if (previousKey === undefined) sessions.delete(sessionID)
        else sessions.set(sessionID, previousKey)
      }
    } catch {
      // Observation must never affect the request.
    }
  }
}

export async function registerReasoning(
  ctx: { readonly session: HookHost },
  runtime: JevPointRuntime,
  options: ReasoningBudgetOptions,
): Promise<Registration[]> {
  const registrations: Registration[] = []
  try {
    registrations.push(await ctx.session.hook("context", createReasoningHandler(runtime, options)))
  } catch (error) {
    await disposeAll(registrations)
    throw error
  }
  return registrations
}
