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
