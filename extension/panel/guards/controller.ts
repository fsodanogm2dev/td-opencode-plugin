/**
 * State of the Guards tab. Every change to saved guards goes through the local
 * service, and only after a user click. The controller never calls the model
 * unless the user selects Generate, and never touches sessions or prompts.
 *
 * Reads carry a number, and answers for an older location or session are
 * dropped. A read that returns an older revision than a change the user just
 * made is dropped too, and read again.
 */
import type { GenerateRequest, GenerateResult, LateGenerateResult } from "@openchamber/sdk"

import { generationRequest, readGeneration, REQUEST_MAX } from "./generation.ts"
import { GUARD_SYSTEM_PROMPT } from "./prompt.ts"
import type { ActivationRequest, GuardService, GuardState, Mutation, ServiceFailure, ServiceResult } from "./service.ts"
import { newOpId } from "./service.ts"
import type { Draft } from "./shared.ts"

export type LoadState =
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "ready"; data: GuardState; refreshFailure: ServiceFailure | null }
  | { kind: "error"; failure: ServiceFailure }

export type DraftState =
  | { kind: "idle" }
  | { kind: "generating"; request: string }
  | { kind: "preview"; request: string; draft: Draft; late: boolean }
  | { kind: "unsupported"; request: string; reason: string }
  | { kind: "invalid"; request: string; reason: string; details: readonly string[] }
  | { kind: "failed"; request: string; code: string }

export type OpKind = "save" | "delete" | "enable" | "release" | "recover"

export type Op = {
  key: string
  kind: OpKind
  opId: string
  status: "pending" | "unclear" | "failed"
  failure: ServiceFailure | null
}

export type EnableForm = {
  guardId: string
  scope: "session" | "request"
  /** The user turned on an automatic end. `minutes` stays null until they pick a time. */
  expiry: boolean
  minutes: number | null
}

export type GuardsState = {
  directory: string | null | undefined
  sessionId: string | null
  load: LoadState
  draft: DraftState
  ops: Record<string, Op>
  enable: EnableForm | null
  confirmDelete: string | null
  /** Short message for the screen-reader live region. */
  notice: string
  /** The service reported a damaged guard store (`STORE_CORRUPT`). */
  storeCorrupt: boolean
  /** The user opened the reset confirmation. Nothing is sent until they confirm. */
  confirmRecover: boolean
  /** The last reset succeeded. `backup` is the file name the service reported. */
  recovered: { backup: string | null } | null
}

export type GuardsDeps = {
  service: GuardService
  generate: (request: GenerateRequest) => Promise<GenerateResult>
  onChange: (state: GuardsState) => void
  opId?: () => string
}

export type GuardsController = {
  setContext: (context: { directory: string | null; sessionId: string | null }) => void
  refresh: () => void
  generate: (text: string) => void
  lateGeneration: (late: LateGenerateResult) => void
  discardDraft: () => void
  save: () => void
  startEnable: (guardId: string) => void
  updateEnable: (patch: Partial<Omit<EnableForm, "guardId">>) => void
  cancelEnable: () => void
  confirmEnable: () => void
  askDelete: (guardId: string) => void
  cancelDelete: () => void
  confirmDelete: (guardId: string) => void
  release: (activationId: string) => void
  askRecover: () => void
  cancelRecover: () => void
  confirmRecover: () => void
  dismissRecovered: () => void
  retry: (key: string) => void
  dismiss: (key: string) => void
  state: () => GuardsState
  dispose: () => void
}

const hostCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN"

