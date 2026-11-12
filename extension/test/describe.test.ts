import { describe, expect, test } from "bun:test"

import { AUTH_BACKGROUND, describeReport, SETUP_HELP } from "../panel/describe.ts"
import { NOW, scenarios, withReport } from "./support/fixtures.ts"

describe("describeReport", () => {
  test("unchanged check keeps the earlier model change visible", () => {
    const view = describeReport(scenarios.unchanged, NOW)
    expect(view.check.headline).toBe("No model changes")
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
