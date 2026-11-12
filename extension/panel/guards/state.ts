/**
 * Pure helpers that turn the service state into what the guard views show.
 * Nothing here says a guard is enforced unless the plugin's own runtime report,
 * written within the last minute, says it is ready.
 */
import type { GuardState } from "./service.ts"
import { activationRelationship, type Activation, type Guard, type GuardRuntimeReport, type LifecycleView, type Rule } from "./shared.ts"

/** The plugin writes its runtime report regularly. An older report does not prove the plugin still runs. */
export const HEARTBEAT_STALE_MS = 60_000

export type Enforcement =
  | { kind: "enforced"; covered: string[] }
  | { kind: "catching-up"; covered: string[] }
  | {
      kind: "not-enforced"
      reason: "no-runtime" | "runtime-invalid" | "not-registered" | "stale" | "store-missing" | "store-invalid" | "store-unavailable"
    }

export const enforcement = (state: GuardState, now: number): Enforcement => {
  // The service decides freshness with its own clock. Older services leave it to the panel.
  if (state.runtimeStatus === "stale") return { kind: "not-enforced", reason: "stale" }
  if (state.runtimeStatus === "invalid") return { kind: "not-enforced", reason: "runtime-invalid" }
  const runtime = state.runtime
  if (!runtime) return { kind: "not-enforced", reason: "no-runtime" }
  if (state.runtimeStatus === undefined) {
    const recorded = Date.parse(runtime.recordedAt)
    if (!Number.isFinite(recorded) || now - recorded > HEARTBEAT_STALE_MS) return { kind: "not-enforced", reason: "stale" }
  }
  if (!runtime.registered) return { kind: "not-enforced", reason: "not-registered" }
  if (runtime.storeState === "missing") {
    // No store yet and nothing saved: there is nothing to enforce, and nothing is unprotected.
    return state.guards.length === 0 && state.activations.length === 0
      ? { kind: "enforced", covered: covered(runtime) }
      : { kind: "not-enforced", reason: "store-missing" }
  }
  if (runtime.storeState === "invalid") return { kind: "not-enforced", reason: "store-invalid" }
  if (runtime.storeState !== "ready") return { kind: "not-enforced", reason: "store-unavailable" }
  // After a store reset the service revision can be lower than the plugin's, so any difference means catching up.
  if (runtime.revision === null || runtime.revision !== state.revision) return { kind: "catching-up", covered: covered(runtime) }
  return { kind: "enforced", covered: covered(runtime) }
}

const covered = (runtime: GuardRuntimeReport): string[] =>
  Array.isArray(runtime.coveredActions) ? runtime.coveredActions.filter((a): a is string => typeof a === "string") : []

type Tone = "success" | "neutral" | "warning" | "error"
type EnforcementKey = Enforcement["kind"] | Extract<Enforcement, { kind: "not-enforced" }>["reason"]

const MAY_BE_ACTIVE = "Existing rules may still be active."
const LOAD_PLUGIN = "Load this worktree version of td-opencode-plugin in OpenCode to register guard enforcement."

/**
 * Only a fresh report with `registered: false` proves that nothing is enforced.
 * A missing, old, or unreadable report only means the panel cannot confirm it.
 */
export const ENFORCEMENT_TEXT: Record<EnforcementKey, { title: string; body: string; tone: Tone }> = {
  enforced: { title: "Enforced by the plugin", body: "The plugin checks matching actions before they run in this location.", tone: "success" },
  "catching-up": {
    title: "Plugin is loading the latest change",
    body: "The plugin has not reported the newest guard change yet. It reads saved rules before the next permission-checked action.",
    tone: "neutral",
  },
  "not-enforced": { title: "Guard status unknown", body: MAY_BE_ACTIVE, tone: "warning" },
  "no-runtime": {
    title: "Enforcement not confirmed",
    body: `td-opencode-plugin has not reported from this location. ${LOAD_PLUGIN} ${MAY_BE_ACTIVE}`,
    tone: "warning",
  },
  "runtime-invalid": {
    title: "Enforcement not confirmed",
    body: `The plugin's status file for this location could not be read. ${MAY_BE_ACTIVE}`,
    tone: "warning",
  },
  "not-registered": {
    title: "Not enforced",
    body: `The plugin runs here, but its guard check is not registered. ${LOAD_PLUGIN}`,
    tone: "error",
  },
  stale: {
    title: "Enforcement not confirmed",
    body: `The plugin has not reported for more than a minute. OpenCode may be stopped here. ${MAY_BE_ACTIVE}`,
    tone: "warning",
  },
  "store-missing": {
    title: "Enforcement not confirmed",
    body: `The plugin cannot find the saved guard file. It keeps the rules it read last. ${MAY_BE_ACTIVE}`,
    tone: "warning",
  },
  "store-invalid": {
    title: "Guard file damaged",
    body: "The saved guard file is damaged. The plugin keeps its last valid rules, or blocks mutating actions when it has no valid copy. Repair the file before changing guards.",
    tone: "warning",
  },
  "store-unavailable": {
    title: "Enforcement not confirmed",
    body: `The plugin cannot read the saved guard file right now. ${MAY_BE_ACTIVE}`,
    tone: "warning",
  },
}

export const enforcementText = (value: Enforcement): { title: string; body: string; tone: Tone } =>
  value.kind === "not-enforced" ? ENFORCEMENT_TEXT[value.reason] : ENFORCEMENT_TEXT[value.kind]

/** Enabling a guard needs a plugin that confirmed it enforces guards here. */
export const canEnable = (value: Enforcement | null): boolean => value !== null && value.kind !== "not-enforced"

