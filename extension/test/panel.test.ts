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

const start = async (options: { connectTimeoutMs?: number } = {}) => {
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
    expect(t).toContain("Reads the saved report again. It does not run a model check.")
  })

  test("unchanged check with an earlier change", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    const t = text(root)
    expect(t).toContain("No model changes")
    expect(t).toContain("Latest change since the plugin started")
    expect(t).toContain("starts again when OpenCode restarts or reloads the plugin")
    expect(t).toContain("gpt-5.2-codex")
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

  test("Reload report reads the file again and announces it", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    await serve(mock, PROJECT, json(scenarios.added))
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload report"))
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

  test("Reload report keeps keyboard focus", async () => {
    const { root, mock } = await start()
    await serve(mock, PROJECT, json(scenarios.unchanged))
    mock.ready(PROJECT)
    await tick()
    const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload report"))!
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
