/**
 * Routing and kind rules for FueliX model IDs that the curated catalog does not know.
 * Shared by the runtime (`src/fuelix/`) and the catalog builder (`scripts/build-catalog.ts`).
 *
 * The curated catalog always wins for a known ID, because it records routes tested in a working configuration
 * (for example, `claude-3-7-sonnet` runs on Chat Completions there).
 */

import type { FuelixProviderID, ModelKind } from "./catalog-types.ts"

export function classifyKind(id: string): ModelKind {
  const value = id.toLowerCase()
  if (value.includes("embedding")) return "embedding"
  if (/^tts-/.test(value)) return "speech"
  if (value.includes("whisper") || value.includes("transcribe")) return "transcription"
  if (/^(dall-e|imagen)/.test(value)) return "image"
  return "chat"
}

/**
 * - Claude-family IDs use Anthropic Messages. FueliX requires `/v1/messages` for premium models (Opus, Fable).
 * - OpenAI GPT and o-series IDs use OpenAI Responses.
 * - Everything else (Gemini, Gemma, Llama, Mistral, DeepSeek, non-chat models) uses Chat Completions.
 */
export function routeModel(id: string): FuelixProviderID {
  const value = id.toLowerCase()
  if (classifyKind(value) !== "chat") return "fuelix"
  if (/^(claude-|cursor-c-|c-(haiku|sonnet|opus)-|fable)/.test(value)) return "fuelix-anthropic"
  if (/^(gpt-|o\d)/.test(value)) return "fuelix-openai"
  return "fuelix"
}

/**
 * One title model per provider. The plugin sets `family` on exactly these models, because OpenCode picks the
 * title model with `model.small(providerID)` (`packages/core/src/model.ts:271-283`). That function returns the first
 * active text model whose family is "gpt-luna", "gemini-flash-lite", "gemini-flash", or "claude-haiku", in that order.
 * Without a family, titles run on the session model. A user can still override the choice with `agents.title.model`.
 * The values are the family names that models.dev uses. Keep this map small: OpenCode also hides older models of
 * the same family in its models tool.
 */
export const TITLE_MODELS: Readonly<Record<FuelixProviderID, { readonly modelID: string; readonly family: string }>> = {
  "fuelix-openai": { modelID: "gpt-6-luna", family: "gpt-luna" },
  "fuelix-anthropic": { modelID: "claude-haiku-5-5", family: "claude-haiku" },
  // gemini-2.5-flash-lite costs less, but its catalog status is "deprecated" and `model.small` takes active models only.
  fuelix: { modelID: "gemini-3.1-flash-lite", family: "gemini-flash-lite" },
}

/** The family to set on a model, or `undefined` when the model is not the title model of its provider or is not active. */
export function titleFamily(providerID: FuelixProviderID, modelID: string, status: string | undefined): string | undefined {
  const title = TITLE_MODELS[providerID]
  if (title.modelID !== modelID || (status ?? "active") !== "active") return undefined
  return title.family
}
