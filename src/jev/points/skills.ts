/**
 * Skill selection point. Shadow only: it observes and records which advertised skills look relevant. It never edits
 * the system prompt, the messages, the tools, or the model options.
 *
 * Trigger: `session.context` (the primary agent loop only, never titles or compaction). The callback copies what it
 * needs, starts a background task, and returns at once, so no upstream call delays the model request. It evaluates
 * once per session and latest user message. Session bookkeeping is bounded, and `dispose` cancels the tasks.
 *
 * The advertised catalog is `<available_skills><skill><id>..</id><name>..</name><description>..</description></skill>`
 * in the system text. One `noul` question per skill asks whether the request needs it. TypeSafe accepts few
 * questions per call, so the catalog goes out in chunks of `MAX_QUESTIONS`, at most `MAX_SKILLS` skills in all.
 *
 * Selection: skills that the request names (`@skill-id`) count as selected. The others need a probability of at
 * least `SKILL_RELEVANCE_THRESHOLD`, at most `maxSkills` of them. Telemetry carries the SHA-256 name (`skillHash`) of
 * each selected skill and counts, never request text or raw IDs.
 *
 * The state of each call is `{ request, skills: [{ id, description }] }` for one chunk. The request and every description
 * are redacted whole, with the literal active key, inside the background task and before any cap.
 */

import { createHash } from "node:crypto"
import { hashName } from "../artifacts.ts"
import { noulProbability } from "../client.ts"
import type { SkillPruningOptions } from "../options.ts"
import { MAX_QUESTIONS, skillQuestion, skillQuestionId } from "../questions.ts"
import { redactText } from "../redact.ts"
import { BoundedMap, failureFields, latestUserRequest, type JevPointRuntime } from "../runtime.ts"
import type { JevFailure, JevQuestions } from "../types.ts"
import { disposeAll, type HookHost, type Registration } from "./safety.ts"

/** A skill is relevant when its probability reaches this value. */
export const SKILL_RELEVANCE_THRESHOLD = 0.5
export const MAX_SKILLS = 64
export const MAX_REQUEST_CHARS = 2000
/** Characters of a description that reach TypeSafe. Redaction runs on the whole description first. */
export const MAX_DESCRIPTION_CHARS = 240
const MAX_BLOCK_CHARS = 400_000
const MAX_SESSIONS = 128
const MAX_SELECTION_ROWS = 8
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface AdvertisedSkill {
  readonly id: string
  /** The whole decoded text (the catalog is bounded by `MAX_BLOCK_CHARS`). Not redacted. Use `describeSkill` before it leaves the process. */
  readonly description: string
  /** Length of the `<skill>` element in the system text. */
  readonly chars: number
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }
const decode = (value: string): string => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITIES[entity] ?? entity)

function tagText(body: string, tag: string): string | undefined {
  const open = body.indexOf(`<${tag}>`)
  if (open < 0) return undefined
  const start = open + tag.length + 2
  const end = body.indexOf(`</${tag}>`, start)
  return end < 0 ? undefined : decode(body.slice(start, end)).trim()
}

/** Parses the advertised skills out of system text. Returns the skills and the length of the whole block. */
export function parseAdvertisedSkills(system: string): { readonly skills: AdvertisedSkill[]; readonly blockChars: number } {
  const open = system.indexOf("<available_skills>")
  if (open < 0) return { skills: [], blockChars: 0 }
  const closeAt = system.indexOf("</available_skills>", open)
  const block = system.slice(open, closeAt < 0 ? Math.min(system.length, open + MAX_BLOCK_CHARS) : closeAt + "</available_skills>".length).slice(0, MAX_BLOCK_CHARS)
  const skills: AdvertisedSkill[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (skills.length < MAX_SKILLS) {
    const start = block.indexOf("<skill>", cursor)
    if (start < 0) break
    const end = block.indexOf("</skill>", start)
    if (end < 0) break
    const element = block.slice(start, end + "</skill>".length)
    cursor = end + "</skill>".length
    const id = tagText(element, "id") ?? tagText(element, "name")
    if (!id || !SKILL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    // Never slice the raw text: a cut could leave the prefix of a long secret, which no pattern recognizes.
    const description = tagText(element, "description") ?? ""
    skills.push({ id, description, chars: element.length })
  }
  return { skills, blockChars: block.length }
}

/** Redacts the whole description (with the literal secrets), then collapses whitespace and caps it. */
export function describeSkill(description: string, secrets: readonly string[]): string {
  return redactText(description, { secrets }).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS)
}

/** Redacts the whole request first, then caps it. */
export function redactedRequest(request: string, secrets: readonly string[]): string {
  return redactText(request, { secrets }).slice(0, MAX_REQUEST_CHARS)
}

const MENTION_CHARS = /[A-Za-z0-9._:-]/

/** Advertised IDs that the request names as `@skill-id`. Only advertised IDs count. */
export function mentionedSkills(request: string, skills: readonly AdvertisedSkill[]): Set<string> {
  const known = new Set(skills.map((skill) => skill.id))
  const found = new Set<string>()
  for (let at = request.indexOf("@"); at >= 0 && found.size < MAX_SKILLS; at = request.indexOf("@", at + 1)) {
    if (at > 0 && /[A-Za-z0-9]/.test(request[at - 1] as string)) continue
    let end = at + 1
    while (end < request.length && end - at <= 65 && MENTION_CHARS.test(request[end] as string)) end++
    let candidate = request.slice(at + 1, end)
    while (candidate !== "" && !known.has(candidate)) candidate = candidate.slice(0, -1)
    if (candidate !== "") found.add(candidate)
  }
  return found
}

export interface SkillScore {
  readonly id: string
  readonly probability: number
}

/** Chooses the selected IDs in catalog order: every named skill plus the top relevant ones, at most `maxSkills`. */
export function selectSkills(skills: readonly AdvertisedSkill[], scores: readonly SkillScore[], forced: ReadonlySet<string>, maxSkills: number): string[] {
  const relevant = scores
    .filter((score) => !forced.has(score.id) && score.probability >= SKILL_RELEVANCE_THRESHOLD)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, maxSkills)
    .map((score) => score.id)
  const selected = new Set([...forced, ...relevant])
  return skills.map((skill) => skill.id).filter((id) => selected.has(id))
}