export const createGuardsController = (deps: GuardsDeps): GuardsController => {
  const makeOpId = deps.opId ?? (() => newOpId())
  let state: GuardsState = {
    directory: undefined,
    sessionId: null,
    load: { kind: "waiting" },
    draft: { kind: "idle" },
    ops: {},
    enable: null,
    confirmDelete: null,
    notice: "",
    storeCorrupt: false,
    confirmRecover: false,
    recovered: null,
  }
  let disposed = false
  let ticket = 0
  let generation = 0
  /** Highest revision a change of ours returned. An older read is out of date. */
  let revisionFloor = -1
  type Runner = { call: () => Promise<ServiceResult<Mutation>>; after?: (result: Mutation) => Partial<GuardsState> }
  const runners = new Map<string, Runner>()

  const set = (patch: Partial<GuardsState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    deps.onChange(state)
  }

  const read = async () => {
    if (state.directory === undefined) return
    const mine = ++ticket
    const context = { directory: state.directory, sessionId: state.sessionId }
    const result = await deps.service.state(context)
    if (disposed || mine !== ticket) return
    if (state.directory !== context.directory || state.sessionId !== context.sessionId) return
    if (result.ok) {
      if (result.data.revision < revisionFloor) {
        // The service answered before it saw our own change. Ask again.
        void read()
        return
      }
      set({ load: { kind: "ready", data: result.data, refreshFailure: null }, storeCorrupt: false })
      return
    }
    const storeCorrupt = result.failure.code === "STORE_CORRUPT" || (state.storeCorrupt && result.failure.kind !== "rejected")
    if (state.load.kind === "ready") set({ load: { ...state.load, refreshFailure: result.failure }, storeCorrupt })
    else set({ load: { kind: "error", failure: result.failure }, storeCorrupt })
  }

  const setOp = (key: string, op: Op | null) => {
    const ops = { ...state.ops }
    if (op) ops[key] = op
    else delete ops[key]
    return ops
  }

  const NOTICES: Record<OpKind, string> = {
    save: "Guard saved. It is off until you turn it on.",
    delete: "Guard deleted.",
    enable: "Guard turned on.",
    release: "Guard released.",
    recover: "Guard store reset.",
  }

  const run = async (key: string, kind: OpKind, opId: string) => {
    const runner = runners.get(key)
    if (!runner) return
    set({ ops: setOp(key, { key, kind, opId, status: "pending", failure: null }) })
    const result = await runner.call()
    // The user discarded the operation while it ran.
    if (runners.get(key) !== runner && !result.ok) return
    const after = runner.after
    if (disposed) return
    if (result.ok) {
      runners.delete(key)
      // A reset may start a new, lower revision series, so it does not raise the floor.
      revisionFloor = kind === "recover" ? -1 : Math.max(revisionFloor, result.data.revision)
      set({ ops: setOp(key, null), notice: NOTICES[kind], ...(after ? after(result.data) : {}) })
      void read()
      return
    }
    if (kind === "recover" && result.failure.code === "RECOVERY_NOT_NEEDED") {
      // The store is readable again. Show it instead of resetting.
      runners.delete(key)
      set({ ops: setOp(key, null), confirmRecover: false, storeCorrupt: false, notice: "The guard store is readable. Nothing was reset." })
      void read()
      return
    }
    if (result.failure.code === "STORE_CORRUPT") set({ storeCorrupt: true })
    const status = result.failure.kind === "unclear" ? "unclear" : "failed"
    if (status === "failed") runners.delete(key)
    set({ ops: setOp(key, { key, kind, opId, status, failure: result.failure }) })
    // A refusal can mean another window changed the guards. Show the current list.
    if (result.failure.kind === "rejected") void read()
  }

  /** Starts a new operation, or does nothing when the same one is still pending or unclear. */
  const start = (
    key: string,
    kind: OpKind,
    call: (opId: string) => Promise<ServiceResult<Mutation>>,
    after?: (result: Mutation) => Partial<GuardsState>,
  ) => {
    const existing = state.ops[key]
    if (existing && existing.status !== "failed") return
    const opId = makeOpId()
    runners.set(key, { call: () => call(opId), ...(after ? { after } : {}) })
    void run(key, kind, opId)
  }

  return {
    setContext: ({ directory, sessionId }) => {
      if (disposed) return
      if (state.directory === directory && state.sessionId === sessionId) return
      const firstRead = state.load.kind === "waiting"
      // The enable form belongs to the session it was opened in.
      const enable = state.sessionId === sessionId ? state.enable : null
      ticket += 1
      set({ directory, sessionId, enable, load: firstRead || state.directory !== directory ? { kind: "loading" } : state.load })
      void read()
    },
    refresh: () => {
      if (!disposed) void read()
    },
    generate: (text) => {
      const request = text.trim()
      if (!request || request.length > REQUEST_MAX || state.draft.kind === "generating") return
      const mine = ++generation
      set({ draft: { kind: "generating", request }, notice: "" })
      deps.generate(generationRequest(request)).then(
        (result) => {
          if (disposed || mine !== generation) return
          const outcome = readGeneration(request, result.text)
          set({
            draft:
              outcome.kind === "draft"
                ? { kind: "preview", request, draft: outcome.draft, late: false }
                : { ...outcome, request },
            notice: outcome.kind === "draft" ? "Preview ready." : "The guard could not be created.",
          })
        },
        (error: unknown) => {
          if (disposed || mine !== generation) return
          set({ draft: { kind: "failed", request, code: hostCode(error) }, notice: "The Small Model did not answer." })
        },
      )
    },
    lateGeneration: (late) => {
      // Only answers to this panel's own guard prompt, and only when nothing else is on screen.
      if (disposed || late.request.system !== GUARD_SYSTEM_PROMPT || state.draft.kind !== "idle") return
      const request = late.request.prompt.trim()
      if (!request || request.length > REQUEST_MAX) return
      if (!late.ok) {
        set({ draft: { kind: "failed", request, code: late.code } })
        return
      }
      const outcome = readGeneration(request, late.result.text)
      set({
        draft:
          outcome.kind === "draft"
            ? { kind: "preview", request, draft: outcome.draft, late: true }
            : { ...outcome, request },
      })
    },
    discardDraft: () => {
      generation += 1
      runners.delete("save")
      set({ draft: { kind: "idle" }, ops: setOp("save", null) })
    },
    save: () => {
      const draft = state.draft
      if (draft.kind !== "preview") return
      start("save", "save", (opId) => deps.service.saveGuard(opId, draft.draft), () => ({ draft: { kind: "idle" } }))
    },
    startEnable: (guardId) => {
      if (!state.sessionId) return
      // Session scope and no automatic end are the defaults.
      set({ enable: { guardId, scope: "session", expiry: false, minutes: null }, confirmDelete: null })
    },
    updateEnable: (patch) => {
      if (!state.enable) return
      const next = { ...state.enable, ...patch }
      if (!next.expiry) next.minutes = null
      set({ enable: next })
    },
    cancelEnable: () => set({ enable: null }),
    confirmEnable: () => {
      const form = state.enable
      const sessionId = state.sessionId
      if (!form || !sessionId) return
      if (form.expiry && form.minutes === null) return
      const request: ActivationRequest = {
        guardId: form.guardId,
        sessionId,
        scope: form.scope,
        ...(form.expiry && form.minutes !== null ? { expiresInMinutes: form.minutes } : {}),
      }
      start(`enable:${form.guardId}`, "enable", (opId) => deps.service.activate(opId, request), () => ({ enable: null }))
    },
    askDelete: (guardId) => set({ confirmDelete: guardId, enable: null }),
    cancelDelete: () => set({ confirmDelete: null }),
    confirmDelete: (guardId) => {
      if (state.confirmDelete !== guardId) return
      start(`delete:${guardId}`, "delete", (opId) => deps.service.deleteGuard(opId, guardId), () => ({ confirmDelete: null }))
    },
    release: (activationId) => {
      start(`release:${activationId}`, "release", (opId) => deps.service.release(opId, activationId))
    },
    askRecover: () => {
      if (state.storeCorrupt) set({ confirmRecover: true })
    },
    cancelRecover: () => {
      const op = state.ops.recover
      // An unclear reset stays on screen so the user can retry it with the same request.
      if (op && op.status !== "failed") return
      runners.delete("recover")
      set({ confirmRecover: false, ops: setOp("recover", null) })
    },
    confirmRecover: () => {
      if (!state.confirmRecover) return
      start("recover", "recover", (opId) => deps.service.recoverStore(opId), (result) => ({
        confirmRecover: false,
        storeCorrupt: false,
        recovered: { backup: typeof result.data.backup === "string" ? result.data.backup : null },
      }))
    },
    dismissRecovered: () => set({ recovered: null }),
    retry: (key) => {
      const op = state.ops[key]
      // Only an unclear result is retried, with the same operation ID.
      if (!op || op.status !== "unclear") return
      void run(key, op.kind, op.opId)
    },
    dismiss: (key) => {
      runners.delete(key)
      set({ ops: setOp(key, null) })
    },
    state: () => state,
    dispose: () => {
      disposed = true
      ticket += 1
      generation += 1
    },
  }
}
