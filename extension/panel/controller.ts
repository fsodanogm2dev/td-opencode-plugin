/**
 * Reads the report for the current location and keeps the latest result.
 * Reading never writes and never runs a model check.
 *
 * Every read carries a number. A result whose number is not the latest one
 * (the user switched location or reloaded again) is discarded.
 *
 * A model check runs only when the user selects Check models now:
 * 1. The injected `requestCheck` asks the extension service for a check and gets a `requestId`.
 * 2. The panel reads the saved report again every `checkPollMs`, up to `checkTimeoutMs`.
 * 3. A report whose `lastCheck.requestId` is that ID shows the check running (`checking: true`),
 *    then its result (`checking: false`). Only the newest request runs; an older ID may never appear.
 * This module has no network access of its own.
 */
import { reportPath as defaultReportPath } from "./hash.ts"
import { matchesLocation, parseReport, type LastCheck, type StatusReport } from "./report.ts"

export type ReportReader = { readFile: (path: string) => Promise<{ content: string }> }

/**
 * Why the service did not accept a check.
 * - `rejected`: the service answered and refused.
 * - `unclear`: no usable answer. The service may have passed the check on.
 * - `host`: OpenChamber refused before the service saw the request.
 */
export type ManualCheckFailure = {
  kind: "rejected" | "unclear" | "host"
  code: string
  /** Fixed text from the service, or empty. Shown as text, never as HTML. */
  message: string
}

export type CheckRequestAnswer =
  | { ok: true; requestId: string; requestedAt: string }
  | { ok: false; failure: ManualCheckFailure }

/** Asks the extension service for a model check. `main.ts` binds it to `POST /model-check`. */
export type CheckRequester = () => Promise<CheckRequestAnswer>

export type ManualCheckState =
  | { kind: "idle" }
  /** Sent, or accepted with no matching report yet. `requestId` is `null` until the service answers. */
  | { kind: "requested"; directory: string | null; requestId: string | null }
  | { kind: "running"; directory: string | null; requestId: string }
  | { kind: "done"; directory: string | null; requestId: string; check: LastCheck }
  /** The service did not accept the check. */
  | { kind: "failed"; directory: string | null; failure: ManualCheckFailure; at: string }
  /** No report with this `requestId` arrived in time. */
  | { kind: "timeout"; directory: string | null; requestId: string; at: string }

export const isCheckInFlight = (
  state: ManualCheckState,
): state is Extract<ManualCheckState, { kind: "requested" | "running" }> => state.kind === "requested" || state.kind === "running"

/** How often the panel reads the report while it waits for a check. */
export const CHECK_POLL_MS = 1_500
/** How long the panel waits for a report with the check's `requestId`: `CHECK_TIMEOUT_MS / CHECK_POLL_MS` reads. */
export const CHECK_TIMEOUT_MS = 45_000

export type LoadedBase = {
  directory: string | null
  path: string
  /** A manual reload is in progress. */
  reloading: boolean
}

export type PanelState =
  | { kind: "connecting" }
  | { kind: "no-host"; reason: "not-embedded" | "no-answer" | "closed" }
  | { kind: "loading"; directory: string | null }
  | (LoadedBase & {
      kind: "report"
      report: StatusReport
      content: string
      /** Error code of the latest reload that failed while an earlier copy stays on screen. */
      reloadError: string | null
    })
  | (LoadedBase & { kind: "missing" })
  | (LoadedBase & { kind: "invalid"; problem: "malformed" | "unsupported" | "other-location"; version: string | null })
  | (LoadedBase & { kind: "error"; code: string })

export type ChangeCause = "directory" | "reload" | "poll" | "host" | "check"

export type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type ControllerOptions = {
  reader: ReportReader
  onChange: (state: PanelState, cause: ChangeCause) => void
  reportPath?: (directory: string | null) => Promise<string>
  /** Requests a model check. Without it, `checkNow` does nothing. */
  requestCheck?: CheckRequester
  onCheckChange?: (check: ManualCheckState) => void
  checkPollMs?: number
  checkTimeoutMs?: number
  /** Test seams. */
  now?: () => number
  timers?: Timers
}

