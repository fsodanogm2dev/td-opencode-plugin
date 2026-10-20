/**
 * FueliX accepts only `Authorization: Bearer <key>`. It rejects `x-api-key` with HTTP 401, and the Anthropic
 * package sends `x-api-key`. This function moves the key to the `Authorization` header and removes `x-api-key`.
 *
 * Key choice: `override`, then the key that the request already carries, then `fallback`.
 */
export function applyAuth(headers: Headers, keys: { override?: string | undefined; fallback?: string | undefined }): boolean {
  const apiKey = headers.get("x-api-key")?.trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1]?.trim()
  const key = keys.override || apiKey || bearer || keys.fallback
  if (!key) return false
  headers.set("authorization", `Bearer ${key}`)
  headers.delete("x-api-key")
  return true
}
