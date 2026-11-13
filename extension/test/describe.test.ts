import { describe, expect, test } from "bun:test"

import {
  AUTH_BACKGROUND,
  describeReport,
  HISTORY_RECENT,
  HISTORY_TEXT,
  historyCoversChange,
  SETUP_HELP,
} from "../panel/describe.ts"
import { historyEntry, NOW, scenarios, withReport } from "./support/fixtures.ts"

describe("describeReport", () => {
  test("unchanged check keeps the earlier model change visible", () => {
    const view = describeReport(scenarios.unchanged, NOW)
    expect(view.check.headline).toBe("No changes in this check")
    expect(view.check.groups).toEqual([])
    expect(view.change?.summary).toBe("1 model added")
    expect(view.change?.groups).toEqual([{ label: "Added", ids: ["gpt-5.2-codex"] }])
  })

  test("added models are listed once, under the check", () => {
    const view = describeReport(scenarios.added, NOW)
    expect(view.check.headline).toBe("2 models added, 1 removed")
    expect(view.check.tone).toBe("success")
    expect(view.check.notes).toContain("OpenCode reloaded its model list.")
    expect(view.check.groups.map((g) => g.label)).toEqual(["Added", "Removed"])
    expect(view.change).toBeNull()
  })

  test("a failed reload never claims the models were added", () => {
    const view = describeReport(scenarios.reloadFailed, NOW)
    expect(view.check.headline).toBe("Changes found, not loaded")
    expect(view.check.groups).toEqual([{ label: "Found, not added", ids: ["claude-opus-5-5"] }])
    expect(JSON.stringify(view.check)).not.toContain('"Added"')
  })

  test("no key", () => {
    const view = describeReport(scenarios.noKey, NOW)
    expect(view.check.headline).toBe("Check skipped: no FueliX key")
    expect(view.check.lastSuccess).toEqual({ at: null })
    expect(view.setup.find((line) => line.label === "FueliX key")).toEqual({
      label: "FueliX key",
      value: "Not found",
      tone: "warning",
      help: SETUP_HELP.key,
    })
    expect(view.models.source).toBe("From the list built into the plugin.")
  })

  test("rejected result shows its reason and does not claim removals", () => {
    const view = describeReport(scenarios.rejected, NOW)
    expect(view.check.headline).toBe("New model list not used")
    expect(view.check.notes).toEqual(["The plugin kept the current model list.", "Reason: too-many-removed"])
    expect(view.check.groups).toEqual([{ label: "Missing, not removed", ids: ["gpt-5", "gpt-5-mini"] }])
  })

  test("failure", () => {
    const view = describeReport(scenarios.failed, NOW)
    expect(view.check.headline).toBe("Check failed")
    expect(view.check.tone).toBe("error")
    expect(view.check.lastSuccess?.at).toBe(scenarios.failed.lastSuccessfulCheckAt)
    expect(view.setup.find((line) => line.label === "Key in agent shells")?.tone).toBe("error")
  })

  test("no finished check yet", () => {
    const view = describeReport(scenarios.firstCheckPending, NOW)
    expect(view.check.headline).toBe("No check finished yet")
    expect(view.checkingWhenSaved).toBe(true)
  })

  test("a report older than two check intervals is out of date", () => {
    expect(describeReport(scenarios.stale, NOW).stale).toEqual({ ageMinutes: 300 })
    expect(describeReport(scenarios.unchanged, NOW).stale).toBeNull()
  })

  test("automatic checks off never mark a report out of date", () => {
    const report = withReport({ recordedAt: new Date(NOW - 7 * 86_400_000).toISOString(), configuration: { refreshMinutes: 0 } })
    const view = describeReport(report, NOW)
    expect(view.stale).toBeNull()
    expect(view.setup.find((line) => line.label === "Automatic check")?.value).toBe("Off")
  })

  test("every setup row explains what it means", () => {
    const expected: Array<[string, string]> = [
      ["FueliX key", "Where the plugin found the API key. The key itself is not saved in this report."],
      [
        "Request authentication",
        "fuelix-openai uses OpenAI Responses, typically for GPT models. fuelix-anthropic uses Anthropic Messages, typically for Claude. fuelix uses OpenAI-compatible Chat Completions, including Gemini and Llama models. All three use the same FueliX key. Authentication for the Anthropic provider also covers background features such as walkthroughs.",
      ],
      [
        "Automatic check",
        "How often the plugin checks FueliX for model changes. Off disables periodic checks; a startup check can still run.",
      ],
      [
        "Model types",
        "Which models the plugin registers. Non-chat models include embeddings, image generation, speech, and transcription.",
      ],
      [
        "Provider availability",
        "A key in Keychain or the environment lets the plugin enable these providers. Otherwise, OpenCode enables them when you connect FueliX. This does not verify that the key works.",
      ],
      [
        "Key in agent shells",
        "When enabled, removes FUELIX_API_KEY from shell commands the agent runs, so commands like env cannot print it accidentally. It does not block access to stored credentials.",
      ],
      [
        "Batch tools",
        "Tools for submitting, checking, cancelling, and collecting deferred requests. Registration does not verify that your account has batch access.",
      ],
    ]
    for (const report of Object.values(scenarios)) {
      expect(describeReport(report, NOW).setup.map((line) => [line.label, line.help])).toEqual(expected)
    }
  })

  test("explanations do not change the recorded values or their tone", () => {
    const off = withReport({
      configuration: {
        authSource: "environment",
        refreshMinutes: 0,
        includeNonChatModels: true,
        activation: "auto",
        shellKeyScrubbing: "disabled",
        batchTools: "failed",
        authHooks: { sessionProviders: [], aiSdk: false },
      },
    })
    expect(describeReport(off, NOW).setup.map(({ label, value, tone }) => ({ label, value, tone }))).toEqual([
      { label: "FueliX key", value: "FUELIX_API_KEY environment variable", tone: "neutral" },
      { label: "Request authentication", value: "Not set up", tone: "warning" },
      { label: "Automatic check", value: "Off", tone: "neutral" },
      { label: "Model types", value: "Chat and non-chat models", tone: "neutral" },
      { label: "Provider availability", value: "Enabled when connected in OpenCode", tone: "neutral" },
      { label: "Key in agent shells", value: "Not removed (scrubShellEnv is off)", tone: "warning" },
      { label: "Batch tools", value: "Could not register", tone: "error" },
    ])
    const failed = describeReport(scenarios.failed, NOW).setup.find((line) => line.label === "Key in agent shells")
    expect(failed).toMatchObject({ value: "Removal failed", tone: "error" })
  })

  describe("request authentication", () => {
    const BASE =
      "fuelix-openai uses OpenAI Responses, typically for GPT models. fuelix-anthropic uses Anthropic Messages, typically for Claude. fuelix uses OpenAI-compatible Chat Completions, including Gemini and Llama models. All three use the same FueliX key."
    const row = (authHooks: { sessionProviders: string[]; aiSdk: boolean }) =>
      describeReport(withReport({ configuration: { authHooks } }), NOW).setup.find(
        (line) => line.label === "Request authentication",
      )!

    test("lists the three providers and nothing else", () => {
      const line = row({ sessionProviders: ["fuelix-openai", "fuelix-anthropic", "fuelix"], aiSdk: true })
      expect(line.value).toBe("fuelix-openai, fuelix-anthropic, fuelix")
      expect(line.value.split(", ")).toHaveLength(3)
      expect(line.value).not.toContain("AI SDK")
      expect(line.value).not.toContain("·")
      expect(line.tone).toBe("neutral")
      expect(line.help).toBe(`${BASE} Authentication for the Anthropic provider also covers background features such as walkthroughs.`)
    })

    test("says when Anthropic background authentication is missing", () => {
      const line = row({ sessionProviders: ["fuelix-openai", "fuelix-anthropic", "fuelix"], aiSdk: false })
      expect(line.value).toBe("fuelix-openai, fuelix-anthropic, fuelix")
      expect(line.tone).toBe("warning")
      expect(line.help).toBe(`${BASE} Anthropic background authentication was not registered.`)
      expect(line.help).not.toContain("also covers")
    })

    test("no background sentence when the Anthropic provider is not listed and the hook is off", () => {
      const line = row({ sessionProviders: ["fuelix-openai"], aiSdk: false })
      expect(line.value).toBe("fuelix-openai")
      expect(line.tone).toBe("neutral")
      expect(line.help).toBe(BASE)
    })

    test("background hook only", () => {
      const line = row({ sessionProviders: [], aiSdk: true })
      expect(line.value).toBe("Anthropic background requests only")
      expect(line.help).toBe(`${BASE} ${AUTH_BACKGROUND.registered}`)
    })

    test("nothing registered", () => {
      const line = row({ sessionProviders: [], aiSdk: false })
      expect(line.value).toBe("Not set up")
      expect(line.tone).toBe("warning")
      expect(line.help).toBe(BASE)
    })
  })

  test("provider availability names who enables the providers", () => {
    const row = (report: Parameters<typeof describeReport>[0]) =>
      describeReport(report, NOW).setup.find((line) => line.label === "Provider availability")?.value
    expect(row(scenarios.unchanged)).toBe("Enabled by the plugin")
    expect(row(scenarios.noKey)).toBe("Enabled when connected in OpenCode")
  })

  test("model totals", () => {
    expect(describeReport(scenarios.unchanged, NOW).models.total).toBe("29 models from 3 providers")
  })
})

