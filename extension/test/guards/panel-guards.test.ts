/**
 * The Guards tab against a fake OpenChamber host and an in-memory guard service.
 * No real service, model, session, or file is used.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://panel.test/" })
  ;(globalThis as { __TD_STATUS_NO_AUTOSTART__?: boolean }).__TD_STATUS_NO_AUTOSTART__ = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

import type { Panel } from "../../panel/main.ts"
import { NOW, PROJECT } from "../support/fixtures.ts"
import { CHILD, createFakeGuardService, guard, iso, OTHER_SESSION, runtime, SESSION, type FakeState } from "../support/guard-service.ts"
import { clickButton, connectMock, findButton, text, tick, typeInto } from "../support/harness.ts"

let panel: Panel | null = null
afterEach(() => {
  panel?.dispose()
  panel = null
})

const DRAFT = {
  label: "Git commits blocked",
  summary: "Stops the agent from committing.",
  message: "A TD-Plugin guard set by the user blocks git commit. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
}

const start = async (options: { state?: Partial<FakeState>; session?: string | null; generate?: string } = {}) => {
  const { startPanel } = await import("../../panel/main.ts")
  panel?.dispose()
  document.body.innerHTML = '<main id="root"></main>'
  const root = document.getElementById("root") as HTMLElement
  const { host, mock } = connectMock()
  const fake = createFakeGuardService(options.state ?? { guards: [guard()] })
  mock.setService((call) => fake.handle(call))
  mock.setGenerate(() => ({ text: options.generate ?? JSON.stringify({ draft: { ...DRAFT, request: "ignored" } }) }))
  const session = options.session === undefined ? SESSION : options.session
  mock.setSession(session ? { id: session, title: "Chat", busy: false } : null)
  let n = 0
  panel = startPanel({ root, host, connectTimeoutMs: 10_000, pollMs: 60_000, guardPollMs: 60_000, now: () => NOW, opId: () => `op-${++n}` })
  mock.ready(PROJECT)
  await tick()
  const guards = root.querySelector("#tab-guards") as HTMLElement
  return { root, guards, mock, fake }
}

const mutations = (mock: { serviceCalls: Array<{ method: string; path: string; body?: string }> }) =>
  mock.serviceCalls.filter((c) => c.method !== "GET").map((c) => ({ method: c.method, path: c.path, body: c.body ? JSON.parse(c.body) : null }))

describe("Guards tab", () => {
  test("opens on Guards with the plugin status, the library, and the setup tab", async () => {
    const { root, guards, mock } = await start()
    const tabs = [...root.querySelectorAll("[role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")])
    expect(tabs).toEqual([
      ["Guards", "true"],
      ["Plugin setup", "false"],
    ])
    expect((root.querySelector("#tab-setup") as HTMLElement).hidden).toBe(true)
    expect(root.querySelector(".hdr-title")?.textContent).toBe("TD-Plugin extension")
    expect(text(guards)).toContain("Enforced by the plugin")
    expect(text(guards)).toContain("No guards are active in this session.")
    expect(text(guards)).toContain("Saved guards (1)")
    expect(text(guards)).toContain("Blocks shell command: git commit")
    expect(mock.serviceCalls[0]).toEqual({ method: "GET", path: "/state", query: { sessionId: SESSION, directory: PROJECT } })
    expect(mock.generateCalls).toHaveLength(0)
  })

  test("plain text, Generate, preview, sample test, Save keeps it off", async () => {
    const { guards, mock, fake } = await start({ state: { guards: [] } })
    const input = guards.querySelector("#gd-request") as HTMLTextAreaElement
    expect(findButton(guards, "Generate preview")?.disabled).toBe(true)
    typeInto(input, "block git commits")
    await tick()
    clickButton(guards, "Generate preview")
    await tick(10)
    expect(mock.generateCalls).toHaveLength(1)
    expect(mock.generateCalls[0]?.prompt).toBe("block git commits")
    const preview = guards.querySelector(".gd-draft") as HTMLElement
    const previewText = text(preview)
    // The app's rule text comes before the model's description.
    expect(previewText.indexOf("What it blocks")).toBeLessThan(previewText.indexOf("Model's description"))
    expect(previewText).toContain("Blocks shell command: git commit")
    expect(previewText).toContain("Not saved")

    const tester = preview.querySelector(".gd-tester input") as HTMLInputElement
    typeInto(tester, "git commit -m wip")
    expect(preview.querySelector(".gd-test-result")?.textContent).toBe("Blocked by rule 1: Blocks shell command: git commit")
    typeInto(tester, "git merge main")
    expect(preview.querySelector(".gd-test-result")?.textContent).toBe("Not blocked by this guard.")

    clickButton(preview, "Save guard")
    await tick(10)
    expect(mutations(mock)).toEqual([
      { method: "POST", path: "/guards", body: { opId: "op-1", draft: { ...DRAFT, request: "block git commits" } } },
    ])
    expect(fake.state.activations).toHaveLength(0)
    expect(guards.querySelector(".gd-draft")).toBeNull()
    const card = guards.querySelector(".gd-card") as HTMLElement
    expect(card.querySelector(".gd-pill")?.textContent).toBe("Off")
  })

  test("Enable: session scope, no end time by default, then Release", async () => {
    const { root, guards, mock } = await start()
    clickButton(guards, "Enable…")
    await tick()
    const radios = [...guards.querySelectorAll<HTMLInputElement>(".gd-enable input[type=radio]")]
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ["session", true],
      ["request", false],
    ])
    const expiry = guards.querySelector<HTMLInputElement>(".gd-enable input[type=checkbox]")!
    expect(expiry.checked).toBe(false)
    expect(guards.querySelector(".gd-enable select")).toBeNull()
    clickButton(guards, "Enable guard")
    await tick(10)
    expect(mutations(mock)).toEqual([
      { method: "POST", path: "/activations", body: { opId: "op-1", guardId: "g_commits", sessionId: SESSION, scope: "session" } },
    ])
    const active = guards.querySelector(".gd-active") as HTMLElement
    expect(text(active)).toContain("Git commits blocked")
    expect(text(active)).toContain("This session and its subagents · No end time")
    expect(root.querySelector("[role=tab]")?.textContent).toBe("Guards1")
    clickButton(active, "Release")
    await tick(10)
    expect(mutations(mock)[1]).toMatchObject({ method: "DELETE", path: "/activations/a_1", body: { opId: "op-2" } })
    expect(text(guards)).toContain("No guards are active in this session.")
  })

  test("an automatic end needs a time the user picks", async () => {
    const { guards, mock } = await start()
    clickButton(guards, "Enable…")
    await tick()
    const expiry = guards.querySelector<HTMLInputElement>(".gd-enable input[type=checkbox]")!
    expiry.click()
    await tick()
    const select = guards.querySelector<HTMLSelectElement>(".gd-enable select")!
    expect(select.value).toBe("")
    expect(findButton(guards, "Enable guard")?.disabled).toBe(true)
    select.value = "60"
    select.dispatchEvent(new Event("change"))
    await tick()
    clickButton(guards, "Enable guard")
    await tick(10)
    expect(mutations(mock)[0]?.body).toMatchObject({ scope: "session", expiresInMinutes: 60 })
    expect(text(guards)).toContain("Ends today")
  })

  test("no plugin report: enforcement not confirmed, the active guard stays listed, Enable waits", async () => {
    const { guards } = await start({
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session", createdAt: iso(-1000), expiresAt: null }],
        runtime: null,
      },
    })
    const status = guards.querySelector(".gd-status") as HTMLElement
    expect(status.dataset.tone).toBe("warning")
    expect(text(status)).toContain("Enforcement not confirmed")
    expect(text(status)).toContain("No guard status report was found for this session’s location.")
    expect(text(status)).toContain("this panel cannot confirm it")
    expect(text(status)).toContain("Existing rules may still be active.")
    expect(text(status)).not.toContain("Not enforced")
    expect(text(guards)).toContain("Git commits blocked")
    // Release stays available; Enable waits for a confirmed plugin. Generation stays available.
    expect(findButton(guards.querySelector(".gd-active")!, "Release")?.disabled).toBe(false)
  })

  test("a registered: false report is Not enforced and Enable is off", async () => {
    const { guards } = await start({ state: { guards: [guard()], runtime: runtime({ registered: false }) } })
    const status = guards.querySelector(".gd-status") as HTMLElement
    expect(status.dataset.tone).toBe("error")
    expect(text(status)).toContain("Not enforced")
    expect(text(status)).toContain("The plugin reported that its guard hook was not registered. Check the TD-Plugin installation in OpenCode.")
    expect(text(status)).not.toMatch(/worktree/i)
    expect(findButton(guards, "Enable…")?.disabled).toBe(true)
    expect(text(guards)).toContain("Enable is available when the plugin confirms enforcement here.")
    expect(findButton(guards, "Generate preview")).not.toBeNull()
  })

  test("a stale report is not confirmed", async () => {
    const { guards } = await start({ state: { guards: [guard()], runtime: runtime({ recordedAt: iso(-120_000) }) } })
    expect(text(guards.querySelector(".gd-status")!)).toContain("has not reported for more than a minute")
  })

  test("a subagent shows the inherited request guard and its uncertain end", async () => {
    const { guards } = await start({
      session: CHILD,
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "request", createdAt: iso(-1000), expiresAt: null }],
        lifecycle: [{ activationId: "a_1", fact: "uncertain", at: iso(), reason: "run-start-unobserved", instance: "inst_1" }],
      },
    })
    const active = text(guards.querySelector(".gd-active")!)
    expect(active).toContain("This request and its subagents · turned on in a parent session")
    expect(active).toContain("stays on until you release it")
    expect(active).toContain("Release turns it off for the parent session and all its subagents.")
  })

  test("the service's verified chain shows an inherited guard even when the plugin is not reporting", async () => {
    const { guards } = await start({
      session: CHILD,
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session", createdAt: iso(-1000), expiresAt: null }],
        runtime: runtime({ recordedAt: iso(-300_000) }),
      },
    })
    expect(text(guards.querySelector(".gd-status")!)).toContain("Enforcement not confirmed")
    expect(text(guards.querySelector(".gd-active")!)).toContain("turned on in a parent session")
  })

  test("an unreported session does not claim that no guard applies", async () => {
    const { guards } = await start({
      session: "ses_unreported",
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: OTHER_SESSION, scope: "session", createdAt: iso(-1000), expiresAt: null }],
      },
    })
    expect(text(guards)).toContain("1 guard is active in other sessions and may apply here")
  })

  test("no session: Enable is off, generation still works", async () => {
    const { guards } = await start({ session: null })
    expect(findButton(guards, "Enable…")?.disabled).toBe(true)
    expect(text(guards)).toContain("Open a chat session to enable a guard.")
    expect(findButton(guards, "Generate preview")).not.toBeNull()
  })

  test("delete asks first, warns when active, and shows a 409", async () => {
    const { guards, fake } = await start({
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: OTHER_SESSION, scope: "session", createdAt: iso(-1000), expiresAt: null }],
      },
    })
    clickButton(guards, "Delete")
    await tick()
    expect(text(guards)).toContain('Delete "Git commits blocked"? This cannot be undone.')
    expect(text(guards)).toContain("This guard is active. Deleting it releases it everywhere.")
    fake.queued.push(fake.error(409, "GUARD_NOT_FOUND", "The guard does not exist."))
    clickButton(guards, "Delete guard")
    await tick(10)
    expect(text(guards)).toContain("The guard was not deleted")
    expect(text(guards)).toContain("The guard does not exist.")
  })

  test("delete does not warn about a request guard that the service proves ended", async () => {
    const row = { id: "a_done", guardId: "g_commits", sessionId: OTHER_SESSION, scope: "request" as const, createdAt: iso(-1000), expiresAt: null }
    const view = (patch: Record<string, unknown>) => ({
      activationId: "a_done",
      phase: "ended",
      reason: "request-completed",
      instance: "inst_1",
      releasable: true,
      conflict: false,
      trust: "ok",
      ...patch,
    })
    const done = await start({ state: { guards: [guard()], activations: [row], lifecycles: [view({})] } as never })
    clickButton(done.guards, "Delete")
    await tick()
    expect(text(done.guards)).toContain('Delete "Git commits blocked"? This cannot be undone.')
    expect(text(done.guards)).not.toContain("This guard is active.")
    // A row whose end is not proven still warns.
    const open = await start({ state: { guards: [guard()], activations: [row], lifecycles: [view({ phase: "uncertain", releasable: false })] } as never })
    clickButton(open.guards, "Delete")
    await tick()
    expect(text(open.guards)).toContain("This guard is active. Deleting it releases it everywhere.")
  })

  test("a 503 on the first read says the status is unknown", async () => {
    const { startPanel } = await import("../../panel/main.ts")
    document.body.innerHTML = '<main id="root"></main>'
    const root = document.getElementById("root") as HTMLElement
    const { host, mock } = connectMock()
    mock.setService(() => ({ status: 503, body: JSON.stringify({ ok: false, error: { code: "STORE_CORRUPT", message: "The guard store file is not valid. The service did not change it." } }) }))
    panel = startPanel({ root, host, connectTimeoutMs: 10_000, pollMs: 60_000, guardPollMs: 60_000, now: () => NOW })
    mock.ready(PROJECT)
    await tick()
    const status = text(root.querySelector(".gd-status")!)
    expect(status).toContain("Guard status unknown")
    expect(status).toContain("The guard store file is not valid.")
  })

  test("an unclear answer offers Try again with the same operation", async () => {
    const { guards, mock, fake } = await start()
    fake.queued.push(fake.applyThenDrop())
    clickButton(guards, "Enable…")
    await tick()
    clickButton(guards, "Enable guard")
    await tick(10)
    expect(text(guards)).toContain("No clear answer")
    clickButton(guards, "Try again")
    await tick(10)
    const posts = mutations(mock).filter((m) => m.path === "/activations")
    expect(posts.map((p) => p.body.opId)).toEqual(["op-1", "op-1"])
    expect(fake.state.activations).toHaveLength(1)
  })

  test("a rejected draft is explained and nothing is saved", async () => {
    const { guards, mock } = await start({
      generate: JSON.stringify({ draft: { ...DRAFT, rules: [{ kind: "command", program: "/usr/bin/git" }] } }),
    })
    typeInto(guards.querySelector("#gd-request") as HTMLTextAreaElement, "block git")
    clickButton(guards, "Generate preview")
    await tick(10)
    expect(text(guards)).toContain("The proposed guard was rejected")
    expect(findButton(guards, "Save guard")).toBeNull()
    expect(mutations(mock)).toEqual([])
  })

  test("guard text is shown as text, never as HTML", async () => {
    const { guards } = await start({ state: { guards: [guard({ label: '<img src=x onerror="alert(1)">', summary: "<b>bold</b>" })] } })
    expect(guards.querySelector("img")).toBeNull()
    expect(guards.querySelector("b")).toBeNull()
    expect(text(guards)).toContain('<img src=x onerror="alert(1)">')
  })

  test("the panel never sends prompts, composes, or starts sessions", async () => {
    const { guards, mock } = await start()
    typeInto(guards.querySelector("#gd-request") as HTMLTextAreaElement, "block git commits")
    clickButton(guards, "Generate preview")
    await tick(10)
    clickButton(guards, "Save guard")
    await tick(10)
    clickButton(guards.querySelector(".gd-card")!, "Enable…")
    await tick()
    clickButton(guards, "Enable guard")
    await tick(10)
    const forbidden = ["prompt", "compose", "start-session", "session-link", "attach", "file-write"]
    expect(mock.sent.filter((type) => forbidden.includes(type))).toEqual([])
  })

  test("the Plugin setup tab keeps the saved report", async () => {
    const { root } = await start()
    const setupTab = [...root.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent === "Plugin setup")!
    setupTab.click()
    await tick()
    expect((root.querySelector("#tab-setup") as HTMLElement).hidden).toBe(false)
    expect((root.querySelector("#tab-guards") as HTMLElement).hidden).toBe(true)
    expect(text(root.querySelector("#tab-setup")!)).toContain("Reload report")
  })

  test("the service's lifecycle view wins over raw facts, and a missing view keeps the guard on", async () => {
    const request = { guardId: "g_commits", sessionId: SESSION, scope: "request" as const, createdAt: iso(-1000), expiresAt: null }
    const { guards, root } = await start({
      state: {
        guards: [guard()],
        activations: [
          { ...request, id: "a_1" },
          { ...request, id: "a_2" },
        ],
        // Raw facts prove a_1 ended, but the service says it is still bound. a_2 has no view.
        lifecycle: [
          { activationId: "a_1", fact: "bound", at: iso(), reason: "running-tracked", instance: "inst_1" },
          { activationId: "a_1", fact: "ended", at: iso(), reason: "request-completed", instance: "inst_1" },
        ],
        lifecycles: [{ activationId: "a_1", phase: "bound", reason: "running-tracked", instance: "inst_1", releasable: false, conflict: false, trust: "ok" }],
      },
    })
    const items = [...guards.querySelectorAll<HTMLElement>(".gd-active")]
    expect(items.map((item) => item.dataset.enforcing)).toEqual(["true", "true"])
    expect(text(items[0]!)).toContain("The plugin releases it after confirming this run and its linked subagents ended.")
    expect(text(items[1]!)).toContain("did not report whether this request ended")
    expect(root.querySelector("[role=tab]")?.textContent).toBe("Guards2")
  })

  test("a damaged store offers a reset only after an explicit confirmation", async () => {
    const { guards, mock, fake } = await start({ state: { guards: [guard()], corrupt: true } })
    expect(text(guards.querySelector(".gd-status")!)).toContain("Guard status unknown")
    const recover = guards.querySelector(".gd-recover") as HTMLElement
    expect(recover.hidden).toBe(false)
    expect(text(recover)).toContain("Guard data is damaged")
    clickButton(recover, "Reset guard store…")
    await tick()
    expect(text(recover)).toContain(
      "This resets all saved guards and releases their activations across every project. The service keeps a backup of the damaged file.",
    )
    // Cancel is focused, and nothing was sent yet.
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe("Cancel")
    expect(mock.serviceCalls.filter((c) => c.path === "/store/recover")).toHaveLength(0)
    clickButton(recover, "Cancel")
    await tick()
    expect(findButton(recover, "Reset guard store")).toBeNull()
    expect(mock.serviceCalls.filter((c) => c.path === "/store/recover")).toHaveLength(0)

    clickButton(recover, "Reset guard store…")
    await tick()
    clickButton(recover, "Reset guard store")
    await tick(12)
    const calls = mock.serviceCalls.filter((c) => c.path === "/store/recover")
    expect(calls.map((c) => JSON.parse(c.body!))).toEqual([{ opId: "op-1", confirmation: "reset-global-guards" }])
    expect(fake.state.corrupt).toBe(false)
    expect(text(recover)).toContain("Guard store reset")
    expect(text(recover)).toContain("The damaged file was kept as a backup: guards.corrupt-20261112T150000Z.json")
    expect(text(guards)).toContain("Saved guards (0)")
  })

  test("an unclear reset is retried with the same opId; a failed reset never claims success", async () => {
    const { guards, mock, fake } = await start({ state: { guards: [guard()], corrupt: true } })
    const recover = guards.querySelector(".gd-recover") as HTMLElement
    clickButton(recover, "Reset guard store…")
    await tick()
    fake.queued.push(fake.applyThenDrop())
    clickButton(recover, "Reset guard store")
    await tick(10)
    expect(text(recover)).toContain("Reset outcome not confirmed")
    expect(text(recover)).not.toContain("was not reset")
    expect(text(recover)).not.toContain("Guard store reset")
    clickButton(recover, "Try again")
    await tick(12)
    const ids = mock.serviceCalls.filter((c) => c.path === "/store/recover").map((c) => JSON.parse(c.body!).opId)
    expect(ids).toEqual(["op-1", "op-1"])
    expect(text(recover)).toContain("Guard store reset")

    const second = await start({ state: { guards: [guard()], corrupt: true } })
    const box = second.guards.querySelector(".gd-recover") as HTMLElement
    clickButton(box, "Reset guard store…")
    await tick()
    second.fake.queued.push(second.fake.error(503, "LOCK_TIMEOUT", "Another process holds the guard store. Try again in a moment."))
    clickButton(box, "Reset guard store")
    await tick(10)
    expect(text(box)).toContain("The guard store was not reset")
    expect(text(box)).toContain("Another process holds the guard store.")
    expect(text(box)).not.toContain("Guard store reset")
  })

  test("a reset with an unknown outcome is not called not reset, and Try again keeps the opId", async () => {
    const { guards, mock, fake } = await start({ state: { guards: [guard()], corrupt: true } })
    const recover = guards.querySelector(".gd-recover") as HTMLElement
    clickButton(recover, "Reset guard store…")
    await tick()
    fake.queued.push(fake.error(503, "OUTCOME_UNKNOWN", "The change may already be applied. Reload the guard data or retry the same request."))
    clickButton(recover, "Reset guard store")
    await tick(10)
    expect(text(recover)).toContain("Reset outcome not confirmed")
    expect(text(recover)).toContain("The reset may already be applied. Reload the guard data or try again.")
    expect(text(recover)).not.toContain("was not reset")
    expect(text(recover)).not.toContain("Guard store reset")
    clickButton(recover, "Try again")
    await tick(12)
    const ids = mock.serviceCalls.filter((c) => c.path === "/store/recover").map((c) => JSON.parse(c.body!).opId)
    expect(ids).toEqual(["op-1", "op-1"])
    expect(text(recover)).toContain("Guard store reset")
  })

  test("a store that is readable again is refreshed, not reset", async () => {
    const { guards, mock, fake } = await start({ state: { guards: [guard()], corrupt: true } })
    const recover = guards.querySelector(".gd-recover") as HTMLElement
    clickButton(recover, "Reset guard store…")
    await tick()
    fake.state.corrupt = false
    clickButton(recover, "Reset guard store")
    await tick(12)
    expect(recover.hidden).toBe(true)
    expect(text(guards)).toContain("Saved guards (1)")
    expect(mock.serviceCalls.filter((c) => c.path === "/store/recover")).toHaveLength(1)
    expect(text(guards)).not.toContain("Guard store reset")
  })

  test("a higher plugin revision after a reset shows catching up, not enforced", async () => {
    const { guards } = await start({ state: { revision: 1, guards: [], runtime: runtime({ revision: 7 }) } })
    expect(text(guards.querySelector(".gd-status")!)).toContain("Plugin is loading the latest change")
  })
})