export type Controller = {
  /** Read the report for this location. The same location again does nothing. */
  setDirectory: (directory: string | null) => void
  /** Read the current location's report again. `quiet` keeps the button idle (polling). */
  reload: (options?: { quiet?: boolean }) => void
  /** Request a model check. Only one runs at a time; a click while one is in flight does nothing. */
  checkNow: () => void
  /** Whether a requester is wired and the panel knows its location. */
  canCheck: () => boolean
  check: () => ManualCheckState
  noHost: (reason: "not-embedded" | "no-answer" | "closed") => void
  state: () => PanelState
  dispose: () => void
}

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code
  }
  return "UNKNOWN"
}

/** A stable key of what the view shows, so identical polls do not repaint. */
export const stateKey = (state: PanelState): string => {
  switch (state.kind) {
    case "connecting":
      return "connecting"
    case "no-host":
      return `no-host:${state.reason}`
    case "loading":
      return `loading:${state.directory}`
    case "report":
      return `report:${state.directory}:${state.reloading}:${state.reloadError}:${state.content}`
    case "missing":
      return `missing:${state.directory}:${state.reloading}`
    case "invalid":
      return `invalid:${state.directory}:${state.reloading}:${state.problem}:${state.version}`
    case "error":
      return `error:${state.directory}:${state.reloading}:${state.code}`
  }
}

