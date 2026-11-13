import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import { DEFAULT_KEYCHAIN_SERVICE, type FuelixOptions } from "../options.ts"
import { applyAuth, KEY_PLACEHOLDER, withAuthFetch } from "./auth.ts"
import { setupBatchTools, type BatchToolsDeps } from "./batch/tools.ts"
import { resolveBaseURL } from "./base-url.ts"
import { withCacheFetch } from "./cache.ts"
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
import { createModelHistoryTracker, createStorageModelHistory, type ModelHistoryStore } from "./history.ts"
import { DiscoveryError, fetchModelIDs, readCachedModels, writeCachedModels, type FetchFn } from "./discovery.ts"
import { buildModelInfo, buildProviderInfo, enrichFromUpstream, type BuiltModel } from "./models.ts"
import { classifyKind, routeModel } from "./rules.ts"
import {
  createStatusRecorder,
  REASONS,
  type AuthSource,
  type CheckOutcome,
  type ModelHistory,
  type ModelSource,
  type ReloadResult,
  type StatusProvider,
  type StatusReason,
  type StatusReportWriter,
} from "./status.ts"
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
  /** Batch tool overrides: service and artifact root. */
  readonly batch?: BatchToolsDeps
  /**
   * Writer of the status report. Without it, no report is written, so tests never touch the home directory.
   * `src/index.ts` injects the file writer. `options.statusReport === false` turns the report off.
   */
  readonly statusReport?: StatusReportWriter
  /**
   * Store of the model-change history. Used only when a status report writer exists and `options.statusReport` is
   * not `false`. The default is the store on `ctx.storage`. `null` turns the history off.
   */
  readonly modelHistory?: ModelHistoryStore | null
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

function authSourceFor(keys: ResolvedKeys): AuthSource {
  return keys.source === "env" ? "environment" : (keys.source ?? "none")
}

function failureReason(error: unknown): StatusReason {
  if (error instanceof DiscoveryError && (error.status === 401 || error.status === 403)) return REASONS.keyRejected
  return REASONS.checkFailed
}

interface BuiltSummary {
  readonly providers: StatusProvider[]
  /** IDs of the eligible models that were built successfully. */
  readonly ids: Set<string>
}

function diffIDs(from: ReadonlySet<string>, to: ReadonlySet<string>): { added: string[]; removed: string[] } {
  return {
    added: [...to].filter((id) => !from.has(id)).sort(),
    removed: [...from].filter((id) => !to.has(id)).sort(),
  }
}

