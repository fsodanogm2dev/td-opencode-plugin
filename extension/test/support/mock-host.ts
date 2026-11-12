/**
 * A fake OpenChamber host that speaks the SDK wire protocol.
 * It answers only `file-read` from an in-memory map of fake files.
 * Used by the panel tests (through `connectHost`'s `target` test seam)
 * and by the browser preview (through a real iframe).
 */
import type { HostTheme } from "@openchamber/sdk"

export type FileAnswer = { content: string } | { code: string }

export type MockHostOptions = {
  /** Send a message to the panel. */
  post: (message: unknown) => void
}

type Waiter = { path: string; respond: (answer: FileAnswer) => void }

const CHANNEL = "openchamber.sdk"

export const DARK_THEME: HostTheme = {
  mode: "dark",
  tokens: {
    background: "#151313",
    elevated: "#1c1a19",
    foreground: "#e8e4df",
    muted: "#9a948d",
    subtle: "#2a2725",
    border: "#34302d",
    hover: "#2a2725",
    selection: "#3a3531",
    focus: "#d97757",
    primary: "#d97757",
    mutedSurface: "#242120",
    elevatedForeground: "#e8e4df",
    active: "#332f2c",
    selectionForeground: "#f4f1ed",
    primaryForeground: "#1b1110",
    primaryText: "#eb9a7d",
    successText: "#8fcf9a",
    warningText: "#e7c06a",
    errorText: "#f0918a",
    infoText: "#8db8ef",
    success: "#4f9d5d",
    warning: "#c99a2e",
    error: "#d0574f",
    info: "#4c86d1",
    font: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
    radius: "9px",
  },
}

export const LIGHT_THEME: HostTheme = {
  mode: "light",
  tokens: {
    ...DARK_THEME.tokens,
    background: "#faf8f5",
    elevated: "#ffffff",
    foreground: "#1f1c1a",
    muted: "#6e6862",
    subtle: "#f0ece7",
    border: "#e4ded7",
    hover: "#f0ece7",
    selection: "#e9e3dc",
    mutedSurface: "#f3efea",
    elevatedForeground: "#1f1c1a",
    active: "#e7e1da",
    selectionForeground: "#1f1c1a",
    primaryForeground: "#ffffff",
    primaryText: "#b0532f",
    successText: "#2f7a3d",
    warningText: "#8a6312",
    errorText: "#b23a32",
    infoText: "#2d64ad",
  },
}

export const createMockHost = (options: MockHostOptions) => {
  const files = new Map<string, FileAnswer>()
  const reads: string[] = []
  const held: Waiter[] = []
  let holding = false
  let theme: HostTheme = DARK_THEME

  const send = (message: Record<string, unknown>) => options.post({ channel: CHANNEL, v: 1, ...message })

  const answer = (id: string, result: FileAnswer) => {
    if ("content" in result) send({ type: "result", id, ok: true, payload: { content: result.content } })
    else send({ type: "result", id, ok: false, code: result.code, error: `Mock host: ${result.code}` })
  }

  return {
    files,
    /** Every path the panel asked for, in order. */
    reads,
    setTheme: (next: HostTheme) => {
      theme = next
    },
    /** While on, reads wait until `release` answers them. */
    hold: (on: boolean) => {
      holding = on
    },
    held,
    ready: (directory: string | null) =>
      send({
        type: "ready",
        payload: {
          theme,
          locale: "en-US",
          directory,
          session: null,
          surface: "panel",
          connection: { connected: false, account: "" },
          settings: {},
          item: null,
        },
      }),
    directory: (directory: string | null) => send({ type: "directory", payload: { directory } }),
    /** Handle one message from the panel. */
    receive: (data: unknown) => {
      if (typeof data !== "object" || data === null) return
      const message = data as { channel?: string; type?: string; id?: string; payload?: { path?: string } }
      if (message.channel !== CHANNEL || message.type !== "file-read" || !message.id) return
      const path = message.payload?.path ?? ""
      reads.push(path)
      const id = message.id
      const respond = (result: FileAnswer) => answer(id, result)
      if (holding) {
        held.push({ path, respond })
        return
      }
      respond(files.get(path) ?? { code: "NOT_FOUND" })
    },
    /** Answer a held read with the file map's current content. */
    release: (index: number) => {
      const waiter = held[index]
      if (!waiter) throw new Error(`No held read ${index}`)
      waiter.respond(files.get(waiter.path) ?? { code: "NOT_FOUND" })
    },
  }
}

export type MockHost = ReturnType<typeof createMockHost>