export interface ContextEvent {
  readonly sessionID: string
  readonly model?: { readonly providerID?: unknown; readonly id?: unknown; readonly variant?: unknown }
  readonly system?: unknown
  readonly messages?: unknown
}

export function systemText(system: unknown): string {
  if (!Array.isArray(system)) return typeof system === "string" ? system : ""
  return system.map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown } | null)?.text === "string" ? (part as { text: string }).text : "")).join("\n")
}

interface SessionState {
  key: string
  previous?: string
}

export function createSkillsHandler(runtime: JevPointRuntime, options: SkillPruningOptions): (event: ContextEvent) => void {
  const sessions = new BoundedMap<string, SessionState>(MAX_SESSIONS)
  return (event) => {
    try {
      if (runtime.disposed || options.mode === "off" || typeof event.sessionID !== "string") return
      const request = latestUserRequest(event.messages)
      if (!request) return
      const state = sessions.get(event.sessionID)
      if (state?.key === request.key) return
      const { skills, blockChars } = parseAdvertisedSkills(systemText(event.system))
      // A small catalog needs no selection.
      if (skills.length <= options.maxSkills) return

      const sessionID = event.sessionID
      const rawRequest = request.text
      const forced = mentionedSkills(rawRequest, skills)
      const previous = state?.previous
      const next: SessionState = { key: request.key, ...(previous === undefined ? {} : { previous }) }
      sessions.set(sessionID, next)
      const isLatest = (): boolean => sessions.get(sessionID)?.key === request.key

      const accepted = runtime.tasks.start(async (signal) => {
        // Redaction covers the whole request and every description before any cap, and needs the literal key.
        const secrets = await runtime.secrets()
        if (runtime.disposed || signal.aborted) return
        const text = redactedRequest(rawRequest, secrets)
        const catalog = skills.map((skill) => ({ id: skill.id, description: describeSkill(skill.description, secrets) }))

        const scores: SkillScore[] = []
        let failure: JevFailure | undefined
        let modelName: string | undefined
        let cached = true
        let latencyMs = 0
        for (let from = 0; from < catalog.length && !failure; from += MAX_QUESTIONS) {
          // Chunks run one after the other. A failure stops the rest. Each state carries its chunk only.
          const chunk = catalog.slice(from, from + MAX_QUESTIONS)
          const questions: Record<string, ReturnType<typeof skillQuestion>> = {}
          chunk.forEach((skill, offset) => {
            questions[skillQuestionId(from + offset)] = skillQuestion(skill.id)
          })
          const outcome = await runtime.decide({
            state: { request: text, skills: chunk },
            questions: questions as JevQuestions,
            timeoutMs: options.timeoutMs,
            signal,
          })
          if (!outcome.ok) {
            failure = outcome.error
            break
          }
          modelName = outcome.value.model
          cached = cached && outcome.value.cached
          latencyMs += outcome.value.latencyMs
          chunk.forEach((skill, offset) => {
            scores.push({ id: skill.id, probability: noulProbability(outcome.value, skillQuestionId(from + offset)) })
          })
        }
        // A result for an older request must not change the session or be reported as current.
        if (runtime.disposed || !isLatest()) return
        const base = { point: "skillPruning", mode: "shadow", sessionID } as const
        if (failure) {
          runtime.record({ ...base, applied: false, ...failureFields(failure) })
          return
        }
        const selected = selectSkills(skills, scores, forced, options.maxSkills)
        const signature = createHash("sha256").update(selected.join("\u0000")).digest("hex")
        const current = sessions.get(sessionID)
        const changed = current?.previous !== undefined && current.previous !== signature
        if (current && current.key === request.key) current.previous = signature
        const chosen = new Set(selected)
        const keptChars = blockChars - skills.filter((skill) => !chosen.has(skill.id)).reduce((sum, skill) => sum + skill.chars, 0)
        runtime.record({
          ...base,
          ...(modelName === undefined ? {} : { model: modelName }),
          score: selected.length,
          applied: false,
          cached,
          latencyMs,
          inputChars: blockChars,
          outputChars: keptChars,
          estimatedSavedTokens: Math.round((blockChars - keptChars) / 4),
          skillSetChanged: changed,
        })
        const probabilityOf = new Map(scores.map((score) => [score.id, score.probability]))
        for (const id of selected.slice(0, MAX_SELECTION_ROWS)) {
          const probability = probabilityOf.get(id)
          runtime.record({ ...base, skillHash: hashName(id), applied: false, ...(probability === undefined ? {} : { probability }) })
        }
      })
      // A task that did not start must not mark the request as seen.
      if (!accepted && sessions.get(sessionID) === next) {
        if (state) sessions.set(sessionID, state)
        else sessions.delete(sessionID)
      }
    } catch {
      // Observation must never affect the request.
    }
  }
}

export async function registerSkills(
  ctx: { readonly session: HookHost },
  runtime: JevPointRuntime,
  options: SkillPruningOptions,
): Promise<Registration[]> {
  const registrations: Registration[] = []
  try {
    registrations.push(await ctx.session.hook("context", createSkillsHandler(runtime, options)))
  } catch (error) {
    await disposeAll(registrations)
    throw error
  }
  return registrations
}
