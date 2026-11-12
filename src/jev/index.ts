/**
 * Jev setup. Disabled (the default) registers nothing, reads nothing, and sends nothing.
 *
 * Enabled, it registers in this order, and one failure disposes everything registered so far and throws a constant
 * error (`JEV_SETUP_FAILED`), so no TypeSafe text reaches the outer log:
 *
 * 1. The `typesafe-ai` integration (key and `TYPESAFE_API_KEY` methods) for `/connect`.
 * 2. The shell hook that removes `TYPESAFE_API_KEY` from agent shell commands (`scrubShellEnv`).
 * 3. The shared runtime: key provider, client, telemetry writer, and private log store. Creating it reads no key.
 *    The key resolves on the first check, so a later `/connect` takes effect.
 * 4. One group of hooks per point whose mode is not `off`.
 *
 * Cleanup disposes the hooks in reverse order, then the runtime: it aborts every request and background task and
 * flushes telemetry. No bootstrap request leaves the process.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { defaultExec, type ExecFn, type KeychainCache } from "../fuelix/credentials.ts"
import type { Logger } from "../log.ts"
import { defaultJevRoot, JevArtifacts } from "./artifacts.ts"
import type { JevCache } from "./cache.ts"
import { createJevClient, type FetchFn } from "./client.ts"
import { createJevKeyProvider, TYPESAFE_ENV_NAME, TYPESAFE_INTEGRATION_ID } from "./credentials.ts"
import type { JevOptions } from "./options.ts"
import { registerReasoning } from "./points/reasoning.ts"
import { disposeAll, registerSafety, type Registration } from "./points/safety.ts"
import { registerSkills } from "./points/skills.ts"
import { registerTestOutput } from "./points/test-output.ts"
import { createJevRuntime, type ModelListEntry } from "./runtime.ts"
import { createJevTelemetry } from "./telemetry.ts"
import type { Env } from "./types.ts"

export const JEV_SETUP_FAILED = "Jev setup failed"

type Cleanup = () => Promise<void> | void

/** Injection points for tests. Every field has a production default. */
export interface JevDeps {
  readonly fetch?: FetchFn
  readonly exec?: ExecFn
  readonly env?: Env
  readonly platform?: string
  readonly homeDir?: string
  /** Clock in milliseconds. */
  readonly now?: () => number
  /** Existence check for the legacy `jev.json`. Its content is never read. */
  readonly fileExists?: (path: string) => boolean
  readonly keychainCache?: KeychainCache
  /** Defaults to the process-wide cache. */
  readonly cache?: JevCache
  /** Artifact root. Defaults to `defaultJevRoot(env, homeDir)`. */
  readonly root?: string
  /** Set to `false` to skip the cleanup of old logs at startup. */
  readonly cleanupLogs?: boolean
}

/** Paths where the legacy plugin read `jev.json`. Only their existence is checked. */
export function legacyConfigPaths(env: Env, homeDir: string): string[] {
  const paths = [join(homeDir, ".config", "opencode", "jev.json")]
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg) && !xdg.includes("\0")) paths.unshift(join(xdg, "opencode", "jev.json"))
  return [...new Set(paths)]
}

const noop: Cleanup = () => undefined

