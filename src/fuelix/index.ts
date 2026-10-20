import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import { DEFAULT_KEYCHAIN_SERVICE, type FuelixOptions } from "../options.ts"
import { applyAuth } from "./auth.ts"
import { resolveBaseURL } from "./base-url.ts"
import { loadCatalog as defaultLoadCatalog, type LoadedCatalog } from "./catalog.ts"
import { FUELIX_PROVIDER_IDS, type Catalog, type CatalogEntry, type FuelixProviderID } from "./catalog-types.ts"
import {
  defaultExec,
  FUELIX_ENV_NAME,
  FUELIX_INTEGRATION_ID,
  resolveKeys,
  type ExecFn,
  type KeychainCache,
  type ResolvedKeys,
} from "./credentials.ts"
import { fetchModelIDs, readCachedModels, writeCachedModels, type FetchFn } from "./discovery.ts"
import { buildModelInfo, buildProviderInfo, enrichFromUpstream, type BuiltModel } from "./models.ts"
import { classifyKind, routeModel } from "./rules.ts"
import { warnStaleFuelixConfig } from "./stale-config.ts"

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
  /** Keychain memo. Defaults to the process-wide memo. */
  readonly keychainCache?: KeychainCache
  /** Holder of the once-per-process stale configuration flag. Defaults to `globalThis`. */
  readonly staleConfigHolder?: Record<symbol, unknown>
  /** Timeout of each provider read in the stale configuration check, in milliseconds. */
  readonly staleConfigTimeoutMs?: number
  /** Delays of the stale configuration checks in milliseconds. */
  readonly staleConfigDelaysMs?: readonly number[]
}

/** A discovery result may drop at most this share of the current IDs. */
export const MAX_DROP_SHARE = 0.3

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

function sameKeys(a: ResolvedKeys, b: ResolvedKeys): boolean {
  return a.keychainKey === b.keychainKey && a.credentialStoreKey === b.credentialStoreKey && a.envKey === b.envKey
}

function activationFor(keys: ResolvedKeys): "enabled" | "auto" {
  return keys.keychainKey || keys.envKey ? "enabled" : "auto"
}

