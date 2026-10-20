/**
 * Shared helpers for the FueliX integration tests: catalog access, a mock FueliX gateway, and model queries.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Catalog, CatalogCost, CatalogEntry, CatalogCostTier } from "../../src/fuelix/catalog-types.ts"
import { type IsolatedServer, pluginEntry, repoRoot, startIsolatedServer, waitFor } from "./harness.ts"

export const FAKE_KEY = "sk-test-not-a-real-key"
export const FUELIX_PROVIDERS = ["fuelix-openai", "fuelix-anthropic", "fuelix"] as const

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(join(repoRoot(), "data", "fuelix-models.json"), "utf8")) as Catalog
}

/** Listed chat IDs of the catalog, sorted. */
export function listedChatIDs(catalog: Catalog = loadCatalog()): string[] {
  return Object.entries(catalog.models)
    .filter(([, entry]) => entry.kind === "chat" && entry.listed === true)
    .map(([id]) => id)
    .sort()
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenCode model and provider shapes (the fields these tests read)
// ---------------------------------------------------------------------------------------------------------------------

export interface ApiCost {
  tier?: { type: string; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface ApiModel {
  id: string
  modelID: string
  providerID: string
  name: string
  package?: string
  settings?: Record<string, unknown>
  variants: { id: string; settings: Record<string, unknown> }[]
  cost: ApiCost[]
  limit: { context: number; input?: number; output: number }
  status: string
}

export interface ApiProvider {
  id: string
  integrationID?: string
  activation?: string
  package?: string
  settings?: Record<string, unknown>
  [key: string]: unknown
}

export async function listModels(server: IsolatedServer): Promise<{ models: ApiModel[]; text: string }> {
  const response = await server.api<{ data: ApiModel[] }>("GET", "/api/model")
  if (response.status !== 200) throw new Error(`GET /api/model returned HTTP ${response.status}`)
  return { models: response.json.data, text: JSON.stringify(response.json.data) }
}

export async function listProviders(server: IsolatedServer): Promise<{ providers: ApiProvider[]; text: string }> {
  const response = await server.api<{ data: ApiProvider[] }>("GET", "/api/provider")
  if (response.status !== 200) throw new Error(`GET /api/provider returned HTTP ${response.status}`)
  return { providers: response.json.data, text: JSON.stringify(response.json.data) }
}

export const isFuelix = (providerID: string): boolean => providerID.startsWith("fuelix")

// ---------------------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------------------

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Expected cost in USD for one step, from catalog prices. `output` here excludes reasoning tokens;
 * the formula adds them at the output price. The tier price applies when the total input is above `contextOver`.
 */
export function expectedCost(entry: CatalogEntry, usage: Usage): number {
  const total = usage.input + usage.cacheRead + usage.cacheWrite
  let price: CatalogCost | CatalogCostTier = entry.cost!
  for (const tier of entry.costTiers ?? []) {
    if (total > tier.contextOver) price = tier
  }
  return (
    (usage.input * price.input +
      (usage.output + usage.reasoning) * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1e6
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock FueliX gateway
// ---------------------------------------------------------------------------------------------------------------------

export interface RecordedRequest {
  method: string
  path: string
  /** Lower-case header names. The values are kept because the key in these tests is a fake. */
  headers: Record<string, string>
  body: any
}

export interface MockFuelix {
  readonly url: string
  readonly port: number
  /** All requests, in order. */
  readonly requests: RecordedRequest[]
  /** Sets the IDs that `GET /v1/models` returns. */
  setModels(ids: string[]): void
  stop(): void
}

export interface MockFuelixInput {
  models: string[]
  /** Handler for non-model requests. Return `undefined` for 404. */
  handler?: (request: RecordedRequest, raw: Request) => Response | Promise<Response> | undefined
}

export function startMockFuelix(input: MockFuelixInput): MockFuelix {
  let ids = [...input.models]
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(raw) {
      const url = new URL(raw.url)
      const headers: Record<string, string> = {}
      raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      let body: any
      if (raw.method !== "GET" && raw.method !== "HEAD") {
        const text = await raw.text()
        try {
          body = text === "" ? undefined : JSON.parse(text)
        } catch {
          body = text
        }
      }
      const recorded: RecordedRequest = { method: raw.method, path: url.pathname, headers, body }
      requests.push(recorded)
      if (raw.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: ids.map((id) => ({ id, object: "model", created: 1_700_000_000, owned_by: "fuelix" })),
        })
      }
      const response = await input.handler?.(recorded, raw)
      return response ?? new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    requests,
    setModels: (next) => {
      ids = [...next]
    },
    stop: () => void server.stop(true),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------------------------------------------------

export interface FuelixServerInput {
  baseURL: string
  /** The key goes only into the server environment. */
  key: string
  extraOptions?: Record<string, unknown>
}

export function startFuelixServer(input: FuelixServerInput): Promise<IsolatedServer> {
  return startIsolatedServer({
    config: {
      plugins: [
        pluginEntry({
          fuelix: { baseURL: input.baseURL, keychainService: false, refreshMinutes: 0 },
          ...input.extraOptions,
        }),
      ],
    },
    env: { FUELIX_API_KEY: input.key },
  })
}

/** Polls `/api/model` until the FueliX model IDs equal `ids` (OpenCode boots its location on the first request). */
export async function waitForFuelixModels(server: IsolatedServer, ids: readonly string[], timeoutMs = 60_000): Promise<ApiModel[]> {
  const expected = [...ids].sort()
  return waitFor(
    async () => {
      const { models } = await listModels(server)
      const found = models.filter((m) => isFuelix(m.providerID))
      const actual = [...new Set(found.map((m) => m.id))].sort()
      return actual.length === expected.length && actual.every((id, index) => id === expected[index]) ? found : undefined
    },
    timeoutMs,
    "FueliX models",
  )
}

export function entryFor(catalog: Catalog, id: string): CatalogEntry | undefined {
  return Object.hasOwn(catalog.models, id) ? catalog.models[id] : undefined
}
