import { describe, expect, test } from "bun:test"

import type { GuardState } from "../../panel/guards/service.ts"
import type { LifecycleView } from "../../panel/guards/shared.ts"
import {
  activeHere,
  canEnable,
  endUnconfirmed,
  enforcedActivationCount,
  enforcement,
  enforcementText,
  lifecycleNote,
  otherSessionCount,
  scopeText,
} from "../../panel/guards/state.ts"
import { NOW } from "../support/fixtures.ts"
import { CHILD, guard, iso, OTHER_SESSION, runtime, SESSION } from "../support/guard-service.ts"

const base = (patch: Partial<GuardState> = {}): GuardState => ({
  revision: 0,
  guards: [guard()],
  activations: [],
  runtime: runtime(),
  lifecycle: [],
  lifecycles: [],
  ...patch,
})

const activation = (patch: Record<string, unknown> = {}) => ({
  id: "a_1",
  guardId: "g_commits",
  sessionId: SESSION,
  scope: "session" as const,
  createdAt: iso(-60_000),
  expiresAt: null,
  ...patch,
})

describe("enforcement status", () => {
  test("enforced only with a fresh, registered, ready runtime report", () => {
    expect(enforcement(base(), NOW)).toMatchObject({ kind: "enforced" })
  })

  test("no runtime report is unknown, not a definite Not enforced", () => {
    const value = enforcement(base({ runtime: null }), NOW)
    expect(value).toEqual({ kind: "not-enforced", reason: "no-runtime" })
    expect(enforcementText(value)).toMatchObject({ title: "Enforcement not confirmed", tone: "warning" })
    expect(enforcementText(value).body).toContain("Existing rules may still be active.")
    expect(canEnable(value)).toBe(false)
  })

  test("only registered: false says Not enforced", () => {
    const value = enforcement(base({ runtime: runtime({ registered: false }) }), NOW)
    expect(enforcementText(value)).toMatchObject({ title: "Not enforced", tone: "error" })
    for (const reason of ["stale", "runtime-invalid", "store-missing", "store-unavailable", "store-invalid"] as const) {
      expect(enforcementText({ kind: "not-enforced", reason }).title).not.toBe("Not enforced")
    }
    expect(enforcementText({ kind: "not-enforced", reason: "store-invalid" }).body).toBe(
      "The saved guard file is damaged. The plugin keeps its last valid rules, or blocks mutating actions when it has no valid copy. Repair the file before changing guards.",
    )
    expect(canEnable(enforcement(base(), NOW))).toBe(true)
    expect(canEnable(enforcement(base({ revision: 3, runtime: runtime({ revision: 2 }) }), NOW))).toBe(true)
  })

  test("a report older than 60 seconds is not enforced", () => {
    expect(enforcement(base({ runtime: runtime({ recordedAt: iso(-61_000) }) }), NOW)).toEqual({ kind: "not-enforced", reason: "stale" })
    expect(enforcement(base({ runtime: runtime({ recordedAt: iso(-59_000) }) }), NOW).kind).toBe("enforced")
  })

  test("a hook that is not registered is not enforced", () => {
    expect(enforcement(base({ runtime: runtime({ registered: false }) }), NOW)).toEqual({ kind: "not-enforced", reason: "not-registered" })
  })

  test("store problems are not enforced", () => {
    expect(enforcement(base({ runtime: runtime({ storeState: "invalid" }) }), NOW)).toMatchObject({ reason: "store-invalid" })
    expect(enforcement(base({ runtime: runtime({ storeState: "unavailable" }) }), NOW)).toMatchObject({ reason: "store-unavailable" })
    expect(enforcement(base({ runtime: runtime({ storeState: "missing" }) }), NOW)).toMatchObject({ reason: "store-missing" })
  })

  test("the service's runtime status wins over the panel clock", () => {
    expect(enforcement(base({ runtimeStatus: "stale", runtime: null }), NOW)).toEqual({ kind: "not-enforced", reason: "stale" })
    expect(enforcement(base({ runtimeStatus: "invalid", runtime: null }), NOW)).toEqual({ kind: "not-enforced", reason: "runtime-invalid" })
    expect(enforcement(base({ runtimeStatus: "missing", runtime: null }), NOW)).toEqual({ kind: "not-enforced", reason: "no-runtime" })
    // A live report is trusted even if the panel clock is ahead.
    expect(enforcement(base({ runtimeStatus: "live", runtime: runtime({ recordedAt: iso(-90_000) }) }), NOW).kind).toBe("enforced")
  })

  test("any revision difference is catching up, including a higher plugin revision after a reset", () => {
    expect(enforcement(base({ revision: 3, runtime: runtime({ revision: 2 }) }), NOW).kind).toBe("catching-up")
    expect(enforcement(base({ revision: 1, runtime: runtime({ revision: 9 }) }), NOW).kind).toBe("catching-up")
    expect(enforcement(base({ revision: 4, runtime: runtime({ revision: 4 }) }), NOW).kind).toBe("enforced")
  })
})

