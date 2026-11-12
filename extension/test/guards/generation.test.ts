import { describe, expect, test } from "bun:test"
import { GUEST_GENERATE_SYSTEM_MAX } from "@openchamber/sdk"

import { generationRequest, readGeneration, REQUEST_MAX } from "../../panel/guards/generation.ts"
import { GUARD_SYSTEM_PROMPT } from "../../panel/guards/prompt.ts"

const REQUEST = "block git commits"
const draft = (patch: Record<string, unknown> = {}) => ({
  label: "Git commits blocked",
  summary: "Blocks git commit.",
  message: "A TD-Plugin guard set by the user blocks this. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
  ...patch,
})

describe("guard generation", () => {
  test("the request is only the user's text, with the guard prompt as system text", () => {
    const request = generationRequest(REQUEST)
    expect(request.prompt).toBe(REQUEST)
    expect(request.system).toBe(GUARD_SYSTEM_PROMPT)
    expect(request.maxOutputTokens).toBeLessThanOrEqual(4000)
  })

  test("the system prompt fits the host limit and names the real shell action", () => {
    expect(GUARD_SYSTEM_PROMPT.length).toBeLessThanOrEqual(GUEST_GENERATE_SYSTEM_MAX)
    expect(GUARD_SYSTEM_PROMPT).toContain("shell, edit, write, patch, subagent")
    expect(GUARD_SYSTEM_PROMPT).not.toContain("bash")
    expect(GUARD_SYSTEM_PROMPT).toContain("only: not merge, rebase, push")
    expect(GUARD_SYSTEM_PROMPT).toContain('"unsupported"')
    expect(REQUEST_MAX).toBeGreaterThan(100)
  })

  test("a valid answer becomes a draft with the user's exact request", () => {
    const outcome = readGeneration(REQUEST, JSON.stringify({ draft: draft({ request: "block everything" }) }))
    // The model may not send its own request field; the strict validator refuses unknown or replaced fields only after
    // the panel writes the user's text over it.
    expect(outcome.kind).toBe("draft")
    if (outcome.kind !== "draft") return
    expect(outcome.draft.request).toBe(REQUEST)
    expect(outcome.draft.rules).toEqual([{ kind: "command", program: "git", subcommands: [["commit"]] }])
  })

  test("a fenced answer is read", () => {
    const outcome = readGeneration(REQUEST, "```json\n" + JSON.stringify({ draft: draft() }) + "\n```")
    expect(outcome.kind).toBe("draft")
  })

  test("an unsupported answer keeps the model's reason", () => {
    const outcome = readGeneration("only allow commits after 5pm", JSON.stringify({ unsupported: "Guards cannot check the time of day." }))
    expect(outcome).toEqual({ kind: "unsupported", reason: "Guards cannot check the time of day." })
  })

  test("text that is not JSON is rejected", () => {
    expect(readGeneration(REQUEST, "Sure! I blocked commits.").kind).toBe("invalid")
  })

  test("rules with code, regex, or unknown fields are rejected by the shared validator", () => {
    const regex = readGeneration(REQUEST, JSON.stringify({ draft: draft({ rules: [{ kind: "command", program: "git.*" + "|rm" }] }) }))
    expect(regex.kind).toBe("invalid")
    const script = readGeneration(REQUEST, JSON.stringify({ draft: draft({ rules: [{ kind: "script", code: "return true" }] }) }))
    expect(script.kind).toBe("invalid")
    const extra = readGeneration(REQUEST, JSON.stringify({ draft: draft({ allow: true }) }))
    expect(extra.kind).toBe("invalid")
    if (extra.kind === "invalid") expect(extra.details.join(" ")).toContain("unknown field")
    const empty = readGeneration(REQUEST, JSON.stringify({ draft: draft({ rules: [] }) }))
    expect(empty.kind).toBe("invalid")
  })
})
