/**
 * Turns a parsed report into plain text for the panel. Pure: no DOM, no clock.
 * Times stay as ISO strings so the view can show them as absolute and relative text.
 */
import { everyText, plural } from "./format.ts"
import type { LastChange, LastCheck, ModelHistoryEntry, StatusReport } from "./report.ts"

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

export type HistoryEntryView = {
  kind: "baseline" | "change"
  title: string
  /** Text before the fetch time, for example "Model list fetched from FueliX ". */
  fetchedLabel: string
  fetchedAt: string
  /** How many IDs the list had, and how many match this location's model types. */
  counts: string
  groups: ModelGroup[]
}

export type HistoryView =
  | {
      kind: "list"
      since: string
      truncated: boolean
      /** Shown first. */
      recent: HistoryEntryView[]
      /** Every remaining entry, in one disclosure. */
      older: HistoryEntryView[]
    }
  | { kind: "message"; title: string; body: string | null; tone: Tone }

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
  history: HistoryView
  /**
   * The plugin's current-run change. Hidden when the latest check already shows it, or when
   * readable history has change entries that hold all its IDs.
   */
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
const EARLIER_CHANGES = "Earlier changes are listed under Model change history."
const NOT_IN_HISTORY = "The latest recorded change is shown below; it is not yet in the shared history."

/** What the latest check adds about the history below it. */
type HistoryNote = "none" | "earlier" | "not-in-history"

/** Entries shown before the "older entries" disclosure. */
export const HISTORY_RECENT = 5

/** Text for every history state. One place, so tests and reviews read the same words. */
export const HISTORY_TEXT = {
  absent: "This plugin report does not include history.",
  empty: "Model history is not available.",
  unreadable: "History could not be read.",
  unreadableBody: "The latest check and the rest of this report are still shown.",
  noEntries: "No model lists are recorded yet.",
  since: "Earliest recorded model list: ",
  times: "Times show when the plugin fetched each model list. They are not the dates FueliX announced the models.",
  truncated: "Older history is omitted from this view.",
  fetchedDiscovery: "Model list fetched from FueliX ",
  fetchedCache: "From a saved model list fetched ",
} as const

const listCounts = (total: number, eligible: number): string =>
  `The list had ${plural(total, "model", "models")}. This plugin can register ${plural(eligible, "model", "models")} here.`

/**
 * Whether the history's change entries hold every added and removed ID of the
 * current-run change. A starting list never counts: it shows what existed, not what changed.
 */
export const historyCoversChange = (change: LastChange, entries: readonly ModelHistoryEntry[]): boolean => {
  const changes = entries.filter((entry) => entry.kind === "change")
  const added = new Set(changes.flatMap((entry) => entry.added))
  const removed = new Set(changes.flatMap((entry) => entry.removed))
  return change.added.every((id) => added.has(id)) && change.removed.every((id) => removed.has(id))
}

const describeHistoryEntry = (entry: ModelHistoryEntry): HistoryEntryView => ({
  kind: entry.kind,
  title:
    entry.kind === "baseline"
      ? `Starting model list · ${plural(entry.eligible, "eligible model", "eligible models")}`
      : countChanges(entry.added.length, entry.removed.length),
  fetchedLabel: entry.source === "cache" ? HISTORY_TEXT.fetchedCache : HISTORY_TEXT.fetchedDiscovery,
  fetchedAt: entry.fetchedAt,
  counts: listCounts(entry.totalIDs, entry.eligible),
  groups: entry.kind === "baseline" ? [] : appliedGroups([...entry.added], [...entry.removed]),
})

const describeHistory = (report: StatusReport): HistoryView => {
  if (report.modelHistoryProblem) {
    return { kind: "message", title: HISTORY_TEXT.unreadable, body: HISTORY_TEXT.unreadableBody, tone: "warning" }
  }
  if (report.modelHistory === undefined) return { kind: "message", title: HISTORY_TEXT.absent, body: null, tone: "neutral" }
  if (report.modelHistory === null) return { kind: "message", title: HISTORY_TEXT.empty, body: null, tone: "neutral" }
  // Newest first. A stable sort keeps the plugin's order for equal times.
  const entries = [...report.modelHistory.entries]
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .map(describeHistoryEntry)
  return {
    kind: "list",
    since: report.modelHistory.since,
    truncated: report.modelHistory.truncated,
    recent: entries.slice(0, HISTORY_RECENT),
    older: entries.slice(HISTORY_RECENT),
  }
}

const describeCheck = (check: LastCheck | null, report: StatusReport, historyNote: HistoryNote): CheckView => {
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
        headline: "No changes in this check",
        tone: "neutral",
        notes: [
          "The registered model list did not change.",
          ...(historyNote === "earlier" ? [EARLIER_CHANGES] : historyNote === "not-in-history" ? [NOT_IN_HISTORY] : []),
          ...reason,
        ],
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
  const history = describeHistory(report)
  const entries = history.kind === "list" ? (report.modelHistory?.entries ?? []) : null
  // Readable history replaces the current-run change card only when it holds that change.
  // A failed history write must not hide a change the plugin applied.
  const uncovered = report.lastChange !== null && entries !== null && !historyCoversChange(report.lastChange, entries)
  const change = entries === null || uncovered ? describeChange(report.lastChange, report.lastCheck) : null
  const historyNote: HistoryNote =
    entries === null
      ? "none"
      : uncovered && change !== null
        ? "not-in-history"
        : entries.some((entry) => entry.kind === "change")
          ? "earlier"
          : "none"
  return {
    pluginVersion: report.pluginVersion,
    startedAt: report.startedAt,
    recordedAt: report.recordedAt,
    stale,
    checkingWhenSaved: report.checking,
    check: describeCheck(report.lastCheck, report, historyNote),
    history,
    change,
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
