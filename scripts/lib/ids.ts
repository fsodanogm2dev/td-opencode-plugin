/** Parse a list of model IDs from a `/v1/models` response, a JSON array, or one ID per line. */

export function parseIds(text: string): string[] {
  const trimmed = text.trim()
  let ids: string[] = []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const value: unknown = JSON.parse(trimmed)
    const list: unknown = Array.isArray(value) ? value : (value as { data?: unknown }).data
    if (!Array.isArray(list)) throw new Error("Expected a JSON array or an object with a `data` array.")
    ids = list
      .map((item) => (typeof item === "string" ? item : (item as { id?: unknown } | null)?.id))
      .filter((item): item is string => typeof item === "string")
  } else {
    ids = trimmed.split(/\r?\n/).map((line) => line.trim())
  }
  return [...new Set(ids.filter((id) => id.length > 0))].sort()
}
