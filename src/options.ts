/**
 * Parses the plugin options that users set in `opencode.json(c)`:
 *
 * ```jsonc
 * { "package": "github:fsodanogm2dev/td-opencode-plugin", "options": { "fuelix": {}, "telemetry": {}, "debug": false } }
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

export interface TelemetryOptions {
  /** Emit td-telemetry events. Telemetry stays off when no td-telemetry installation is found. */
  readonly enabled: boolean
  /** td-telemetry installation directory (contains `lib/` and `scripts/`). Found automatically when unset. */
  readonly root: string | undefined
  /** OTLP/HTTP receiver origin. Defaults to `http://127.0.0.1:${TD_RECEIVER_PORT ?? 4418}`. */
  readonly receiverURL: string
  /** Node.js executable used to run td-telemetry scripts (Node 22.5 or later). */
  readonly node: string
  /** Minutes without activity before a session segment is closed (`SessionEnd`). */
  readonly idleMinutes: number
  /** OpenCode tool names that start a subagent. They are reported to td-telemetry as `Task`. */
  readonly subagentToolNames: readonly string[]
}

export interface ParsedOptions {
  readonly fuelix: FuelixOptions
  readonly telemetry: TelemetryOptions
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

  const readOptionalString = (source: Record<string, unknown>, path: string, key: string): string | undefined => {
    const value = source[key]
    if (value === undefined) return undefined
    if (typeof value === "string" && value.trim() !== "") return value.trim()
    warnings.push(`options.${path}.${key} must be a non-empty string; ignoring it`)
    return undefined
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

  const telemetryRaw = section("telemetry")
  const port = env.TD_RECEIVER_PORT && /^\d+$/.test(env.TD_RECEIVER_PORT) ? env.TD_RECEIVER_PORT : "4418"
  const subagentRaw = telemetryRaw.subagentToolNames
  let subagentToolNames: readonly string[] = ["task", "subagent"]
  if (subagentRaw !== undefined) {
    if (Array.isArray(subagentRaw) && subagentRaw.every((item) => typeof item === "string" && item !== "")) {
      subagentToolNames = subagentRaw as string[]
    } else {
      warnings.push("options.telemetry.subagentToolNames must be an array of strings; using defaults")
    }
  }

  const telemetry: TelemetryOptions = {
    enabled: readBoolean(telemetryRaw, "telemetry", "enabled", true),
    root: readOptionalString(telemetryRaw, "telemetry", "root") ?? (env.TD_TELEMETRY_ROOT?.trim() || undefined),
    receiverURL: readString(telemetryRaw, "telemetry", "receiverURL", `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    node: readString(telemetryRaw, "telemetry", "node", "node"),
    idleMinutes: readNumber(telemetryRaw, "telemetry", "idleMinutes", 30, 1, 24 * 60),
    subagentToolNames,
  }

  const debug = readBoolean(root, "options", "debug", false) || env.TD_OPENCODE_PLUGIN_DEBUG === "1"

  return { fuelix, telemetry, debug, warnings }
}
