import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import type { FuelixOptions } from "../options.ts"

export type Cleanup = () => Promise<void> | void

/**
 * Registers the FueliX integration, providers, models, and per-request auth hooks.
 * Contract stub: the Phase 1 lane replaces this body.
 */
export async function setupFuelix(_ctx: Plugin.Context, _options: FuelixOptions, log: Logger): Promise<Cleanup> {
  log.warn("FueliX setup is not implemented yet")
  return () => {}
}
