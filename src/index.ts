/**
 * td-opencode-plugin entry point.
 *
 * OpenCode V2 reads the default export's `id` and `setup`. The plugin imports only types from
 * `@opencode/plugin`, so it has no runtime dependencies.
 */

import type { Plugin } from "@opencode/plugin"
import { setupFuelix } from "./fuelix/index.ts"
import { createLogger } from "./log.ts"
import { parseOptions } from "./options.ts"

export const PLUGIN_ID = "td-opencode-plugin"

type Cleanup = () => Promise<void> | void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const log = createLogger({ debug: options.debug })
    for (const warning of options.warnings) log.warn(warning)

    // A setup failure is logged and does not stop OpenCode.
    const cleanups: Cleanup[] = []
    try {
      cleanups.push(await setupFuelix(ctx, options.fuelix, log))
    } catch (error) {
      log.error("FueliX setup failed", { error: errorMessage(error) })
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

export default plugin
