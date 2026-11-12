import { describe, expect, test } from "bun:test"
import {
  emptyGuardStore,
  isExpired,
  LIMITS,
  parseGuardStore,
  parseGuardStoreText,
  parseLifecycleLine,
  parseRuntimeReport,
  sanitizeMessage,
  validateGuardDraft,
  validateRule,
  DEFAULT_DENY_MESSAGE,
} from "../../../src/guards/schema.ts"
import { activation, guard, storeOf, commitRule, T0 } from "./helpers.ts"

const draft = { label: "No commits", summary: "Blocks git commit", request: "do not commit", message: "No commits here", rules: [commitRule] }

describe("validateGuardDraft", () => {
  test("accepts a valid draft", () => {
    const result = validateGuardDraft(draft)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.rules).toEqual([{ kind: "command", program: "git", subcommands: [["commit"]] }])
  })
  test("rejects unknown fields at every level", () => {
    expect(validateGuardDraft({ ...draft, extra: 1 }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, rules: [{ ...commitRule, regex: ".*" }] }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, rules: [{ kind: "permission", action: "edit", pattern: "x" }] }).ok).toBe(false)
  })
  test("rejects missing fields, empty rules, and wrong kinds", () => {
    expect(validateGuardDraft({ ...draft, label: undefined }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, rules: [] }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, rules: [{ kind: "sql", query: "select 1" }] }).ok).toBe(false)
    expect(validateGuardDraft("text").ok).toBe(false)
    expect(validateGuardDraft(null).ok).toBe(false)
  })
  test("bounds arrays and text", () => {
    const rule = (n: number) => ({ kind: "permission", action: `a${n}` })
    expect(validateGuardDraft({ ...draft, rules: Array.from({ length: LIMITS.array }, (_, n) => rule(n)) }).ok).toBe(true)
    expect(validateGuardDraft({ ...draft, rules: Array.from({ length: LIMITS.array + 1 }, (_, n) => rule(n)) }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, label: "x".repeat(LIMITS.label + 1) }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, message: "x".repeat(LIMITS.message + 1) }).ok).toBe(false)
    expect(validateGuardDraft({ ...draft, label: "bad\u0000" }).ok).toBe(false)
    const tooMany = { kind: "command", program: "git", flags: Array.from({ length: 17 }, (_, i) => `--f${i}`) }
    expect(validateRule(tooMany).ok).toBe(false)
  })
  test("rule contents are literal data, not code", () => {
    expect(validateRule({ kind: "command", program: "git; rm -rf /" }).ok).toBe(false)
    expect(validateRule({ kind: "command", program: "/usr/bin/git" }).ok).toBe(false)
    expect(validateRule({ kind: "command", program: "git", subcommands: [["commit; ls"]] }).ok).toBe(false)
    expect(validateRule({ kind: "command", program: "git", subcommands: [[]] }).ok).toBe(false)
    expect(validateRule({ kind: "command", program: "git", flags: ["commit"] }).ok).toBe(false)
    expect(validateRule({ kind: "permission", action: "Edit" }).ok).toBe(false)
    expect(validateRule({ kind: "permission", action: "edit", resources: ["***"] }).ok).toBe(false)
    expect(validateRule({ kind: "permission", action: "edit", resources: ["/a/**/*.ts"] }).ok).toBe(true)
  })
})

