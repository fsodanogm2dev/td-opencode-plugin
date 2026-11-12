/**
 * Test-output compression point (`tool.execute.after`, shell only).
 *
 * The shell result that OpenCode 2.2.5 returns has this shape:
 *
 * ```
 * { output: { exit, truncated, output, status },
 *   content: [{ type: "text", text }, { type: "text", text: "Exited with code 1" }],
 *   metadata: { status, truncated, exit } }
 * ```
 *
 * `output.output` duplicates the first text part. OpenCode keeps no file with the original text, even when it
 * truncated the text itself (about 51 KB). The protected log of this point therefore holds the redacted text that
 * OpenCode returned, and the summary says so when `truncated` is set.
 *
 * Flow: detect a test or build failure above `maxRawLength` -> leave it alone when redaction would change it
 * (enforce) -> ask TypeSafe (`error_type`, `is_flaky`) about a
 * bounded extractive sample -> write the redacted text to a private log -> replace the text with a shorter extractive
 * summary. Every step that fails leaves the original result unchanged. `shadow` asks and records, and changes nothing
 * and writes nothing. Files, the exit-code part, and the metadata stay as they are.
 */

import { chosenOption, noulProbability } from "../client.ts"
import type { TestCompressionOptions } from "../options.ts"
import { ERROR_TYPE_QUESTION_ID, FLAKY_QUESTION_ID, testOutputQuestions } from "../questions.ts"
import { redactText, MAX_REDACT_CHARS } from "../redact.ts"
import { failureFields, type JevPointRuntime } from "../runtime.ts"
import { disposeAll, type HookHost, type Registration } from "./safety.ts"

export const HEAD_CHARS = 300
export const EXCERPT_CHARS = 2400
export const TAIL_CHARS = 700
export const MAX_LINE_CHARS = 300
const CONTEXT_BEFORE = 2
const CONTEXT_AFTER = 8
const TAIL_MAX_LINES = 14

/** Lines that show a test or build failure. */
const FAILURE =
  /(?:\bFAIL(?:ED|URE|URES)?\b|\bAssertionError\b|\bAssertion failed\b|\b(?:Type|Syntax|Reference|Range)Error\b|\bTraceback \(most recent call last\)|\bpanic:|\bnpm ERR!|\berror\[E\d+\]|\berror TS\d+|\bTS\d{4}:|\b\d+ (?:tests? )?(?:failed|failing)\b|\bTests?:.*\bfailed\b|\btests? failed\b|^\s*(?:error|Error):|✗|✘|\bCannot find module\b|\bModuleNotFoundError\b|\bcommand not found\b|\bTimeoutError\b|\bTest timed out\b)/
/** Lines that carry no information about a failure. */
const NOISE = /^\s*(?:PASS|PASSED|ok|OK|✓|✔|\.+)(?:\s|$)/

export function looksLikeFailure(text: string): boolean {
  return text.split("\n").some((line) => FAILURE.test(line))
}

