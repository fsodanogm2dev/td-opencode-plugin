import type { Logger } from "../log.ts"
import { DEFAULT_FUELIX_BASE_URL } from "../options.ts"

export const ALLOW_CUSTOM_URL_ENV = "TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL"

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

/**
 * Chooses the gateway origin. Plugin options can come from a project configuration, and the Keychain or credential
 * store key follows the base URL. A custom URL therefore needs an explicit opt-in in the environment, and must use
 * https (http only for a loopback host). Any other value falls back to the default with a warning.
 */
export function resolveBaseURL(requested: string, env: Readonly<Record<string, string | undefined>>, log: Logger): string {
  if (requested === DEFAULT_FUELIX_BASE_URL) return requested
  if (env[ALLOW_CUSTOM_URL_ENV] !== "1") {
    log.warn(
      `fuelix.baseURL is ignored because ${ALLOW_CUSTOM_URL_ENV} is not "1"; using ${DEFAULT_FUELIX_BASE_URL}`,
    )
    return DEFAULT_FUELIX_BASE_URL
  }
  let url: URL
  try {
    url = new URL(requested)
  } catch {
    log.warn(`fuelix.baseURL is not a valid URL; using ${DEFAULT_FUELIX_BASE_URL}`)
    return DEFAULT_FUELIX_BASE_URL
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))
  if (!secure) {
    log.warn(`fuelix.baseURL must use https (http is allowed only for localhost); using ${DEFAULT_FUELIX_BASE_URL}`)
    return DEFAULT_FUELIX_BASE_URL
  }
  log.info("FueliX uses a custom gateway", { host: url.host })
  return requested
}
