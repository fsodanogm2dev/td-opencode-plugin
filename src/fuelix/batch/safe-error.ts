const MAX_ERROR_CHARS = 300

/**
 * Error names whose messages may reach a model or a user: fixed-message errors of this plugin only. Anything else
 * becomes a generic message, so remote bodies, headers, paths from system errors, and keys never reach the output.
 */
export const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set(["BatchClientError", "BatchArtifactError", "BatchServiceError"])

export function sanitizeMessage(message: string, secrets: readonly string[]): string {
  let text = message
  for (const secret of secrets) if (secret !== "") text = text.split(secret).join("[redacted]")
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\b(sk|ak)-[A-Za-z0-9_-]{6,}/g, "$1-[redacted]")
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text
}

/** Short, log-safe error code, or undefined. */
export function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : undefined
}
