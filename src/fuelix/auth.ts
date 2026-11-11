/**
 * FueliX accepts only `Authorization: Bearer <key>`. It rejects `x-api-key` with HTTP 401, and the Anthropic
 * package sends `x-api-key`. This function moves the key to the `Authorization` header and removes `x-api-key`.
 *
 * Key choice: `override`, then the key that the request already carries, then `fallback`.
 * `KEY_PLACEHOLDER` is not a key. The plugin sets it so that `@ai-sdk/anthropic` does not fail before it sends a
 * request, and this function treats it as absent.
 */
export const KEY_PLACEHOLDER = "fuelix-plugin-managed"

const real = (value: string | undefined): string | undefined => (value && value !== KEY_PLACEHOLDER ? value : undefined)

export function applyAuth(headers: Headers, keys: { override?: string | undefined; fallback?: string | undefined }): boolean {
  const apiKey = real(headers.get("x-api-key")?.trim())
  const bearer = real(/^Bearer\s+(.+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1]?.trim())
  const key = keys.override || apiKey || bearer || keys.fallback
  if (!key) return false
  headers.set("authorization", `Bearer ${key}`)
  headers.delete("x-api-key")
  return true
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Wraps the AI SDK `fetch` so that every request gets Bearer auth. Stateless calls such as
 * `/api/experimental/generate/text` do not run Session hooks, so the Session `http.request` hook alone
 * does not cover them. `keys` is read for each request, so a changed key applies at once.
 */
export function withAuthFetch(
  base: FetchLike,
  keys: () => { override?: string | undefined; fallback?: string | undefined },
): FetchLike {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!applyAuth(headers, keys())) return base(input, init)
    return base(input, { ...init, headers })
  }
}