const EARLIER = "Earlier changes are listed under Model change history."
const NOT_IN_HISTORY = "The latest recorded change is shown below; it is not yet in the shared history."
const NOW_ISO = new Date(NOW).toISOString()

describe("describeReport: model change history", () => {
  test("a change from another chat stays visible when this check found nothing new", () => {
    const view = describeReport(scenarios.history, NOW)
    expect(view.check.headline).toBe("No changes in this check")
    expect(view.check.notes).toEqual([
      "The registered model list did not change.",
      "Earlier changes are listed under Model change history.",
    ])
    if (view.history.kind !== "list") throw new Error("expected a list")
    expect(view.history.since).toBe(scenarios.history.modelHistory!.since)
    expect(view.history.truncated).toBe(false)
    expect(view.history.older).toEqual([])
    expect(view.history.recent.map((e) => [e.kind, e.title, e.fetchedLabel, e.counts])).toEqual([
      ["change", "1 model added", HISTORY_TEXT.fetchedDiscovery, "The list had 41 models. This plugin can register 29 models here."],
      ["change", "1 model added, 1 removed", HISTORY_TEXT.fetchedCache, "The list had 40 models. This plugin can register 29 models here."],
      ["baseline", "Starting model list · 28 eligible models", HISTORY_TEXT.fetchedCache, "The list had 40 models. This plugin can register 28 models here."],
    ])
    expect(view.history.recent[0]?.groups).toEqual([{ label: "Added", ids: ["hydrogen-1"] }])
    expect(view.history.recent[1]?.groups).toEqual([
      { label: "Added", ids: ["gpt-5.2-codex"] },
      { label: "Removed", ids: ["gpt-4o"] },
    ])
  })

  test("the starting list never lists its models as added", () => {
    const view = describeReport(scenarios.historyBaselineOnly, NOW)
    if (view.history.kind !== "list") throw new Error("expected a list")
    expect(view.history.recent).toHaveLength(1)
    expect(view.history.recent[0]?.groups).toEqual([])
    expect(view.history.recent[0]?.title).not.toContain("added")
    // Nothing changed after the starting list, so the check does not point at earlier changes.
    expect(view.check.notes).not.toContain("Earlier changes are listed under Model change history.")
  })

  test("the count line names what the plugin can register, not a reason", () => {
    const report = withReport({
      modelHistory: { since: scenarios.history.modelHistory!.since, truncated: false, entries: [historyEntry(5, { totalIDs: 29, eligible: 29, added: ["a"] })] },
    })
    const view = describeReport(report, NOW)
    expect(view.history.kind === "list" && view.history.recent[0]?.counts).toBe("The list had 29 models. This plugin can register 29 models here.")
  })

  test("history that holds the current-run change replaces its card", () => {
    const report = withReport({
      modelHistory: scenarios.history.modelHistory!,
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1"], removed: [] },
    })
    const view = describeReport(report, NOW)
    expect(view.change).toBeNull()
    expect(view.check.notes).toContain(EARLIER)
    expect(view.check.notes).not.toContain(NOT_IN_HISTORY)
  })

  test("a change missing from history keeps its card after an unchanged check", () => {
    // The plugin applied hydrogen-1, but the history write failed.
    const report = withReport({
      modelHistory: scenarios.historyBaselineOnly.modelHistory!,
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1"], removed: ["gpt-4o"] },
    })
    const view = describeReport(report, NOW)
    expect(view.check.headline).toBe("No changes in this check")
    expect(view.change?.summary).toBe("1 model added, 1 removed")
    expect(view.change?.groups).toEqual([
      { label: "Added", ids: ["hydrogen-1"] },
      { label: "Removed", ids: ["gpt-4o"] },
    ])
    expect(view.check.notes).toContain(NOT_IN_HISTORY)
    expect(view.check.notes).not.toContain(EARLIER)
  })

  test("valid history with no entries still shows the current-run change", () => {
    const report = withReport({
      modelHistory: { since: scenarios.history.modelHistory!.since, truncated: false, entries: [] },
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1"], removed: [] },
    })
    const view = describeReport(report, NOW)
    expect(view.change?.groups).toEqual([{ label: "Added", ids: ["hydrogen-1"] }])
    expect(view.check.notes).toContain(NOT_IN_HISTORY)
  })

  test("partial coverage is not coverage", () => {
    const report = withReport({
      modelHistory: scenarios.history.modelHistory!,
      // hydrogen-1 is in history; helium-2 is not, and the history never removed gpt-5.
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1", "helium-2"], removed: ["gpt-5"] },
    })
    const view = describeReport(report, NOW)
    expect(view.change?.summary).toBe("2 models added, 1 removed")
    expect(view.check.notes).toContain(NOT_IN_HISTORY)
  })

  test("a latest check that shows the change keeps the card hidden", () => {
    const report = withReport({
      lastCheck: { outcome: "updated", added: ["hydrogen-1"], removed: [], reload: "succeeded" },
      lastChange: { at: scenarios.history.recordedAt, added: ["hydrogen-1"], removed: [] },
      modelHistory: scenarios.historyBaselineOnly.modelHistory!,
    })
    const view = describeReport(report, NOW)
    expect(view.check.groups).toEqual([{ label: "Added", ids: ["hydrogen-1"] }])
    expect(view.change).toBeNull()
  })

  test("historyCoversChange: change entries can cover across entries; a starting list never counts", () => {
    const entries = scenarios.history.modelHistory!.entries
    expect(historyCoversChange({ at: NOW_ISO, added: ["hydrogen-1", "gpt-5.2-codex"], removed: ["gpt-4o"] }, entries)).toBe(true)
    expect(historyCoversChange({ at: NOW_ISO, added: ["helium-2"], removed: [] }, entries)).toBe(false)
    expect(historyCoversChange({ at: NOW_ISO, added: ["gpt-4o"], removed: [] }, entries)).toBe(false)
    const baselineOnly = [historyEntry(10, { kind: "baseline", added: [], removed: [] })]
    expect(historyCoversChange({ at: NOW_ISO, added: ["hydrogen-1"], removed: [] }, baselineOnly)).toBe(false)
  })

  test("long history shows five entries and keeps every older entry and ID", () => {
    const view = describeReport(scenarios.historyLong, NOW)
    if (view.history.kind !== "list") throw new Error("expected a list")
    expect(view.history.truncated).toBe(true)
    expect(view.history.recent).toHaveLength(HISTORY_RECENT)
    expect(view.history.older).toHaveLength(15 - HISTORY_RECENT)
    const ids = [...view.history.recent, ...view.history.older].flatMap((e) => e.groups.flatMap((g) => g.ids))
    expect(ids).toHaveLength(13 + 12 + 3)
    expect(view.history.older[view.history.older.length - 1]?.kind).toBe("baseline")
  })

  test("entries show newest first even when the file order is wrong", () => {
    const entries = [...scenarios.history.modelHistory!.entries].reverse()
    const view = describeReport(withReport({ modelHistory: { ...scenarios.history.modelHistory!, entries } }), NOW)
    expect(view.history.kind === "list" && view.history.recent.map((e) => e.kind)).toEqual(["change", "change", "baseline"])
  })

  test("absent, empty, and unreadable history each say what is true; the legacy card stays", () => {
    const absent = describeReport(scenarios.unchanged, NOW)
    expect(absent.history).toEqual({ kind: "message", title: "This plugin report does not include history.", body: null, tone: "neutral" })
    expect(absent.change?.summary).toBe("1 model added")

    const empty = withReport({ modelHistory: null, lastChange: scenarios.unchanged.lastChange })
    expect(describeReport(empty, NOW).history).toEqual({ kind: "message", title: "Model history is not available.", body: null, tone: "neutral" })
    expect(describeReport(empty, NOW).change?.summary).toBe("1 model added")

    const unreadable = withReport({ modelHistoryProblem: { field: "modelHistory.entries" }, lastChange: scenarios.unchanged.lastChange })
    const view = describeReport(unreadable, NOW)
    expect(view.history).toEqual({
      kind: "message",
      title: "History could not be read.",
      body: "The latest check and the rest of this report are still shown.",
      tone: "warning",
    })
    expect(view.check.headline).toBe("No changes in this check")
    expect(view.change?.summary).toBe("1 model added")
  })
})
