import { realpathSync } from "node:fs"

/**
 * Decides whether this plugin instance owns a session.
 *
 * OpenCode can run two plugin instances for one physical directory when the directory has two spellings, for example
 * `/var/...` and its real path `/private/var/...` on macOS. Both instances then receive the events of a session, but only
 * the instance whose location equals the session location receives its prompt hook. Without a rule, both instances
 * start a segment and the receiver can store two segments for one session.
 *
 * The rule: an instance owns a session when the two directories are the same string, when either is unknown, or when
 * they are different places. When the two strings differ but resolve to the same real path, only the instance with the
 * exact session location owns the session (so this instance does not).
 */
export function createOwnership(
  ownDirectory: string | undefined,
  realpath: (path: string) => string = realpathSync,
): (sessionDirectory: string | undefined) => boolean {
  const cache = new Map<string, string | undefined>()
  const resolve = (path: string): string | undefined => {
    if (cache.has(path)) return cache.get(path)
    let value: string | undefined
    try {
      value = realpath(path)
    } catch {
      value = undefined
    }
    cache.set(path, value)
    return value
  }
  return (sessionDirectory) => {
    if (!ownDirectory || !sessionDirectory || ownDirectory === sessionDirectory) return true
    const own = resolve(ownDirectory)
    const session = resolve(sessionDirectory)
    return !(own !== undefined && own === session)
  }
}
