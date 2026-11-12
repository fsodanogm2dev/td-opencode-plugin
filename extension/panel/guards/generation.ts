/**
 * Turns a plain-text request into a guard draft with the user's Small Model.
 * The model only proposes data. The shared strict validator decides whether the
 * draft is usable; the panel never runs model output as code.
 */
import type { GenerateRequest } from "@openchamber/sdk"

import { GUARD_SYSTEM_PROMPT } from "./prompt.ts"
import { LIMITS, validateGuardDraft, type Draft } from "./shared.ts"

/** Longest request the panel sends. Longer text is refused before any model call. */
export const REQUEST_MAX = Math.min(2_000, LIMITS.request)
export const OUTPUT_TOKENS = 1_200

export const generationRequest = (text: string): GenerateRequest => ({
  // The prompt is only the user's text, so a late answer can be matched to it again.
  prompt: text,
  system: GUARD_SYSTEM_PROMPT,
  maxOutputTokens: OUTPUT_TOKENS,
})

export type GenerationOutcome =
  | { kind: "draft"; draft: Draft }
  | { kind: "unsupported"; reason: string }
  | { kind: "invalid"; reason: string; details: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Removes a Markdown code fence and any text around the outer JSON object. */
const jsonPart = (text: string): string => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

const REASON_MAX = 400

export const readGeneration = (request: string, text: string): GenerationOutcome => {
  let value: unknown
  try {
    value = JSON.parse(jsonPart(text))
  } catch {
    return { kind: "invalid", reason: "The model did not answer in the expected format.", details: [] }
  }
  if (!isRecord(value)) return { kind: "invalid", reason: "The model did not answer in the expected format.", details: [] }
  if (typeof value.unsupported === "string" && value.unsupported.trim()) {
    return { kind: "unsupported", reason: value.unsupported.trim().slice(0, REASON_MAX) }
  }
  if (!isRecord(value.draft)) return { kind: "invalid", reason: "The model did not propose a guard.", details: [] }
  // The request is the user's own text, never the model's version of it.
  const parsed = validateGuardDraft({ ...value.draft, request })
  if (!parsed.ok) {
    return { kind: "invalid", reason: "The proposed guard uses something the plugin cannot enforce.", details: parsed.errors.slice(0, 5) }
  }
  return { kind: "draft", draft: parsed.value }
}