export async function setupJev(ctx: Plugin.Context, options: JevOptions, log: Logger, deps: JevDeps = {}): Promise<Cleanup> {
  if (!options.enabled) return noop

  const env = deps.env ?? process.env
  const home = deps.homeDir ?? homedir()
  const registrations: Registration[] = []
  let runtimeDispose: (() => Promise<void>) | undefined

  const rollback = async (): Promise<void> => {
    await disposeAll(registrations)
    await runtimeDispose?.().catch(() => undefined)
  }

  try {
    // 1. Integration, for /connect.
    registrations.push(
      await ctx.integration.transform((integrations) => {
        if (!integrations.get(TYPESAFE_INTEGRATION_ID)) {
          integrations.method.update({ integrationID: TYPESAFE_INTEGRATION_ID, method: { type: "key", label: "TypeSafe API key" } })
        }
        integrations.update(TYPESAFE_INTEGRATION_ID, (integration) => {
          integration.name = "TypeSafe"
        })
        integrations.method.update({ integrationID: TYPESAFE_INTEGRATION_ID, method: { type: "env", names: [TYPESAFE_ENV_NAME] } })
      }),
    )

    // 2. Shell hook.
    if (options.scrubShellEnv) {
      registrations.push(
        await ctx.shell.hook("create.before", (event) => {
          delete event.env[TYPESAFE_ENV_NAME]
        }),
      )
    }

    // The legacy file holds a clear-text key. Only its existence is checked, to point the user to the migration.
    const exists = deps.fileExists ?? ((path: string) => existsSync(path))
    try {
      if (legacyConfigPaths(env, home).some((path) => exists(path))) {
        log.warn("A legacy Jev file (jev.json) exists. This plugin does not read it. Store the TypeSafe key in the Keychain, /connect, or TYPESAFE_API_KEY.")
      }
    } catch {
      // The check is advisory.
    }

    // 3. Runtime.
    const points = options.points
    const anyPoint = Object.values(points).some((point) => point.mode !== "off")
    if (anyPoint) {
      const keys = createJevKeyProvider({
        keychainService: options.keychainService,
        platform: deps.platform ?? process.platform,
        exec: deps.exec ?? defaultExec,
        env,
        integration: ctx.integration,
        log,
        ...(deps.keychainCache ? { keychainCache: deps.keychainCache } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      })
      const client = createJevClient({
        baseURL: options.baseURL,
        model: options.model,
        keys,
        locationScope: ctx.location?.directory ?? "",
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.cache ? { cache: deps.cache } : {}),
      })
      const root = deps.root ?? defaultJevRoot(env, home)
      const telemetry = createJevTelemetry({ root, enabled: options.telemetry, log, ...(deps.now ? { now: deps.now } : {}) })
      let artifacts: JevArtifacts | undefined
      if (points.testCompression.mode === "enforce") {
        try {
          artifacts = new JevArtifacts(root, deps.now ? { now: deps.now } : {})
        } catch {
          log.warn("Jev log store is unavailable; test-output compression leaves outputs unchanged")
        }
      }
      const runtime = createJevRuntime({
        client,
        keys,
        telemetry,
        ...(artifacts ? { artifacts } : {}),
        listModels: async () => (await ctx.model.list()).data as unknown as readonly ModelListEntry[],
        log,
        ...(deps.now ? { now: deps.now } : {}),
      })
      runtimeDispose = () => runtime.dispose()

      if (artifacts && deps.cleanupLogs !== false) void artifacts.cleanup().catch(() => undefined)

      // 4. Points.
      if (points.safetyPreCheck.mode !== "off") registrations.push(...(await registerSafety(ctx, runtime, points.safetyPreCheck)))
      if (points.testCompression.mode !== "off") registrations.push(...(await registerTestOutput(ctx, runtime, points.testCompression)))
      if (points.skillPruning.mode !== "off") registrations.push(...(await registerSkills(ctx, runtime, points.skillPruning)))
      if (points.reasoningBudget.mode !== "off") registrations.push(...(await registerReasoning(ctx, runtime, points.reasoningBudget)))
    }
  } catch {
    await rollback()
    throw new Error(JEV_SETUP_FAILED)
  }

  log.info("Jev enabled", {
    safetyPreCheck: options.points.safetyPreCheck.mode,
    testCompression: options.points.testCompression.mode,
    skillPruning: options.points.skillPruning.mode,
    reasoningBudget: options.points.reasoningBudget.mode,
  })

  let cleaned = false
  return async () => {
    if (cleaned) return
    cleaned = true
    await rollback()
  }
}
