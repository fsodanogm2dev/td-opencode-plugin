/**
 * Secret redaction for every text that leaves the process (TypeSafe requests) or reaches disk (log artifacts).
 *
 * Redaction always runs on the whole string, and a size cap runs afterwards. A cap applied first could cut a token
 * in half and leave a prefix that no pattern recognizes. Redaction lowers the risk. It does not guarantee that no
 * secret leaves the machine.
 */

import type { JsonValue } from "./types.ts"

export const REDACTED = "[REDACTED]"

/**
 * Longest text that redaction scans. A longer text is never redacted in pieces, because a secret could then cross a
 * cut. `redactText` returns `OVERSIZE_MARKER` for it, and callers that store text refuse it (`exceedsRedactLimit`).
 */
export const MAX_REDACT_CHARS = 4 * 1024 * 1024

export const OVERSIZE_MARKER = "[output omitted: too large to redact safely]"

export function exceedsRedactLimit(text: string): boolean {
  return text.length > MAX_REDACT_CHARS
}

/** Shortest literal secret that redaction replaces. Shorter strings would damage ordinary text. */
const MIN_LITERAL_LENGTH = 6

export interface RedactOptions {
  /** Literal secrets, for example the active API key. Replaced in raw, JSON-escaped, URL-encoded, and base64 form. */
  readonly secrets?: readonly string[]
}

