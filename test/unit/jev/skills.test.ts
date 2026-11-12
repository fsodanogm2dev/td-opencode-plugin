import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  createSkillsHandler,
  describeSkill,
  mentionedSkills,
  parseAdvertisedSkills,
  selectSkills,
  SKILL_RELEVANCE_THRESHOLD,
  MAX_SKILLS,
} from "../../../src/jev/points/skills.ts"
import { hashName } from "../../../src/jev/artifacts.ts"
import { createTaskTracker, type JevDecideRequest, type JevPointRuntime } from "../../../src/jev/runtime.ts"
import type { JevTelemetryEvent } from "../../../src/jev/telemetry.ts"
import type { JevOutcome } from "../../../src/jev/types.ts"

const options = (extra: Record<string, unknown> = {}) => ({ mode: "shadow" as const, timeoutMs: 800, maxSkills: 3, ...extra })

const skillBlock = (count: number, prefix = "skill") =>
  `Intro\n<available_skills>\n${Array.from({ length: count }, (_, i) => `<skill><id>${prefix}-${i}</id><name>${prefix}-${i}</name><description>Does thing ${i} &amp; more</description></skill>`).join("\n")}\n</available_skills>\nOutro`

/** Probability by skill id from the question text. */
type Scorer = (id: string) => number

function fakeRuntime(scorer: Scorer = () => 0.1, decide?: (r: JevDecideRequest) => JevOutcome | Promise<JevOutcome>, secrets: string[] = [], taskLimit = 4) {
  const requests: JevDecideRequest[] = []
  const records: JevTelemetryEvent[] = []
  const state = { disposed: false }
  const runtime: JevPointRuntime = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => 0,
    get disposed() {
      return state.disposed
    },
    async decide(request) {
      requests.push(request)
      if (decide) return decide(request)
      const answers: Record<string, { type: "noul"; noul: number }> = {}
      for (const [name, question] of Object.entries(request.questions)) {
        const id = /Is the skill "([^"]+)"/.exec(question.instructions)![1]!
        answers[name] = { type: "noul", noul: scorer(id) }
      }
      return { ok: true, value: { model: "jev-1.14.0", requestedModel: "jev-1.14.0", answers, cached: false, latencyMs: 3 } }
    },
    secrets: async () => secrets,
    record: (event) => void records.push(event),
    writeLog: async () => {
      throw new Error("unused")
    },
    modelVariants: async () => undefined,
    tasks: createTaskTracker(taskLimit),
  }
  return { runtime, requests, records, state }
}

const selectedHashes = (records: JevTelemetryEvent[]) => records.map((r) => (r as { skillHash?: string }).skillHash).filter((value) => value !== undefined)

const settle = async (runtime: JevPointRuntime) => {
  for (let i = 0; i < 100 && runtime.tasks.size > 0; i++) await Bun.sleep(2)
}

const contextEvent = (text: string, system = skillBlock(10), id: string | null = "msg_1") => ({
  sessionID: "ses_1",
  model: { providerID: "p", id: "m" },
  system: [{ type: "text", text: system }],
  messages: [{ ...(id === null ? {} : { id }), role: "user", content: [{ type: "text", text }] }],
})

describe("parseAdvertisedSkills", () => {
  test("reads ids, descriptions, and element sizes", () => {
    const { skills, blockChars } = parseAdvertisedSkills(skillBlock(2))
    expect(skills.map((s) => s.id)).toEqual(["skill-0", "skill-1"])
    expect(skills[0]!.description).toBe("Does thing 0 & more")
    expect(skills[0]!.chars).toBeGreaterThan(20)
    expect(blockChars).toBeGreaterThan(skills[0]!.chars * 2)
  })

  test("falls back to the name, skips invalid and duplicate ids, and bounds the count", () => {
    const text = `<available_skills><skill><name>only-name</name></skill><skill><id>bad id!</id></skill><skill><id>dup</id></skill><skill><id>dup</id></skill></available_skills>`
    expect(parseAdvertisedSkills(text).skills.map((s) => s.id)).toEqual(["only-name", "dup"])
    expect(parseAdvertisedSkills(skillBlock(200)).skills.length).toBe(MAX_SKILLS)
  })

  test("returns nothing without a block, and tolerates an unterminated block", () => {
    expect(parseAdvertisedSkills("no skills").skills).toEqual([])
    expect(parseAdvertisedSkills("<available_skills><skill><id>a</id>").skills).toEqual([])
  })

  test("keeps the whole raw description, so redaction sees all of it before the 240 cap", () => {
    const text = `<available_skills><skill><id>a</id><description>${"x".repeat(20000)}</description></skill></available_skills>`
    expect(parseAdvertisedSkills(text).skills[0]!.description.length).toBe(20000)
    expect(describeSkill("x".repeat(20000), []).length).toBe(240)
    expect(describeSkill("  a \n b\t c ", [])).toBe("a b c")
  })
})

