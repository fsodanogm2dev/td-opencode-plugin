/**
 * Starts the panel or the status section against the mock host in a fake DOM.
 * The caller registers happy-dom first.
 */
import { connectHost } from "@openchamber/sdk"
import type { HostClient, HostFrame } from "@openchamber/sdk"

import { createMockHost, type MockHost } from "./mock-host.ts"

export const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

export const text = (root: ParentNode) => (root.textContent ?? "").replace(/\s+/g, " ")

export const connectMock = (): { host: HostClient; mock: MockHost } => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parentWindow = {}
  let mock: MockHost | null = null
  const target: HostFrame = {
    addEventListener: ((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.add(listener)
    }) as HostFrame["addEventListener"],
    removeEventListener: ((type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.delete(listener)
    }) as HostFrame["removeEventListener"],
    parent: { postMessage: (message) => queueMicrotask(() => mock?.receive(message)) },
  }
  mock = createMockHost({
    post: (data) =>
      queueMicrotask(() => {
        const event = new MessageEvent("message", { data, source: parentWindow as unknown as Window })
        for (const listener of listeners) listener(event)
      }),
  })
  const host = connectHost({ target, acceptSource: (source) => source === parentWindow, requestTimeoutMs: 1000 })
  return { host, mock }
}

/** Clicks the SDK button whose visible label is `label`, inside `scope`. */
export const clickButton = (scope: ParentNode, label: string) => {
  const button = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label)
  if (!button) throw new Error(`No button "${label}". Buttons: ${[...scope.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`)
  button.click()
  return button
}

export const findButton = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null

export const typeInto = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  field.value = value
  field.dispatchEvent(new Event("input", { bubbles: true }))
}
