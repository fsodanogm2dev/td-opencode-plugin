import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import type { TelemetryOptions } from "../options.ts"

export type Cleanup = () => Promise<void> | void

/**
 * Emits td-telemetry events from OpenCode session activity.
 * Contract stub: the Phase 3 lane replaces this body.
 */
export async function setupTelemetry(
  _ctx: Plugin.Context,
  _options: TelemetryOptions,
  log: Logger,
): Promise<Cleanup> {
  log.debug("telemetry is not implemented yet")
  return () => {}
}