describe("mentionedSkills", () => {
  const skills = parseAdvertisedSkills(skillBlock(4, "tdd")).skills
  test("finds advertised ids only", () => {
    expect([...mentionedSkills("please use @tdd-1, and @tdd-3. also @unknown and @tdd-9", skills)].sort()).toEqual(["tdd-1", "tdd-3"])
  })
  test("ignores mentions inside words such as email addresses", () => {
    expect(mentionedSkills("mail me at user@tdd-1", skills).size).toBe(0)
  })
  test("handles a long garbage run and ids that look like regex", () => {
    expect(mentionedSkills(`@${"a".repeat(100000)} @(.*)`, skills).size).toBe(0)
  })
})

describe("selectSkills", () => {
  const skills = parseAdvertisedSkills(skillBlock(6)).skills
  const scores = skills.map((s, i) => ({ id: s.id, probability: [0.9, 0.1, 0.6, 0.5, 0.49, 0.8][i]! }))
  test("keeps relevant skills by score, in catalog order, up to the maximum", () => {
    expect(selectSkills(skills, scores, new Set(), 3)).toEqual(["skill-0", "skill-2", "skill-5"])
    expect(selectSkills(skills, scores, new Set(), 2)).toEqual(["skill-0", "skill-5"])
  })
  test("applies the central threshold", () => {
    expect(SKILL_RELEVANCE_THRESHOLD).toBe(0.5)
    expect(selectSkills(skills, scores, new Set(), 6)).toEqual(["skill-0", "skill-2", "skill-3", "skill-5"])
  })
  test("named skills are always selected and do not use up the maximum", () => {
    expect(selectSkills(skills, scores, new Set(["skill-1"]), 1)).toEqual(["skill-0", "skill-1"])
  })
})

