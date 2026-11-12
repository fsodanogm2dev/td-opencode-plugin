import { describe, expect, test } from "bun:test"
import type { GenerateRequest } from "@openchamber/sdk"

import { createGuardsController, type GuardsState } from "../../panel/guards/controller.ts"
import { GUARD_SYSTEM_PROMPT } from "../../panel/guards/prompt.ts"
import { createGuardService, type GuardService } from "../../panel/guards/service.ts"
import { createFakeGuardService, guard, SESSION } from "../support/guard-service.ts"

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

const DRAFT_TEXT = JSON.stringify({
  draft: {
    label: "Git commits blocked",
    summary: "Blocks git commit.",
    message: "A TD-Plugin guard blocks this. Continue with other work.",
    rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
  },
})

const setup = (options: { service?: GuardService; generate?: (r: GenerateRequest) => Promise<{ text: string }> } = {}) => {
  const fake = createFakeGuardService({ guards: [guard()] })
  const ops: string[] = []
  let n = 0
  const generated: GenerateRequest[] = []
  const states: GuardsState[] = []
  const controller = createGuardsController({
    service: options.service ?? createGuardService({ serviceRequest: async (r) => {
      const answer = await fake.handle(r)
      if ("code" in answer) throw Object.assign(new Error(answer.code), { code: answer.code })
      return answer
    } }),
    generate:
      options.generate ??
      (async (request) => {
        generated.push(request)
        return { text: DRAFT_TEXT }
      }),
    onChange: (state) => states.push(state),
    opId: () => {
      const id = `op-${++n}`
      ops.push(id)
      return id
    },
  })
  return { fake, controller, ops, generated, states }
}

