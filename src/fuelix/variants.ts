/**
 * Reasoning variants for FueliX models.
 *
 * This module replicates `packages/core/src/variant.ts` of OpenCode 2.0.32 for the three packages that FueliX
 * providers use, with the default support `[{ type: "effort" }]`. The output must match the live OpenCode registry.
 * `test/fixtures/fuelix/variants-live-2.0.32.json` holds the captured reference.
 */

import type { FuelixProviderID } from "./catalog-types.ts"

export interface PlainVariant {
  readonly id: string
  readonly settings: Record<string, unknown>
}

export interface VariantInput {
  readonly providerID: FuelixProviderID
  readonly modelID: string
  /** Final output token limit of the model. Budget-based variants stay under it. */
  readonly outputLimit: number
  /** `false` means the model has no reasoning controls. Unknown (`undefined`) uses the OpenCode default. */
  readonly reasoning?: boolean | undefined
}

type Support = { readonly type: "effort"; readonly values?: readonly string[] } | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }

interface ModelRef {
  readonly modelID: string
  readonly outputLimit: number
}

type Protocol = (model: ModelRef, support: Support) => PlainVariant[]

const EFFORTS = ["low", "medium", "high"]
const ENCRYPTED_REASONING = ["reasoning.encrypted_content"]
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" }
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000

const efforts = (values: readonly string[], spell: (effort: string) => Record<string, unknown>): PlainVariant[] =>
  values.map((effort) => ({ id: effort, settings: spell(effort) }))

function budgets(
  model: ModelRef,
  support: Extract<Support, { type: "budget_tokens" }>,
  spell: (tokens: number) => Record<string, unknown>,
  ceiling = model.outputLimit,
): PlainVariant[] {
  const maximum = Math.min(support.max ?? ceiling - 1, model.outputLimit - 1, ceiling - 1)
  if (maximum <= 0) return []
  const high = Math.min(Math.max(support.min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  return [
    { id: "high", settings: spell(high) },
    { id: "max", settings: spell(maximum) },
  ]
}

function claudeInfo(modelID: string) {
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(modelID)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(modelID)
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    family,
    major,
    minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === "fable" || family === "mythos" || modelID.toLowerCase().includes("mythos-preview"),
  }
}

function manualThinking(model: ModelRef): { settings: Record<string, unknown> } | undefined {
  const tokens = Math.min(16_000, model.outputLimit - 1)
  if (tokens < 1024) return undefined
  return { settings: { thinking: { type: "enabled", budgetTokens: tokens } } }
}

const openaiChat: Protocol = (_, support) => {
  if (support.type !== "effort") return []
  return efforts(support.values ?? EFFORTS, (effort) => ({ reasoningEffort: effort }))
}

const openaiResponses: Protocol = (_, support) => {
  if (support.type !== "effort") return []
  return efforts(support.values ?? ["none", "minimal", ...EFFORTS, "xhigh"], (effort) => ({
    reasoningEffort: effort,
    reasoningSummary: "auto",
    include: ENCRYPTED_REASONING,
  }))
}

const anthropicMessages: Protocol = (model, support) => {
  const info = claudeInfo(model.modelID)
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5
  if (support.type === "budget_tokens") {
    return budgets(
      model,
      support,
      (tokens) => ({ thinking: { type: "enabled", budgetTokens: tokens } }),
      ANTHROPIC_OUTPUT_TOKEN_MAX,
    )
  }
  if (info.manual && !opus45) return anthropicMessages(model, { type: "budget_tokens", min: 1024 })
  const thinking = opus45 ? manualThinking(model)?.settings : { thinking: ADAPTIVE_THINKING }
  if (!thinking) return []
  const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, "max"] : [...EFFORTS, "xhigh", "max"]
  const values = (support.values ?? defaults).filter((effort) => !info.always || effort !== "none")
  return efforts(values, (effort) =>
    effort === "none" ? { thinking: { type: "disabled" } } : { ...thinking, effort },
  )
}

const PROTOCOLS: Readonly<Record<FuelixProviderID, Protocol>> = {
  "fuelix-openai": openaiResponses,
  "fuelix-anthropic": anthropicMessages,
  fuelix: openaiChat,
}

/** Packages that each FueliX provider uses. */
export const FUELIX_PACKAGES: Readonly<Record<FuelixProviderID, string>> = {
  "fuelix-openai": "@opencode/ai/providers/openai",
  "fuelix-anthropic": "@opencode/ai/providers/anthropic",
  fuelix: "@opencode/ai/providers/openai-compatible",
}

export function resolveVariants(input: VariantInput): PlainVariant[] {
  if (input.reasoning === false) return []
  const model: ModelRef = { modelID: input.modelID, outputLimit: input.outputLimit }
  const variants = PROTOCOLS[input.providerID](model, { type: "effort" })
  return variants.filter((variant, index) => variants.findIndex((other) => other.id === variant.id) === index)
}
