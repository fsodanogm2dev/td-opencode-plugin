/**
 * Panel entry. Connects to OpenChamber, follows the current location, and reads
 * that location's saved report. It never writes files and never runs a model check.
 */
import { connectHost, type HostClient } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"

import { createController, type Controller } from "./controller.ts"
import { createView, type View } from "./view.ts"

/** How often the panel reads the report again while it is open and visible. */
export const POLL_MS = 30_000
/** How long the panel waits for OpenChamber's first message. */
export const CONNECT_TIMEOUT_MS = 5_000

export type StartOptions = {
  root: HTMLElement
  host?: HostClient
  win?: Window
  pollMs?: number
  connectTimeoutMs?: number
  /** Test seam for the clock. */
  now?: () => number
}

export type Panel = { controller: Controller; view: View; dispose: () => void }

export const startPanel = (options: StartOptions): Panel => {
  const win = options.win ?? window
  const doc = win.document
  let locale = "en"
  let disposed = false

  // `controller` is assigned right below; the view only calls back on a click.
  let controller: Controller
  const view = createView({
    root: options.root,
    onReload: () => controller.reload(),
    locale: () => locale,
    ...(options.now ? { now: options.now } : {}),
  })
  controller = createController({
    reader: { readFile: (path) => host.readFile(path) },
    onChange: (state, cause) => view.render(state, cause),
  })
  view.render(controller.state(), "host")

  const embedded = win.parent !== win
  const host = options.host ?? connectHost()

  let ready = false
  const connectTimer = win.setTimeout(() => {
    if (!ready && !disposed) controller.noHost(embedded ? "no-answer" : "not-embedded")
  }, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
  if (!embedded && !options.host) {
    win.clearTimeout(connectTimer)
    controller.noHost("not-embedded")
  }

  const stopReady = host.onReady((ctx) => {
    applyHostReady(ctx, doc.documentElement)
    locale = ctx.locale || "en"
    ready = true
    win.clearTimeout(connectTimer)
    // `onDirectory` also fires for each snapshot; the controller ignores a repeat.
    controller.setDirectory(ctx.directory)
  })
  const stopDirectory = host.onDirectory((directory) => {
    if (ready) controller.setDirectory(directory)
  })

  const visible = () => doc.visibilityState !== "hidden"
  const poll = win.setInterval(() => {
    if (!visible() || !ready) return
    controller.reload({ quiet: true })
    view.tick()
  }, options.pollMs ?? POLL_MS)

  const onVisibility = () => {
    if (visible() && ready) {
      controller.reload({ quiet: true })
      view.tick()
    }
  }
  doc.addEventListener("visibilitychange", onVisibility)

  const dispose = () => {
    if (disposed) return
    disposed = true
    win.clearTimeout(connectTimer)
    win.clearInterval(poll)
    doc.removeEventListener("visibilitychange", onVisibility)
    stopReady()
    stopDirectory()
    controller.dispose()
    host.dispose()
  }
  win.addEventListener("pagehide", dispose, { once: true })

  return { controller, view, dispose }
}

const root = typeof document !== "undefined" ? document.getElementById("root") : null
if (root && !(globalThis as { __TD_STATUS_NO_AUTOSTART__?: boolean }).__TD_STATUS_NO_AUTOSTART__) {
  startPanel({ root })
}