describe("guards active in this session", () => {
  test("direct, inherited, unknown, and unrelated activations", () => {
    const state = base({
      activations: [
        activation({ id: "a_direct" }),
        activation({ id: "a_other", sessionId: OTHER_SESSION }),
      ],
    })
    expect(activeHere(state, SESSION).map((e) => [e.activation.id, e.relation])).toEqual([["a_direct", "direct"]])
    expect(activeHere(state, CHILD).map((e) => [e.activation.id, e.relation])).toEqual([["a_direct", "inherited"]])
    // A session the plugin has not reported cannot be placed, so nothing is promised.
    expect(activeHere(state, "ses_unreported").map((e) => e.relation)).toEqual(["unknown", "unknown"])
    expect(activeHere(state, null)).toEqual([])
  })

  test("the service's verified chain decides direct and inherited", () => {
    const state = base({
      activations: [activation({ id: "a_root" }), activation({ id: "a_other", sessionId: OTHER_SESSION })],
      runtime: runtime({ sessions: [] }),
      effective: { sessionId: "ses_deep", rootSessionId: SESSION, activationIds: ["a_root"] },
      bridge: "ok",
    })
    expect(activeHere(state, "ses_deep").map((e) => [e.activation.id, e.relation])).toEqual([["a_root", "inherited"]])
  })

  test("without a verified chain, unknown sessions stay unknown", () => {
    const state = base({ activations: [activation()], runtime: runtime({ sessions: [] }), effective: null, bridge: "unavailable" })
    expect(activeHere(state, "ses_deep").map((e) => e.relation)).toEqual(["unknown"])
  })

  test("the enable-time snapshot is what the panel shows as enforced", () => {
    const state = base({
      activations: [activation({ snapshot: { label: "Commits blocked (snapshot)", message: "m", rules: [{ kind: "command", program: "git" }] } })],
    })
    const [entry] = activeHere(state, SESSION)
    expect(entry?.label).toBe("Commits blocked (snapshot)")
    expect(entry?.rules).toEqual([{ kind: "command", program: "git" }])
  })

  test("request scope follows the service's view, not the raw facts", () => {
    const view = (patch: Partial<LifecycleView> = {}): LifecycleView => ({
      activationId: "a_1",
      phase: "bound",
      reason: "running-tracked",
      instance: "inst_1",
      releasable: false,
      conflict: false,
      trust: "ok",
      ...patch,
    })
    const ended = [
      { activationId: "a_1", fact: "bound", at: iso(), reason: "running-tracked", instance: "inst_1" },
      { activationId: "a_1", fact: "ended", at: iso(), reason: "request-completed", instance: "inst_1" },
    ] as GuardState["lifecycle"]
    const entry = (lifecycles: LifecycleView[], lifecycle: GuardState["lifecycle"] = []) =>
      activeHere(base({ activations: [activation({ scope: "request" })], lifecycle, lifecycles }), SESSION)[0]!

    // Raw facts prove an end, but the service says bound: the panel keeps it enforced.
    const bound = entry([view()], ended)
    expect(bound.enforcing).toBe(true)
    expect(lifecycleNote(bound)).toBe(
      "The plugin releases it after confirming this run and its linked subagents ended. If completion is uncertain, it stays on until you release it.",
    )
    // No raw facts, but the service proved the end: no longer enforcing.
    const done = entry([view({ phase: "ended", releasable: true, reason: "request-completed" })])
    expect(done.enforcing).toBe(false)
    expect(lifecycleNote(done)).toBe("The request finished, so this guard no longer applies. It is removed at the next change.")
    // One complete observer ends it even when another lost track.
    expect(entry([view({ phase: "ended", releasable: true, conflict: true })]).enforcing).toBe(false)

    // A missing view keeps it enforced with an unknown end.
    const missing = entry([], ended)
    expect(missing.lifecycle).toBeNull()
    expect(missing.enforcing).toBe(true)
    expect(endUnconfirmed(missing)).toBe(true)
    expect(lifecycleNote(missing)).toContain("did not report whether this request ended")

    const uncertain = entry([view({ phase: "uncertain", reason: "event-stream-lost" })])
    expect(endUnconfirmed(uncertain)).toBe(true)
    expect(lifecycleNote(uncertain)).toBe("The plugin could not confirm when this request ends, so the guard stays on until you release it.")
    expect(lifecycleNote(entry([view({ trust: "unverified-end" })]))).toContain("could not confirm")
    expect(lifecycleNote(entry([view({ phase: "pending", trust: "history-truncated" })]))).toContain("Older plugin history")
  })

  test("inherited request scope text", () => {
    const [entry] = activeHere(base({ activations: [activation({ scope: "request" })] }), CHILD)
    expect(scopeText(entry!)).toBe("This request and its subagents · turned on in a parent session")
  })

  test("session scope never ends on its own", () => {
    const [entry] = activeHere(
      base({ activations: [activation()], lifecycles: [{ activationId: "a_1", phase: "session", reason: null, instance: null, releasable: false, conflict: false, trust: "ok" }] }),
      SESSION,
    )
    expect(entry?.enforcing).toBe(true)
    expect(lifecycleNote(entry!)).toBeNull()
  })
})

