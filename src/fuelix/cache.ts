/**
 * FueliX has rejected a long Anthropic request with HTTP 400: "Model ... requires a cache_control breakpoint on
 * prompts of 1024 tokens or more". This module is a safeguard. It adds one breakpoint to a request that has none.
 * The cause of the missing marker is not established.
 *
 * `ensureCacheBreakpoint` is a pure transform of a parsed `/v1/messages` body. `withCacheFetch` applies it to the
 * outgoing request. The plugin does not count tokens, so the transform marks every request that has no marker yet.
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type Json = Record<string, unknown>

const EPHEMERAL = { type: "ephemeral" } as const

/** Block types that accept `cache_control`. Thinking blocks and empty text blocks do not. */
const CACHEABLE_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result"])

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

function isCacheable(block: unknown): block is Json {
  if (!isRecord(block) || typeof block.type !== "string" || !CACHEABLE_TYPES.has(block.type)) return false
  if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== ""
  return true
}

const isMarked = (value: unknown): boolean => isRecord(value) && value.cache_control !== undefined && value.cache_control !== null

/** True when a content block, or a `tool_result` content block inside it, carries a marker. */
function blockMarked(block: unknown): boolean {
  if (isMarked(block)) return true
  return isRecord(block) && block.type === "tool_result" && Array.isArray(block.content) && block.content.some(isMarked)
}

/**
 * True when the body carries a `cache_control` marker at an Anthropic structural position: the top level, a tool,
 * a system block, a message content block, or a `tool_result` content block. Schemas, tool input, and other
 * user data are not scanned, because they can hold a property that is named `cache_control`.
 */
function hasMarker(body: Json): boolean {
  if (isMarked(body)) return true
  if (Array.isArray(body.tools) && body.tools.some(isMarked)) return true
  if (Array.isArray(body.system) && body.system.some(blockMarked)) return true
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => isRecord(message) && Array.isArray(message.content) && message.content.some(blockMarked))
}

function markedBlock(block: Json): Json {
  return { ...block, cache_control: { ...EPHEMERAL } }
}

function markSystem(system: unknown): unknown[] | undefined {
  if (typeof system === "string") {
    return system.trim() === "" ? undefined : [{ type: "text", text: system, cache_control: { ...EPHEMERAL } }]
  }
  if (!Array.isArray(system)) return undefined
  for (let index = system.length - 1; index >= 0; index--) {
    const block = system[index]
    if (!isCacheable(block)) continue
    const copy = [...system]
    copy[index] = markedBlock(block)
    return copy
  }
  return undefined
}

function markMessages(messages: unknown[]): unknown[] | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (!isRecord(message)) continue
    const content = message.content
    let next: unknown[] | undefined
    if (typeof content === "string") {
      if (content.trim() === "") continue
      next = [{ type: "text", text: content, cache_control: { ...EPHEMERAL } }]
    } else if (Array.isArray(content)) {
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b]
        if (!isCacheable(block)) continue
        next = [...content]
        next[b] = markedBlock(block)
        break
      }
    }
    if (!next) continue
    const copy = [...messages]
    copy[m] = { ...message, content: next }
    return copy
  }
  return undefined
}

/**
 * Returns `body` with one `cache_control: {type: "ephemeral"}` marker, or `undefined` when the body needs no change.
 * No change means: it is not an Anthropic messages body, it has a marker already, or it has no cacheable block.
 * The marker goes on the last cacheable system block, else on the last cacheable message block.
 * The input is never mutated.
 */
export function ensureCacheBreakpoint(body: unknown): Json | undefined {
  if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) return undefined
  if (hasMarker(body)) return undefined
  const system = markSystem(body.system)
  if (system) return { ...body, system }
  const messages = markMessages(body.messages)
  if (messages) return { ...body, messages }
  return undefined
}

/** Anthropic `POST .../messages` only. `/messages/count_tokens`, `/messages/batches`, and other paths do not match. */
function isMessagesPost(url: string, method: string): boolean {
  if (method.toUpperCase() !== "POST") return false
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/messages")
  } catch {
    return false
  }
}

/** The body rewritten with a marker, or `undefined` when the request must go out untouched. */
function rewriteBody(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const next = ensureCacheBreakpoint(parsed)
  return next ? JSON.stringify(next) : undefined
}

/** The arguments for `base`: marked when the request qualifies, otherwise the original arguments. */
async function prepare(input: RequestInfo | URL, init: RequestInit | undefined): Promise<[RequestInfo | URL, RequestInit | undefined]> {
  const original: [RequestInfo | URL, RequestInit | undefined] = [input, init]
  try {
    const request = input instanceof Request ? input : undefined
    const url = request ? request.url : input instanceof URL ? input.href : String(input)
    const method = init?.method ?? request?.method ?? "GET"
    if (!isMessagesPost(url, method)) return original

    const initBody = init?.body ?? undefined
    let text: string | undefined
    if (initBody !== undefined) {
      if (typeof initBody === "string") text = initBody
    } else if (request && !request.bodyUsed) {
      text = await request.clone().text()
    }
    if (text === undefined) return original

    const body = rewriteBody(text)
    if (body === undefined) return original

    // The body length changes, so a fixed `content-length` header would be wrong.
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.delete("content-length")
    if (request && initBody === undefined) return [new Request(request, { ...init, headers, body }), undefined]
    return [input, { ...init, headers, body }]
  } catch {
    return original
  }
}

/**
 * Wraps `base` so that outgoing Anthropic `/messages` JSON requests carry a cache breakpoint. Auth is not part of
 * this wrapper. Compose it inside `withAuthFetch`. A body that is not a string or not JSON goes out unchanged, and
 * the response, streaming included, is returned as `base` returns it.
 */
export function withCacheFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const [nextInput, nextInit] = await prepare(input, init)
    return base(nextInput, nextInit)
  }
}
