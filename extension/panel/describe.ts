/**
 * Turns a parsed report into plain text for the panel. Pure: no DOM, no clock.
 * Times stay as ISO strings so the view can show them as absolute and relative text.
 */
import { everyText, plural } from "./format.ts"
import type { LastChange, LastCheck, StatusReport } from "./report.ts"

export type Tone = "neutral" | "success" | "warning" | "error" | "info"

export type ModelGroup = { label: string; ids: string[] }

/** One row of "What the plugin set up": the setting, its recorded value, and what the setting means. */
export type SetupLine = { label: string; value: string; tone: Tone; help: string }

/** What each setting means. The same text for every value. */
export const SETUP_HELP = {
  key: "Where the plugin found the API key. The key itself is not saved in this report.",
  auth: "fuelix-openai uses OpenAI Responses, typically for GPT models. fuelix-anthropic uses Anthropic Messages, typically for Claude. fuelix uses OpenAI-compatible Chat Completions, including Gemini and Llama models. All three use the same FueliX key.",
  refresh:
    "How often the plugin checks FueliX for model changes. Off disables periodic checks; a startup check can still run.",
  modelTypes:
    "Which models the plugin registers. Non-chat models include embeddings, image generation, speech, and transcription.",
  activation:
    "A key in Keychain or the environment lets the plugin enable these providers. Otherwise, OpenCode enables them when you connect FueliX. This does not verify that the key works.",
  shell:
    "When enabled, removes FUELIX_API_KEY from shell commands the agent runs, so commands like env cannot print it accidentally. It does not block access to stored credentials.",
  batch:
    "Tools for submitting, checking, cancelling, and collecting deferred requests. Registration does not verify that your account has batch access.",
} as const

/** Added to the request authentication help, depending on the Anthropic background hook. */
export const AUTH_BACKGROUND = {
  registered: "Authentication for the Anthropic provider also covers background features such as walkthroughs.",
  missing: "Anthropic background authentication was not registered.",
} as const

const ANTHROPIC_PROVIDER = "fuelix-anthropic"

export type CheckView = {
  headline: string
  tone: Tone
  /** Plain sentences under the headline. */
  notes: string[]
  /** When the check finished, or `null` when no check finished. */
  finishedAt: string | null
  groups: ModelGroup[]
  /** Shown when the last check did not succeed. */
  lastSuccess: { at: string | null } | null
}

export type ChangeView = { at: string; summary: string; groups: ModelGroup[] }

export type ProviderView = { id: string; count: string; titleModel: string }

export type ReportView = {
  pluginVersion: string
  startedAt: string
  recordedAt: string
  /** Set when the report is older than the plugin's check interval allows. */
  stale: { ageMinutes: number } | null
  /** Set when the report says a check was running when it was saved. */
  checkingWhenSaved: boolean
  check: CheckView
  change: ChangeView | null
  models: { total: string; source: string; providers: ProviderView[] }
  setup: SetupLine[]
}

/** Extra minutes on top of two check intervals before a report counts as old. */
const STALE_GRACE_MINUTES = 10

const countChanges = (added: number, removed: number): string => {
  if (added > 0 && removed > 0) return `${plural(added, "model", "models")} added, ${removed} removed`
  if (added > 0) return `${plural(added, "model", "models")} added`
  if (removed > 0) return `${plural(removed, "model", "models")} removed`
  return "Model list updated"
}

const appliedGroups = (added: string[], removed: string[]): ModelGroup[] => [
  ...(added.length > 0 ? [{ label: "Added", ids: added }] : []),
  ...(removed.length > 0 ? [{ label: "Removed", ids: removed }] : []),
]

const notAppliedGroups = (added: string[], removed: string[]): ModelGroup[] => [
  ...(added.length > 0 ? [{ label: "Found, not added", ids: added }] : []),
  ...(removed.length > 0 ? [{ label: "Missing, not removed", ids: removed }] : []),
]

const KEPT = "The plugin kept the current model list."

const describeCheck = (check: LastCheck | null, report: StatusReport): CheckView => {
  if (check === null) {
    return {
      headline: "No check finished yet",
      tone: "neutral",
      notes: ["No model check had finished when the plugin saved this report."],
      finishedAt: null,
      groups: [],
      lastSuccess: null,
    }
  }
  const reason = check.reason ? [`Reason: ${check.reason}`] : []
  const lastSuccess = { at: report.lastSuccessfulCheckAt }
  const base = { finishedAt: check.finishedAt }
  switch (check.outcome) {
    case "updated":
      if (check.reload === "failed") {
        return {
          ...base,
          headline: "Changes found, not loaded",
          tone: "warning",
          notes: [
            "FueliX has a different model list, but OpenCode could not reload it. These changes may not be available until OpenCode restarts.",
            ...reason,
          ],
          groups: notAppliedGroups(check.added, check.removed),
          lastSuccess: null,
        }
      }
      return {
        ...base,
        headline: countChanges(check.added.length, check.removed.length),
        tone: "success",
        notes: [...(check.reload === "succeeded" ? ["OpenCode reloaded its model list."] : []), ...reason],
        groups: appliedGroups(check.added, check.removed),
        lastSuccess: null,
      }
    case "unchanged":
      return {
        ...base,
        headline: "No model changes",
        tone: "neutral",
        notes: ["The registered model list did not change.", ...reason],
        groups: [],
        lastSuccess: null,
      }
    case "no-key":
      return {
        ...base,
        headline: "Check skipped: no FueliX key",
        tone: "warning",
        notes: ["The plugin found no FueliX key, so it could not ask FueliX for models.", ...reason],
        groups: notAppliedGroups(check.added, check.removed),
        lastSuccess,
      }
    case "empty":
      return {
        ...base,
        headline: "FueliX listed no models",
        tone: "warning",
        notes: [KEPT, ...reason],
        groups: notAppliedGroups(check.added, check.removed),
        lastSuccess,
      }
    case "rejected":
      return {
        ...base,
        headline: "New model list not used",
        tone: "warning",
        notes: [KEPT, ...reason],
        groups: notAppliedGroups(check.added, check.removed),
        lastSuccess,
      }
    case "failed":
      return {
        ...base,
        headline: "Check failed",
        tone: "error",
        notes: [KEPT, ...reason],
        groups: notAppliedGroups(check.added, check.removed),
        lastSuccess,
      }
  }
}

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

