/**
 * Work Status section. Shows the guards active in the current session and a
 * Release button for each. It cannot create, enable, or generate guards; the
 * panel does that. It never calls the model, sends prompts, or changes sessions.
 */
import { connectHost, type HostClient } from "@openchamber/sdk"
import { applyHostReady, mountButton } from "@openchamber/sdk/ui"

import { createGuardsController, type GuardsController, type GuardsState } from "./guards/controller.ts"
import { createGuardService } from "./guards/service.ts"
import { activeHere, endUnconfirmed, enforcement, enforcementText, type ActiveEntry } from "./guards/state.ts"
import { failureText } from "./guards/text.ts"

export const STATUS_POLL_MS = 15_000

export type StatusOptions = {
  root: HTMLElement
  host?: HostClient
  win?: Window
  pollMs?: number
  now?: () => number
  opId?: () => string
}

export type StatusSection = { guards: GuardsController; dispose: () => void }

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export const startStatus = (options: StatusOptions): StatusSection => {
  const win = options.win ?? window
  const doc = win.document
  const now = options.now ?? (() => Date.now())
  const host = options.host ?? connectHost()
  const { root } = options
  let disposed = false
  let mounted: Array<{ dispose: () => void }> = []
  let lastKey = ""

  const sizeToContent = () => {
    const height = Math.ceil(root.getBoundingClientRect().height) + 2
    host.setHeight(Math.max(24, height)).catch(() => {})
  }

  const render = (state: GuardsState) => {
    const data = state.load.kind === "ready" ? state.load.data : null
    const here: ActiveEntry[] = data ? activeHere(data, state.sessionId) : []
    // A request that the shared resolver says has ended no longer blocks anything.
    const enforcing = here.filter((entry) => entry.enforcing)
    const known = enforcing.filter((entry) => entry.relation !== "unknown")
    const unknown = enforcing.length - known.length
    const enforced = data ? enforcement(data, now()) : null
    const key = JSON.stringify([
      state.load.kind,
      state.load.kind === "error" ? state.load.failure : null,
      state.sessionId,
      known.map((e) => [e.activation.id, e.label, e.relation, e.lifecycle, e.enforcing]),
      unknown,
      enforced,
      state.ops,
    ])
    if (key === lastKey) return
    lastKey = key
    const focusKey = (doc.activeElement?.closest("[data-key]") as HTMLElement | null)?.dataset.key
    for (const handle of mounted) handle.dispose()
    mounted = []
    root.replaceChildren()

    if (state.load.kind === "waiting" || state.load.kind === "loading") {
      root.append(h("p", "st-muted", "Reading guards…"))
    } else if (state.load.kind === "error") {
      const p = h("p", "st-line")
      p.dataset.tone = "warning"
      p.textContent = `Guard status unknown. ${failureText(state.load.failure)}`
      root.append(p)
    } else if (!state.sessionId) {
      root.append(h("p", "st-muted", "Open a chat session to see its guards."))
    } else {
      if (known.length === 0 && unknown === 0) root.append(h("p", "st-muted", "No guards active in this session."))
      const ul = h("ul", "st-list")
      for (const entry of known) {
        const li = h("li", "st-item")
        const dot = h("span", "st-dot")
        dot.setAttribute("aria-hidden", "true")
        const text = h("span", "st-text")
        text.append(h("span", "st-label", entry.label))
        const where = entry.relation === "inherited" ? "from parent session" : entry.activation.scope === "request" ? "this request" : "this session"
        text.append(h("span", "st-meta", where))
        if (endUnconfirmed(entry)) text.append(h("span", "st-meta", "end not confirmed"))
        const slot = h("span", "st-btn")
        slot.dataset.key = `release:${entry.activation.id}`
        li.append(dot, text, slot)
        const op = state.ops[`release:${entry.activation.id}`]
        mounted.push(
          mountButton(slot, {
            label: op?.status === "unclear" ? "Try again" : "Release",
            variant: "outline",
            size: "xs",
            loading: op?.status === "pending",
            onClick: () => (op?.status === "unclear" ? guards.retry(op.key) : guards.release(entry.activation.id)),
          }),
        )
        ul.append(li)
        if (op?.status === "failed" && op.failure) {
          const err = h("li", "st-line", `Not released: ${failureText(op.failure)}`)
          err.dataset.tone = "error"
          ul.append(err)
        }
      }
      if (ul.childElementCount > 0) root.append(ul)
      if (unknown > 0) {
        root.append(
          h("p", "st-muted", `${unknown === 1 ? "1 guard" : `${unknown} guards`} from other sessions may apply if this is a subagent.`),
        )
      }
      if (enforcing.length > 0 && enforced && enforced.kind === "not-enforced") {
        const message = enforcementText(enforced)
        const p = h("p", "st-line", `${message.title}. ${message.body}`)
        p.dataset.tone = message.tone
        root.append(p)
      }
    }
    if (focusKey) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"] button`)?.focus()
    sizeToContent()
  }

  const guards = createGuardsController({
    service: createGuardService({ serviceRequest: (request) => host.serviceRequest(request) }),
    // This section never generates guards.
    generate: () => Promise.reject(new Error("Generation is not available in the status section.")),
    onChange: render,
    ...(options.opId ? { opId: options.opId } : {}),
  })
  render(guards.state())

  let ready = false
  let directory: string | null = null
  let sessionId: string | null = null
  const stopReady = host.onReady((ctx) => {
    applyHostReady(ctx, doc.documentElement)
    ready = true
    directory = ctx.directory
    sessionId = ctx.session?.id ?? null
    guards.setContext({ directory, sessionId })
  })
  const stopDirectory = host.onDirectory((next) => {
    if (!ready) return
    directory = next
    guards.setContext({ directory, sessionId })
  })
  const stopSession = host.onSession((session) => {
    if (!ready) return
    sessionId = session?.id ?? null
    guards.setContext({ directory, sessionId })
  })
  const poll = win.setInterval(() => {
    if (ready && doc.visibilityState !== "hidden") guards.refresh()
  }, options.pollMs ?? STATUS_POLL_MS)

  const dispose = () => {
    if (disposed) return
    disposed = true
    win.clearInterval(poll)
    stopReady()
    stopDirectory()
    stopSession()
    guards.dispose()
    for (const handle of mounted) handle.dispose()
    host.dispose()
  }
  win.addEventListener("pagehide", dispose, { once: true })
  return { guards, dispose }
}

const root = typeof document !== "undefined" ? document.getElementById("status-root") : null
if (root && !(globalThis as { __TD_STATUS_NO_AUTOSTART__?: boolean }).__TD_STATUS_NO_AUTOSTART__) {
  startStatus({ root })
}
