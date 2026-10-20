/** Default cap for the per-session maps and sets of the emitter. */
export const MAX_TRACKED = 5000

/** Sets `key` in `map`. Drops the oldest entry when the map is full. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number = MAX_TRACKED): void {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

/** Adds `value` to `set`. Drops the oldest entry when the set is full. */
export function addBounded<V>(set: Set<V>, value: V, max: number = MAX_TRACKED): void {
  if (!set.has(value) && set.size >= max) {
    const oldest = set.values().next()
    if (!oldest.done) set.delete(oldest.value)
  }
  set.add(value)
}
