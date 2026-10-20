/**
 * Environment of the child processes of the emitter.
 *
 * td-telemetry's process manager copies its environment into long-lived daemons, so the children get an allowlist,
 * not the full server environment. The FueliX key, OpenCode variables, and other API keys never pass.
 */

type Env = Readonly<Record<string, string | undefined>>

const EXACT: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
])

const PREFIXES: readonly string[] = ["LC_", "TD_"]

/** Needed by the hook scripts, which run `gh pr view`. The process manager does not need them. */
const HOOK_ONLY: ReadonlySet<string> = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR"])

const DENIED = /(^OPENCODE_|^FUELIX_|_API_KEY$)/i

export type ChildKind = "hook" | "manager"

export function childEnv(source: Env, kind: ChildKind): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || DENIED.test(name)) continue
    const allowed =
      EXACT.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix)) || (kind === "hook" && HOOK_ONLY.has(name))
    if (allowed) out[name] = value
  }
  return out
}
