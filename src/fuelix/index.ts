import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import { DEFAULT_KEYCHAIN_SERVICE, type FuelixOptions } from "../options.ts"
import { applyAuth } from "./auth.ts"
import { loadCatalog as defaultLoadCatalog, type LoadedCatalog } from "./catalog.ts"
import { FUELIX_PROVIDER_IDS, type Catalog, type CatalogEntry, type FuelixProviderID } from "./catalog-types.ts"
import {
  defaultExec,
  FUELIX_ENV_NAME,
  FUELIX_INTEGRATION_ID,
  resolveKeys,
  type ExecFn,
  type ResolvedKeys,
} from "./credentials.ts"
import { fetchModelIDs, readCachedModels, writeCachedModels, type FetchFn } from "./discovery.ts"
import { buildModelInfo, buildProviderInfo, enrichFromUpstream, type IncompleteField } from "./models.ts"
import { classifyKind, routeModel } from "./rules.ts"

export type Cleanup = () => Promise<void> | void

/** Injection points for tests. Every field has a production default. */
export interface FuelixDeps {
  readonly fetch?: FetchFn
  readonly exec?: ExecFn
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: string
  readonly now?: () => Date
  readonly setInterval?: (callback: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly loadCatalog?: () => Promise<LoadedCatalog>
}

interface PlannedModel {
  readonly id: string
  readonly entry: CatalogEntry | undefined
}

interface Plan {
  readonly byProvider: Record<FuelixProviderID, PlannedModel[]>
  /** IDs that no catalog entry routes. A rule chose their provider. */
  readonly routedByRule: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error"
}

function sameIDs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function initialIDs(catalog: Catalog, cached: readonly string[] | undefined): string[] {
  if (cached && cached.length > 0) return [...cached]
  const entries = Object.entries(catalog.models)
  const listed = entries.filter(([, entry]) => entry.listed === true).map(([id]) => id)
  return (listed.length > 0 ? listed : entries.map(([id]) => id)).sort()
}

function planModels(catalog: Catalog, ids: readonly string[], includeNonChat: boolean): Plan {
  const byProvider: Plan["byProvider"] = { "fuelix-openai": [], "fuelix-anthropic": [], fuelix: [] }
  const routedByRule: string[] = []
  for (const id of ids) {
    const entry = Object.hasOwn(catalog.models, id) ? catalog.models[id] : undefined
    const kind = entry?.kind ?? classifyKind(id)
    if (kind !== "chat" && !includeNonChat) continue
    if (!entry) routedByRule.push(id)
    byProvider[entry?.provider ?? routeModel(id)].push({ id, entry })
  }
  return { byProvider, routedByRule }
}

async function safely(label: string, log: Logger, action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    log.warn(`${label} failed`, { error: errorMessage(error) })
  }
}

/**
 * Registers the FueliX integration, providers, models, and per-request auth hooks.
 * Discovery of `/v1/models` runs in the background and never throws into the caller.
 */