describe("skill handler (shadow)", () => {
  test("evaluates once per session and latest user, in chunks of 16 questions, and records the selection", async () => {
    const { runtime, requests, records } = fakeRuntime((id) => (id === "skill-3" || id === "skill-17" ? 0.9 : 0.1))
    const handler = createSkillsHandler(runtime, options())
    const event = contextEvent("fix the parser", skillBlock(20))
    handler(event)
    handler(event)
    await settle(runtime)
    handler(event)
    await settle(runtime)
    expect(requests.length).toBe(2)
    expect(Object.keys(requests[0]!.questions).length).toBe(16)
    expect(Object.keys(requests[1]!.questions).length).toBe(4)
    const first = requests[0]!.state as { request: string; skills: Array<{ id: string; description: string }> }
    expect(first.request).toBe("fix the parser")
    expect(first.skills.length).toBe(16)
    expect(first.skills[0]).toEqual({ id: "skill-0", description: "Does thing 0 & more" })
    expect((requests[1]!.state as { skills: unknown[] }).skills.length).toBe(4)
    expect(requests[0]!.timeoutMs).toBe(800)
    const summary = records.find((r) => r.score !== undefined)!
    expect(summary).toMatchObject({ point: "skillPruning", mode: "shadow", applied: false, score: 2, skillSetChanged: false, model: "jev-1.14.0" })
    expect(summary.inputChars).toBeGreaterThan(summary.outputChars!)
    expect(selectedHashes(records)).toEqual([hashName("skill-3"), hashName("skill-17")])
    expect(records.some((r) => "choice" in r)).toBe(false)
    expect(JSON.stringify(records)).not.toContain("fix the parser")
    expect(JSON.stringify(records)).not.toContain("skill-3")
  })

  test("names skills in the instructions, keeps ids out of question ids, and puts descriptions in the state", async () => {
    const { runtime, requests } = fakeRuntime()
    createSkillsHandler(runtime, options())(contextEvent("hello there", skillBlock(5)))
    await settle(runtime)
    const [id, question] = Object.entries(requests[0]!.questions)[0]!
    expect(id).toBe("s0")
    expect(question.instructions).toContain('"skill-0"')
    expect(question.instructions).not.toContain("Does thing 0")
    expect(JSON.stringify(requests[0]!.state)).toContain("Does thing 0 & more")
  })

  test("an opaque active key that crosses the 2000 character cap leaves no piece in the state", async () => {
    const key = "ts-opaque-key-0123456789abcdefghijklmnop"
    const text = `${"a ".repeat(992)}${key} tail`
    expect(text.indexOf(key)).toBe(1984)
    const { runtime, requests } = fakeRuntime(undefined, undefined, [key])
    createSkillsHandler(runtime, options())(contextEvent(text, skillBlock(8)))
    await settle(runtime)
    const sent = (requests[0]!.state as { request: string }).request
    expect(sent).toContain("[REDACTED]")
    expect(sent).not.toContain("ts-opaque")
    expect(sent).not.toContain("0123456")
    expect(sent.length).toBeLessThanOrEqual(2000)
    // Control: without the literal key, the sliced request would carry a piece of it.
    expect(text.slice(0, 2000)).toContain("ts-opaque-key-01")
  })

  test("a private key block that starts before the cap is redacted whole", async () => {
    const block = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(3000)}\n-----END PRIVATE KEY-----`
    const { runtime, requests } = fakeRuntime()
    createSkillsHandler(runtime, options())(contextEvent(`${"x ".repeat(900)}${block}`, skillBlock(8)))
    await settle(runtime)
    const sent = (requests[0]!.state as { request: string }).request
    expect(sent).not.toContain("BEGIN PRIVATE KEY")
    expect(sent).not.toContain("AAAA")
  })

  test("a known secret that crosses the 240 character description cap is redacted first", async () => {
    const secret = "sk-test-not-a-real-key-0123456789abcdef"
    const description = `${"d".repeat(225)} ${secret} end`
    const text = `<available_skills>${Array.from({ length: 8 }, (_, i) => `<skill><id>s-${i}</id><description>${i === 0 ? description : "plain"}</description></skill>`).join("")}</available_skills>`
    const { runtime, requests } = fakeRuntime()
    createSkillsHandler(runtime, options())(contextEvent("hello there", text))
    await settle(runtime)
    const first = (requests[0]!.state as { skills: Array<{ description: string }> }).skills[0]!.description
    expect(first).not.toContain("sk-")
    expect(first).not.toContain("0123")
    expect(first.length).toBeLessThanOrEqual(240)
    expect(describeSkill(`${"d".repeat(235)} ${secret}`, [])).not.toContain("sk-")
    const key = "opaque-active-key-abcdefghij"
    expect(describeSkill(`${"d".repeat(235)}${key}`, [key])).toBe(`${"d".repeat(235)}[REDACTED]`.slice(0, 240))
  })

  test("an opaque active key longer than 8000 characters that starts inside the first 240 leaves no prefix in the state", async () => {
    const key = `ts-opaque-${"k".repeat(9000)}`
    const text = `<available_skills>${Array.from({ length: 8 }, (_, i) => `<skill><id>s-${i}</id><description>${i === 0 ? `${"d".repeat(100)} ${key} end` : "plain"}</description></skill>`).join("")}</available_skills>`
    const { runtime, requests } = fakeRuntime(undefined, undefined, [key])
    createSkillsHandler(runtime, options())(contextEvent("hello there", text))
    await settle(runtime)
    const sent = JSON.stringify(requests[0]!.state)
    expect(sent).not.toContain("ts-opaque")
    expect(sent).not.toContain("kkkkkkkk")
    expect((requests[0]!.state as { skills: Array<{ description: string }> }).skills[0]!.description).toBe(`${"d".repeat(100)} [REDACTED] end`)
  })

  test("a stale result neither records nor changes the session state", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let first = true
    const { runtime, records } = fakeRuntime((id) => (id === "skill-1" ? 0.9 : 0.1), async (request) => {
      const wait = first
      first = false
      if (wait) await gate
      const answers: Record<string, { type: "noul"; noul: number }> = {}
      for (const name of Object.keys(request.questions)) answers[name] = { type: "noul", noul: name === "s2" ? 0.9 : 0.1 }
      return { ok: true, value: { model: "jev-1.14.0", requestedModel: "jev-1.14.0", answers, cached: false, latencyMs: 1 } }
    })
    const handler = createSkillsHandler(runtime, options())
    handler(contextEvent("old request", skillBlock(8), "m1"))
    handler(contextEvent("new request", skillBlock(8), "m2"))
    await Bun.sleep(5)
    release()
    await settle(runtime)
    const summaries = records.filter((r) => r.score !== undefined)
    expect(summaries.length).toBe(1)
    expect(summaries[0]!.skillSetChanged).toBe(false)
    expect(selectedHashes(records)).toEqual([hashName("skill-2")])
  })

  test("a task that capacity rejects does not mark the request as seen", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { runtime, requests } = fakeRuntime(undefined, async () => {
      await gate
      return { ok: false, error: { code: "timeout" } }
    }, [], 1)
    const handler = createSkillsHandler(runtime, options())
    handler({ ...contextEvent("one", skillBlock(8), "m1"), sessionID: "a" })
    handler({ ...contextEvent("two", skillBlock(8), "m1"), sessionID: "b" })
    await Bun.sleep(3)
    expect(requests.length).toBe(1)
    release()
    await settle(runtime)
    handler({ ...contextEvent("two", skillBlock(8), "m1"), sessionID: "b" })
    await settle(runtime)
    expect(requests.length).toBe(2)
  })

  test("a new user message evaluates again and reports a changed set; the same set is not changed", async () => {
    let favorite = "skill-1"
    const { runtime, records } = fakeRuntime((id) => (id === favorite ? 0.9 : 0.1))
    const handler = createSkillsHandler(runtime, options())
    handler(contextEvent("first", skillBlock(8), "m1"))
    await settle(runtime)
    handler(contextEvent("second", skillBlock(8), "m2"))
    await settle(runtime)
    favorite = "skill-4"
    handler(contextEvent("third", skillBlock(8), "m3"))
    await settle(runtime)
    const summaries = records.filter((r) => r.score !== undefined)
    expect(summaries.map((r) => r.skillSetChanged)).toEqual([false, false, true])
  })

  test("uses a fingerprint when the user message has no id", async () => {
    const { runtime, requests } = fakeRuntime()
    const handler = createSkillsHandler(runtime, options())
    handler(contextEvent("same text", skillBlock(8), null))
    await settle(runtime)
    handler(contextEvent("same text", skillBlock(8), null))
    await settle(runtime)
    handler(contextEvent("other text", skillBlock(8), null))
    await settle(runtime)
    expect(requests.length).toBe(2)
  })

  test("a named skill is selected even when its probability is low", async () => {
    const { runtime, records } = fakeRuntime(() => 0.01)
    createSkillsHandler(runtime, options())(contextEvent("use @skill-6 now", skillBlock(8)))
    await settle(runtime)
    expect(selectedHashes(records)).toEqual([hashName("skill-6")])
  })

  test("never edits the event", async () => {
    const { runtime } = fakeRuntime(() => 0.9)
    const event = contextEvent("fix it", skillBlock(12))
    const before = JSON.stringify(event)
    createSkillsHandler(runtime, options())(event)
    await settle(runtime)
    expect(JSON.stringify(event)).toBe(before)
  })

  test("skips a small catalog, no catalog, off mode, and no user text", async () => {
    const { runtime, requests } = fakeRuntime()
    const handler = createSkillsHandler(runtime, options())
    handler(contextEvent("x", skillBlock(3)))
    handler(contextEvent("x", "no skills here"))
    handler({ ...contextEvent("x"), messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] })
    createSkillsHandler(runtime, options({ mode: "off" }))(contextEvent("x"))
    await settle(runtime)
    expect(requests).toEqual([])
  })

  test("a failed call records the error code and no selection", async () => {
    const { runtime, records } = fakeRuntime(undefined, () => ({ ok: false, error: { code: "timeout" } }))
    createSkillsHandler(runtime, options())(contextEvent("x", skillBlock(8)))
    await settle(runtime)
    expect(records).toEqual([{ point: "skillPruning", mode: "shadow", sessionID: "ses_1", applied: false, errorCode: "timeout" }])
  })

  test("returns before the upstream call finishes", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { runtime, requests, records } = fakeRuntime(undefined, async () => {
      await gate
      return { ok: false, error: { code: "timeout" } }
    })
    createSkillsHandler(runtime, options())(contextEvent("x", skillBlock(8)))
    expect(runtime.tasks.size).toBe(1)
    await Bun.sleep(3)
    expect(requests.length).toBe(1)
    expect(records).toEqual([])
    release()
    await settle(runtime)
    expect(records.length).toBe(1)
  })

  test("tasks are cancelled on dispose and record nothing afterwards", async () => {
    let aborted = false
    const { runtime, records, state } = fakeRuntime(undefined, (request) => new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => {
        aborted = true
        resolve({ ok: false, error: { code: "aborted" } })
      })
    }))
    createSkillsHandler(runtime, options())(contextEvent("x", skillBlock(8)))
    await Bun.sleep(3)
    state.disposed = true
    runtime.tasks.dispose()
    await Bun.sleep(5)
    expect(aborted).toBe(true)
    expect(records).toEqual([])
  })

  test("bookkeeping stays bounded across many sessions", async () => {
    const { runtime, requests } = fakeRuntime()
    const handler = createSkillsHandler(runtime, options())
    for (let i = 0; i < 400; i++) {
      handler({ ...contextEvent("same", skillBlock(8), "m1"), sessionID: `ses_${i}` })
      await settle(runtime)
    }
    expect(requests.length).toBe(400)
    // The oldest session was evicted, so it evaluates again.
    handler({ ...contextEvent("same", skillBlock(8), "m1"), sessionID: "ses_0" })
    await settle(runtime)
    expect(requests.length).toBe(401)
  })

  test("a throwing event does not throw", () => {
    const { runtime } = fakeRuntime()
    const handler = createSkillsHandler(runtime, options())
    const hostile = {
      sessionID: "s",
      get messages(): unknown {
        throw new Error("boom")
      },
    }
    expect(() => handler(hostile as never)).not.toThrow()
    void createHash
  })
})
