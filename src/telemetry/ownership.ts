import { realpathSync } from "node:fs"
import { addBounded } from "./bounded.ts"

/**
 * Decides which plugin instance reports a session.
 *
 * One OpenCode server can run several plugin instances: one per loaded location (project), and sometimes two for one
 * directory with two spellings (`/var/...` and `/private/var/...` on macOS). OpenCode's event bus delivers events that
 * carry no location to every instance, so more than one instance can see the same session. Only one must report it.
 *
 * Instances register their directory in a process-wide registry (directory to count of active instances).
 * An instance owns a session when:
 *
 * 1. its own directory or the session directory is unknown, or
 * 2. the two directories are the same string, or
 * 3. no instance is registered for exactly the session directory, and this instance has the lexicographically smallest
 *    directory among the registered directories that resolve to the same real path as the session directory.
 *
 * It does not own the session when an instance is registered for exactly the session directory, or when no registered
 * directory has the same real path.
 */

export type OwnerRegistry = Map<string, number>

const REGISTRY_KEY = Symbol.for("td-opencode-plugin.telemetry.owners")

/** The registry shared by all plugin instances in this process. */
export function globalOwnerRegistry(): OwnerRegistry {
  const holder = globalThis as unknown as Record<symbol, OwnerRegistry | undefined>
  let registry = holder[REGISTRY_KEY]
  if (!registry) {
    registry = new Map()
    holder[REGISTRY_KEY] = registry
  }
  return registry
}

export interface OwnershipOptions {
  readonly ownDirectory: string | undefined
  readonly registry?: OwnerRegistry
  readonly realpath?: (path: string) => string
  /** Called once per session ID when the session has no matching owner. */
  readonly onNoOwner?: (sessionDirectory: string, sessionID: string | undefined) => void
}

export interface Ownership {
  /** Adds this instance to the registry. Call once when telemetry is active. */
  register(): void
  /** Removes this instance from the registry. Safe to call more than once. */
  unregister(): void
  owns(sessionDirectory: string | undefined, sessionID?: string): boolean
}

export function createOwnership(options: OwnershipOptions): Ownership {
  const registry = options.registry ?? globalOwnerRegistry()
  const realpath = options.realpath ?? realpathSync
  const own = options.ownDirectory
  const cache = new Map<string, string>()
  const resolve = (path: string): string => {
    const cached = cache.get(path)
    if (cached !== undefined) return cached
    let value: string
    try {
      value = realpath(path)
    } catch {
      value = path
    }
    cache.set(path, value)
    return value
  }
  const reported = new Set<string>()
  let registered = false

  return {
    register() {
      if (!own || registered) return
      registered = true
      registry.set(own, (registry.get(own) ?? 0) + 1)
    },
    unregister() {
      if (!own || !registered) return
      registered = false
      const count = (registry.get(own) ?? 0) - 1
      if (count > 0) registry.set(own, count)
      else registry.delete(own)
    },
    owns(sessionDirectory, sessionID) {
      if (!own || !sessionDirectory) return true
      if (own === sessionDirectory) return true
      if ((registry.get(sessionDirectory) ?? 0) > 0) return false
      const target = resolve(sessionDirectory)
      let smallest: string | undefined
      for (const directory of registry.keys()) {
        if (resolve(directory) !== target) continue
        if (smallest === undefined || directory < smallest) smallest = directory
      }
      if (smallest === undefined) {
        const key = sessionID ?? sessionDirectory
        if (!reported.has(key)) {
          addBounded(reported, key)
          options.onNoOwner?.(sessionDirectory, sessionID)
        }
        return false
      }
      return smallest === own
    },
  }
}