export async function setupFuelix(
  ctx: Plugin.Context,
  options: FuelixOptions,
  log: Logger,
  deps: FuelixDeps = {},
): Promise<Cleanup> {
  const doFetch: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const startInterval = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms))
  const stopInterval = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))

  const loaded = await (deps.loadCatalog ?? defaultLoadCatalog)()
  const catalog = loaded.catalog
  if (loaded.warning) log.warn(loaded.warning)
  else if (Object.keys(catalog.models).length === 0) log.warn("FueliX catalog is empty")

  const registrations: { dispose: () => Promise<void> }[] = []

  // 1. Integration: one key for the three providers.
  registrations.push(
    await ctx.integration.transform((integrations) => {
      if (!integrations.get(FUELIX_INTEGRATION_ID)) {
        integrations.method.update({
          integrationID: FUELIX_INTEGRATION_ID,
          method: { type: "key", label: "FueliX API key" },
        })
      }
      integrations.update(FUELIX_INTEGRATION_ID, (integration) => {
        integration.name = "FuelIX"
      })
      integrations.method.update({
        integrationID: FUELIX_INTEGRATION_ID,
        method: { type: "env", names: [FUELIX_ENV_NAME] },
      })
    }),
  )

  // 2. Key resolution.
  const keys: ResolvedKeys = await resolveKeys({
    keychainService: options.keychainService,
    platform: deps.platform ?? process.platform,
    exec: deps.exec ?? defaultExec,
    env,
    integration: ctx.integration,
    log,
  })
  const activation = keys.keychainKey || keys.envKey ? "enabled" : "auto"

  // 3. Model state. Initial IDs: cache, then listed catalog entries, then the whole catalog.
  const cached = await readCachedModels(ctx.storage)
  let ids = initialIDs(catalog, cached?.ids)
  let plan = planModels(catalog, ids, options.includeNonChatModels)

  // 4. Providers. The transform is synchronous and reads the captured plan.
  registrations.push(
    await ctx.provider.transform((editor) => {
      for (const providerID of FUELIX_PROVIDER_IDS) {
        const built = plan.byProvider[providerID].map(({ id, entry }) => ({ id, ...buildModelInfo(providerID, id, entry) }))
        editor.add({
          info: buildProviderInfo(providerID, options.baseURL, activation),
          models: built.map((item) => item.info),
        })
        for (const item of built) enrichFromUpstream(editor, providerID, item.id, item.info, item.incomplete)
      }
    }),
  )

  // 5. Auth hooks. FueliX accepts only `Authorization: Bearer`.
  for (const providerID of FUELIX_PROVIDER_IDS) {
    registrations.push(
      await ctx.session.hook(
        "http.request",
        (event) => {
          try {
            applyAuth(event.request.headers, { override: keys.keychainKey, fallback: keys.envKey })
          } catch (error) {
            log.warn("could not apply FueliX auth", { error: errorMessage(error) })
          }
        },
        { providerID },
      ),
    )
  }

  // 6. Summary.
  const incompleteIDs: string[] = []
  for (const providerID of FUELIX_PROVIDER_IDS) {
    for (const { id, entry } of plan.byProvider[providerID]) {
      if (buildModelInfo(providerID, id, entry).incomplete.length > 0) incompleteIDs.push(id)
    }
  }
  log.info("FueliX models registered", {
    "fuelix-openai": plan.byProvider["fuelix-openai"].length,
    "fuelix-anthropic": plan.byProvider["fuelix-anthropic"].length,
    fuelix: plan.byProvider.fuelix.length,
    source: cached ? "cache" : "catalog",
    routedByRule: plan.routedByRule.length,
    routedByRuleIDs: plan.routedByRule.slice(0, 10).join(","),
    incomplete: incompleteIDs.length,
    incompleteIDs: incompleteIDs.slice(0, 10).join(","),
  })

  // 7. Background discovery.
  let disposed = false
  let running = false
  const discover = async (): Promise<void> => {
    if (disposed || running || !keys.key) return
    running = true
    try {
      const found = await fetchModelIDs({
        baseURL: options.baseURL,
        key: keys.key,
        timeoutMs: options.discoveryTimeoutMs,
        fetch: doFetch,
      })
      if (disposed) return
      if (found.length === 0) {
        log.warn("FueliX discovery returned no models; keeping the current list")
        return
      }
      if (sameIDs(found, ids)) return
      ids = found
      plan = planModels(catalog, ids, options.includeNonChatModels)
      await safely("FueliX model cache write", log, () => writeCachedModels(ctx.storage, ids, now()))
      await ctx.provider.reload()
      log.info("FueliX models refreshed", { count: ids.length })
    } catch (error) {
      log.warn("FueliX discovery failed; keeping the current list", { error: errorMessage(error) })
    } finally {
      running = false
    }
  }

  let interval: unknown
  if (keys.key) {
    void Promise.resolve().then(discover)
    if (options.refreshMinutes > 0) {
      interval = startInterval(() => void discover(), options.refreshMinutes * 60_000)
      ;(interval as { unref?: () => void } | undefined)?.unref?.()
    }
  } else {
    const service = options.keychainService === false ? DEFAULT_KEYCHAIN_SERVICE : options.keychainService
    log.warn(
      `No FueliX API key found. Run /connect and choose FuelIX, or run: security add-generic-password -U -s ${service} -a "$USER" -w`,
    )
  }

  return async () => {
    disposed = true
    if (interval !== undefined) stopInterval(interval)
    for (const registration of registrations.reverse()) {
      await safely("FueliX registration dispose", log, () => registration.dispose())
    }
  }
}
