/**
 * The whole panel against a fake OpenChamber host. The host speaks the SDK wire
 * protocol through `connectHost`'s test seam and serves fake reports only.
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

import { connectHost } from "@openchamber/sdk"
import type { HostFrame } from "@openchamber/sdk"

import { AUTH_BACKGROUND, SETUP_HELP } from "../panel/describe.ts"
import { reportPath } from "../panel/hash.ts"
import type { Panel } from "../panel/main.ts"
import { json, NOW, OTHER_PROJECT, PROJECT, scenarios, withReport } from "./support/fixtures.ts"
import { createMockHost, type MockHost } from "./support/mock-host.ts"

let panel: Panel | null = null
afterEach(() => {
  panel?.dispose()
  panel = null
})

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

const start = async (options: { connectTimeoutMs?: number; checkPollMs?: number; checkTimeoutMs?: number } = {}) => {
  const { startPanel } = await import("../panel/main.ts")
  document.body.innerHTML = '<main id="root"></main>'
  const root = document.getElementById("root") as HTMLElement
  const listeners = new Set<(event: MessageEvent) => void>()
  const parentWindow = {}
  let mock: MockHost | null = null
  const target: HostFrame = {
    addEventListener: ((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.add(listener)
    }) as HostFrame["addEventListener"],
    removeEventListener: ((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.delete(listener)
    }) as HostFrame["removeEventListener"],
    parent: { postMessage: (message) => queueMicrotask(() => mock?.receive(message)) },
  }
  mock = createMockHost({
    post: (data) =>
      queueMicrotask(() => {
        const event = new MessageEvent("message", { data, source: parentWindow as unknown as Window })
        for (const listener of listeners) listener(event)
      }),
  })
  const host = connectHost({ target, acceptSource: (source) => source === parentWindow, requestTimeoutMs: 1000 })
  panel = startPanel({
    root,
    host,
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    pollMs: 60_000,
    checkPollMs: options.checkPollMs ?? 5,
    checkTimeoutMs: options.checkTimeoutMs ?? 2_000,
    now: () => NOW,
  })
  return { root, mock }
}

const text = (root: HTMLElement) => (root.textContent ?? "").replace(/\s+/g, " ")

const serve = async (mock: MockHost, directory: string | null, content: string) => {
  mock.files.set(await reportPath(directory), { content })
}

describe("panel with a mock host", () => {
  test("waits for OpenChamber before reading", async () => {
    const { root, mock } = await start()
    expect(text(root)).toContain("Connecting to OpenChamber")
    expect(mock.reads).toHaveLength(0)
  })

  test("says when OpenChamber never connects", async () => {
    const { root } = await start({ connectTimeoutMs: 5 })
    await new Promise((r) => setTimeout(r, 20))
    expect(text(root)).toMatch(/OpenChamber did not connect|Open this panel in OpenChamber/)
  })

  test("no report for this location", async () => {
    const { root, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    expect(mock.reads).toEqual([await reportPath(PROJECT)])
    expect(text(root)).toContain("No report for this location")
    expect(text(root)).toContain("fuelix.statusReport")
  })

  test("added models", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.added))
    mock.ready(PROJECT)
    await tick()
    const t = text(root)
    expect(t).toContain("example-project")
    expect(t).toContain("2 models added, 1 removed")
    expect(t).toContain("claude-opus-5-5")
    expect(t).toContain("OpenCode reloaded its model list.")
    expect(t).toContain("not a live check")
    expect(t).toContain("Reload saved report reads the saved report again. It does not run a model check.")
  })

  test("unchanged check with an earlier change", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    const t = text(root)
    expect(t).toContain("No changes in this check")
    expect(t).toContain("This plugin report does not include history.")
    expect(t).toContain("Latest change since the plugin started")
    expect(t).toContain("This card covers only the current plugin run.")
    expect(t).toContain("gpt-5.2-codex")
  })

  test("model change history from another chat shows under an unchanged check", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    mock.ready(PROJECT)
    await tick()
    const sections = [...root.querySelectorAll<HTMLElement>("#content > .sec")].map((s) => s.querySelector(".sec-title")?.textContent)
    expect(sections.slice(0, 2)).toEqual(["Latest model check", "Model change history"])
    expect(sections).not.toContain("Latest change since the plugin started")
    const history = root.querySelector<HTMLElement>('[aria-labelledby="sec-history"]')!
    const t = text(history)
    expect(t).toContain("Earliest recorded model list: ")
    expect(t).toContain("They are not the dates FueliX announced the models.")
    expect(t).not.toContain("Older history is omitted")
    const items = [...history.querySelectorAll<HTMLElement>(".hist-item")]
    expect(items.map((i) => i.dataset.kind)).toEqual(["change", "change", "baseline"])
    expect(text(items[0]!)).toContain("1 model added")
    expect(text(items[0]!)).toContain("Model list fetched from FueliX ")
    expect(text(items[0]!)).toContain("hydrogen-1")
    expect(text(items[1]!)).toContain("From a saved model list fetched ")
    expect(text(items[2]!)).toContain("Starting model list · 28 eligible models")
    expect(items[2]!.querySelector(".chip")).toBeNull()
    for (const item of items) expect(item.querySelector("time")?.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(text(root.querySelector('[aria-labelledby="sec-check"]')!)).toContain("Earlier changes are listed under Model change history.")
  })

  test("long history folds older entries, keeps every ID, and stays open after Reload", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.historyLong))
    mock.ready(PROJECT)
    await tick()
    const history = () => root.querySelector<HTMLElement>('[aria-labelledby="sec-history"]')!
    expect(text(history())).toContain("Older history is omitted from this view.")
    expect(history().querySelectorAll(":scope > .hist > .hist-item")).toHaveLength(5)
    const more = history().querySelector<HTMLDetailsElement>("details.hist-more")!
    expect(more.querySelector("summary")?.textContent).toBe("Show 10 older entries")
    expect(more.querySelectorAll(".hist-item")).toHaveLength(10)
    expect(history().querySelectorAll(".chip")).toHaveLength(28)
    const batch = history().querySelector<HTMLDetailsElement>("details.fold:not(.hist-more)")!
    expect(batch.querySelectorAll(".chip")).toHaveLength(12)
    more.open = true
    batch.open = true
    root.querySelector<HTMLButtonElement>(".ftr-button button")!.click()
    await tick(6)
    expect(history().querySelector<HTMLDetailsElement>("details.hist-more")?.open).toBe(true)
    expect(history().querySelector<HTMLDetailsElement>("details.fold:not(.hist-more)")?.open).toBe(true)
  })

  test("a change missing from history shows its card below the history", async () => {
    const { root, mock } = await start()
    const report = withReport({
      modelHistory: scenarios.historyBaselineOnly.modelHistory!,
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1"], removed: [] },
    })
    await serve(mock, PROJECT, json(report))
    mock.ready(PROJECT)
    await tick()
    const sections = [...root.querySelectorAll<HTMLElement>("#content > .sec")].map((s) => s.querySelector(".sec-title")?.textContent)
    expect(sections.slice(0, 3)).toEqual(["Latest model check", "Model change history", "Latest change since the plugin started"])
    expect(text(root.querySelector('[aria-labelledby="sec-check"]')!)).toContain(
      "The latest recorded change is shown below; it is not yet in the shared history.",
    )
    expect(text(root.querySelector('[aria-labelledby="sec-change"]')!)).toContain("hydrogen-1")
  })

  test("null and damaged history say so; the rest of the report still shows", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.historyNull))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("Model history is not available.")
    await serve(mock, PROJECT, json({ ...scenarios.history, modelHistory: { since: "soon", truncated: false, entries: [] } }))
    root.querySelector<HTMLButtonElement>(".ftr-button button")!.click()
    await tick(6)
    const t = text(root)
    expect(t).toContain("History could not be read.")
    expect(t).toContain("The latest check and the rest of this report are still shown.")
    expect(t).toContain("No changes in this check")
    expect(t).toContain("Models in OpenCode")
    expect(t).not.toContain("The report could not be read")
  })

  test("history text is shown as text, never as HTML", async () => {
    const { root, mock } = await start()
    const hostile = '<img src=x onerror="globalThis.__pwned=1">'
    const report = withReport({
      modelHistory: {
        since: scenarios.history.modelHistory!.since,
        truncated: false,
        entries: [{ ...scenarios.history.modelHistory!.entries[0]!, added: [hostile], removed: ["</li><script>x()</script>"] }],
      },
    })
    await serve(mock, PROJECT, json(report))
    mock.ready(PROJECT)
    await tick()
    const history = root.querySelector<HTMLElement>('[aria-labelledby="sec-history"]')!
    expect(history.querySelector("img, script")).toBeNull()
    expect(text(history)).toContain(hostile)
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined()
  })

  test("a sanitized directory in the report is not a mismatch", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json({ ...scenarios.added, directory: "/work/[redacted]" }))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("2 models added, 1 removed")
    expect(text(root)).not.toContain("another location")
  })

  test("checking:true is described as saved state, not live", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.firstCheckPending))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("That does not mean a check is running now.")
  })

  test("reason text is shown as plain text", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json({ ...scenarios.failed, lastCheck: { ...scenarios.failed.lastCheck, reason: "HTTP 401 for key [redacted]" } }))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("Reason: HTTP 401 for key [redacted]")
  })

  test("no key", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.noKey))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("Check skipped: no FueliX key")
    expect(text(root)).toContain("No successful check since the plugin started.")
  })

  test("rejected result", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.rejected))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("New model list not used")
    expect(text(root)).toContain("Reason: too-many-removed")
    expect(text(root)).toContain("Missing, not removed (2)")
  })

  test("failed check", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.failed))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("Check failed")
    expect(text(root)).toContain("Last successful check:")
  })

  test("out-of-date report is labelled", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.stale))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("This report may be out of date")
    expect(text(root)).toContain("Out of date")
  })

  test("missing permission", async () => {
    const { root, mock } = await start()
    mock.files.set(await reportPath(PROJECT), { code: "NOT_GRANTED" })
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("File access not approved")
  })

  test("damaged and newer reports", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, "{ not json")
    await serve(mock, OTHER_PROJECT, json({ ...scenarios.unchanged, directory: OTHER_PROJECT, version: 7 }))
    mock.ready(PROJECT)
    await tick()
    expect(text(root)).toContain("The report could not be read")
    mock.directory(OTHER_PROJECT)
    await tick()
    expect(text(root)).toContain("format version 7")
  })

  test("no project uses global.json", async () => {
    const { root, mock } = await start()
    await serve(mock, null, json(scenarios.global))
    mock.ready(null)
    await tick()
    expect(mock.reads).toEqual(["~/.td-opencode-plugin/status/global.json"])
    expect(text(root)).toContain("No project open")
  })

  test("switching location shows only the new location's report, even when the old answer arrives last", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.added))
    await serve(mock, OTHER_PROJECT, json(withReport({ lastCheck: { outcome: "failed", reason: "timeout" } }, OTHER_PROJECT)))
    mock.hold(true)
    mock.ready(PROJECT)
    await tick()
    mock.directory(OTHER_PROJECT)
    await tick()
    expect(mock.held.map((w) => w.path)).toEqual([await reportPath(PROJECT), await reportPath(OTHER_PROJECT)])
    mock.release(1)
    await tick()
    mock.release(0)
    await tick()
    const t = text(root)
    expect(t).toContain("other-project")
    expect(t).toContain("Check failed")
    expect(t).not.toContain("2 models added")
  })

  test("Reload saved report reads the file again and announces it", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    await serve(mock, PROJECT, json(scenarios.added))
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload saved report"))
    expect(button).toBeDefined()
    button!.click()
    await tick(5)
    expect(mock.reads).toHaveLength(2)
    expect(text(root)).toContain("2 models added, 1 removed")
    expect(root.querySelector('[aria-live="polite"]')?.textContent).toBe("Report reloaded.")
  })

  test("report text is never parsed as HTML", async () => {
    const { root, mock } = await start()
    const hostile = withReport({
      lastCheck: { outcome: "updated", added: ['<img src=x onerror="alert(1)">'], removed: [], reload: "succeeded" },
      pluginVersion: "<b>bold</b>",
      configuration: { authHooks: { sessionProviders: ["<script>alert(2)</script>"], aiSdk: false } },
    })
    await serve(mock, PROJECT, json(hostile))
    mock.ready(PROJECT)
    await tick()
    expect(root.querySelector("img")).toBeNull()
    expect(root.querySelector("b")).toBeNull()
    expect(root.querySelector("script")).toBeNull()
    expect(text(root)).toContain('<img src=x onerror="alert(1)">')
    const auth = [...root.querySelectorAll(".fact")].find((row) => row.querySelector("dt")?.textContent === "Request authentication")
    expect(auth?.querySelector(".fact-value")?.textContent).toBe("<script>alert(2)</script>")
  })

  test("each setup row shows the setting, its value, and what it means", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.failed))
    mock.ready(PROJECT)
    await tick()
    const section = root.querySelector('[aria-labelledby="sec-setup"]')
    expect(section?.querySelector("h2")?.textContent).toBe("What the plugin set up")
    const rows = [...(section?.querySelectorAll("dl.facts > div.fact") ?? [])]
    expect(rows).toHaveLength(7)
    // The fixture registers the Anthropic background hook, so its sentence follows the base help.
    const helps = Object.values({ ...SETUP_HELP, auth: `${SETUP_HELP.auth} ${AUTH_BACKGROUND.registered}` })
    rows.forEach((row, index) => {
      const children = [...row.children].map((child) => child.tagName.toLowerCase())
      expect(children).toEqual(["dt", "dd", "dd"])
      expect(row.querySelector(".fact-help")?.textContent).toBe(helps[index]!)
    })
    const shell = rows.find((row) => row.querySelector("dt")?.textContent === "Key in agent shells")
    const value = shell?.querySelector(".fact-value") as HTMLElement | null
    expect(value?.textContent).toBe("Removal failed")
    expect(value?.dataset.tone).toBe("error")
    expect(shell?.querySelector(".fact-help")?.textContent).toStartWith("When enabled, removes FUELIX_API_KEY")
    const auth = rows.find((row) => row.querySelector("dt")?.textContent === "Request authentication")
    expect(auth?.querySelector(".fact-value")?.textContent).toBe("fuelix-openai, fuelix-anthropic, fuelix")
    expect(section?.textContent).not.toContain("AI SDK")
  })

  test("a missing Anthropic background hook is shown as a warning", async () => {
    const { root, mock } = await start()
    const partial = withReport({
      configuration: { authHooks: { sessionProviders: ["fuelix-openai", "fuelix-anthropic", "fuelix"], aiSdk: false } },
    })
    await serve(mock, PROJECT, json(partial))
    mock.ready(PROJECT)
    await tick()
    const auth = [...root.querySelectorAll(".fact")].find((row) => row.querySelector("dt")?.textContent === "Request authentication")
    const value = auth?.querySelector(".fact-value") as HTMLElement | null
    expect(value?.textContent).toBe("fuelix-openai, fuelix-anthropic, fuelix")
    expect(value?.dataset.tone).toBe("warning")
    expect(auth?.querySelector(".fact-help")?.textContent).toEndWith("Anthropic background authentication was not registered.")
  })

  test("Reload saved report keeps keyboard focus", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload saved report"))!
    button.focus()
    await serve(mock, PROJECT, json(scenarios.added))
    button.click()
    await tick(5)
    expect(text(root)).toContain("2 models added, 1 removed")
    expect(document.activeElement).toBe(button)
  })

  test("after dispose, late answers change nothing", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.added))
    mock.hold(true)
    mock.ready(PROJECT)
    await tick()
    const before = text(root)
    panel?.dispose()
    panel = null
    mock.release(0)
    await tick()
    expect(text(root)).toBe(before)
  })
})

const REQUEST_ID = "AbCdEfGhIjKlMnOpQrStUv"
const accepted = {
  status: 202,
  body: JSON.stringify({ ok: true, data: { requestId: REQUEST_ID, requestedAt: new Date(NOW).toISOString() } }),
}
const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>(".ftr button")].find((b) => b.textContent?.includes(label))!
const card = (root: HTMLElement) => root.querySelector<HTMLElement>('[aria-labelledby="sec-manual"]')
const live = (root: HTMLElement) => root.querySelector('[aria-live="polite"]')?.textContent
/** Waits until `check` holds, for real timers. */
const until = async (check: () => boolean, ms = 1_500) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 2))
  }
}
const manualReport = (patch: Record<string, unknown>, checking = false) =>
  json(
    withReport({
      checking,
      modelHistory: {
        since: scenarios.history.modelHistory!.since,
        truncated: false,
        entries: [{ ...scenarios.history.modelHistory!.entries[0]!, added: ["helium-2"], fetchedAt: new Date(NOW).toISOString() }, ...scenarios.history.modelHistory!.entries],
      },
      lastCheck: { trigger: "manual", requestId: REQUEST_ID, ...patch },
    }),
  )