const NAME = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|cookie)`
const SENSITIVE_KEY = new RegExp(NAME, "i")

// A private key block: the BEGIN line, then only key material (base64 lines of 16 or more characters, JSON-escaped
// `\n` as a line break, and the PEM `Proc-Type` and `DEK-Info` headers), then the END line when it follows. Text with
// a `;`, a command, or any other character ends the match, so a shell payload after an unterminated marker stays
// visible. Tokens are maximal base64 runs, so matching stays linear.
const KEY_GAP = String.raw`(?:\s|\\[nr])*`
const KEY_TOKEN = String.raw`[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/])`
const KEY_HEADER = String.raw`(?:Proc-Type|DEK-Info):[A-Za-z0-9 ,.:-]*`
const KEY_END = String.raw`-----END [A-Z0-9 ]*PRIVATE KEY-----`
const PRIVATE_KEY = new RegExp(
  String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:${KEY_GAP}(?:${KEY_HEADER}|${KEY_TOKEN}))*` +
    String.raw`(?:${KEY_GAP}[A-Za-z0-9+/]{2,}={0,2}(?![A-Za-z0-9+/])(?=${KEY_GAP}(?:${KEY_END}|$)))?` +
    String.raw`(?:${KEY_GAP}${KEY_END})?`,
  "g",
)
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
const VENDOR_KEY = /\b(?:sk|ak)-[A-Za-z0-9_-]{6,}/g
const AWS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g
const SLACK_TOKEN = /(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi
const AUTHORIZATION = /(\bauthorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?!\[REDACTED\])(?:(?:basic|bearer|digest|token|negotiate)\s+)?[^\s"',;\\]+/gi
const CLI_FLAG = new RegExp(
  String.raw`(--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key)\s+)(?!-|\[REDACTED\])(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|["'][^\n]*|\S+)`,
  "gi",
)
// A name that holds a secret, a separator, and the value. Quoted values may contain spaces. An unterminated quote
// redacts the rest of the line. Name affixes are bounded, so matching stays linear.
const ASSIGNMENT = new RegExp(
  String.raw`([A-Za-z0-9_.-]{0,40}${NAME}[A-Za-z0-9_.-]{0,40}(?:\\?["'])?\s*[:=]\s*)(?!\[REDACTED\])` +
    String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\\["'][^\n]*?\\["']|["'][^\n]*|[^\s"'\x60,;&)\]}]+)`,
  "gi",
)

/** Shell constructs that run code: command substitution, backticks, and process substitution. */
const EXPANSION = /\$\(|`|<\(|>\(/

/**
 * Replaces the value of an assignment, flag, or header. Keeps the quotes of a quoted value. A value that holds
 * executable shell syntax keeps that syntax and everything after it, because it is code, not a secret. Only the
 * literal text before it is replaced. Literal active keys and vendor key formats inside the code are redacted by the
 * other patterns. Single-quoted text never runs, so it is redacted whole.
 */
function replaceValue(match: string, prefix: string): string {
  const value = match.slice(prefix.length)
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote) && quote === "'") {
    return `${prefix}${quote}${REDACTED}${quote}`
  }
  const run = quote === "'" ? -1 : value.search(EXPANSION)
  if (run >= 0) {
    const open = quote === '"' ? 1 : value.startsWith('\\"') || value.startsWith("\\'") ? 2 : 0
    const literal = value.slice(open, run)
    return `${prefix}${value.slice(0, open)}${literal === "" ? "" : REDACTED}${value.slice(run)}`
  }
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return `${prefix}${quote}${REDACTED}${quote}`
  return `${prefix}${REDACTED}`
}

function literalVariants(secrets: readonly string[] | undefined): string[] {
  const variants = new Set<string>()
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string" || secret.length < MIN_LITERAL_LENGTH) continue
    variants.add(secret)
    variants.add(JSON.stringify(secret).slice(1, -1))
    variants.add(encodeURIComponent(secret))
    variants.add(Buffer.from(secret, "utf8").toString("base64"))
  }
  return [...variants].filter((value) => value.length >= MIN_LITERAL_LENGTH).sort((a, b) => b.length - a.length)
}

/**
 * Redacts the whole text. Does not cap the length. A text above `MAX_REDACT_CHARS` becomes `OVERSIZE_MARKER`, so no
 * part of it is sent or stored.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  if (exceedsRedactLimit(text)) return OVERSIZE_MARKER
  let out = text
  for (const variant of literalVariants(options.secrets)) out = out.split(variant).join(REDACTED)
  out = out.replace(PRIVATE_KEY, REDACTED)
  out = out.replace(JWT, REDACTED)
  out = out.replace(VENDOR_KEY, REDACTED)
  out = out.replace(AWS_KEY, REDACTED)
  out = out.replace(GITHUB_TOKEN, REDACTED)
  out = out.replace(SLACK_TOKEN, REDACTED)
  out = out.replace(BEARER, `Bearer ${REDACTED}`)
  out = out.replace(URL_CREDENTIALS, (match, scheme: string) => (EXPANSION.test(match) ? match : `${scheme}${REDACTED}@`))
  out = out.replace(AUTHORIZATION, (match, prefix: string) => replaceValue(match, prefix))
  out = out.replace(CLI_FLAG, (match, prefix: string) => replaceValue(match, prefix))
  out = out.replace(ASSIGNMENT, (match, prefix: string) => replaceValue(match, prefix))
  return out
}

export interface CappedText {
  readonly text: string
  /** Length of the original text, before redaction and cap. */
  readonly originalLength: number
  readonly truncated: boolean
}

/** Redacts the whole text first, then keeps at most `maxChars` characters from the start. An oversize text gives the marker. */
export function redactAndCap(text: string, maxChars: number, options: RedactOptions = {}): CappedText {
  const redacted = redactText(text, options)
  const limit = Math.max(0, Math.floor(maxChars))
  return {
    text: redacted.length > limit ? redacted.slice(0, limit) : redacted,
    originalLength: text.length,
    truncated: exceedsRedactLimit(text) || redacted.length > limit,
  }
}

/**
 * Redacts the whole text first, then keeps the first `headChars` and the last `tailChars` characters. A text that
 * fits keeps all of it. The marker between the parts says that the middle is omitted.
 */
export function redactHeadTail(text: string, headChars: number, tailChars: number, options: RedactOptions = {}): CappedText {
  const redacted = redactText(text, options)
  const head = Math.max(0, Math.floor(headChars))
  const tail = Math.max(0, Math.floor(tailChars))
  if (exceedsRedactLimit(text)) return { text: redacted, originalLength: text.length, truncated: true }
  if (redacted.length <= head + tail) return { text: redacted, originalLength: text.length, truncated: false }
  return {
    text: `${redacted.slice(0, head)}\n...[middle omitted]...\n${tail > 0 ? redacted.slice(-tail) : ""}`,
    originalLength: text.length,
    truncated: true,
  }
}

const MAX_DEPTH = 24
const MAX_NODES = 20_000

export type IncompleteReason = "oversize" | "truncated"

export interface RedactJsonOptions extends RedactOptions {
  /**
   * Called when the result lacks input: a string above `MAX_REDACT_CHARS` became `OVERSIZE_MARKER`, or the structure
   * was cut off. Callers that send or store the result must treat that as a failure.
   */
  readonly onIncomplete?: (reason: IncompleteReason) => void
  /** Replace string and number values under keys that name a secret (`password`, `token`, ...). Default true. */
  readonly sensitiveKeys?: boolean
}

/**
 * Returns a JSON copy of `value` with every string redacted. Object keys stay as they are. Functions, symbols, and
 * `undefined` are dropped, non-finite numbers become `null`, and a structure deeper than 24 levels or larger than
 * 20,000 nodes is cut off with a marker string.
 */
export function redactJson(value: unknown, options: RedactJsonOptions = {}): JsonValue {
  let nodes = 0
  const sensitiveKeys = options.sensitiveKeys !== false
  const visit = (current: unknown, depth: number): JsonValue | undefined => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      options.onIncomplete?.("truncated")
      return "[truncated]"
    }
    if (current === null) return null
    switch (typeof current) {
      case "string":
        if (exceedsRedactLimit(current)) options.onIncomplete?.("oversize")
        return redactText(current, options)
      case "number":
        return Number.isFinite(current) ? current : null
      case "boolean":
        return current
      case "bigint":
        return redactText(current.toString(), options)
      case "object":
        break
      default:
        return undefined
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1) ?? null)
    // A null prototype keeps a `__proto__` key as plain data.
    const out = Object.create(null) as Record<string, JsonValue>
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (sensitiveKeys && SENSITIVE_KEY.test(key) && (typeof item === "string" || typeof item === "number")) {
        out[key] = REDACTED
        continue
      }
      const next = visit(item, depth + 1)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return visit(value, 0) ?? null
}
