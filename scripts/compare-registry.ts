/**
 * Compares two OpenCode model registries (`GET /api/model` responses) for the FueliX providers and prints Markdown.
 *
 *   bun scripts/compare-registry.ts --before live.json --after plugin.json [--out report.md]
 *
 * Only `id`, `providerID`, `name`, `cost`, `limit`, `capabilities.input`, and variant IDs are read. Provider and model
 * `settings`, `headers`, and `body` are never read or printed, because a live registry can contain keys there.
 */

import { readFileSync, writeFileSync } from "node:fs"

export interface ModelSummary {
  readonly key: string
  readonly name: string
  readonly cost: string
  readonly limit: string
  readonly input: string
  readonly variants: string
  readonly priced: boolean
}

export interface RegistryDiff {
  readonly before: number
  readonly after: number
  readonly added: readonly ModelSummary[]
  readonly removed: readonly ModelSummary[]
  readonly changed: readonly { readonly key: string; readonly field: keyof ModelSummary; readonly before: string; readonly after: string }[]
  readonly unpricedBefore: readonly string[]
  readonly unpricedAfter: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?"
}

function summarizeCost(value: unknown): { text: string; priced: boolean } {
  if (!Array.isArray(value) || value.length === 0) return { text: "none", priced: false }
  const parts = value.map((tier) => {
    if (!isRecord(tier)) return "?"
    const cache = isRecord(tier.cache) ? tier.cache : {}
    const prefix = isRecord(tier.tier) ? `>${formatNumber(tier.tier.size)}: ` : ""
    return `${prefix}${formatNumber(tier.input)}/${formatNumber(tier.output)}/${formatNumber(cache.read)}/${formatNumber(cache.write)}`
  })
  return { text: parts.join("; "), priced: true }
}

export function summarize(model: unknown): ModelSummary | undefined {
  if (!isRecord(model)) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : undefined
  const id = typeof model.id === "string" ? model.id : undefined
  if (!providerID || !id || !providerID.startsWith("fuelix")) return undefined
  const limit = isRecord(model.limit) ? model.limit : {}
  const capabilities = isRecord(model.capabilities) ? model.capabilities : {}
  // Modality order has no meaning, so compare a sorted list.
  const input = Array.isArray(capabilities.input)
    ? capabilities.input.filter((item): item is string => typeof item === "string").sort()
    : []
  const variants = Array.isArray(model.variants)
    ? model.variants.map((variant) => (isRecord(variant) && typeof variant.id === "string" ? variant.id : "?"))
    : []
  const cost = summarizeCost(model.cost)
  return {
    key: `${providerID}/${id}`,
    name: typeof model.name === "string" ? model.name : id,
    cost: cost.text,
    limit: `${formatNumber(limit.context)}/${formatNumber(limit.output)}`,
    input: input.join(",") || "none",
    variants: variants.join(",") || "none",
    priced: cost.priced,
  }
}

export function readRegistry(json: unknown): Map<string, ModelSummary> {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.data) ? json.data : []
  const result = new Map<string, ModelSummary>()
  for (const model of list) {
    const summary = summarize(model)
    if (summary) result.set(summary.key, summary)
  }
  return result
}

const COMPARED_FIELDS = ["name", "cost", "limit", "input", "variants"] as const

export function diffRegistries(before: Map<string, ModelSummary>, after: Map<string, ModelSummary>): RegistryDiff {
  const added = [...after.values()].filter((model) => !before.has(model.key))
  const removed = [...before.values()].filter((model) => !after.has(model.key))
  const changed: RegistryDiff["changed"][number][] = []
  for (const [key, next] of after) {
    const previous = before.get(key)
    if (!previous) continue
    for (const field of COMPARED_FIELDS) {
      if (previous[field] !== next[field]) changed.push({ key, field, before: previous[field], after: next[field] })
    }
  }
  const sortByKey = <T extends { key: string }>(items: T[]) => items.sort((a, b) => a.key.localeCompare(b.key))
  return {
    before: before.size,
    after: after.size,
    added: sortByKey(added),
    removed: sortByKey(removed),
    changed: changed.sort((a, b) => a.key.localeCompare(b.key) || a.field.localeCompare(b.field)),
    unpricedBefore: [...before.values()].filter((model) => !model.priced).map((model) => model.key).sort(),
    unpricedAfter: [...after.values()].filter((model) => !model.priced).map((model) => model.key).sort(),
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|")

export function renderMarkdown(diff: RegistryDiff): string {
  const lines: string[] = []
  const countBy = (field: string) => new Set(diff.changed.filter((item) => item.field === field).map((item) => item.key)).size
  lines.push("| Measure | Count |", "| --- | ---: |")
  lines.push(`| FueliX models before | ${diff.before} |`, `| FueliX models after | ${diff.after} |`)
  lines.push(`| Models added | ${diff.added.length} |`, `| Models removed | ${diff.removed.length} |`)
  for (const field of COMPARED_FIELDS) lines.push(`| Models with a changed ${field} | ${countBy(field)} |`)
  lines.push(`| Models without a price before | ${diff.unpricedBefore.length} |`)
  lines.push(`| Models without a price after | ${diff.unpricedAfter.length} |`, "")

  if (diff.removed.length > 0) {
    lines.push("Removed models:", "", "| Model | Name |", "| --- | --- |")
    for (const model of diff.removed) lines.push(`| \`${model.key}\` | ${cell(model.name)} |`)
    lines.push("")
  }
  if (diff.added.length > 0) {
    lines.push("Added models:", "", "| Model | Name |", "| --- | --- |")
    for (const model of diff.added) lines.push(`| \`${model.key}\` | ${cell(model.name)} |`)
    lines.push("")
  }
  if (diff.changed.length > 0) {
    lines.push(
      "Changed fields (cost is input/output/cache read/cache write in USD per 1M tokens; limit is context/output):",
      "",
      "| Model | Field | Before | After |",
      "| --- | --- | --- | --- |",
    )
    for (const item of diff.changed) {
      lines.push(`| \`${item.key}\` | ${item.field} | ${cell(item.before)} | ${cell(item.after)} |`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const beforePath = readFlag(args, "--before")
  const afterPath = readFlag(args, "--after")
  if (!beforePath || !afterPath) {
    console.error("usage: bun scripts/compare-registry.ts --before <file> --after <file> [--out <file>]")
    process.exit(2)
  }
  const before = readRegistry(JSON.parse(readFileSync(beforePath, "utf8")))
  const after = readRegistry(JSON.parse(readFileSync(afterPath, "utf8")))
  const markdown = renderMarkdown(diffRegistries(before, after))
  const outPath = readFlag(args, "--out")
  if (outPath) writeFileSync(outPath, markdown)
  else process.stdout.write(markdown)
}