describe("Check models now", () => {
  test("is the primary footer action, beside a separate read-only reload; nothing runs on open", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    mock.ready(PROJECT)
    await tick()
    const labels = [...root.querySelectorAll(".ftr button")].map((b) => b.textContent)
    expect(labels).toEqual(["Check models now", "Reload saved report"])
    expect(button(root, "Check models now").getAttribute("aria-describedby")).toBe("check-hint")
    expect(button(root, "Check models now").disabled).toBe(false)
    expect(text(root)).toContain("It sends no prompt and uses no model.")
    button(root, "Reload saved report").click()
    await tick(5)
    expect(mock.serviceCalls.filter((c) => c.path === "/model-check")).toHaveLength(0)
    expect(mock.generateCalls).toHaveLength(0)
  })

  test("one click sends one POST /model-check, shows progress, then the matching result and new history", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    let answer: (() => void) | null = null
    mock.setService((call) => (call.path === "/model-check" ? new Promise((r) => (answer = () => r(accepted))) : { code: "NO_SERVICE" }))
    mock.ready(PROJECT)
    await tick()
    const check = button(root, "Check models now")
    check.focus()
    check.click()
    check.click()
    await tick()
    const calls = mock.serviceCalls.filter((c) => c.path === "/model-check")
    expect(calls).toEqual([{ method: "POST", path: "/model-check", body: "{}" }])
    expect(check.disabled).toBe(true)
    expect(check.textContent).toBe("Checking models…")
    expect(check.getAttribute("aria-busy")).toBe("true")
    expect(live(root)).toBe("Checking models.")
    expect(text(card(root)!)).toContain("The saved report below stays on screen until the check finishes.")
    // The saved report stays visible while the check runs.
    expect(text(root)).toContain("Model change history")
    answer!()
    await tick()
    // Running: `checking` is true; the other lastCheck fields are still the previous result.
    await serve(mock, PROJECT, manualReport({ outcome: "unchanged", added: [], removed: [] }, true))
    await until(() => text(card(root)!).includes("The plugin is asking FueliX for the model list now."))
    expect(text(card(root)!)).not.toContain("No changes")
    expect(text(root.querySelector('[aria-labelledby="sec-check"]')!)).not.toContain("Started with Check models now.")
    check.click()
    await tick()
    expect(mock.serviceCalls.filter((c) => c.path === "/model-check")).toHaveLength(1)
    await serve(mock, PROJECT, manualReport({ outcome: "updated", added: ["helium-2"], removed: [], reload: "succeeded" }))
    await until(() => !check.disabled)
    const t = text(card(root)!)
    expect(t).toContain("1 model added")
    expect(t).toContain("helium-2")
    expect(t).toContain("Checked ")
    expect(card(root)!.querySelector("time")?.dateTime).toMatch(/^\d{4}-/)
    expect(live(root)).toBe("Model check result: 1 model added.")
    expect(check.textContent).toBe("Check models now")
    expect(document.activeElement).toBe(check)
    const history = root.querySelector<HTMLElement>('[aria-labelledby="sec-history"]')!
    expect(text(history.querySelector(".hist-item")!)).toContain("helium-2")
    expect(text(root.querySelector('[aria-labelledby="sec-check"]')!)).toContain("Started with Check models now.")
  })

  test("a failed check shows its fixed reason as text, never as unchanged", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    mock.setService(() => accepted)
    mock.ready(PROJECT)
    await tick()
    button(root, "Check models now").click()
    await tick()
    await serve(mock, PROJECT, manualReport({ outcome: "failed", reason: "FueliX returned HTTP 503" }))
    await until(() => card(root)?.querySelector(".headline")?.textContent === "Check failed")
    const t = text(card(root)!)
    expect(t).toContain("Reason: FueliX returned HTTP 503")
    expect(t).not.toContain("No changes")
    expect(card(root)!.dataset.tone).toBe("error")
    expect(live(root)).toBe("Model check result: Check failed.")
  })

  test("no matching report in time says no plugin answered; the saved report stays", async () => {
    const { root, mock } = await start({ checkTimeoutMs: 30 })
    await serve(mock, PROJECT, json(scenarios.history))
    mock.setService(() => accepted)
    mock.ready(PROJECT)
    await tick()
    button(root, "Check models now").click()
    await until(() => text(root).includes("No plugin answered the check"))
    expect(card(root)!.querySelector(".headline")?.textContent).toBe("No plugin answered the check")
    expect(card(root)!.querySelector(".note")?.textContent).toBe(
      "The running plugin may be older than 0.8.0, or not loaded for this project. The saved report is unchanged.",
    )
    expect(text(card(root)!)).not.toContain("No changes")
    expect(text(root)).toContain("hydrogen-1")
    expect(button(root, "Check models now").disabled).toBe(false)
    expect(live(root)).toBe("No plugin answered the check.")
  })

  test("a request error shows the action; no polling", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    mock.setService(() => ({
      status: 500,
      body: JSON.stringify({ ok: false, error: { code: "MODEL_CHECK_REQUEST_FAILED", message: "The check request could not be saved." } }),
    }))
    mock.ready(PROJECT)
    await tick()
    const reads = mock.reads.length
    button(root, "Check models now").click()
    await until(() => card(root)?.dataset.tone === "error")
    const t = text(card(root)!)
    expect(t).toContain("The service could not pass the check to the plugin")
    expect(t).toContain("Select Check models now to try again.")
    expect(t).toContain("The saved report is unchanged.")
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.reads.length).toBe(reads)
    expect(text(root)).toContain("hydrogen-1")
  })

  test("no service gives a concrete step, not a blanket restart", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.history))
    mock.ready(PROJECT)
    await tick()
    button(root, "Check models now").click()
    await until(() => card(root)?.dataset.tone === "error")
    const t = text(card(root)!)
    expect(t).toContain("The extension service is not running")
    expect(t).toContain("Turn the extension off and on in Settings → Extensions")
    expect(t.toLowerCase()).not.toContain("restart")
  })

  test("an old report without the new fields never counts as the answer", async () => {
    const { root, mock } = await start({ checkTimeoutMs: 30 })
    await serve(mock, PROJECT, json(scenarios.history))
    mock.setService(() => accepted)
    mock.ready(PROJECT)
    await tick()
    button(root, "Check models now").click()
    await tick()
    await serve(mock, PROJECT, json(scenarios.added))
    await until(() => text(root).includes("No plugin answered the check"))
    expect(text(root.querySelector('[aria-labelledby="sec-check"]')!)).toContain("2 models added, 1 removed")
  })
})
