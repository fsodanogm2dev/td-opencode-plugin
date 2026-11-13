/**
 * Fake status reports. No real paths, keys, or user data.
 * `NOW` is a fixed clock so text such as "3 min ago" is stable.
 */
import type { ModelHistoryEntry, StatusReport } from "../../panel/report.ts"

export const NOW = Date.parse("2026-11-12T15:00:00.000Z")
export const PROJECT = "/work/example-project"
export const OTHER_PROJECT = "/work/other-project"

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

type Patch = Partial<Omit<StatusReport, "configuration" | "models" | "lastCheck">> & {
  configuration?: Partial<Omit<StatusReport["configuration"], "authHooks">> & {
    authHooks?: Partial<StatusReport["configuration"]["authHooks"]>
  }
  models?: Partial<StatusReport["models"]>
  lastCheck?: Partial<NonNullable<StatusReport["lastCheck"]>> | null
}

export const baseReport = (directory: string | null = PROJECT): StatusReport => ({
  version: 1,
  pluginVersion: "0.4.0",
  directory,
  startedAt: minutesAgo(95),
  recordedAt: minutesAgo(3),
  checking: false,
  configuration: {
    refreshMinutes: 60,
    includeNonChatModels: false,
    authSource: "keychain",
    activation: "enabled",
    shellKeyScrubbing: "enabled",
    batchTools: "registered",
    authHooks: { sessionProviders: ["fuelix-openai", "fuelix-anthropic", "fuelix"], aiSdk: true },
  },
  models: {
    source: "discovery",
    providers: [
      { id: "fuelix-openai", count: 14, titleModel: "gpt-5-nano" },
      { id: "fuelix-anthropic", count: 9, titleModel: "claude-haiku-4-5" },
      { id: "fuelix", count: 6, titleModel: null },
    ],
  },
  lastCheck: {
    startedAt: minutesAgo(4),
    finishedAt: minutesAgo(3),
    outcome: "unchanged",
    added: [],
    removed: [],
    reason: null,
    reload: "not-needed",
  },
  lastSuccessfulCheckAt: minutesAgo(3),
  lastChange: null,
})

export const withReport = (patch: Patch, directory: string | null = PROJECT): StatusReport => {
  const base = baseReport(directory)
  return {
    ...base,
    ...patch,
    configuration: {
      ...base.configuration,
      ...(patch.configuration ?? {}),
      authHooks: { ...base.configuration.authHooks, ...(patch.configuration?.authHooks ?? {}) },
    },
    models: { ...base.models, ...(patch.models ?? {}) },
    lastCheck:
      patch.lastCheck === null ? null : base.lastCheck && { ...base.lastCheck, ...(patch.lastCheck ?? {}) },
    lastChange:
      patch.lastChange === undefined ? base.lastChange : (patch.lastChange as StatusReport["lastChange"]),
  } as StatusReport
}

/** One history entry. Defaults to an applied change fetched from FueliX. */
export const historyEntry = (minutes: number, patch: Partial<ModelHistoryEntry> = {}): ModelHistoryEntry => ({
  kind: "change",
  fetchedAt: minutesAgo(minutes),
  source: "discovery",
  totalIDs: 41,
  eligible: 29,
  added: [],
  removed: [],
  ...patch,
})

const baselineEntry = historyEntry(60 * 30, { kind: "baseline", source: "cache", totalIDs: 40, eligible: 28 })

/** Fourteen changes, so the panel shows five and folds nine. One change adds twelve models. */
const longHistory: ModelHistoryEntry[] = [
  ...Array.from({ length: 14 }, (_, i) =>
    historyEntry(60 * (i + 1) * 6, {
      added: i === 2 ? Array.from({ length: 12 }, (_, n) => `model-batch-${n + 1}`) : [`model-${i + 1}`],
      removed: i % 4 === 3 ? [`old-model-${i}`] : [],
    }),
  ),
  historyEntry(60 * 24 * 5, { kind: "baseline", source: "cache", totalIDs: 30, eligible: 20 }),
]

/** One report per state the panel must explain. */
export const scenarios = {
  unchanged: withReport({
    lastChange: { at: minutesAgo(60 * 26), added: ["gpt-5.2-codex"], removed: [] },
  }),
  added: withReport({
    lastCheck: { outcome: "updated", added: ["claude-opus-5-5", "gpt-5.2-codex"], removed: ["gpt-4o"], reload: "succeeded" },
    lastChange: { at: minutesAgo(3), added: ["claude-opus-5-5", "gpt-5.2-codex"], removed: ["gpt-4o"] },
  }),
  reloadFailed: withReport({
    lastCheck: { outcome: "updated", added: ["claude-opus-5-5"], removed: [], reload: "failed", reason: "reload-failed" },
  }),
  noKey: withReport({
    configuration: { authSource: "none", activation: "auto" },
    lastCheck: { outcome: "no-key", reason: "no-key" },
    lastSuccessfulCheckAt: null,
    models: { source: "catalog", providers: baseReport().models.providers },
  }),
  rejected: withReport({
    lastCheck: { outcome: "rejected", added: [], removed: ["gpt-5", "gpt-5-mini"], reason: "too-many-removed" },
    lastSuccessfulCheckAt: minutesAgo(180),
  }),
  failed: withReport({
    lastCheck: { outcome: "failed", reason: "timeout" },
    lastSuccessfulCheckAt: minutesAgo(64),
    models: { source: "cache", providers: baseReport().models.providers },
    configuration: { shellKeyScrubbing: "failed" },
  }),
  empty: withReport({ lastCheck: { outcome: "empty", reason: "empty-list" } }),
  firstCheckPending: withReport({ lastCheck: null, checking: true, lastSuccessfulCheckAt: null, recordedAt: minutesAgo(0) }),
  stale: withReport({ recordedAt: minutesAgo(60 * 5) }),
  global: withReport({}, null),
  /** Another chat applied a change. This location's latest check found nothing new. */
  history: withReport({
    modelHistory: {
      since: baselineEntry.fetchedAt,
      truncated: false,
      entries: [
        historyEntry(120, { added: ["hydrogen-1"] }),
        historyEntry(60 * 26, { source: "cache", added: ["gpt-5.2-codex"], removed: ["gpt-4o"], totalIDs: 40 }),
        baselineEntry,
      ],
    },
  }),
  historyNull: withReport({ modelHistory: null }),
  historyBaselineOnly: withReport({
    modelHistory: { since: baselineEntry.fetchedAt, truncated: false, entries: [baselineEntry] },
  }),
  historyLong: withReport({
    modelHistory: { since: longHistory[longHistory.length - 1]!.fetchedAt, truncated: true, entries: longHistory },
  }),
} satisfies Record<string, StatusReport>

export const json = (report: unknown): string => JSON.stringify(report, null, 2)
