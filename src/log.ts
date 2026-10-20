/**
 * Plugin logger. Writes one line per message to stderr, which OpenCode captures in its server log.
 *
 * Never pass a secret to a logger. `redact` is a second line of defense for values that look like FueliX keys.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export interface LoggerOptions {
  readonly debug?: boolean
  readonly prefix?: string
  readonly sink?: (line: string) => void
}

const SECRET_PATTERN = /\b(sk|ak)-[A-Za-z0-9_-]{6,}/g

export function redact(value: string): string {
  return value.replace(SECRET_PATTERN, (match) => `${match.slice(0, 3)}[redacted]`)
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return ""
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text = typeof value === "string" ? JSON.stringify(redact(value)) : String(value)
    parts.push(`${key}=${text}`)
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const prefix = options.prefix ?? "[td-opencode-plugin]"
  const sink = options.sink ?? ((line: string) => console.error(line))
  const write = (level: string, message: string, fields?: LogFields) => {
    try {
      sink(`${prefix} ${level} ${redact(message)}${formatFields(fields)}`)
    } catch {
      // Logging must never throw into plugin code.
    }
  }
  return {
    debug: (message, fields) => {
      if (options.debug) write("debug", message, fields)
    },
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  }
}

/** A logger that records lines in memory. For tests. */
export function createMemoryLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  const logger = createLogger({ debug: true, sink: (line) => lines.push(line) })
  return Object.assign(logger, { lines })
}
