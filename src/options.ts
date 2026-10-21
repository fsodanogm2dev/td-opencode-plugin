/**
 * Parses the plugin options that users set in `opencode.json(c)`:
 *
 * ```jsonc
 * { "package": "github:fsodanogm2dev/td-opencode-plugin", "options": { "fuelix": {}, "debug": false } }
 * ```
 *
 * Invalid values fall back to defaults and add a warning. Parsing never throws.
 */

export interface FuelixOptions {
  /** Gateway origin without a path. Providers append `/v1` where their package needs it. */
  readonly baseURL: string
  /** macOS Keychain service name of the FueliX key. `false` disables the Keychain lookup. */
  readonly keychainService: string | false
  /** Minutes between `/v1/models` refreshes. `0` disables the periodic refresh. */
  readonly refreshMinutes: number
  /** Register embedding, speech, transcription, and image-generation models too. */
  readonly includeNonChatModels: boolean
  /** Timeout of the `/v1/models` request in milliseconds. */
  readonly discoveryTimeoutMs: number
  /** Remove `FUELIX_API_KEY` from the environment of agent shell commands. */
  readonly scrubShellEnv: boolean
}

export interface ParsedOptions {
  readonly fuelix: FuelixOptions
  readonly debug: boolean
  readonly warnings: readonly string[]
}

export const DEFAULT_FUELIX_BASE_URL = "https://api.fuelix.ai"
export const DEFAULT_KEYCHAIN_SERVICE = "fuelix-api-key"

type Env = Readonly<Record<string, string | undefined>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseOptions(raw: unknown, env: Env = process.env): ParsedOptions {
  const warnings: string[] = []
  const root = isRecord(raw) ? raw : {}
  if (raw !== undefined && !isRecord(raw)) warnings.push("options must be an object; using defaults")

  const section = (name: string): Record<string, unknown> => {
    const value = root[name]
    if (value === undefined) return {}
    if (isRecord(value)) return value
    warnings.push(`options.${name} must be an object; using defaults`)
    return {}
  }

  const readString = (source: Record<string, unknown>, path: string, key: string, fallback: string): string => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "string" && value.trim() !== "") return value.trim()
    warnings.push(`options.${path}.${key} must be a non-empty string; using ${JSON.stringify(fallback)}`)
    return fallback
  }

  const readNumber = (
    source: Record<string, unknown>,
    path: string,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value
    warnings.push(`options.${path}.${key} must be a number from ${min} to ${max}; using ${fallback}`)
    return fallback
  }

  const readBoolean = (source: Record<string, unknown>, path: string, key: string, fallback: boolean): boolean => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    warnings.push(`options.${path}.${key} must be true or false; using ${fallback}`)
    return fallback
  }

  const fuelixRaw = section("fuelix")
  const keychainRaw = fuelixRaw.keychainService
  let keychainService: string | false = DEFAULT_KEYCHAIN_SERVICE
  if (keychainRaw === false) keychainService = false
  else if (keychainRaw !== undefined) keychainService = readString(fuelixRaw, "fuelix", "keychainService", DEFAULT_KEYCHAIN_SERVICE)

  const baseURL = readString(fuelixRaw, "fuelix", "baseURL", DEFAULT_FUELIX_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "")

  const fuelix: FuelixOptions = {
    baseURL,
    keychainService,
    refreshMinutes: readNumber(fuelixRaw, "fuelix", "refreshMinutes", 60, 0, 24 * 60),
    includeNonChatModels: readBoolean(fuelixRaw, "fuelix", "includeNonChatModels", false),
    discoveryTimeoutMs: readNumber(fuelixRaw, "fuelix", "discoveryTimeoutMs", 5000, 500, 60000),
    scrubShellEnv: readBoolean(fuelixRaw, "fuelix", "scrubShellEnv", true),
  }

  const debug = readBoolean(root, "options", "debug", false) || env.TD_OPENCODE_PLUGIN_DEBUG === "1"

  return { fuelix, debug, warnings }
}