/** Why a discovery result must not replace the current list, or `undefined` when it is acceptable. */
function rejectDrop(
  current: readonly string[],
  found: readonly string[],
  currentPlan: Plan,
  foundPlan: Plan,
): { reason: string; kind: "drop-share" | "provider-emptied"; dropped: string[] } | undefined {
  const present = new Set(found)
  const dropped = current.filter((id) => !present.has(id))
  if (dropped.length === 0) return undefined
  const emptied = FUELIX_PROVIDER_IDS.filter(
    (providerID) => currentPlan.byProvider[providerID].length > 0 && foundPlan.byProvider[providerID].length === 0,
  )
  if (dropped.length > current.length * MAX_DROP_SHARE) {
    return { reason: `drops ${dropped.length} of ${current.length} models`, kind: "drop-share", dropped }
  }
  if (emptied.length > 0) return { reason: `removes every model of ${emptied.join(", ")}`, kind: "provider-emptied", dropped }
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
  const startedAt = now()
  const writeReport = options.statusReport === false ? undefined : deps.statusReport
  // What the setup registered, for the status report.
  const sessionHookProviders: FuelixProviderID[] = []
  let aiSdkHookRegistered = false
  let shellHookRegistered = false
  let batchToolsRegistered = false

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
      sessionHookProviders.push(providerID)
    } catch (error) {
      log.error("could not register the FueliX auth hook", { providerID, error: errorMessage(error) })
    }
    // `fuelix-anthropic` runs on the AI SDK bridge. Stateless generation (`/api/experimental/generate/text`, used by
    // OpenChamber walkthroughs) skips Session hooks, but the AI SDK `sdk` hook runs for every call.
    if (providerID !== "fuelix-anthropic") continue
    try {
      registrations.push(
        await ctx.aisdk.hook(
          "sdk",
          (event) => {
            // `@ai-sdk/anthropic` throws before it calls `fetch` when it has no key. `withAuthFetch` ignores this value.
            if (typeof event.options.apiKey !== "string" || event.options.apiKey === "") {
              if (!event.options.authToken) event.options.apiKey = KEY_PLACEHOLDER
            }
            const base = (event.options.fetch as typeof fetch | undefined) ?? ((input, init) => fetch(input, init))
            // Cache wrapper inside, auth wrapper outside: auth responsibility stays in `withAuthFetch`.
            event.options.fetch = withAuthFetch(withCacheFetch(base), () => ({
              override: state.keys.keychainKey,
              fallback: state.keys.envKey,
            }))
          },
          { providerID },
        ),
      )
      aiSdkHookRegistered = true
    } catch (error) {
      log.error("could not register the FueliX AI SDK auth hook", { providerID, error: errorMessage(error) })
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
      shellHookRegistered = true
    } catch (error) {
      log.error("could not register the FueliX shell hook", { error: errorMessage(error) })
    }
  }

  // 4b. Batch tools. A failure here is logged and leaves the providers and auth hooks working.
  try {
    registrations.push(
      await setupBatchTools(
        ctx,
        {
          baseURL,
          log,
          resolveKeys: () => resolveKeys(resolveInput),
          fetch: doFetch,
          now,
          env,
          ...(options.batchRates ? { rates: options.batchRates } : {}),
        },
        deps.batch,
      ),
    )
    batchToolsRegistered = true
  } catch (error) {
    log.error("could not register the FueliX batch tools", { error: errorMessage(error) })
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
        // Enrich before `editor.add`. `editor.models.update` would reset the model package to the native one.
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
        editor.add({
          info: buildProviderInfo(providerID, baseURL, state.activation),
          models: built.map((item) => item.model.info),
        })
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

  // 7a. Model-change history. It exists only with a status report. It lives in the storage that all locations share.
  const eligibility = new Map<string, boolean>()
  const isEligible = (id: string): boolean => {
    let known = eligibility.get(id)
    if (known === undefined) {
      const single = planModels(catalog, [id], options.includeNonChatModels)
      known = FUELIX_PROVIDER_IDS.some((providerID) => {
        const item = single.byProvider[providerID][0]
        return item !== undefined && safeBuild(providerID, id, item.entry) !== undefined
      })
      eligibility.set(id, known)
    }
    return known
  }
  const historyStore = writeReport ? (deps.modelHistory === undefined ? createStorageModelHistory(ctx.storage) : (deps.modelHistory ?? undefined)) : undefined
  const tracker = historyStore
    ? createModelHistoryTracker({
        store: historyStore,
        log,
        now,
        isEligible,
        secrets: () => [state.keys.key, state.keys.keychainKey, state.keys.credentialStoreKey, state.keys.envKey],
      })
    : undefined
  // A cache with a valid `fetchedAt` is the baseline of an empty history. The startup catalog is never recorded.
  let modelHistory: ModelHistory | null | undefined = tracker ? await tracker.seed(cached) : undefined
  // The list that the plugin fetched and has not yet applied. A successful reload records it.
  let pendingObservation: { readonly fetchedAt: string; readonly ids: readonly string[] } | undefined

  // 7b. Status report. It records what the plugin applied. Writes are nonfatal, ordered, and never awaited here.
  const modelsSource: { value: ModelSource } = { value: cached ? "cache" : "catalog" }
  const summarize = (source: Plan): BuiltSummary => {
    const builtIDs = new Set<string>()
    const providers = FUELIX_PROVIDER_IDS.map((providerID): StatusProvider => {
      let modelCount = 0
      let titleModel: string | null = null
      for (const { id, entry } of source.byProvider[providerID]) {
        const built = safeBuild(providerID, id, entry)
        if (!built) continue
        modelCount++
        builtIDs.add(id)
        if ((built.info as unknown as { family?: unknown }).family) titleModel = id
      }
      return { id: providerID, count: modelCount, titleModel }
    })
    return { providers, ids: builtIDs }
  }
  const authSource = (): AuthSource => authSourceFor(state.keys)
  const directory = typeof ctx.location?.directory === "string" && ctx.location.directory !== "" ? ctx.location.directory : null
  const reportConfiguration = () => ({
    authSource: authSource(),
    activation: state.activation,
  })
  let applied: { plan: Plan; summary: BuiltSummary } | undefined
  let recorder: ReturnType<typeof createStatusRecorder> | undefined
  if (writeReport) {
    try {
      const summary = summarize(plan)
      applied = { plan, summary }
      const startedISO = startedAt.toISOString()
      recorder = createStatusRecorder({
        directory,
        startedAt,
        now,
        write: writeReport,
        log,
        secrets: () => [state.keys.key, state.keys.keychainKey, state.keys.credentialStoreKey, state.keys.envKey],
        initial: {
          checking: false,
          configuration: {
            refreshMinutes: options.refreshMinutes,
            includeNonChatModels: options.includeNonChatModels,
            ...reportConfiguration(),
            shellKeyScrubbing: !options.scrubShellEnv ? "disabled" : shellHookRegistered ? "enabled" : "failed",
            batchTools: batchToolsRegistered ? "registered" : "failed",
            authHooks: { sessionProviders: [...sessionHookProviders], aiSdk: aiSdkHookRegistered },
          },
          models: { source: modelsSource.value, providers: summary.providers },
          // Without a key, no check runs at startup. The snapshot says so.
          lastCheck: state.keys.key
            ? null
            : {
                startedAt: startedISO,
                finishedAt: startedISO,
                outcome: "no-key",
                added: [],
                removed: [],
                reason: REASONS.noKey,
                reload: "not-needed",
              },
          lastSuccessfulCheckAt: null,
          lastChange: null,
          ...(modelHistory !== undefined ? { modelHistory } : {}),
        },
      })
      recorder.update({}) // Writes the startup snapshot.
    } catch (error) {
      log.warn("FueliX status report not started")
      recorder = undefined
    }
  }

  // 8. Background discovery. Each cycle re-resolves the keys, so a later /connect, a rotated key, or a new Keychain
  // item takes effect without a restart. The Keychain read is memoized and retries at most every 5 minutes.
  let disposed = false
  let running = false
  let needsReload = false // A reload failed. The next cycle retries it.
  const discover = async (skipKeys = false): Promise<void> => {
    if (disposed || running) return
    running = true
    const checkStarted = now()
    let outcome: CheckOutcome | undefined
    let reason: StatusReason | null = null
    // Widened: the catch block reads it after assignments in the try block.
    let reload = "not-needed" as ReloadResult
    const finishCheck = (added: string[], removed: string[], change: boolean): void => {
      if (disposed || !recorder) return
      const finished = now()
      const finishedISO = finished.toISOString()
      const finalOutcome = outcome ?? "unchanged"
      const reported = finalOutcome === "updated"
      recorder.update({
        checking: false,
        configuration: reportConfiguration(),
        ...(applied ? { models: { source: modelsSource.value, providers: applied.summary.providers } } : {}),
        lastCheck: {
          startedAt: checkStarted.toISOString(),
          finishedAt: finishedISO,
          outcome: finalOutcome,
          added: reported ? added : [],
          removed: reported ? removed : [],
          reason,
          reload,
        },
        ...(finalOutcome === "updated" || finalOutcome === "unchanged" ? { lastSuccessfulCheckAt: finishedISO } : {}),
        ...(change ? { lastChange: { at: finishedISO, added, removed } } : {}),
        ...(modelHistory !== undefined ? { modelHistory } : {}),
      })
    }
    try {
      recorder?.update({ checking: true })
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
          outcome = "empty"
          reason = REASONS.empty
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
            outcome = "rejected"
            reason = rejected.kind === "drop-share" ? REASONS.dropShare : REASONS.providerEmptied
          } else {
            ids = found
            plan = foundPlan
            trusted = true
            idsChanged = true
            const fetchedAt = now()
            pendingObservation = Number.isNaN(fetchedAt.getTime()) ? undefined : { fetchedAt: fetchedAt.toISOString(), ids: [...ids] }
            await safely("FueliX model cache write", log, () => writeCachedModels(ctx.storage, ids, fetchedAt))
          }
        } else {
          trusted = true
        }
      } else {
        outcome = "no-key"
        reason = REASONS.noKey
      }
      if (idsChanged || activationChanged) needsReload = true
      let added: string[] = []
      let removed: string[] = []
      let change = false
      if (needsReload) {
        try {
          await ctx.provider.reload()
        } catch (error) {
          reload = "failed"
          throw error
        }
        needsReload = false
        reload = "succeeded"
        if (idsChanged) log.info("FueliX models refreshed", { count: ids.length })
        // The reload applied the plan. Compare it with the last applied list, which a failed reload leaves unchanged.
        if (recorder && applied && applied.plan !== plan && !disposed) {
          const summary = summarize(plan)
          ;({ added, removed } = diffIDs(applied.summary.ids, summary.ids))
          applied = { plan, summary }
          modelsSource.value = "discovery"
          change = added.length > 0 || removed.length > 0
        }
      }
      // The reload applied the list. The record is durable before the status report finishes the check.
      if (tracker && !disposed) {
        if (reload === "succeeded" && pendingObservation) {
          const observation = pendingObservation
          pendingObservation = undefined
          modelHistory = await tracker.record({ ...observation, source: "discovery" })
        } else if (outcome === undefined || outcome === "unchanged") {
          modelHistory = await tracker.refresh() // Another location may have recorded a change.
        }
      }
      if (change && (outcome === undefined || outcome === "unchanged")) outcome = "updated"
      finishCheck(added, removed, change)
    } catch (error) {
      log.warn("FueliX discovery failed; keeping the current list", { error: errorMessage(error) })
      outcome = "failed"
      reason = reload === "failed" ? REASONS.reloadFailed : failureReason(error)
      finishCheck([], [], false)
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
    recorder?.close() // Disposal writes no report.
    tracker?.close()
    if (interval !== undefined) stopInterval(interval)
    for (const registration of registrations.reverse()) {
      await safely("FueliX registration dispose", log, () => registration.dispose())
    }
  }
}
