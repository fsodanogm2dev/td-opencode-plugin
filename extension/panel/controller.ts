/**
 * Reads the report for the current location and keeps the latest result.
 * It only reads: no write, no network, no model check.
 *
 * Every read carries a number. A result whose number is not the latest one
 * (the user switched location or reloaded again) is discarded.
 */
import { reportPath as defaultReportPath } from "./hash.ts"
import { matchesLocation, parseReport, type StatusReport } from "./report.ts"

export type ReportReader = { readFile: (path: string) => Promise<{ content: string }> }

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

export type ControllerOptions = {
  reader: ReportReader
  onChange: (state: PanelState, cause: "directory" | "reload" | "poll" | "host") => void
  reportPath?: (directory: string | null) => Promise<string>
}

export type Controller = {
  /** Read the report for this location. The same location again does nothing. */
  setDirectory: (directory: string | null) => void
  /** Read the current location's report again. `quiet` keeps the button idle (polling). */
  reload: (options?: { quiet?: boolean }) => void
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

export const createController = (options: ControllerOptions): Controller => {
  const toPath = options.reportPath ?? defaultReportPath
  let current: PanelState = { kind: "connecting" }
  let directory: string | null | undefined
  let latest = 0
  let disposed = false
  let lastKey = stateKey(current)

  const set = (next: PanelState, cause: "directory" | "reload" | "poll" | "host") => {
    if (disposed) return
    current = next
    const key = stateKey(next)
    if (key === lastKey) return
    lastKey = key
    options.onChange(next, cause)
  }

  const read = async (target: string | null, cause: "directory" | "reload" | "poll") => {
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
    } catch (error) {
      if (!stillLatest()) return
      const code = errorCode(error)
      const base: LoadedBase = { directory: target, path, reloading: false }
      if (code === "NOT_FOUND") {
        set({ ...base, kind: "missing" }, cause)
        return
      }
      // A failed reload keeps the copy already on screen and says the reload failed.
      if (cause !== "directory" && previous.kind === "report" && previous.directory === target) {
        set({ ...previous, reloading: false, reloadError: code }, cause)
        return
      }
      set({ ...base, kind: "error", code }, cause)
    }
  }

  return {
    setDirectory: (next) => {
      if (disposed) return
      if (directory === next && current.kind !== "no-host" && current.kind !== "connecting") return
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
    noHost: (reason) => {
      latest += 1
      set({ kind: "no-host", reason }, "host")
    },
    state: () => current,
    dispose: () => {
      disposed = true
      latest += 1
    },
  }
}
