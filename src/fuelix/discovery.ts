import type { Plugin } from "@opencode/plugin"

export const STORAGE_KEY = "fuelix/models"

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Discovery error. The message never contains the API key. */
export class DiscoveryError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = "DiscoveryError"
    this.status = status
  }
}

export interface FetchModelIDsInput {
  /** Gateway origin without a path. */
  readonly baseURL: string
  readonly key: string
  readonly timeoutMs: number
  readonly fetch: FetchFn
}

/** `GET {baseURL}/v1/models`. Returns sorted, unique model IDs. */
export async function fetchModelIDs(input: FetchModelIDsInput): Promise<string[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DiscoveryError(`GET /v1/models timed out after ${input.timeoutMs} ms`))
    }, input.timeoutMs)
  })
  try {
    const request = (async () => {
      let response: Response
      try {
        response = await input.fetch(`${input.baseURL}/v1/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${input.key}`, accept: "application/json" },
          signal: controller.signal,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error"
        throw new DiscoveryError(`GET /v1/models failed: ${reason.split(input.key).join("[redacted]")}`)
      }
      if (!response.ok) throw new DiscoveryError(`GET /v1/models failed with HTTP ${response.status}`, response.status)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new DiscoveryError("GET /v1/models returned invalid JSON", response.status)
      }
      const data = (body as { data?: unknown } | null)?.data
      if (!Array.isArray(data)) throw new DiscoveryError("GET /v1/models returned an unexpected body", response.status)
      const ids = data
        .map((item) => (item as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === "string" && id !== "")
      return [...new Set(ids)].sort()
    })()
    request.catch(() => {})
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface CachedModels {
  readonly fetchedAt: string
  readonly ids: readonly string[]
}

export async function readCachedModels(storage: Pick<Plugin.Context["storage"], "get">): Promise<CachedModels | undefined> {
  try {
    const value = (await storage.get(STORAGE_KEY)) as { fetchedAt?: unknown; ids?: unknown } | undefined
    if (!value || !Array.isArray(value.ids)) return undefined
    const ids = value.ids.filter((id): id is string => typeof id === "string" && id !== "")
    if (ids.length === 0) return undefined
    return { fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "", ids }
  } catch {
    return undefined
  }
}

export async function writeCachedModels(
  storage: Pick<Plugin.Context["storage"], "set">,
  ids: readonly string[],
  fetchedAt: Date,
): Promise<void> {
  await storage.set(STORAGE_KEY, { fetchedAt: fetchedAt.toISOString(), ids: [...ids] })
}