const defaultTimers: Timers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export const createController = (options: ControllerOptions): Controller => {
  const toPath = options.reportPath ?? defaultReportPath
  const clock = options.now ?? (() => Date.now())
  const timers = options.timers ?? defaultTimers
  const pollMs = options.checkPollMs ?? CHECK_POLL_MS
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  let current: PanelState = { kind: "connecting" }
  let directory: string | null | undefined
  let latest = 0
  let disposed = false
  let lastKey = stateKey(current)

  let manual: ManualCheckState = { kind: "idle" }
  let checkTicket = 0
  /** Reads left before the check times out. */
  let pollsLeft = 0
  let pollTimer: unknown = null

  const setCheck = (next: ManualCheckState) => {
    if (disposed) return
    manual = next
    options.onCheckChange?.(next)
  }

  const stopPolling = () => {
    if (pollTimer !== null) timers.clearTimeout(pollTimer)
    pollTimer = null
  }

  /** Ends any check in flight without a result, for example when the location changes. */
  const cancelCheck = () => {
    checkTicket += 1
    stopPolling()
    if (manual.kind !== "idle") setCheck({ kind: "idle" })
  }

  /** Moves a check in flight forward when a report names its `requestId`. */
  const inspect = (report: StatusReport, target: string | null) => {
    if (!isCheckInFlight(manual) || manual.directory !== target) return
    const requestId = manual.requestId
    const last = report.lastCheck
    if (requestId === null || !last || last.requestId !== requestId) return
    // While `checking` is true, `trigger` and `requestId` name the running check; the other fields are the previous result.
    if (report.checking) {
      if (manual.kind !== "running") setCheck({ kind: "running", directory: target, requestId })
      return
    }
    stopPolling()
    setCheck({ kind: "done", directory: target, requestId, check: last })
  }

  const set = (next: PanelState, cause: ChangeCause) => {
    if (disposed) return
    current = next
    const key = stateKey(next)
    if (key === lastKey) return
    lastKey = key
    options.onChange(next, cause)
  }

  const read = async (target: string | null, cause: "directory" | "reload" | "poll" | "check") => {
    const ticket = ++latest
    const previous = current
    const stillLatest = () => !disposed && ticket === latest && directory === target
    let path = ""
    try {
      path = await toPath(target)
      if (!stillLatest()) return
      const { content } = await options.reader.readFile(path)
      if (!stillLatest()) return
      const parsed = parseReport(content)
      const base: LoadedBase = { directory: target, path, reloading: false }
      if (!parsed.ok) {
        set(
          { ...base, kind: "invalid", problem: parsed.problem, version: parsed.problem === "unsupported" ? parsed.version : null },
          cause,
        )
        return
      }
      if (!matchesLocation(parsed.report.directory, target)) {
        set({ ...base, kind: "invalid", problem: "other-location", version: null }, cause)
        return
      }
      set({ ...base, kind: "report", report: parsed.report, content, reloadError: null }, cause)
      // Any read can carry the check's result: a poll, a reload, or the regular refresh.
      inspect(parsed.report, target)
    } catch (error) {
      if (!stillLatest()) return
      const code = errorCode(error)
      const base: LoadedBase = { directory: target, path, reloading: false }
      const keepCopy = cause !== "directory" && previous.kind === "report" && previous.directory === target
      // A read while a check is in flight never replaces the copy on screen and never adds a banner per poll.
      if (cause === "check" && keepCopy) return
      if (code === "NOT_FOUND") {
        set({ ...base, kind: "missing" }, cause)
        return
      }
      // A failed reload keeps the copy already on screen and says the reload failed.
      if (keepCopy) {
        set({ ...previous, reloading: false, reloadError: code }, cause)
        return
      }
      set({ ...base, kind: "error", code }, cause)
    }
  }

  const schedulePoll = (ticket: number, target: string | null) => {
    pollTimer = timers.setTimeout(() => {
      pollTimer = null
      void pollOnce(ticket, target)
    }, pollMs)
  }

  const pollOnce = async (ticket: number, target: string | null) => {
    if (disposed || ticket !== checkTicket || !isCheckInFlight(manual)) return
    await read(target, "check")
    if (disposed || ticket !== checkTicket || !isCheckInFlight(manual)) return
    pollsLeft -= 1
    if (pollsLeft <= 0) {
      if (manual.requestId !== null) {
        setCheck({ kind: "timeout", directory: target, requestId: manual.requestId, at: new Date(clock()).toISOString() })
      }
      return
    }
    schedulePoll(ticket, target)
  }

  const runCheck = async (requestCheck: CheckRequester, target: string | null) => {
    const ticket = ++checkTicket
    setCheck({ kind: "requested", directory: target, requestId: null })
    let answer: CheckRequestAnswer
    try {
      answer = await requestCheck()
    } catch (error) {
      answer = { ok: false, failure: { kind: "unclear", code: errorCode(error), message: "" } }
    }
    if (disposed || ticket !== checkTicket || directory !== target) return
    if (!answer.ok) {
      setCheck({ kind: "failed", directory: target, failure: answer.failure, at: new Date(clock()).toISOString() })
      return
    }
    pollsLeft = Math.max(1, Math.ceil(timeoutMs / pollMs))
    setCheck({ kind: "requested", directory: target, requestId: answer.requestId })
    // The report on screen may already name this request.
    if (current.kind === "report" && current.directory === target) inspect(current.report, target)
    if (isCheckInFlight(manual)) schedulePoll(ticket, target)
  }

  const canCheck = () =>
    !disposed &&
    options.requestCheck !== undefined &&
    directory !== undefined &&
    current.kind !== "no-host" &&
    current.kind !== "connecting"

  return {
    setDirectory: (next) => {
      if (disposed) return
      if (directory === next && current.kind !== "no-host" && current.kind !== "connecting") return
      if (directory !== next) cancelCheck()
      directory = next
      set({ kind: "loading", directory: next }, "directory")
      void read(next, "directory")
    },
    reload: (opts = {}) => {
      if (disposed || directory === undefined) return
      const target = directory
      if (!opts.quiet && current.kind !== "loading" && current.kind !== "connecting" && current.kind !== "no-host") {
        set({ ...current, reloading: true }, "reload")
      }
      void read(target, opts.quiet ? "poll" : "reload")
    },
    checkNow: () => {
      if (!canCheck() || isCheckInFlight(manual)) return
      void runCheck(options.requestCheck!, directory ?? null)
    },
    canCheck,
    check: () => manual,
    noHost: (reason) => {
      latest += 1
      cancelCheck()
      set({ kind: "no-host", reason }, "host")
    },
    state: () => current,
    dispose: () => {
      disposed = true
      latest += 1
      checkTicket += 1
      stopPolling()
    },
  }
}