describe("guards controller", () => {
  test("generation runs only on request and the preview is not saved", async () => {
    const { controller, generated, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    expect(generated).toHaveLength(0)
    controller.generate("  block git commits  ")
    expect(controller.state().draft.kind).toBe("generating")
    await flush()
    expect(generated).toEqual([{ prompt: "block git commits", system: GUARD_SYSTEM_PROMPT, maxOutputTokens: 1200 }])
    const draft = controller.state().draft
    expect(draft.kind).toBe("preview")
    if (draft.kind === "preview") expect(draft.draft.request).toBe("block git commits")
    expect(fake.state.guards).toHaveLength(1)
  })

  test("save stores the guard without enabling it", async () => {
    const { controller, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    controller.generate("block git commits")
    await flush()
    controller.save()
    await flush()
    expect(fake.state.guards).toHaveLength(2)
    expect(fake.state.activations).toHaveLength(0)
    expect(controller.state().draft.kind).toBe("idle")
    expect(controller.state().notice).toBe("Guard saved. It is off until you turn it on.")
  })

  test("enable defaults to this session with no end time", async () => {
    const { controller, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    controller.startEnable("g_commits")
    expect(controller.state().enable).toEqual({ guardId: "g_commits", scope: "session", expiry: false, minutes: null })
    controller.confirmEnable()
    await flush()
    expect(fake.state.activations).toEqual([expect.objectContaining({ guardId: "g_commits", sessionId: SESSION, scope: "session", expiresAt: null })])
  })

  test("an automatic end needs an explicit time", async () => {
    const { controller, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    controller.startEnable("g_commits")
    controller.updateEnable({ expiry: true })
    controller.confirmEnable()
    await flush()
    expect(fake.state.activations).toHaveLength(0)
    controller.updateEnable({ minutes: 30, scope: "request" })
    controller.confirmEnable()
    await flush()
    expect(fake.state.activations[0]).toMatchObject({ scope: "request" })
    expect(fake.state.activations[0]?.expiresAt).not.toBeNull()
  })

  test("no session: cannot enable, can still generate", async () => {
    const { controller, generated } = setup()
    controller.setContext({ directory: "/work/p", sessionId: null })
    controller.startEnable("g_commits")
    expect(controller.state().enable).toBeNull()
    controller.generate("block git commits")
    await flush()
    expect(generated).toHaveLength(1)
  })

  test("an unclear answer is retried with the same opId and applied once", async () => {
    const { controller, fake, ops } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    fake.queued.push(fake.applyThenDrop())
    controller.startEnable("g_commits")
    controller.confirmEnable()
    await flush()
    expect(controller.state().ops["enable:g_commits"]).toMatchObject({ status: "unclear", opId: "op-1" })
    expect(fake.state.activations).toHaveLength(1)
    controller.confirmEnable() // A second click does not start a new operation.
    controller.retry("enable:g_commits")
    await flush()
    expect(ops).toEqual(["op-1"])
    expect(fake.state.activations).toHaveLength(1)
    expect(controller.state().ops["enable:g_commits"]).toBeUndefined()
    expect(controller.state().enable).toBeNull()
  })

  test("a 409 is shown and the list is read again", async () => {
    const { controller, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    fake.queued.push(fake.error(409, "GUARD_NOT_FOUND", "The guard does not exist."))
    controller.askDelete("g_commits")
    controller.confirmDelete("g_commits")
    await flush()
    expect(controller.state().ops["delete:g_commits"]).toMatchObject({
      status: "failed",
      failure: { kind: "rejected", status: 409, code: "GUARD_NOT_FOUND" },
    })
    // A new click after a refusal gets a new opId.
    controller.confirmDelete("g_commits")
    await flush()
    expect(fake.state.guards).toHaveLength(0)
  })

  test("a 503 on the first read shows an error state", async () => {
    const { controller, fake } = setup()
    fake.queued.push(fake.error(503, "STORE_UNAVAILABLE", "The guard store cannot be read or written."))
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    expect(controller.state().load).toMatchObject({ kind: "error", failure: { status: 503, code: "STORE_UNAVAILABLE" } })
  })

  test("answers for an earlier location or session are dropped", async () => {
    const pending: Array<{ query: Record<string, string> | undefined; resolve: (v: { status: number; body: string }) => void }> = []
    const service = createGuardService({
      serviceRequest: (request) => new Promise((resolve) => pending.push({ query: request.query, resolve })),
    })
    const { controller } = setup({ service })
    const answer = (revision: number) => ({
      status: 200,
      body: JSON.stringify({ ok: true, data: { revision, guards: [], activations: [], runtime: null, lifecycle: [] } }),
    })
    controller.setContext({ directory: "/a", sessionId: "s1" })
    controller.setContext({ directory: "/b", sessionId: "s1" })
    controller.setContext({ directory: "/b", sessionId: "s2" })
    pending[2]!.resolve(answer(3))
    await flush()
    pending[0]!.resolve(answer(1))
    pending[1]!.resolve(answer(2))
    await flush()
    const load = controller.state().load
    expect(load.kind === "ready" && load.data.revision).toBe(3)
    expect(pending.map((p) => p.query)).toEqual([
      { sessionId: "s1", directory: "/a" },
      { sessionId: "s1", directory: "/b" },
      { sessionId: "s2", directory: "/b" },
    ])
  })

  test("a read older than our own change is read again", async () => {
    const { controller, fake } = setup()
    controller.setContext({ directory: "/work/p", sessionId: SESSION })
    await flush()
    const stale = JSON.stringify({ ok: true, data: { revision: 0, guards: [], activations: [], runtime: null, lifecycle: [] } })
    fake.queued.push(fake.pass, { status: 200, body: stale })
    controller.startEnable("g_commits")
    controller.confirmEnable()
    await flush(10)
    expect(fake.state.activations).toHaveLength(1)
    const load = controller.state().load
    expect(load.kind === "ready" && load.data.revision).toBe(1)
  })

  test("a late answer to this panel's prompt becomes a preview", async () => {
    const { controller } = setup()
    controller.lateGeneration({ request: { prompt: "something else", system: "other" }, ok: true, result: { text: DRAFT_TEXT } })
    expect(controller.state().draft.kind).toBe("idle")
    controller.lateGeneration({ request: { prompt: "block git commits", system: GUARD_SYSTEM_PROMPT }, ok: true, result: { text: DRAFT_TEXT } })
    expect(controller.state().draft).toMatchObject({ kind: "preview", late: true, request: "block git commits" })
  })

  test("model failures and unsupported requests are explained, not saved", async () => {
    const failing = setup({ generate: async () => Promise.reject(Object.assign(new Error("x"), { code: "NO_MODEL" })) })
    failing.controller.generate("block git commits")
    await flush()
    expect(failing.controller.state().draft).toEqual({ kind: "failed", request: "block git commits", code: "NO_MODEL" })
    const unsupported = setup({ generate: async () => ({ text: JSON.stringify({ unsupported: "Guards cannot check the time." }) }) })
    unsupported.controller.generate("block commits after 5pm")
    await flush()
    expect(unsupported.controller.state().draft).toMatchObject({ kind: "unsupported", reason: "Guards cannot check the time." })
    unsupported.controller.save()
    await flush()
    expect(unsupported.fake.state.guards).toHaveLength(1)
  })
})