describe("parseGuardStore", () => {
  const good = storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "ses_1")])
  test("round-trips a valid store", () => {
    const parsed = parseGuardStore(JSON.parse(JSON.stringify(good)))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(good)
  })
  test("empty store", () => {
    expect(parseGuardStore(emptyGuardStore()).ok).toBe(true)
  })
  test("rejects unknown fields, wrong schema, duplicates, and bad timestamps", () => {
    expect(parseGuardStore({ ...good, extra: 1 }).ok).toBe(false)
    expect(parseGuardStore({ ...good, schema: "td-guards/2" }).ok).toBe(false)
    expect(parseGuardStore({ ...good, revision: -1 }).ok).toBe(false)
    expect(parseGuardStore({ ...good, revision: 1.5 }).ok).toBe(false)
    expect(parseGuardStore({ ...good, guards: [good.guards[0], good.guards[0]] }).ok).toBe(false)
    expect(parseGuardStore({ ...good, activations: [{ ...good.activations[0], scope: "forever" }] }).ok).toBe(false)
    expect(parseGuardStore({ ...good, activations: [{ ...good.activations[0], createdAt: "yesterday" }] }).ok).toBe(false)
    expect(parseGuardStore({ ...good, activations: [{ ...good.activations[0], extra: 1 }] }).ok).toBe(false)
  })
  test("optional snapshot and operations", () => {
    const withSnapshot = {
      ...good,
      activations: [{ ...good.activations[0], guardUpdatedAt: T0, snapshot: { label: "l", message: "m", rules: [commitRule] } }],
      operations: [{ opId: "op-1", result: { ok: true } }],
    }
    expect(parseGuardStore(withSnapshot).ok).toBe(true)
    expect(parseGuardStore({ ...withSnapshot, activations: [{ ...withSnapshot.activations[0], snapshot: { label: "l", message: "m", rules: [commitRule], x: 1 } }] }).ok).toBe(false)
  })
  test("bounds the collections and the file", () => {
    const many = Array.from({ length: LIMITS.guards + 1 }, (_, n) => guard(`g${n}`, [commitRule]))
    expect(parseGuardStore({ ...good, guards: many }).ok).toBe(false)
    expect(parseGuardStoreText("x".repeat(LIMITS.storeBytes + 1)).ok).toBe(false)
    expect(parseGuardStoreText("{not json").ok).toBe(false)
  })
})

describe("runtime report and lifecycle parsers", () => {
  const report = {
    schema: "td-guards-runtime/1",
    directory: "/p",
    instanceId: "i1",
    registered: true,
    recordedAt: T0,
    storeState: "ready",
    revision: 3,
    blockedCount: 0,
    uncertainCount: 0,
    coveredActions: ["shell"],
    sessions: [{ id: "ses_1", parentId: null, activity: "idle" }],
  }
  test("runtime report", () => {
    expect(parseRuntimeReport(report).ok).toBe(true)
    expect(parseRuntimeReport({ ...report, directory: null, revision: null }).ok).toBe(true)
    expect(parseRuntimeReport({ ...report, extra: 1 }).ok).toBe(false)
    expect(parseRuntimeReport({ ...report, storeState: "weird" }).ok).toBe(false)
  })
  test("lifecycle line parser skips malformed lines", () => {
    const fact = { activationId: "a1", fact: "bound" as const, at: T0, reason: "observed-start" as const, instance: "i1" }
    expect(parseLifecycleLine(JSON.stringify(fact))).toEqual(fact)
    expect(parseLifecycleLine("{broken")).toBeUndefined()
    expect(parseLifecycleLine(JSON.stringify({ ...fact, reason: "free text from the model" }))).toBeUndefined()
    expect(parseLifecycleLine(JSON.stringify({ ...fact, extra: 1 }))).toBeUndefined()
    expect(parseLifecycleLine("")).toBeUndefined()
  })
})

describe("expiry and messages", () => {
  test("expiry is an explicit timestamp", () => {
    expect(isExpired({ expiresAt: null }, Date.parse("2099-01-01T00:00:00Z"))).toBe(false)
    expect(isExpired({ expiresAt: "2026-11-12T10:00:00.000Z" }, Date.parse("2026-11-12T10:00:00.000Z"))).toBe(true)
    expect(isExpired({ expiresAt: "2026-11-12T10:00:01.000Z" }, Date.parse("2026-11-12T10:00:00.000Z"))).toBe(false)
  })
  test("sanitizeMessage bounds and cleans", () => {
    expect(sanitizeMessage("a\nb\u0000c")).toBe("a b c")
    expect(sanitizeMessage("x".repeat(2000)).length).toBe(LIMITS.message)
    expect(sanitizeMessage("   ")).toBe(DEFAULT_DENY_MESSAGE)
    expect(sanitizeMessage(undefined)).toBe(DEFAULT_DENY_MESSAGE)
  })
})
