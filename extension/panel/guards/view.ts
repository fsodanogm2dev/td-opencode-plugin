/**
 * Draws the Guards tab. Every value from the service or the model goes in as
 * text (`textContent`), never as HTML.
 *
 * The request box and the preview's sample test keep their text across repaints.
 * Lists repaint only when what they show changes, and keyboard focus and open
 * disclosures come back after a repaint.
 */
import { mountBanner, mountButton, mountSpinner, type ButtonHandle } from "@openchamber/sdk/ui"

import { absoluteTime } from "../format.ts"
import type { DraftState, GuardsController, GuardsState, Op } from "./controller.ts"
import { REQUEST_MAX } from "./generation.ts"
import { describeRule, ruleCoverage, uncoveredActions } from "./rules.ts"
import type { GuardState, ServiceFailure } from "./service.ts"
import { failureText } from "./text.ts"
import type { Guard, Rule } from "./shared.ts"
import {
  activeHere,
  canEnable,
  endUnconfirmed,
  enforcedActivationCount,
  enforcement,
  enforcementText,
  EXPIRY_CHOICES,
  lifecycleNote,
  otherSessionCount,
  scopeText,
  type ActiveEntry,
  type Enforcement,
} from "./state.ts"
import { testCommand } from "./tester.ts"

type Disposable = { dispose: () => void }

export type GuardsViewOptions = {
  root: HTMLElement
  controller: () => GuardsController
  now?: () => number
  locale?: () => string
}