describe("active elsewhere count", () => {
  const view = (activationId: string, patch: Partial<LifecycleView> = {}): LifecycleView => ({
    activationId,
    phase: "bound",
    reason: "running-tracked",
    instance: "inst_1",
    releasable: false,
    conflict: false,
    trust: "ok",
    ...patch,
  })
  const endedView = (id: string, patch: Partial<LifecycleView> = {}) =>
    view(id, { phase: "ended", reason: "request-completed", releasable: true, ...patch })
  const count = (state: GuardState) => otherSessionCount(state, "g_commits", activeHere(state, SESSION).filter((e) => e.enforcing))

  test("a completed request row that is still stored is not counted as active elsewhere", () => {
    const state = base({
      activations: [activation({ id: "a_done", scope: "request", sessionId: OTHER_SESSION })],
      lifecycles: [endedView("a_done")],
    })
    expect(count(state)).toBe(0)
    expect(enforcedActivationCount(state, "g_commits")).toBe(0)
    // The ended row is also not counted when the current session inherits it and it dropped out of the list.
    const here = base({ activations: [activation({ id: "a_done", scope: "request" })], lifecycles: [endedView("a_done")] })
    expect(count(here)).toBe(0)
    expect(enforcedActivationCount(here, "g_commits")).toBe(0)
  })

  test("an active request or session guard in another root is counted", () => {
    const state = base({
      activations: [
        activation({ id: "a_req", scope: "request", sessionId: OTHER_SESSION }),
        activation({ id: "a_ses", sessionId: "ses_other_2" }),
        activation({ id: "a_done", scope: "request", sessionId: "ses_other_3" }),
      ],
      lifecycles: [view("a_req"), view("a_ses", { phase: "session", reason: null, instance: null }), endedView("a_done")],
    })
    expect(count(state)).toBe(2)
    expect(enforcedActivationCount(state, "g_commits")).toBe(2)
  })

  test("only an ended view that is releasable ends it: uncertain, unverified, and not releasable stay counted", () => {
    const state = base({
      activations: ["a_unc", "a_unv", "a_nr", "a_pend"].map((id) => activation({ id, scope: "request", sessionId: `ses_${id}` })),
      lifecycles: [
        view("a_unc", { phase: "uncertain" }),
        view("a_unv", { trust: "unverified-end" }),
        endedView("a_nr", { releasable: false }),
        view("a_pend", { phase: "pending", reason: null, instance: null }),
      ],
    })
    expect(count(state)).toBe(4)
    expect(enforcedActivationCount(state, "g_commits")).toBe(4)
  })

  test("a missing view is counted, and raw ended facts cannot override the view", () => {
    const rawEnded = [
      { activationId: "a_raw", fact: "bound", at: iso(), reason: "running-tracked", instance: "inst_1" },
      { activationId: "a_raw", fact: "ended", at: iso(), reason: "request-completed", instance: "inst_1" },
    ] as GuardState["lifecycle"]
    const state = base({
      activations: [
        activation({ id: "a_raw", scope: "request", sessionId: OTHER_SESSION }),
        activation({ id: "a_bound", scope: "request", sessionId: "ses_other_2" }),
      ],
      lifecycle: rawEnded,
      lifecycles: [view("a_bound")],
    })
    expect(count(state)).toBe(2)
    expect(enforcedActivationCount(state, "g_commits")).toBe(2)
    // The raw facts also cannot hide a row whose view says bound.
    expect(count(base({ activations: [activation({ id: "a_raw", scope: "request", sessionId: OTHER_SESSION })], lifecycle: rawEnded, lifecycles: [view("a_raw")] }))).toBe(1)
  })

  test("malformed views prove nothing and do not throw", () => {
    const state = base({
      activations: [activation({ id: "a_1", scope: "request", sessionId: OTHER_SESSION })],
      lifecycles: [{ activationId: "other", phase: "ended", releasable: true }, { activationId: "a_1", phase: "ended", releasable: "yes" }, { activationId: "a_1", phase: "ENDED", releasable: true }] as unknown as LifecycleView[],
    })
    expect(count(state)).toBe(1)
  })

  test("one session with a session and a request activation counts once as a session, twice as rows", () => {
    const state = base({
      activations: [activation({ id: "a_ses", sessionId: OTHER_SESSION }), activation({ id: "a_req", scope: "request", sessionId: OTHER_SESSION })],
      lifecycles: [view("a_ses", { phase: "session", reason: null, instance: null }), view("a_req")],
    })
    expect(count(state)).toBe(1)
    expect(enforcedActivationCount(state, "g_commits")).toBe(2)
    // When the request row ends, the session row still keeps that session counted.
    const partly = base({ activations: state.activations, lifecycles: [view("a_ses", { phase: "session", reason: null, instance: null }), endedView("a_req")] })
    expect(count(partly)).toBe(1)
    expect(enforcedActivationCount(partly, "g_commits")).toBe(1)
  })

  test("other guards and the current session's own list are unaffected", () => {
    const state = base({
      guards: [guard(), guard({ id: "g_other" })],
      activations: [
        activation({ id: "a_mine" }),
        activation({ id: "a_x", guardId: "g_other", sessionId: OTHER_SESSION }),
        activation({ id: "a_y", sessionId: OTHER_SESSION }),
      ],
    })
    expect(count(state)).toBe(1)
    expect(otherSessionCount(state, "g_other", [])).toBe(1)
    expect(enforcedActivationCount(state, "g_commits")).toBe(2)
  })
})