/** Why a discovery result must not replace the current list, or `undefined` when it is acceptable. */
function rejectDrop(
  current: readonly string[],
  found: readonly string[],
  currentPlan: Plan,
  foundPlan: Plan,
): { reason: string; dropped: string[] } | undefined {
  const present = new Set(found)
  const dropped = current.filter((id) => !present.has(id))
  if (dropped.length === 0) return undefined
  const emptied = FUELIX_PROVIDER_IDS.filter(
    (providerID) => currentPlan.byProvider[providerID].length > 0 && foundPlan.byProvider[providerID].length === 0,
  )
  if (dropped.length > current.length * MAX_DROP_SHARE) {
    return { reason: `drops ${dropped.length} of ${current.length} models`, dropped }
  }
  if (emptied.length > 0) return { reason: `removes every model of ${emptied.join(", ")}`, dropped }
  return undefined
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
  const baseURL = resolveBaseURL(options.baseURL, env, log)

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

  // 2. Key resolution. The auth hook and the provider transform read this mutable state.
  const resolveInput = {
    keychainService: options.keychainService,
    platform: deps.platform ?? process.platform,
    exec: deps.exec ?? defaultExec,
    env,
    integration: ctx.integration,
    log,
    ...(deps.keychainCache ? { keychainCache: deps.keychainCache } : {}),
    now: () => now().getTime(),
  }
  const initialKeys = await resolveKeys(resolveInput)
  const state = { keys: initialKeys, activation: activationFor(initialKeys) as "enabled" | "auto" }

  // 3. Auth hooks. FueliX accepts only `Authorization: Bearer`. They go before the provider transform.
  for (const providerID of FUELIX_PROVIDER_IDS) {
    try {
      registrations.push(
        await ctx.session.hook(
          "http.request",
          (event) => {
            try {
              applyAuth(event.request.headers, { override: state.keys.keychainKey, fallback: state.keys.envKey })
            } catch (error) {
              log.warn("could not apply FueliX auth", { error: errorMessage(error) })
            }
          },
          { providerID },
        ),
      )
    } catch (error) {
      log.error("could not register the FueliX auth hook", { providerID, error: errorMessage(error) })
    }
  }

  // 4. Shell hook: agent shell commands must not inherit the key.
  if (options.scrubShellEnv) {
    try {
      registrations.push(
        await ctx.shell.hook("create.before", (event) => {
          delete event.env[FUELIX_ENV_NAME]
        }),
      )
    } catch (error) {
      log.error("could not register the FueliX shell hook", { error: errorMessage(error) })
    }
  }

  // 5. Model state. Initial IDs: cache, then listed catalog entries, then the whole catalog.
  const cached = await readCachedModels(ctx.storage)
  let ids = initialIDs(catalog, cached?.ids)
  let trusted = cached !== undefined // The list comes from an earlier discovery.
  let plan = planModels(catalog, ids, options.includeNonChatModels)

  const failedBuilds = new Set<string>()
  const safeBuild = (providerID: FuelixProviderID, id: string, entry: CatalogEntry | undefined): BuiltModel | undefined => {
    try {
      return buildModelInfo(providerID, id, entry)
    } catch (error) {
      if (!failedBuilds.has(id)) {
        failedBuilds.add(id)
        log.warn("FueliX model skipped because its metadata is invalid", { providerID, modelID: id, error: errorMessage(error) })
      }
      return undefined
    }
  }

  // 6. Providers. The transform is synchronous and reads the captured plan and state.
  registrations.push(
    await ctx.provider.transform((editor) => {
      for (const providerID of FUELIX_PROVIDER_IDS) {
        const built: { id: string; model: BuiltModel }[] = []
        for (const { id, entry } of plan.byProvider[providerID]) {
          const model = safeBuild(providerID, id, entry)
          if (model) built.push({ id, model })
        }
        editor.add({
          info: buildProviderInfo(providerID, baseURL, state.activation),
          models: built.map((item) => item.model.info),
        })
        for (const item of built) {
          try {
            enrichFromUpstream(editor, providerID, item.id, item.model.info, item.model.incomplete)
          } catch (error) {
            if (!failedBuilds.has(`enrich:${item.id}`)) {
              failedBuilds.add(`enrich:${item.id}`)
              log.warn("FueliX upstream metadata not applied", { providerID, modelID: item.id, error: errorMessage(error) })
            }
          }
        }
      }
    }),
  )

  // 7. Summary.
  const incompleteIDs: string[] = []
  for (const providerID of FUELIX_PROVIDER_IDS) {
    for (const { id, entry } of plan.byProvider[providerID]) {
      if ((safeBuild(providerID, id, entry)?.incomplete.length ?? 0) > 0) incompleteIDs.push(id)
    }
  }
  log.info("FueliX models registered", {
    location: ctx.location?.directory,
    "fuelix-openai": plan.byProvider["fuelix-openai"].length,
    "fuelix-anthropic": plan.byProvider["fuelix-anthropic"].length,
    fuelix: plan.byProvider.fuelix.length,
    source: cached ? "cache" : "catalog",
    routedByRule: plan.routedByRule.length,
    routedByRuleIDs: plan.routedByRule.slice(0, 10).join(","),
    incomplete: incompleteIDs.length,
    incompleteIDs: incompleteIDs.slice(0, 10).join(","),
  })

  // 8. Background discovery. Each cycle re-resolves the keys, so a later /connect, a rotated key, or a new Keychain
  // item takes effect without a restart. The Keychain read is memoized and retries at most every 5 minutes.
  let disposed = false
  let running = false
  const discover = async (skipKeys = false): Promise<void> => {
    if (disposed || running) return
    running = true
    try {
      let activationChanged = false
      if (!skipKeys) {
        const next = await resolveKeys(resolveInput)
        if (disposed) return
        if (!sameKeys(state.keys, next)) {
          state.keys = next
          const activation = activationFor(next)
          activationChanged = activation !== state.activation
          state.activation = activation
        }
      }
      const key = state.keys.key
      let idsChanged = false
      if (key) {
        const found = await fetchModelIDs({ baseURL, key, timeoutMs: options.discoveryTimeoutMs, fetch: doFetch })
        if (disposed) return
        if (found.length === 0) {
          log.warn("FueliX discovery returned no models; keeping the current list")
        } else if (!sameIDs(found, ids)) {
          const foundPlan = planModels(catalog, found, options.includeNonChatModels)
          const rejected = trusted ? rejectDrop(ids, found, plan, foundPlan) : undefined
          if (rejected) {
            log.warn(`FueliX discovery ${rejected.reason}; keeping the current list`, {
              current: ids.length,
              found: found.length,
              dropped: rejected.dropped.length,
              droppedIDs: rejected.dropped.slice(0, 10).join(","),
            })
          } else {
            ids = found
            plan = foundPlan
            trusted = true
            idsChanged = true
            await safely("FueliX model cache write", log, () => writeCachedModels(ctx.storage, ids, now()))
          }
        } else {
          trusted = true
        }
      }
      if (idsChanged || activationChanged) {
        await ctx.provider.reload()
        if (idsChanged) log.info("FueliX models refreshed", { count: ids.length })
      }
    } catch (error) {
      log.warn("FueliX discovery failed; keeping the current list", { error: errorMessage(error) })
    } finally {
      running = false
    }
  }

  if (!state.keys.key) {
    const service = options.keychainService === false ? DEFAULT_KEYCHAIN_SERVICE : options.keychainService
    log.warn(
      `No FueliX API key found. Run /connect and choose FuelIX, or run: security add-generic-password -U -s ${service} -a "$USER" -w`,
    )
  }
  // The stale configuration check runs before the first reload, because the plugin client stops showing the
  // configuration overlay after a reload.
  void Promise.resolve()
    .then(async () => {
      if (!disposed) {
        await warnStaleFuelixConfig(ctx, log, {
          ...(deps.staleConfigHolder ? { holder: deps.staleConfigHolder } : {}),
          ...(deps.staleConfigTimeoutMs !== undefined ? { timeoutMs: deps.staleConfigTimeoutMs } : {}),
          ...(deps.staleConfigDelaysMs ? { delaysMs: deps.staleConfigDelaysMs } : {}),
        })
      }
      if (state.keys.key) await discover(true)
    })
    .catch(() => {})

  let interval: unknown
  if (options.refreshMinutes > 0) {
    interval = startInterval(() => void discover(), options.refreshMinutes * 60_000)
    ;(interval as { unref?: () => void } | undefined)?.unref?.()
  }

  return async () => {
    disposed = true
    if (interval !== undefined) stopInterval(interval)
    for (const registration of registrations.reverse()) {
      await safely("FueliX registration dispose", log, () => registration.dispose())
    }
  }
}
