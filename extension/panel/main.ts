/**
 * Panel entry. Connects to OpenChamber and follows the current location and session.
 *
 * - Plugin setup: reads that location's saved report. It never writes files and never runs a model check.
 * - Guards: reads and changes guards only through this extension's local service, and only after a
 *   user click. It calls the Small Model only when the user selects Generate. It never sends prompts
 *   or changes sessions.
 */
import { connectHost, type HostClient } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"

import { createController, type Controller } from "./controller.ts"
import { createGuardsController, type GuardsController } from "./guards/controller.ts"
import { createGuardService } from "./guards/service.ts"
import { createGuardsView, type GuardsView } from "./guards/view.ts"
import { createView, type View } from "./view.ts"

/** How often the panel reads the report again while it is open and visible. */
export const POLL_MS = 30_000
/** How often the panel reads guard state while it is open and visible. The plugin reports about this often. */
export const GUARD_POLL_MS = 15_000
/** How long the panel waits for OpenChamber's first message. */
export const CONNECT_TIMEOUT_MS = 5_000

export type StartOptions = {
  root: HTMLElement
  host?: HostClient
  win?: Window
  pollMs?: number
  guardPollMs?: number
  connectTimeoutMs?: number
  /** Test seam for the clock. */
  now?: () => number
  /** Test seam for operation IDs. */
  opId?: () => string
}

export type Panel = {
  controller: Controller
  view: View
  guards: GuardsController
  guardsView: GuardsView
  dispose: () => void
}

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

  let guards: GuardsController
  const guardsView = createGuardsView({
    root: view.guardsRoot,
    controller: () => guards,
    locale: () => locale,
    ...(options.now ? { now: options.now } : {}),
  })
  guards = createGuardsController({
    service: createGuardService({ serviceRequest: (request) => host.serviceRequest(request) }),
    generate: (request) => host.generate(request),
    onChange: (state) => {
      guardsView.render(state)
      view.setGuardCount(guardsView.activeCount())
    },
    ...(options.opId ? { opId: options.opId } : {}),
  })
  guardsView.render(guards.state())

  let ready = false
  let directory: string | null = null
  let sessionId: string | null = null
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
    directory = ctx.directory
    sessionId = ctx.session?.id ?? null
    // `onDirectory` also fires for each snapshot; the controllers ignore a repeat.
    controller.setDirectory(ctx.directory)
    guards.setContext({ directory, sessionId })
  })
  const stopDirectory = host.onDirectory((next) => {
    if (!ready) return
    directory = next
    controller.setDirectory(next)
    guards.setContext({ directory, sessionId })
  })
  const stopSession = host.onSession((session) => {
    if (!ready) return
    sessionId = session?.id ?? null
    guards.setContext({ directory, sessionId })
  })
  // A Generate answer that arrived after an earlier frame closed.
  const stopLate = host.onLateGenerateResult((late) => guards.lateGeneration(late))

  const visible = () => doc.visibilityState !== "hidden"
  const poll = win.setInterval(() => {
    if (!visible() || !ready) return
    controller.reload({ quiet: true })
    view.tick()
  }, options.pollMs ?? POLL_MS)
  const guardPoll = win.setInterval(() => {
    if (visible() && ready) guards.refresh()
  }, options.guardPollMs ?? GUARD_POLL_MS)

  const onVisibility = () => {
    if (visible() && ready) {
      controller.reload({ quiet: true })
      guards.refresh()
      view.tick()
    }
  }
  doc.addEventListener("visibilitychange", onVisibility)

  const dispose = () => {
    if (disposed) return
    disposed = true
    win.clearTimeout(connectTimer)
    win.clearInterval(poll)
    win.clearInterval(guardPoll)
    doc.removeEventListener("visibilitychange", onVisibility)
    stopReady()
    stopDirectory()
    stopSession()
    stopLate()
    controller.dispose()
    // The views stay on screen as they are; only the controllers stop.
    guards.dispose()
    host.dispose()
  }
  win.addEventListener("pagehide", dispose, { once: true })

  return { controller, view, guards, guardsView, dispose }
}

const root = typeof document !== "undefined" ? document.getElementById("root") : null
if (root && !(globalThis as { __TD_STATUS_NO_AUTOSTART__?: boolean }).__TD_STATUS_NO_AUTOSTART__) {
  startPanel({ root })
}