const describeChange = (change: LastChange | null, check: LastCheck | null): ChangeView | null => {
  if (change === null) return null
  const shownByCheck =
    check !== null &&
    check.outcome === "updated" &&
    check.reload !== "failed" &&
    sameList(check.added, change.added) &&
    sameList(check.removed, change.removed)
  if (shownByCheck) return null
  return {
    at: change.at,
    summary: countChanges(change.added.length, change.removed.length),
    groups: appliedGroups(change.added, change.removed),
  }
}

const AUTH_SOURCE: Record<StatusReport["configuration"]["authSource"], SetupLine> = {
  keychain: { label: "FueliX key", value: "macOS Keychain", tone: "neutral", help: SETUP_HELP.key },
  "credential-store": { label: "FueliX key", value: "OpenCode credential store", tone: "neutral", help: SETUP_HELP.key },
  environment: {
    label: "FueliX key",
    value: "FUELIX_API_KEY environment variable",
    tone: "neutral",
    help: SETUP_HELP.key,
  },
  none: { label: "FueliX key", value: "Not found", tone: "warning", help: SETUP_HELP.key },
}

const MODEL_SOURCE: Record<StatusReport["models"]["source"], string> = {
  discovery: "From the model list accepted by discovery.",
  cache: "From the list saved by an earlier check.",
  catalog: "From the list built into the plugin.",
}

const describeSetup = (report: StatusReport): SetupLine[] => {
  const c = report.configuration
  const hooks = c.authHooks.sessionProviders
  const background = c.authHooks.aiSdk
  // The value lists only providers. The background hook belongs to the Anthropic provider, so it is not a list entry.
  const hookValue =
    hooks.length > 0 ? hooks.join(", ") : background ? "Anthropic background requests only" : "Not set up"
  const backgroundMissing = !background && hooks.includes(ANTHROPIC_PROVIDER)
  const authHelp = background
    ? `${SETUP_HELP.auth} ${AUTH_BACKGROUND.registered}`
    : backgroundMissing
      ? `${SETUP_HELP.auth} ${AUTH_BACKGROUND.missing}`
      : SETUP_HELP.auth
  return [
    AUTH_SOURCE[c.authSource],
    {
      label: "Request authentication",
      value: hookValue,
      tone: (hooks.length === 0 && !background) || backgroundMissing ? "warning" : "neutral",
      help: authHelp,
    },
    {
      label: "Automatic check",
      value: c.refreshMinutes > 0 ? everyText(c.refreshMinutes) : "Off",
      tone: "neutral",
      help: SETUP_HELP.refresh,
    },
    {
      label: "Model types",
      value: c.includeNonChatModels ? "Chat and non-chat models" : "Chat models only",
      tone: "neutral",
      help: SETUP_HELP.modelTypes,
    },
    {
      label: "Provider availability",
      value: c.activation === "enabled" ? "Enabled by the plugin" : "Enabled when connected in OpenCode",
      tone: "neutral",
      help: SETUP_HELP.activation,
    },
    {
      label: "Key in agent shells",
      value:
        c.shellKeyScrubbing === "enabled"
          ? "Removed"
          : c.shellKeyScrubbing === "disabled"
            ? "Not removed (scrubShellEnv is off)"
            : "Removal failed",
      tone: c.shellKeyScrubbing === "failed" ? "error" : c.shellKeyScrubbing === "disabled" ? "warning" : "neutral",
      help: SETUP_HELP.shell,
    },
    {
      label: "Batch tools",
      value: c.batchTools === "registered" ? "Registered" : "Could not register",
      tone: c.batchTools === "failed" ? "error" : "neutral",
      help: SETUP_HELP.batch,
    },
  ]
}

/**
 * Builds the panel text for one report. `now` decides only whether the report is old;
 * the view formats every time itself.
 */
export const describeReport = (report: StatusReport, now: number): ReportView => {
  const ageMinutes = Math.max(0, Math.floor((now - Date.parse(report.recordedAt)) / 60_000))
  const interval = report.configuration.refreshMinutes
  const stale = interval > 0 && ageMinutes > interval * 2 + STALE_GRACE_MINUTES ? { ageMinutes } : null
  const total = report.models.providers.reduce((sum, provider) => sum + provider.count, 0)
  return {
    pluginVersion: report.pluginVersion,
    startedAt: report.startedAt,
    recordedAt: report.recordedAt,
    stale,
    checkingWhenSaved: report.checking,
    check: describeCheck(report.lastCheck, report),
    change: describeChange(report.lastChange, report.lastCheck),
    models: {
      total: `${plural(total, "model", "models")} from ${plural(report.models.providers.length, "provider", "providers")}`,
      source: MODEL_SOURCE[report.models.source],
      providers: report.models.providers.map((provider) => ({
        id: provider.id,
        count: plural(provider.count, "model", "models"),
        titleModel: provider.titleModel ? `Titles: ${provider.titleModel}` : "No title model",
      })),
    },
    setup: describeSetup(report),
  }
}
