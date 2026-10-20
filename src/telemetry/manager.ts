import path from "node:path"
import type { Logger } from "../log.ts"
import type { SpawnDetached } from "./process.ts"

/** Process-wide state of the td-telemetry process manager, shared by all plugin instances. */
export interface ProcessManagerState {
  /** The initial spawn happened. */
  spawned: boolean
  /** Time of the last spawn, in epoch milliseconds. */
  lastSpawnAt: number | undefined
}

const STATE_KEY = Symbol.for("td-opencode-plugin.telemetry.process-manager")

export function globalProcessManagerState(): ProcessManagerState {
  const holder = globalThis as unknown as Record<symbol, ProcessManagerState | undefined>
  let state = holder[STATE_KEY]
  if (!state) {
    state = { spawned: false, lastSpawnAt: undefined }
    holder[STATE_KEY] = state
  }
  return state
}

export const RESPAWN_INTERVAL_MS = 10 * 60_000

export interface ManagerOptions {
  readonly root: string
  readonly node: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly spawn: SpawnDetached
  readonly now: () => number
  readonly log: Logger
  readonly state: ProcessManagerState
}

/** Starts the receiver and dashboard pair through `lib/process-manager.mjs`. The script always exits 0. */
export function createManagerSpawner(options: ManagerOptions) {
  const run = () => {
    options.state.spawned = true
    options.state.lastSpawnAt = options.now()
    options.spawn(options.node, [path.join(options.root, "lib", "process-manager.mjs")], options.env)
  }
  return {
    /** Spawns once per process. Returns true when it spawned. */
    ensure(): boolean {
      if (options.state.spawned) return false
      run()
      return true
    },
    /** Spawns again after the receiver was unreachable. At most once every 10 minutes per process. */
    restart(): boolean {
      const last = options.state.lastSpawnAt
      if (last !== undefined && options.now() - last < RESPAWN_INTERVAL_MS) return false
      options.log.debug("telemetry receiver is unreachable; starting td-telemetry again")
      run()
      return true
    },
  }
}
