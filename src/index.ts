/**
 * td-opencode-plugin entry point.
 *
 * OpenCode V2 reads the default export's `id` and `setup`. The plugin imports only types from
 * `@opencode/plugin`, so it has no runtime dependencies.
 */

import type { Plugin } from "@opencode/plugin"
import { setupFuelix } from "./fuelix/index.ts"
import { setupGuards } from "./guards/index.ts"
import { setupJev } from "./jev/index.ts"
import { createFileStatusWriter, type StatusReportWriter } from "./fuelix/status.ts"
import { createLogger } from "./log.ts"
import { parseOptions } from "./options.ts"

export const PLUGIN_ID = "td-opencode-plugin"

type Cleanup = () => Promise<void> | void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The setup steps. Tests replace them to prove the order and the failure isolation. */
export interface PluginSteps {
  readonly setupGuards: typeof setupGuards
  readonly setupFuelix: typeof setupFuelix
  readonly setupJev: typeof setupJev
  readonly statusReport: () => StatusReportWriter
}

const defaultSteps: PluginSteps = { setupGuards, setupFuelix, setupJev, statusReport: createFileStatusWriter }

export function createPlugin(steps: PluginSteps = defaultSteps): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const log = createLogger({ debug: options.debug })
      for (const warning of options.warnings) log.warn(warning)

      // Order matters: Guards, then FueliX, then Jev. Each step has its own try/catch, and cleanup runs in reverse.
      const cleanups: Cleanup[] = []

      // The guards register first, so a guard denial is already set when Jev sees a permission request. Jev must not
      // send a command that a guard denies to TypeSafe. The guards are also removed last. A failure is logged as an
      // error without the error body. The guards are then NOT enforced, and the runtime report says `registered: false`.
      try {
        cleanups.push(await steps.setupGuards(ctx, log))
      } catch {
        log.error("TD-Plugin guards are NOT enforced: setup failed")
      }

      // A FueliX setup failure is logged and does not stop OpenCode.
      try {
        cleanups.push(await steps.setupFuelix(ctx, options.fuelix, log, { statusReport: steps.statusReport() }))
      } catch (error) {
        log.error("FueliX setup failed", { error: errorMessage(error) })
      }

      // Jev is independent of FueliX and of the guards. Its error text is never logged, because it could carry
      // TypeSafe data.
      try {
        cleanups.push(await steps.setupJev(ctx, options.jev, log))
      } catch {
        log.error("Jev setup failed")
      }

      return async () => {
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup()
          } catch (error) {
            log.warn("cleanup failed", { error: errorMessage(error) })
          }
        }
      }
    },
  }
}

export default createPlugin()