export type ActiveEntry = {
  activation: Activation
  guard: Guard | null
  /** What the plugin enforces: the snapshot taken at enable time, or else the saved guard. */
  label: string
  rules: readonly Rule[]
  /**
   * `direct`: turned on in this session. `inherited`: turned on in a parent session.
   * `unknown`: the parent chain is not known, so it may or may not reach this session.
   */
  relation: "direct" | "inherited" | "unknown"
  /** The service's view of this activation. `null` when the service sent none: the end is not known. */
  lifecycle: LifecycleView | null
  /** Still enforced. False only when the service says the request is proven ended. */
  enforcing: boolean
}

/** Activations that apply, or may apply, to this session: its own, inherited ones, and unknown ones. */
export const activeHere = (state: GuardState, sessionId: string | null): ActiveEntry[] => {
  if (!sessionId) return []
  const sessions = state.runtime?.sessions ?? []
  const byId = new Map(state.guards.map((guard) => [guard.id, guard]))
  // The service checked OpenCode's parent links for this session. Use its answer when it has one.
  const verified = state.effective && state.effective.sessionId === sessionId ? new Set(state.effective.activationIds) : null
  // The service's views are authoritative. Raw facts are never used to work out a phase here.
  const lifecycles = new Map(state.lifecycles.map((view) => [view.activationId, view]))
  const entries: ActiveEntry[] = []
  for (const activation of state.activations) {
    const relation = verified
      ? verified.has(activation.id)
        ? activation.sessionId === sessionId
          ? "direct"
          : "inherited"
        : "none"
      : activationRelationship(activation.sessionId, sessionId, sessions)
    if (relation === "none") continue
    const guard = byId.get(activation.guardId) ?? null
    const lifecycle = lifecycles.get(activation.id) ?? null
    entries.push({
      activation,
      guard,
      label: activation.snapshot?.label ?? guard?.label ?? "Deleted guard",
      rules: activation.snapshot?.rules ?? guard?.rules ?? [],
      relation,
      lifecycle,
      enforcing: !(lifecycle?.phase === "ended" && lifecycle.releasable),
    })
  }
  const order = { direct: 0, inherited: 1, unknown: 2 }
  return entries.sort((a, b) => order[a.relation] - order[b.relation] || a.activation.createdAt.localeCompare(b.activation.createdAt))
}

/**
 * Ids of activations the service proves ended. Only a view with phase `ended` and `releasable: true` counts.
 * A missing or malformed view proves nothing, and raw facts are never read here.
 */
const provenEnded = (state: GuardState): Set<string> =>
  new Set(
    (Array.isArray(state.lifecycles) ? state.lifecycles : [])
      .filter((view) => view?.phase === "ended" && view.releasable === true)
      .map((view) => view.activationId),
  )

/** Activations of one guard that are still enforced: stored rows minus the ones the service proves ended. */
export const enforcedActivationCount = (state: GuardState, guardId: string): number => {
  const ended = provenEnded(state)
  return state.activations.filter((a) => a.guardId === guardId && !ended.has(a.id)).length
}

/**
 * Distinct sessions where one guard is still enforced and not listed for the current session. One session can hold
 * both a session and a request activation, so this counts anchor sessions, not rows.
 */
export const otherSessionCount = (state: GuardState, guardId: string, here: readonly ActiveEntry[]): number => {
  const local = new Set(here.map((entry) => entry.activation.id))
  const ended = provenEnded(state)
  return new Set(state.activations.filter((a) => a.guardId === guardId && !local.has(a.id) && !ended.has(a.id)).map((a) => a.sessionId)).size
}

/** Where the guard applies, for example `This session and its subagents`. */
export const scopeText = (entry: ActiveEntry): string => {
  if (entry.relation === "unknown") return "Turned on in another session. It may reach this session as a subagent."
  const base = entry.activation.scope === "request" ? "This request and its subagents" : "This session and its subagents"
  return entry.relation === "inherited" ? `${base} · turned on in a parent session` : base
}

const REQUEST_END =
  "The plugin releases it after confirming this run and its linked subagents ended. If completion is uncertain, it stays on until you release it."

/** A request guard whose end the service cannot confirm. It stays on until the user releases it. */
export const endUnconfirmed = (entry: ActiveEntry): boolean => {
  if (entry.activation.scope !== "request" || !entry.enforcing) return false
  const view = entry.lifecycle
  return !view || view.phase === "uncertain" || view.trust !== "ok"
}

export const lifecycleNote = (entry: ActiveEntry): string | null => {
  const view = entry.lifecycle
  if (entry.activation.scope !== "request") return null
  if (!view) return "The service did not report whether this request ended, so the guard stays on until the plugin confirms it or you release it."
  if (view.phase === "ended" && view.releasable) return "The request finished, so this guard no longer applies. It is removed at the next change."
  if (view.trust === "unverified-end") return "The plugin reported an end it could not confirm, so the guard stays on until you release it."
  if (view.trust === "history-truncated") return "Older plugin history is not available, so the end cannot be confirmed. The guard stays on until you release it."
  if (view.phase === "uncertain") return "The plugin could not confirm when this request ends, so the guard stays on until you release it."
  return REQUEST_END
}

export const EXPIRY_CHOICES: ReadonlyArray<{ id: string; label: string; minutes: number }> = [
  { id: "15", label: "15 minutes", minutes: 15 },
  { id: "30", label: "30 minutes", minutes: 30 },
  { id: "60", label: "1 hour", minutes: 60 },
  { id: "120", label: "2 hours", minutes: 120 },
  { id: "240", label: "4 hours", minutes: 240 },
  { id: "480", label: "8 hours", minutes: 480 },
]