const cut = (line: string): string => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …` : line)

export interface Excerpt {
  readonly head: string
  readonly regions: readonly string[]
  readonly omittedRegions: number
  readonly tail: string
}

/**
 * Extractive selection from already redacted text: a short head, the regions around failure lines (two lines
 * before, up to eight after, never through a pass line), and the last informative lines. Nothing is paraphrased.
 */
export function selectExcerpt(text: string): Excerpt {
  const lines = text.split("\n")
  const ranges: Array<[number, number]> = []
  let covered = -1
  for (let i = 0; i < lines.length; i++) {
    if (i <= covered || !FAILURE.test(lines[i] as string)) continue
    let start = i
    for (let step = 0; step < CONTEXT_BEFORE && start - 1 > covered && !NOISE.test(lines[start - 1] as string); step++) start--
    let end = i
    for (let step = 0; step < CONTEXT_AFTER && end + 1 < lines.length && !NOISE.test(lines[end + 1] as string); step++) end++
    ranges.push([start, end])
    covered = end
  }

  const regions: string[] = []
  let used = 0
  let omitted = 0
  for (const [start, end] of ranges) {
    const region = lines.slice(start, end + 1).map(cut).join("\n").trim()
    if (used > 0 && used + region.length > EXCERPT_CHARS) {
      omitted++
      continue
    }
    // The first region always stays, even when it is long: it holds the first failure.
    regions.push(used === 0 && region.length > EXCERPT_CHARS ? `${region.slice(0, EXCERPT_CHARS)} …` : region)
    used += region.length
  }

  const firstStart = ranges[0]?.[0] ?? lines.length
  const headLines: string[] = []
  let headLength = 0
  for (let i = 0; i < firstStart; i++) {
    const line = cut(lines[i] as string)
    if (headLength + line.length > HEAD_CHARS) break
    headLines.push(line)
    headLength += line.length + 1
  }

  const lastEnd = ranges.at(-1)?.[1] ?? -1
  const tailLines: string[] = []
  let tailLength = 0
  for (let i = lines.length - 1; i > lastEnd && tailLines.length < TAIL_MAX_LINES; i--) {
    const raw = lines[i] as string
    if (raw.trim() === "" || NOISE.test(raw)) continue
    const line = cut(raw)
    if (tailLength + line.length > TAIL_CHARS) break
    tailLines.unshift(line)
    tailLength += line.length + 1
  }

  return { head: headLines.join("\n").trim(), regions, omittedRegions: omitted, tail: tailLines.join("\n").trim() }
}

/** The text that goes to TypeSafe: the extract, without summary headers. */
export function excerptSample(excerpt: Excerpt): string {
  return [excerpt.head, ...excerpt.regions, excerpt.tail].filter((part) => part !== "").join("\n...\n")
}

export interface SummaryInput {
  readonly excerpt: Excerpt
  readonly originalChars: number
  readonly choice: string
  readonly confidence?: number
  readonly flaky: number
  readonly logPath: string
  /** OpenCode had already truncated the output that this plugin received. */
  readonly truncatedByOpenCode: boolean
}

export function buildSummary(input: SummaryInput): string {
  const { excerpt } = input
  const lines = [
    `[Jev test-output summary: ${input.originalChars} characters reduced to an excerpt. The classification is an estimate.]`,
    `Classification: ${input.choice}${input.confidence === undefined ? "" : ` (confidence ${input.confidence.toFixed(2)})`}`,
    `Flaky probability: ${input.flaky.toFixed(2)}`,
    `Protected log, a redacted copy of the output${input.truncatedByOpenCode ? " that OpenCode had already truncated" : ""}: ${input.logPath}`,
    "Read the log for lines that this summary omits.",
  ]
  if (excerpt.head !== "") lines.push("--- Start ---", excerpt.head)
  if (excerpt.regions.length > 0) {
    lines.push("--- Failure excerpt ---", excerpt.regions.join("\n...\n"))
    if (excerpt.omittedRegions > 0) lines.push(`[${excerpt.omittedRegions} further failure region(s) omitted. See the log.]`)
  }
  if (excerpt.tail !== "") lines.push("--- End ---", excerpt.tail)
  return lines.join("\n")
}

// -- Result shape ----------------------------------------------------------------------------------------------

interface ResultLike {
  output?: unknown
  content?: string | ReadonlyArray<unknown>
  metadata?: Readonly<Record<string, unknown>>
}

export interface ToolAfterEvent {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly status: "completed" | "error"
  result?: ResultLike
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Index of the first text part, or -1 for string content. `undefined` when the content has no text. */
function primaryText(content: ResultLike["content"]): { readonly index: number; readonly text: string } | undefined {
  if (typeof content === "string") return { index: -1, text: content }
  if (!Array.isArray(content)) return undefined
  const index = content.findIndex((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
  return index < 0 ? undefined : { index, text: (content[index] as { text: string }).text }
}

function exitCode(result: ResultLike): number | undefined {
  if (isRecord(result.output) && typeof result.output.exit === "number") return result.output.exit
  if (typeof result.metadata?.exit === "number") return result.metadata.exit
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        const match = /^Exited with code (-?\d+)\s*$/.exec(part.text)
        if (match) return Number(match[1])
      }
    }
  }
  return undefined
}

function replacePrimary(result: ResultLike, primary: { readonly index: number }, original: string, summary: string): ResultLike {
  const next: ResultLike = { ...result }
  if (primary.index < 0) next.content = summary
  else {
    const parts = [...(result.content as ReadonlyArray<unknown>)]
    parts[primary.index] = { ...(parts[primary.index] as Record<string, unknown>), text: summary }
    next.content = parts
  }
  // `output.output` duplicates the text. The original must not stay in the returned result.
  if (isRecord(result.output) && typeof result.output.output === "string") next.output = { ...result.output, output: summary }
  else if (typeof result.output === "string" && result.output === original) next.output = summary
  return next
}

// -- Handler -----------------------------------------------------------------------------------------------------

export function createTestOutputHandler(runtime: JevPointRuntime, options: TestCompressionOptions): (event: ToolAfterEvent) => Promise<void> {
  const enforce = options.mode === "enforce"
  return async (event) => {
    try {
      if (runtime.disposed || event.tool !== "shell" || event.status !== "completed" || !event.result) return
      const result = event.result
      const primary = primaryText(result.content)
      if (!primary) return
      const original = primary.text
      if (original.length <= options.maxRawLength || original.length > MAX_REDACT_CHARS) return
      const code = exitCode(result)
      if (code === 0 || !looksLikeFailure(original)) return

      const secrets = await runtime.secrets()
      const redacted = redactText(original, { secrets })
      const base = { point: "testCompression", mode: options.mode, sessionID: event.sessionID, inputChars: original.length } as const
      // Redaction also erases facts that a developer needs, such as a fake token in an assertion. OpenCode already
      // holds the original, so leaving it alone costs no privacy. Compression never writes a recognized secret to a
      // new log or a summary, so an output that redaction changes stays as it is. Shadow only classifies the redacted
      // excerpt and persists nothing.
      if (enforce && redacted !== original) {
        runtime.record({ ...base, applied: false })
        return
      }
      const excerpt = selectExcerpt(redacted)

      const outcome = await runtime.decide({ state: excerptSample(excerpt), questions: testOutputQuestions(), timeoutMs: options.timeoutMs })
      if (runtime.disposed) return
      if (!outcome.ok) {
        runtime.record({ ...base, applied: false, ...failureFields(outcome.error) })
        return
      }
      const choice = chosenOption(outcome.value, ERROR_TYPE_QUESTION_ID)
      const flaky = noulProbability(outcome.value, FLAKY_QUESTION_ID)
      const answer = outcome.value.answers[ERROR_TYPE_QUESTION_ID]
      const confidence = answer?.type === "choice" ? answer.confidence : undefined
      const decided = { model: outcome.value.model, choice, probability: flaky, latencyMs: outcome.value.latencyMs, cached: outcome.value.cached }

      if (!enforce) {
        runtime.record({ ...base, ...decided, applied: false })
        return
      }

      let logPath: string
      try {
        logPath = await runtime.writeLog(event.sessionID, event.id, original)
      } catch {
        runtime.record({ ...base, ...decided, applied: false })
        return
      }
      // A write that finished after dispose must not change the result.
      if (runtime.disposed) return
      const truncatedByOpenCode = (isRecord(result.output) && result.output.truncated === true) || result.metadata?.truncated === true
      const summary = buildSummary({
        excerpt,
        originalChars: original.length,
        choice,
        ...(confidence === undefined ? {} : { confidence }),
        flaky,
        logPath,
        truncatedByOpenCode,
      })
      if (summary.length >= original.length) {
        runtime.record({ ...base, ...decided, applied: false, outputChars: summary.length })
        return
      }
      event.result = replacePrimary(result, primary, original, summary)
      runtime.record({
        ...base,
        ...decided,
        applied: true,
        outputChars: summary.length,
        estimatedTokens: Math.ceil(summary.length / 4),
        estimatedSavedTokens: Math.round((original.length - summary.length) / 4),
      })
    } catch {
      // The original result stays.
    }
  }
}

export async function registerTestOutput(
  ctx: { readonly tool: HookHost },
  runtime: JevPointRuntime,
  options: TestCompressionOptions,
): Promise<Registration[]> {
  const registrations: Registration[] = []
  try {
    registrations.push(await ctx.tool.hook("execute.after", createTestOutputHandler(runtime, options)))
  } catch (error) {
    await disposeAll(registrations)
    throw error
  }
  return registrations
}
