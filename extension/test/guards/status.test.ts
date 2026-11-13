/** The Work Status section against a fake host and an in-memory guard service. */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://status.test/" })
  ;(globalThis as { __TD_STATUS_NO_AUTOSTART__?: boolean }).__TD_STATUS_NO_AUTOSTART__ = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

import type { StatusSection } from "../../panel/status.ts"
import { NOW, PROJECT } from "../support/fixtures.ts"
import { CHILD, createFakeGuardService, guard, iso, runtime, SESSION, type FakeState } from "../support/guard-service.ts"
import { clickButton, connectMock, text, tick } from "../support/harness.ts"

let section: StatusSection | null = null
afterEach(() => {
  section?.dispose()
  section = null
})

const ACTIVE = { id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session" as const, createdAt: iso(-1000), expiresAt: null }

const start = async (state: Partial<FakeState>, session: string | null = SESSION) => {
  const { startStatus } = await import("../../panel/status.ts")
  document.body.innerHTML = '<main id="status-root"></main>'
  const root = document.getElementById("status-root") as HTMLElement
  const { host, mock } = connectMock()
  const fake = createFakeGuardService(state)
  mock.setService((call) => fake.handle(call))
  mock.setSurface("status")
  mock.setSession(session ? { id: session, title: "Chat", busy: false } : null)
  section = startStatus({ root, host, pollMs: 60_000, now: () => NOW, opId: () => "op-1" })
  mock.ready(PROJECT)
  await tick(10)
  return { root, mock, fake }
}

describe("status section", () => {
  test("shows the active guard with Release, and nothing to create or generate", async () => {
    const { root, mock, fake } = await start({ guards: [guard()], activations: [ACTIVE] })
    expect(text(root)).toContain("Git commits blocked")
    expect(text(root)).toContain("this session")
    expect(root.querySelectorAll("button")).toHaveLength(1)
    expect(root.querySelector("textarea, input")).toBeNull()
    expect(mock.heights.length).toBeGreaterThan(0)
    clickButton(root, "Release")
    await tick(10)
    expect(fake.state.activations).toHaveLength(0)
    expect(text(root)).toContain("No guards active in this session.")
    expect(mock.generateCalls).toHaveLength(0)
    expect(mock.sent).not.toContain("generate")
  })

  test("an ended request guard is not shown as blocking", async () => {
    const { root } = await start({
      guards: [guard()],
      activations: [{ ...ACTIVE, scope: "request" }],
      lifecycle: [
        { activationId: "a_1", fact: "bound", at: iso(), reason: "running-tracked", instance: "inst_1" },
        { activationId: "a_1", fact: "ended", at: iso(), reason: "request-completed", instance: "inst_1" },
      ],
    })
    expect(text(root)).not.toContain("Git commits blocked")
    expect(text(root)).toContain("No guards active in this session.")
  })

  test("inherited guard in a subagent", async () => {
    const { root } = await start({ guards: [guard()], activations: [ACTIVE] }, CHILD)
    expect(text(root)).toContain("from parent session")
  })

  test("says Not enforced next to an active guard when the plugin reports its hook is not registered", async () => {
    const { root } = await start({ guards: [guard()], activations: [ACTIVE], runtime: runtime({ registered: false }) })
    expect(text(root)).toContain("Git commits blocked")
    expect(text(root)).toContain(
      "Not enforced. The plugin reported that its guard hook was not registered. Check the TD-Plugin installation in OpenCode.",
    )
    expect(text(root)).not.toMatch(/worktree/i)
  })

  test("a missing plugin report next to an active guard stays not confirmed", async () => {
    const { root } = await start({ guards: [guard()], activations: [ACTIVE], runtime: null })
    expect(text(root)).toContain("Enforcement not confirmed. No guard status report was found for this session’s location.")
    expect(text(root)).not.toContain("Not enforced")
    expect(text(root)).not.toMatch(/worktree/i)
  })

  test("service errors are not shown as no guards", async () => {
    const { root, fake } = await start({ guards: [guard()], activations: [ACTIVE] })
    void fake
    expect(text(root)).not.toContain("Guard status unknown")
    const { startStatus } = await import("../../panel/status.ts")
    section?.dispose()
    document.body.innerHTML = '<main id="status-root"></main>'
    const root2 = document.getElementById("status-root") as HTMLElement
    const { host, mock } = connectMock()
    mock.setService(() => ({ code: "NO_SERVICE" }))
    mock.setSession({ id: SESSION, title: "Chat", busy: false })
    section = startStatus({ root: root2, host, pollMs: 60_000, now: () => NOW })
    mock.ready(PROJECT)
    await tick(10)
    expect(text(root2)).toContain("Guard status unknown")
    expect(text(root2)).not.toContain("No guards active")
  })
})