export type GuardsView = {
  render: (state: GuardsState) => void
  /** Number of guards on in the current session, for the tab label. */
  activeCount: () => number
  dispose: () => void
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

let uid = 0
const nextId = (prefix: string) => `${prefix}-${++uid}`

const GENERATE_FAILURES: Record<string, { title: string; body: string }> = {
  NOT_GRANTED: { title: "Small Model access not approved", body: "Approve Small Model access for this extension in Settings → Extensions." },
  NO_MODEL: { title: "No Small Model is set", body: "Choose a Small Model in OpenChamber settings, then select Generate again." },
  MODEL_FAILED: { title: "The Small Model returned an error", body: "Select Generate to try again. Each try uses tokens." },
  HOST_TIMEOUT: { title: "The Small Model took too long", body: "Select Generate to try again. Each try uses tokens." },
  DISABLED: { title: "Extension paused", body: "Turn it on again in Settings → Extensions." },
}

const OP_TITLES: Record<Op["kind"], string> = {
  save: "The guard was not saved",
  delete: "The guard was not deleted",
  enable: "The guard was not enabled",
  release: "The guard was not released",
  recover: "The guard store was not reset",
}

/** Shown before the reset. The service needs this click; the model has no way to ask for it. */
export const RECOVER_WARNING =
  "This resets all saved guards and releases their activations across every project. The service keeps a backup of the damaged file."

export const createGuardsView = (options: GuardsViewOptions): GuardsView => {
  const now = options.now ?? (() => Date.now())
  const locale = options.locale ?? (() => "en")
  const ctl = () => options.controller()
  const { root } = options

  root.replaceChildren()
  const wrap = h("div", "gd")

  // Enforcement status.
  const statusBox = h("div", "gd-status")
  statusBox.setAttribute("role", "status")

  // Damaged store recovery. Kept apart from the status line so its buttons are not in a live region.
  const recoverBox = h("div", "gd-recover")
  recoverBox.hidden = true

  // Active guards.
  const activeSec = h("section", "sec")
  const activeTitle = h("h2", "sec-title", "Active in this session")
  activeTitle.id = "gd-active-title"
  activeSec.setAttribute("aria-labelledby", activeTitle.id)
  const activeBody = h("div", "gd-body")
  activeSec.append(activeTitle, activeBody)

  // New guard.
  const newSec = h("section", "sec")
  const newTitle = h("h2", "sec-title", "New guard")
  newTitle.id = "gd-new-title"
  newSec.setAttribute("aria-labelledby", newTitle.id)
  const inputLabel = h("label", "gd-label", "What should the agent not do?")
  inputLabel.htmlFor = "gd-request"
  const input = h("textarea", "gd-input")
  input.id = "gd-request"
  input.rows = 3
  input.maxLength = REQUEST_MAX
  input.placeholder = "For example: block git commits"
  input.setAttribute("aria-describedby", "gd-cost")
  const generateRow = h("div", "gd-row")
  const generateSlot = h("div", "gd-btn")
  const cost = h("p", "gd-hint", "Uses your Small Model. Each Generate click uses tokens.")
  cost.id = "gd-cost"
  generateRow.append(generateSlot, cost)
  const previewBox = h("div", "gd-preview")
  newSec.append(newTitle, inputLabel, input, generateRow, previewBox)

  // Library.
  const librarySec = h("section", "sec")
  const libraryTitle = h("h2", "sec-title", "Saved guards")
  libraryTitle.id = "gd-library-title"
  librarySec.setAttribute("aria-labelledby", libraryTitle.id)
  const libraryBody = h("div", "gd-body")
  librarySec.append(libraryTitle, libraryBody)

  // How it works.
  const about = h("details", "gd-about")
  about.dataset.key = "about"
  about.append(h("summary", "gd-about-summary", "How guards work"))
  for (const text of [
    "A guard is a saved list of rules. It does nothing until you enable it for a session or a request.",
    "When a matching action is about to run, td-opencode-plugin refuses it, even if it was approved or auto-approved. The agent gets a short error and can continue with other work. It is not asked to approve anything again.",
    "Guards are saved on this computer and are available in every project. Only you can enable, release, or delete them, from this panel. The agent has no tool to change them.",
    "Guards are checks inside OpenCode, not an operating-system security boundary. A command hidden in a script or another program can avoid a command rule.",
    "This extension uses a local service that runs with your user rights to save guards, your Small Model only when you select Generate, and session names and parent links to apply guards to subagents. It does not read your conversations.",
  ]) {
    about.append(h("p", "gd-about-text", text))
  }

  wrap.append(statusBox, recoverBox, activeSec, newSec, librarySec, about)
  root.append(wrap)

  const generateButton: ButtonHandle = mountButton(generateSlot, {
    label: "Generate preview",
    variant: "default",
    size: "sm",
    disabled: true,
    onClick: () => ctl().generate(input.value),
  })
  input.addEventListener("input", () => {
    const draft = ctl().state().draft
    generateButton.update({ disabled: !input.value.trim() || draft.kind === "generating" })
  })

  // Repaint bookkeeping.
  let statusMounted: Disposable[] = []
  let recoverMounted: Disposable[] = []
  let recoverKey = ""
  let recoverWasOpen = false
  let activeMounted: Disposable[] = []
  let libraryMounted: Disposable[] = []
  let previewMounted: Disposable[] = []
  let previewOps: Disposable[] = []
  let statusKey = ""
  let activeKey = ""
  let libraryKey = ""
  let previewDraft: DraftState | null = null
  let previewOpKey = ""
  let saveButton: ButtonHandle | null = null
  let opSlot: HTMLElement | null = null
  let here: ActiveEntry[] = []

  const dispose = (list: Disposable[]) => {
    for (const item of list) item.dispose()
    list.length = 0
  }

  /** Records focus and open disclosures, runs `paint`, then restores them. */
  const preserving = (container: HTMLElement, paint: () => void) => {
    const active = document.activeElement as HTMLElement | null
    const focusKey = active && container.contains(active) ? (active.closest("[data-key]") as HTMLElement | null)?.dataset.key : undefined
    const open = new Set([...container.querySelectorAll<HTMLDetailsElement>("details[data-key]")].filter((d) => d.open).map((d) => d.dataset.key))
    paint()
    for (const details of container.querySelectorAll<HTMLDetailsElement>("details[data-key]")) {
      if (open.has(details.dataset.key)) details.open = true
    }
    if (focusKey) {
      const target = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
      const focusable = target?.matches("button, input, select, textarea, summary") ? target : target?.querySelector<HTMLElement>("button, input, select, textarea, summary")
      focusable?.focus()
    }
  }

  const button = (
    parent: HTMLElement,
    list: Disposable[],
    key: string,
    props: Parameters<typeof mountButton>[1],
  ): ButtonHandle => {
    const slot = h("span", "gd-btn")
    slot.dataset.key = key
    parent.append(slot)
    const handle = mountButton(slot, props)
    list.push(handle)
    return handle
  }

  const banner = (parent: HTMLElement, list: Disposable[], props: Parameters<typeof mountBanner>[1]) => {
    const slot = h("div", "slot")
    parent.append(slot)
    list.push(mountBanner(slot, props))
  }

  /** Banner for an operation that failed or got no clear answer. */
  const opNotice = (parent: HTMLElement, list: Disposable[], op: Op | undefined) => {
    if (!op || op.status === "pending" || !op.failure) return
    const box = h("div", "gd-op")
    box.dataset.key = `op:${op.key}`
    parent.append(box)
    if (op.status === "unclear") {
      const reset = op.kind === "recover"
      banner(box, list, {
        tone: "warning",
        title: reset ? "Reset outcome not confirmed" : "No clear answer",
        body: reset
          ? "The reset may already be applied. Reload the guard data or try again."
          : "The change may already be done. Try again sends the same request, so it cannot happen twice.",
        action: { label: "Try again", onClick: () => ctl().retry(op.key) },
      })
    } else {
      banner(box, list, { tone: "error", title: OP_TITLES[op.kind], body: failureText(op.failure) })
    }
    button(box, list, `dismiss:${op.key}`, { label: "Dismiss", variant: "ghost", size: "xs", onClick: () => ctl().dismiss(op.key) })
  }

  /** Rule text with each flag (`--force`) kept on one line. */
  const ruleText = (value: string): HTMLElement => {
    const node = h("span", "gd-rule-text")
    for (const part of value.split(/(\s+)/)) {
      if (/^-{1,2}\S/.test(part)) node.append(h("span", "nowrap", part))
      else if (part) node.append(part)
    }
    return node
  }

  const ruleList = (parent: HTMLElement, rules: readonly Rule[], withCoverage: boolean) => {
    const ul = h("ul", "gd-rules")
    for (const rule of rules) {
      const li = h("li", "gd-rule")
      li.append(ruleText(describeRule(rule)))
      if (withCoverage) li.append(h("span", "gd-rule-note", ruleCoverage(rule)))
      ul.append(li)
    }
    parent.append(ul)
  }

  // ---------------------------------------------------------------- status

  const renderStatus = (state: GuardsState) => {
    const load = state.load
    let key: string
    let tone: string
    let title: string
    let body: string
    let covered: string[] = []
    let failure: ServiceFailure | null = null
    if (load.kind === "waiting" || load.kind === "loading") {
      key = "loading"
      tone = "neutral"
      title = "Reading guards…"
      body = ""
    } else if (load.kind === "error") {
      failure = load.failure
      key = `error:${failure.kind}:${failure.code}`
      tone = "warning"
      title = "Guard status unknown"
      body = `${failureText(failure)} The panel cannot tell whether guards are enforced.`
    } else {
      const value: Enforcement = enforcement(load.data, now())
      const text = enforcementText(value)
      covered = value.kind === "not-enforced" ? [] : value.covered
      tone = text.tone
      title = text.title
      body = text.body
      if (load.refreshFailure) body = `${body} The latest refresh failed: ${failureText(load.refreshFailure)}`
      key = `${value.kind}:${"reason" in value ? value.reason : ""}:${covered.join(",")}:${body}`
    }
    if (key === statusKey) return
    statusKey = key
    preserving(statusBox, () => {
      dispose(statusMounted)
      statusBox.replaceChildren()
      statusBox.dataset.tone = tone
      const head = h("p", "gd-status-title")
      const dot = h("span", "dot")
      dot.setAttribute("aria-hidden", "true")
      head.append(dot, h("span", "", title))
      statusBox.append(head)
      if (body) statusBox.append(h("p", "gd-status-body", body))
      if (covered.length > 0) statusBox.append(h("p", "gd-status-meta", `Actions the plugin can block here: ${covered.join(", ")}`))
      if (failure) {
        const row = h("div", "gd-row")
        statusBox.append(row)
        button(row, statusMounted, "status-retry", { label: "Try again", variant: "outline", size: "xs", onClick: () => ctl().refresh() })
      }
    })
  }

  // ---------------------------------------------------------------- recovery

  const renderRecover = (state: GuardsState) => {
    const op = state.ops.recover
    const key = JSON.stringify([state.storeCorrupt, state.confirmRecover, state.recovered, op ?? null])
    if (key === recoverKey) return
    recoverKey = key
    const opening = state.confirmRecover && !recoverWasOpen
    recoverWasOpen = state.confirmRecover
    preserving(recoverBox, () => {
      dispose(recoverMounted)
      recoverBox.replaceChildren()
      recoverBox.hidden = !state.storeCorrupt && !state.recovered
      if (state.recovered) {
        const backup = state.recovered.backup
        banner(recoverBox, recoverMounted, {
          tone: "success",
          title: "Guard store reset",
          body: backup
            ? `All saved guards and activations were removed. The damaged file was kept as a backup: ${backup}`
            : "All saved guards and activations were removed. The service kept a backup of the damaged file.",
        })
        button(recoverBox, recoverMounted, "recovered-dismiss", { label: "Dismiss", variant: "ghost", size: "xs", onClick: () => ctl().dismissRecovered() })
        return
      }
      if (!state.storeCorrupt) return
      const box = h("div", "gd-confirm")
      box.append(h("p", "gd-card-label", "Guard data is damaged"))
      box.append(
        h("p", "gd-note", "The service cannot read the saved guard file, so it cannot save, enable, or release guards. Existing rules may still be active."),
      )
      recoverBox.append(box)
      if (!state.confirmRecover) {
        const actions = h("div", "gd-actions")
        box.append(actions)
        button(actions, recoverMounted, "recover-open", { label: "Reset guard store…", variant: "outline", size: "xs", onClick: () => ctl().askRecover() })
        return
      }
      const warning = h("p", "gd-note", RECOVER_WARNING)
      warning.dataset.tone = "warning"
      box.setAttribute("role", "group")
      box.setAttribute("aria-label", "Confirm guard store reset")
      box.append(warning)
      const actions = h("div", "gd-actions")
      box.append(actions)
      const busy = op?.status === "pending" || op?.status === "unclear"
      button(actions, recoverMounted, "recover-cancel", {
        label: "Cancel",
        variant: "outline",
        size: "xs",
        disabled: busy,
        onClick: () => ctl().cancelRecover(),
      })
      button(actions, recoverMounted, "recover-confirm", {
        label: "Reset guard store",
        variant: "destructive",
        size: "xs",
        loading: op?.status === "pending",
        disabled: op?.status === "unclear",
        onClick: () => ctl().confirmRecover(),
      })
      opNotice(box, recoverMounted, op)
    })
    // Cancel is the safe default, so it gets focus when the confirmation opens.
    if (opening) recoverBox.querySelector<HTMLElement>('[data-key="recover-cancel"] button')?.focus()
  }

  // ---------------------------------------------------------------- active

  const expiryText = (iso: string | null): string => (iso ? `Ends ${absoluteTime(iso, now(), locale())}` : "No end time")

  const activeItem = (ul: HTMLElement, entry: ActiveEntry, state: GuardsState) => {
    const li = h("li", "gd-active")
    li.dataset.relation = entry.relation
    li.dataset.enforcing = entry.enforcing ? "true" : "false"
    const top = h("div", "gd-active-top")
    const dot = h("span", "gd-active-dot")
    dot.setAttribute("aria-hidden", "true")
    top.append(dot, h("span", "gd-active-label", entry.label))
    li.append(top)
    li.append(h("p", "gd-meta", `${scopeText(entry)} · ${expiryText(entry.activation.expiresAt)}`))
    const note = lifecycleNote(entry)
    if (note) {
      const p = h("p", "gd-note", note)
      if (endUnconfirmed(entry)) p.dataset.tone = "warning"
      li.append(p)
    }
    if (entry.relation === "inherited") li.append(h("p", "gd-note", "Release turns it off for the parent session and all its subagents."))
    const op = state.ops[`release:${entry.activation.id}`]
    const actions = h("div", "gd-actions")
    li.append(actions)
    button(actions, activeMounted, `release:${entry.activation.id}`, {
      label: "Release",
      variant: "outline",
      size: "xs",
      loading: op?.status === "pending",
      onClick: () => ctl().release(entry.activation.id),
    })
    opNotice(li, activeMounted, op)
    ul.append(li)
  }

  const renderActive = (state: GuardsState) => {
    const data = state.load.kind === "ready" ? state.load.data : null
    here = data ? activeHere(data, state.sessionId) : []
    const releaseOps = Object.values(state.ops).filter((op) => op.kind === "release")
    const key = JSON.stringify([
      state.load.kind,
      state.sessionId,
      here.map((e) => [e.activation, e.label, e.rules, e.relation, e.lifecycle]),
      releaseOps,
    ])
    if (key === activeKey) return
    activeKey = key
    preserving(activeBody, () => {
      dispose(activeMounted)
      activeBody.replaceChildren()
      if (!data) {
        activeBody.append(h("p", "gd-empty", state.load.kind === "error" ? "Not available." : "Reading…"))
        return
      }
      if (!state.sessionId) {
        activeBody.append(h("p", "gd-empty", "Open a chat session to see and enable its guards."))
        return
      }
      const known = here.filter((entry) => entry.relation !== "unknown")
      const unknown = here.filter((entry) => entry.relation === "unknown" && entry.enforcing)
      if (known.length === 0) activeBody.append(h("p", "gd-empty", "No guards are active in this session."))
      else {
        const ul = h("ul", "gd-list")
        for (const entry of known) activeItem(ul, entry, state)
        activeBody.append(ul)
      }
      if (unknown.length > 0) {
        const details = h("details", "gd-unknown")
        details.dataset.key = "unknown"
        const summary = h(
          "summary",
          "gd-unknown-summary",
          `${unknown.length === 1 ? "1 guard is" : `${unknown.length} guards are`} active in other sessions and may apply here`,
        )
        details.append(summary)
        details.append(
          h("p", "gd-note", "The plugin has not reported this session's parent. If this is a subagent of those sessions, their guards apply here too."),
        )
        const ul = h("ul", "gd-list")
        for (const entry of unknown) activeItem(ul, entry, state)
        details.append(ul)
        activeBody.append(details)
      }
    })
  }

  // ---------------------------------------------------------------- preview

  const renderTester = (parent: HTMLElement, rules: readonly Rule[]) => {
    const box = h("div", "gd-tester")
    const id = nextId("gd-test")
    const label = h("label", "gd-label", "Test a command")
    label.htmlFor = id
    const field = h("input", "gd-input mono")
    field.id = id
    field.type = "text"
    field.placeholder = "git commit -m \"wip\""
    field.autocomplete = "off"
    field.spellcheck = false
    const result = h("p", "gd-test-result")
    result.setAttribute("aria-live", "polite")
    const update = () => {
      const outcome = testCommand(rules, field.value)
      result.replaceChildren()
      delete result.dataset.tone
      if (outcome.kind === "empty") {
        result.textContent = "Type a shell command to see whether this guard would block it. Nothing runs."
        return
      }
      if (outcome.kind === "allowed") {
        result.dataset.tone = "success"
        result.textContent = "Not blocked by this guard."
        return
      }
      result.dataset.tone = "error"
      result.textContent = outcome.certain
        ? `Blocked by rule ${outcome.index + 1}: ${describeRule(outcome.rule)}`
        : `May be blocked by rule ${outcome.index + 1}: the command could not be read exactly, so the plugin blocks it to be safe.`
    }
    field.addEventListener("input", update)
    update()
    box.append(label, field, result)
    parent.append(box)
  }

  const renderPreviewBody = (state: GuardsState) => {
    const draft = state.draft
    dispose(previewMounted)
    saveButton = null
    opSlot = null
    previewBox.replaceChildren()
    previewBox.hidden = draft.kind === "idle"
    switch (draft.kind) {
      case "idle":
        return
      case "generating": {
        const slot = h("div", "slot")
        previewBox.append(slot)
        previewMounted.push(mountSpinner(slot, { label: "Generating with your Small Model… This can take a minute." }))
        return
      }
      case "failed": {
        const known = GENERATE_FAILURES[draft.code] ?? {
          title: "The Small Model did not answer",
          body: `Select Generate to try again (${draft.code}). Each try uses tokens.`,
        }
        banner(previewBox, previewMounted, { tone: "error", title: known.title, body: known.body })
        break
      }
      case "unsupported":
        banner(previewBox, previewMounted, {
          tone: "warning",
          title: "This cannot be a guard",
          body: `${draft.reason} Nothing was saved. Change the request and select Generate again.`,
        })
        break
      case "invalid": {
        banner(previewBox, previewMounted, {
          tone: "warning",
          title: "The proposed guard was rejected",
          body: `${draft.reason} Nothing was saved. Name the exact command or action to block, then select Generate again.`,
        })
        if (draft.details.length > 0) {
          const details = h("details", "gd-details")
          details.append(h("summary", "", "What was wrong"))
          const ul = h("ul", "gd-errors")
          for (const line of draft.details) ul.append(h("li", "mono", line))
          details.append(ul)
          previewBox.append(details)
        }
        break
      }
      case "preview": {
        const card = h("div", "gd-draft")
        const head = h("div", "gd-draft-head")
        head.append(h("h3", "gd-draft-label", draft.draft.label), h("span", "gd-pill", "Not saved"))
        card.append(head)
        if (draft.late) card.append(h("p", "gd-note", "This preview is the answer to an earlier Generate click."))
        card.append(h("p", "gd-subtitle", "What it blocks"))
        ruleList(card, draft.draft.rules, true)
        const runtime = state.load.kind === "ready" ? state.load.data.runtime : null
        const missing = uncoveredActions(draft.draft.rules, runtime ? [...runtime.coveredActions] : null)
        if (missing.length > 0) {
          const p = h("p", "gd-note", `The plugin does not report that it can block ${missing.join(", ")} here.`)
          p.dataset.tone = "warning"
          card.append(p)
        }
        card.append(h("p", "gd-subtitle", "Model's description"), h("p", "gd-text", draft.draft.summary))
        card.append(h("p", "gd-subtitle", "Message the agent sees"), h("p", "gd-quote", draft.draft.message))
        renderTester(card, draft.draft.rules)
        const row = h("div", "gd-actions")
        saveButton = button(row, previewMounted, "save", { label: "Save guard", variant: "default", size: "sm", onClick: () => ctl().save() })
        button(row, previewMounted, "discard", { label: "Discard", variant: "ghost", size: "sm", onClick: () => ctl().discardDraft() })
        card.append(row, h("p", "gd-hint", "Saving keeps the guard off. Enable it from Saved guards."))
        opSlot = h("div", "gd-op-slot")
        card.append(opSlot)
        previewBox.append(card)
        return
      }
    }
  }

  const renderPreview = (state: GuardsState) => {
    if (state.draft !== previewDraft) {
      previewDraft = state.draft
      previewOpKey = ""
      dispose(previewOps)
      renderPreviewBody(state)
    }
    generateButton.update({
      disabled: !input.value.trim() || state.draft.kind === "generating",
      loading: state.draft.kind === "generating",
    })
    input.disabled = state.draft.kind === "generating"
    const op = state.ops.save
    const key = JSON.stringify(op ?? null)
    if (key === previewOpKey) return
    previewOpKey = key
    saveButton?.update({ loading: op?.status === "pending" })
    if (opSlot) {
      const slot = opSlot
      preserving(slot, () => {
        dispose(previewOps)
        slot.replaceChildren()
        opNotice(slot, previewOps, op)
      })
    }
  }

  // ---------------------------------------------------------------- library

  const enableForm = (parent: HTMLElement, state: GuardsState, guard: Guard) => {
    const form = state.enable
    if (!form || form.guardId !== guard.id) return
    const box = h("fieldset", "gd-enable")
    box.append(h("legend", "gd-subtitle", "Enable for"))
    const name = nextId("gd-scope")
    const choices: Array<{ value: "session" | "request"; label: string; help: string }> = [
      {
        value: "session",
        label: "This session",
        help: "This chat and the subagents it starts, until you release it.",
      },
      {
        value: "request",
        label: "This request",
        help: "The current request and its linked subagents. The plugin releases it after confirming they ended. If completion is uncertain, it stays on until you release it.",
      },
    ]
    for (const choice of choices) {
      const row = h("label", "gd-choice")
      row.dataset.key = `scope:${guard.id}:${choice.value}`
      const radio = h("input")
      radio.type = "radio"
      radio.name = name
      radio.value = choice.value
      radio.checked = form.scope === choice.value
      radio.addEventListener("change", () => ctl().updateEnable({ scope: choice.value }))
      const text = h("span", "gd-choice-text")
      text.append(h("span", "gd-choice-label", choice.label), h("span", "gd-choice-help", choice.help))
      row.append(radio, text)
      box.append(row)
    }
    const expiryRow = h("div", "gd-expiry")
    const check = h("label", "gd-choice")
    check.dataset.key = `expiry:${guard.id}`
    const box2 = h("input")
    box2.type = "checkbox"
    box2.checked = form.expiry
    box2.addEventListener("change", () => ctl().updateEnable({ expiry: box2.checked }))
    check.append(box2, h("span", "gd-choice-label", "End automatically"))
    expiryRow.append(check)
    if (form.expiry) {
      const selectId = nextId("gd-expiry")
      const label = h("label", "sr-only", "End after")
      label.htmlFor = selectId
      const select = h("select", "gd-select")
      select.id = selectId
      select.dataset.key = `expiry-time:${guard.id}`
      const placeholder = h("option", "", "Choose a time")
      placeholder.value = ""
      placeholder.disabled = true
      select.append(placeholder)
      for (const choice of EXPIRY_CHOICES) {
        const option = h("option", "", `after ${choice.label}`)
        option.value = String(choice.minutes)
        select.append(option)
      }
      select.value = form.minutes === null ? "" : String(form.minutes)
      select.addEventListener("change", () => ctl().updateEnable({ minutes: Number(select.value) }))
      expiryRow.append(label, select)
    }
    box.append(expiryRow)
    const op = state.ops[`enable:${guard.id}`]
    const actions = h("div", "gd-actions")
    button(actions, libraryMounted, `enable-confirm:${guard.id}`, {
      label: "Enable guard",
      variant: "default",
      size: "xs",
      disabled: form.expiry && form.minutes === null,
      loading: op?.status === "pending",
      onClick: () => ctl().confirmEnable(),
    })
    button(actions, libraryMounted, `enable-cancel:${guard.id}`, { label: "Cancel", variant: "ghost", size: "xs", onClick: () => ctl().cancelEnable() })
    box.append(actions)
    opNotice(box, libraryMounted, op)
    parent.append(box)
  }

  const deleteConfirm = (parent: HTMLElement, state: GuardsState, data: GuardState, guard: Guard) => {
    if (state.confirmDelete !== guard.id) return
    const count = enforcedActivationCount(data, guard.id)
    const box = h("div", "gd-confirm")
    box.setAttribute("role", "group")
    box.setAttribute("aria-label", "Confirm delete")
    box.append(h("p", "gd-text", `Delete "${guard.label}"? This cannot be undone.`))
    if (count > 0) {
      // One guard can hold a session and a request activation on the same session, so the row count is not a session count.
      const p = h("p", "gd-note", "This guard is active. Deleting it releases it everywhere.")
      p.dataset.tone = "warning"
      box.append(p)
    }
    const op = state.ops[`delete:${guard.id}`]
    const actions = h("div", "gd-actions")
    button(actions, libraryMounted, `delete-confirm:${guard.id}`, {
      label: "Delete guard",
      variant: "destructive",
      size: "xs",
      loading: op?.status === "pending",
      onClick: () => ctl().confirmDelete(guard.id),
    })
    button(actions, libraryMounted, `delete-cancel:${guard.id}`, { label: "Cancel", variant: "ghost", size: "xs", onClick: () => ctl().cancelDelete() })
    box.append(actions)
    opNotice(box, libraryMounted, op)
    parent.append(box)
  }

  const guardCard = (ul: HTMLElement, state: GuardsState, data: GuardState, guard: Guard, enforced: Enforcement) => {
    const li = h("li", "gd-card")
    const mine = here.filter((entry) => entry.guard?.id === guard.id && entry.relation !== "unknown" && entry.enforcing)
    li.dataset.active = mine.length > 0 ? "true" : "false"
    const head = h("div", "gd-card-head")
    head.append(h("h3", "gd-card-label", guard.label))
    head.append(h("span", "gd-pill", mine.length > 0 ? "Active here" : "Off"))
    li.append(head)
    ruleList(li, guard.rules, false)
    const others = otherSessionCount(data, guard.id, mine)
    if (others > 0) li.append(h("p", "gd-meta", `Active in ${others === 1 ? "1 other session" : `${others} other sessions`}.`))
    const details = h("details", "gd-details")
    details.dataset.key = `details:${guard.id}`
    details.append(h("summary", "", "Details"))
    const dl = h("dl", "gd-dl")
    const row = (label: string, value: string, className = "gd-text") => {
      const div = h("div")
      div.append(h("dt", "gd-subtitle", label), h("dd", className, value))
      dl.append(div)
    }
    row("Model's description", guard.summary)
    row("Your request", guard.request, "gd-quote")
    row("Message the agent sees", guard.message, "gd-quote")
    const coverage = h("div")
    coverage.append(h("dt", "gd-subtitle", "When rules apply"))
    for (const rule of guard.rules) coverage.append(h("dd", "gd-text", `${describeRule(rule)}. ${ruleCoverage(rule)}`))
    dl.append(coverage)
    details.append(dl)
    li.append(details)

    const actions = h("div", "gd-actions")
    li.append(actions)
    const editing = state.enable?.guardId === guard.id || state.confirmDelete === guard.id
    if (!editing) {
      if (mine.length > 0) {
        const pending = mine.some((entry) => state.ops[`release:${entry.activation.id}`]?.status === "pending")
        button(actions, libraryMounted, `release-guard:${guard.id}`, {
          label: "Release",
          variant: "outline",
          size: "xs",
          loading: pending,
          onClick: () => {
            for (const entry of mine) ctl().release(entry.activation.id)
          },
        })
      } else {
        button(actions, libraryMounted, `enable:${guard.id}`, {
          label: "Enable…",
          variant: "outline",
          size: "xs",
          disabled: !state.sessionId || !canEnable(enforced),
          onClick: () => ctl().startEnable(guard.id),
        })
      }
      button(actions, libraryMounted, `delete:${guard.id}`, { label: "Delete", variant: "ghost", size: "xs", onClick: () => ctl().askDelete(guard.id) })
    }
    if (mine.length === 0 && !editing) {
      if (!state.sessionId) li.append(h("p", "gd-hint", "Open a chat session to enable a guard."))
      else if (!canEnable(enforced)) li.append(h("p", "gd-hint", "Enable is available when the plugin confirms enforcement here."))
    }
    enableForm(li, state, guard)
    deleteConfirm(li, state, data, guard)
    if (!editing) opNotice(li, libraryMounted, state.ops[`delete:${guard.id}`])
    ul.append(li)
  }

  const renderLibrary = (state: GuardsState) => {
    const data = state.load.kind === "ready" ? state.load.data : null
    const ops = Object.values(state.ops).filter((op) => op.kind !== "save")
    const key = JSON.stringify([
      data ? canEnable(enforcement(data, now())) : false,
      data ? [data.guards, data.activations] : state.load.kind,
      state.sessionId,
      here.map((e) => [e.activation.id, e.relation]),
      ops,
      state.enable,
      state.confirmDelete,
    ])
    if (key === libraryKey) return
    libraryKey = key
    libraryTitle.textContent = data ? `Saved guards (${data.guards.length})` : "Saved guards"
    preserving(libraryBody, () => {
      dispose(libraryMounted)
      libraryBody.replaceChildren()
      if (!data) {
        libraryBody.append(h("p", "gd-empty", state.load.kind === "error" ? "Not available." : "Reading…"))
        return
      }
      if (data.guards.length === 0) {
        libraryBody.append(h("p", "gd-empty", "No saved guards yet. Describe one above and select Generate preview."))
        return
      }
      const ul = h("ul", "gd-list")
      const enforced = enforcement(data, now())
      for (const guard of [...data.guards].sort((a, b) => a.label.localeCompare(b.label))) guardCard(ul, state, data, guard, enforced)
      libraryBody.append(ul)
    })
  }

  return {
    render: (state) => {
      renderStatus(state)
      renderRecover(state)
      renderActive(state)
      renderPreview(state)
      renderLibrary(state)
    },
    activeCount: () => here.filter((entry) => entry.relation !== "unknown" && entry.enforcing).length,
    dispose: () => {
      dispose(statusMounted)
      dispose(recoverMounted)
      dispose(activeMounted)
      dispose(libraryMounted)
      dispose(previewMounted)
      dispose(previewOps)
      generateButton.dispose()
      root.replaceChildren()
    },
  }
}
