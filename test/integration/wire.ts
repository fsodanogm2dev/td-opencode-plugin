/**
 * FueliX wire formats: usage parsing and normalization. Shared by the live usage test and the wire replay test.
 */

export type WireKind = "anthropic" | "responses" | "chat"

export function kindOfPath(path: string): WireKind | undefined {
  if (path.endsWith("/messages")) return "anthropic"
  if (path.endsWith("/responses")) return "responses"
  if (path.endsWith("/chat/completions")) return "chat"
  return undefined
}

/** Usage object as the upstream sent it. Field names depend on the wire format. */
export type RawUsage = Record<string, any>

function sseDataLines(text: string): any[] {
  const events: any[] = []
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data === "" || data === "[DONE]") continue
    try {
      events.push(JSON.parse(data))
    } catch {
      // Ignore frames that are not JSON.
    }
  }
  return events
}

/** Parses the final usage of a response body (JSON or SSE). Returns `undefined` when none is present. */
export function parseUsage(kind: WireKind, contentType: string, text: string): RawUsage | undefined {
  const isSSE = contentType.includes("text/event-stream")
  if (!isSSE) {
    try {
      const body = JSON.parse(text)
      return kind === "responses" ? (body?.usage ?? body?.response?.usage) : body?.usage
    } catch {
      return undefined
    }
  }
  const events = sseDataLines(text)
  if (kind === "anthropic") {
    let merged: RawUsage | undefined
    for (const event of events) {
      if (event?.type === "message_start" && event.message?.usage) merged = { ...merged, ...event.message.usage }
      if (event?.type === "message_delta" && event.usage) merged = { ...merged, ...event.usage }
    }
    return merged
  }
  if (kind === "responses") {
    for (const event of events) {
      if (event?.type === "response.completed" || event?.type === "response.incomplete") {
        if (event.response?.usage) return event.response.usage
      }
    }
    return undefined
  }
  let last: RawUsage | undefined
  for (const event of events) if (event?.usage) last = event.usage
  return last
}

/** Token counts in the shape of OpenCode `tokens`. `output` includes `reasoning` when the wire reports it as part of the output. */
export interface NormalizedUsage {
  input: number
  /** Total output tokens as the upstream reports them (`output_tokens`, `completion_tokens`). */
  outputTotal: number
  /** Reasoning tokens when the upstream reports them. */
  reasoning: number | undefined
  cacheRead: number
  cacheWrite: number
  /** Facts that do not map to an OpenCode field. */
  notes: string[]
}

export function normalizeUsage(kind: WireKind, usage: RawUsage): NormalizedUsage {
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const notes: string[] = []
  if (kind === "anthropic") {
    return {
      input: n(usage.input_tokens),
      outputTotal: n(usage.output_tokens),
      reasoning: undefined,
      cacheRead: n(usage.cache_read_input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      notes,
    }
  }
  if (kind === "responses") {
    const cached = n(usage.input_tokens_details?.cached_tokens)
    const cacheWrite = n(usage.input_tokens_details?.cache_write_tokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens)
    if (usage.input_tokens_details?.cache_write_tokens !== undefined || usage.cache_write_tokens !== undefined) {
      notes.push(`cache_write_tokens reported: ${usage.input_tokens_details?.cache_write_tokens ?? usage.cache_write_tokens}`)
    }
    return {
      input: n(usage.input_tokens) - cached,
      outputTotal: n(usage.output_tokens),
      reasoning: usage.output_tokens_details?.reasoning_tokens === undefined ? undefined : n(usage.output_tokens_details.reasoning_tokens),
      cacheRead: cached,
      cacheWrite,
      notes,
    }
  }
  const cached = n(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens)
  return {
    input: n(usage.prompt_tokens) - cached,
    outputTotal: n(usage.completion_tokens),
    reasoning:
      usage.completion_tokens_details?.reasoning_tokens === undefined ? undefined : n(usage.completion_tokens_details.reasoning_tokens),
    cacheRead: cached,
    cacheWrite: n(usage.cache_creation_input_tokens),
    notes,
  }
}

/** Request body has a non-empty `tools` array: the request comes from the agent loop. */
export function hasTools(body: any): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0
}

export function authScheme(headers: Headers | Record<string, string>): "bearer" | "x-api-key" | "none" {
  const get = (name: string) => (headers instanceof Headers ? headers.get(name) : (headers[name] ?? null))
  if (get("x-api-key")) return "x-api-key"
  const authorization = get("authorization")
  if (authorization && /^bearer\s+\S/i.test(authorization)) return "bearer"
  return "none"
}
