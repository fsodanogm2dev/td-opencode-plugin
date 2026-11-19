/**
 * Where the running plugin was loaded from. The status report records the kind only, never the path.
 *
 * - `extension`: the OpenChamber extension folder (`.../openchamber/extensions/...`).
 * - `git`: an OpenCode package-cache directory for a git install (`.../opencode/npm/git-<name>-<hash>/...`).
 * - `npm`: any other `node_modules` path.
 * - `folder`: anything else, such as a source checkout or a local plugin folder.
 */

export type PluginSource = "extension" | "git" | "npm" | "folder"

export const PLUGIN_SOURCES: readonly PluginSource[] = ["extension", "git", "npm", "folder"]

/** Classifies a module URL or path. Pure. Never throws. Accepts POSIX and Windows file URLs and paths. */
export function detectPluginSource(moduleUrl: string): PluginSource {
  let path = String(moduleUrl)
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.replace(/^file:\/*/i, "/")
    }
  }
  const normalized = `/${path.replace(/\\/g, "/").toLowerCase()}`.replace(/\/{2,}/g, "/")
  if (normalized.includes("/openchamber/extensions/")) return "extension"
  if (/\/opencode\/(?:npm|packages)\/git-[^/]+\//.test(normalized)) return "git"
  if (normalized.includes("/node_modules/")) return "npm"
  return "folder"
}

/** Source of the running module. Evaluates `import.meta.url` at runtime, also inside a bundle. */
export function currentPluginSource(): PluginSource {
  return detectPluginSource(import.meta.url)
}
