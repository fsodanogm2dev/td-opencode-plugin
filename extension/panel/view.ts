/**
 * Draws the panel. All report data goes in as text (`textContent`), never as HTML.
 * The header, the Reload report button, and the live region are mounted once, so
 * focus stays on the button across repaints.
 */
import {
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSpinner,
  type BadgeHandle,
  type ButtonHandle,
} from "@openchamber/sdk/ui"

import type { PanelState } from "./controller.ts"
import { describeReport, type ModelGroup, type ReportView } from "./describe.ts"
import { everyText, relativeTime, timeText } from "./format.ts"
import { REPORT_FOLDER } from "./hash.ts"

type Disposable = { dispose: () => void }

export type ViewOptions = {
  root: HTMLElement
  onReload: () => void
  now?: () => number
  locale?: () => string
}

export type View = {
  render: (state: PanelState, cause: string) => void
  /** Updates relative times and the "out of date" check without a full repaint. */
  tick: () => void
  dispose: () => void
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const basename = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Lists longer than this fold into a disclosure, so the rail stays short. */
const FOLD_AFTER = 8

const ERRORS: Record<string, { title: string; body: string }> = {
  NOT_GRANTED: {
    title: "File access not approved",
    body: `Approve this extension's access to ${REPORT_FOLDER}/ in Settings → Extensions.`,
  },
  BAD_PATH: {
    title: "OpenChamber refused the report path",
    body: `This extension can read only ${REPORT_FOLDER}/*.json. Add the extension again if this does not stop.`,
  },
  DISABLED: { title: "Extension paused", body: "Turn it on again in Settings → Extensions." },
  HOST_TIMEOUT: { title: "OpenChamber did not answer", body: "Select Reload report to try again." },
  HOST_UNAVAILABLE: { title: "OpenChamber is not connected", body: "Close this panel and open it again." },
  DENIED: {
    title: "The system refused to read the report",
    body: `Check the file permissions of ${REPORT_FOLDER}/.`,
  },
  FILE_TOO_LARGE: { title: "The report file is too large", body: "The panel reads files up to 2 MB." },
}

export const createView = (options: ViewOptions): View => {
  const now = options.now ?? (() => Date.now())
  const locale = options.locale ?? (() => "en")
  const { root } = options

  // Mounted once.
  root.replaceChildren()
  const header = h("header", "hdr")
  const headerText = h("div", "hdr-text")
  const title = h("h1", "hdr-title", "FueliX plugin")
  const place = h("p", "hdr-place", "Connecting to OpenChamber…")
  const placePath = h("p", "hdr-path")
  placePath.hidden = true
  headerText.append(title, place, placePath)
  const badgeSlot = h("div", "hdr-badge")
  header.append(headerText, badgeSlot)

  const content = h("div", "content")
  content.id = "content"

  const footer = h("footer", "ftr")
  const buttonSlot = h("div", "ftr-button")
  const hint = h("p", "ftr-hint", "Reads the saved report again. It does not run a model check.")
  hint.id = "reload-hint"
  footer.append(buttonSlot, hint)

  const live = h("p", "sr-only")
  live.setAttribute("aria-live", "polite")
  live.setAttribute("role", "status")

  root.append(header, content, footer, live)

  const button: ButtonHandle = mountButton(buttonSlot, {
    label: "Reload report",
    variant: "outline",
    size: "sm",
    disabled: true,
    onClick: () => options.onReload(),
  })
  buttonSlot.querySelector("button")?.setAttribute("aria-describedby", "reload-hint")

  let badge: BadgeHandle | null = null
  let mounted: Disposable[] = []
  let current: PanelState = { kind: "connecting" }
  let view: ReportView | null = null
  const times: Array<{ node: HTMLElement; iso: string; withAbsolute: boolean }> = []

  const timeNode = (iso: string, withAbsolute = true): HTMLTimeElement => {
    const node = h("time")
    node.dateTime = iso
    node.textContent = withAbsolute ? timeText(iso, now(), locale()) : relativeTime(iso, now())
    times.push({ node, iso, withAbsolute })
    return node
  }

  const clear = () => {
    for (const handle of mounted) handle.dispose()
    mounted = []
    times.length = 0
    content.replaceChildren()
  }

  const setBadge = (label: string | null, tone: "neutral" | "warning" = "neutral") => {
    if (label === null) {
      badge?.dispose()
      badge = null
      return
    }
    if (badge) badge.update({ label, tone })
    else badge = mountBadge(badgeSlot, { label, tone })
  }

  const setPlace = (directory: string | null | undefined) => {
    if (directory === undefined) {
      place.textContent = "Connecting to OpenChamber…"
      placePath.hidden = true
      return
    }
    if (directory === null) {
      place.textContent = "No project open"
      placePath.textContent = "Report for sessions without a project"
      placePath.title = ""
    } else {
      place.textContent = basename(directory)
      placePath.textContent = directory
      placePath.title = directory
    }
    placePath.hidden = false
  }

  const section = (heading: string, id: string): HTMLElement => {
    const node = h("section", "sec")
    const label = h("h2", "sec-title", heading)
    label.id = id
    node.setAttribute("aria-labelledby", id)
    node.append(label)
    content.append(node)
    return node
  }

  const banner = (parent: HTMLElement, tone: "info" | "success" | "warning" | "error", t: string, body?: string) => {
    const slot = h("div", "slot")
    parent.append(slot)
    mounted.push(mountBanner(slot, { tone, title: t, ...(body ? { body } : {}) }))
  }

  const empty = (t: string, body: string) => {
    const slot = h("div", "slot")
    content.append(slot)
    mounted.push(mountEmpty(slot, { title: t, body }))
  }

  const groups = (parent: HTMLElement, list: ModelGroup[]) => {
    for (const group of list) {
      const wrap = h("div", "group")
      const label = h("h3", "group-title", `${group.label} (${group.ids.length})`)
      const ul = h("ul", "chips")
      for (const id of group.ids) ul.append(h("li", "chip", id))
      if (group.ids.length > FOLD_AFTER) {
        const details = h("details", "fold")
        const summary = h("summary", "fold-summary")
        summary.append(label)
        details.append(summary, ul)
        wrap.append(details)
      } else {
        wrap.append(label, ul)
      }
      parent.append(wrap)
    }
  }

  const line = (parent: HTMLElement, className: string, before: string, iso: string | null, after = "") => {
    const p = h("p", className, before)
    if (iso) p.append(timeNode(iso))
    if (after) p.append(after)
    parent.append(p)
  }

  const renderReport = (state: Extract<PanelState, { kind: "report" }>) => {
    const v = describeReport(state.report, now())
    view = v
    const c = state.report.configuration

    if (state.reloadError) {
      banner(
        content,
        "warning",
        "Could not reload the report",
        `${ERRORS[state.reloadError]?.title ?? state.reloadError}. The panel shows the copy it read earlier.`,
      )
    }
    if (v.stale) {
      banner(
        content,
        "warning",
        "This report may be out of date",
        `The plugin checks models ${everyText(c.refreshMinutes).toLowerCase()}, but this report is older than two checks. The plugin may not be running for this location now.`,
      )
    }

    // Latest model check
    const check = section("Latest model check", "sec-check")
    const headline = h("p", "headline")
    headline.dataset.tone = v.check.tone
    const dot = h("span", "dot")
    dot.setAttribute("aria-hidden", "true")
    headline.append(dot, h("span", "", v.check.headline))
    check.append(headline)
    if (v.check.finishedAt) line(check, "meta", "Finished ", v.check.finishedAt)
    for (const note of v.check.notes) check.append(h("p", "note", note))
    if (v.checkingWhenSaved) {
      check.append(
        h("p", "note", "A check was running when the plugin saved this report. That does not mean a check is running now."),
      )
    }
    groups(check, v.check.groups)
    if (v.check.lastSuccess) {
      if (v.check.lastSuccess.at) line(check, "meta", "Last successful check: ", v.check.lastSuccess.at)
      else check.append(h("p", "meta", "No successful check since the plugin started."))
    }

    if (v.change) {
      const change = section("Latest change since the plugin started", "sec-change")
      const p = h("p", "summary", v.change.summary)
      change.append(p)
      line(change, "meta", "", v.change.at)
      groups(change, v.change.groups)
      change.append(h("p", "meta", "This history starts again when OpenCode restarts or reloads the plugin."))
    }

    // Models
    const models = section("Models in OpenCode", "sec-models")
    models.append(h("p", "summary", v.models.total), h("p", "meta", v.models.source))
    if (v.models.providers.length > 0) {
      const ul = h("ul", "rows")
      for (const provider of v.models.providers) {
        const li = h("li", "row")
        const top = h("div", "row-top")
        top.append(h("span", "mono", provider.id), h("span", "row-meta", provider.count))
        li.append(top, h("div", "row-sub", provider.titleModel))
        ul.append(li)
      }
      models.append(ul)
    }

    // Setup
    const setup = section("What the plugin set up", "sec-setup")
    const dl = h("dl", "facts")
    // Each row groups the setting (dt), its value (dd), and what it means (a second dd).
    for (const fact of v.setup) {
      const row = h("div", "fact")
      const dt = h("dt", "fact-label", fact.label)
      const dd = h("dd", "fact-value", fact.value)
      if (fact.tone !== "neutral") dd.dataset.tone = fact.tone
      const help = h("dd", "fact-help", fact.help)
      row.append(dt, dd, help)
      dl.append(row)
    }
    setup.append(dl)

    // Where this came from
    const source = h("p", "source")
    source.append(`Plugin ${v.pluginVersion} saved this report `)
    source.append(timeNode(v.recordedAt))
    source.append(". It started ")
    source.append(timeNode(v.startedAt))
    source.append(". The panel shows what the plugin recorded, not a live check.")
    content.append(source)

    setBadge(v.stale ? "Out of date" : `Saved ${relativeTime(v.recordedAt, now())}`, v.stale ? "warning" : "neutral")
  }

  const render = (state: PanelState, cause: string) => {
    current = state
    view = null
    clear()
    content.setAttribute("aria-busy", state.kind === "loading" || state.kind === "connecting" ? "true" : "false")
    setPlace(state.kind === "connecting" || state.kind === "no-host" ? undefined : state.directory)
    const canReload = state.kind !== "connecting" && state.kind !== "no-host" && state.kind !== "loading"
    const reloading = canReload && state.reloading
    button.update({ disabled: !canReload, loading: reloading })
    if (state.kind !== "report") setBadge(null)

    switch (state.kind) {
      case "connecting": {
        const slot = h("div", "slot center")
        content.append(slot)
        mounted.push(mountSpinner(slot, { label: "Connecting to OpenChamber…" }))
        break
      }
      case "no-host":
        place.textContent = "Not connected"
        if (state.reason === "not-embedded") {
          empty("Open this panel in OpenChamber", "Add this folder in OpenChamber under Settings → Extensions.")
        } else if (state.reason === "no-answer") {
          empty("OpenChamber did not connect", "Close this panel and open it again.")
        } else {
          empty("Panel closed", "Open the panel again to read the report.")
        }
        break
      case "loading": {
        const slot = h("div", "slot center")
        content.append(slot)
        mounted.push(mountSpinner(slot, { label: "Reading the saved report…" }))
        break
      }
      case "missing":
        empty(
          "No report for this location",
          "The plugin writes a report when OpenCode runs it here. Open a session in this location. Reports are off when the plugin option fuelix.statusReport is false.",
        )
        content.append(h("p", "path", `Expected file: ${state.path}`))
        break
      case "invalid":
        if (state.problem === "unsupported") {
          banner(
            content,
            "warning",
            "Report format not supported",
            `This report uses format version ${state.version}. This panel reads version 1. Update the extension or the plugin so they match.`,
          )
        } else if (state.problem === "other-location") {
          banner(
            content,
            "warning",
            "Report is for another location",
            "The file names a different location than the one open now, so the panel does not show it.",
          )
        } else {
          banner(
            content,
            "error",
            "The report could not be read",
            "The file is not a valid report. It may be damaged. The plugin should replace it when it saves its next report.",
          )
        }
        content.append(h("p", "path", `File: ${state.path}`))
        break
      case "error": {
        const known = ERRORS[state.code]
        banner(content, "error", known?.title ?? "Could not read the report", known?.body ?? `Error code: ${state.code}.`)
        break
      }
      case "report":
        renderReport(state)
        break
    }

    if (cause === "reload" && !reloading) {
      live.textContent = state.kind === "report" && !state.reloadError ? "Report reloaded." : "Report reload finished."
    } else if (cause === "directory" && state.kind !== "loading") {
      live.textContent = ""
    }
  }

  const tick = () => {
    if (current.kind !== "report" || !view) return
    const next = describeReport(current.report, now())
    if ((next.stale === null) !== (view.stale === null)) {
      render(current, "tick")
      return
    }
    for (const entry of times) {
      entry.node.textContent = entry.withAbsolute
        ? timeText(entry.iso, now(), locale())
        : relativeTime(entry.iso, now())
    }
    if (!next.stale) setBadge(`Saved ${relativeTime(next.recordedAt, now())}`)
  }

  return {
    render,
    tick,
    dispose: () => {
      clear()
      badge?.dispose()
      button.dispose()
    },
  }
}
