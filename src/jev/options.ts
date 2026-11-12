/**
 * Parses `options.jev`:
 *
 * ```jsonc
 * "jev": {
 *   "enabled": false,
 *   "model": "jev-1.14.0",
 *   "baseURL": "https://typesafe-gateway.k8smos.telus.gizmos.run",
 *   "keychainService": "typesafe-api-key",
 *   "scrubShellEnv": true,
 *   "telemetry": true,
 *   "points": {
 *     "safetyPreCheck":  { "mode": "enforce", "timeoutMs": 1500, "riskThreshold": 0.2, "failClosed": true },
 *     "testCompression": { "mode": "enforce", "timeoutMs": 2500, "maxRawLength": 1200 },
 *     "skillPruning":    { "mode": "off", "timeoutMs": 800, "maxSkills": 3 },
 *     "reasoningBudget": { "mode": "off", "timeoutMs": 800 }
 *   }
 * }
 * ```
 *
 * Invalid values fall back to defaults and add a warning. Parsing never throws. A warning never contains a value that
 * the user supplied for a secret field.
 */

import type { Env, JevMode } from "./types.ts"

export const DEFAULT_JEV_BASE_URL = "https://typesafe-gateway.k8smos.telus.gizmos.run"
export const PUBLIC_JEV_BASE_URL = "https://api.typesafe.ai"
export const TRUSTED_JEV_BASE_URLS: readonly string[] = [DEFAULT_JEV_BASE_URL, PUBLIC_JEV_BASE_URL]
export const TYPESAFE_BASE_URL_ENV = "TYPESAFE_BASE_URL"
export const DEFAULT_JEV_MODEL = "jev-1.14.0"
export const DEFAULT_JEV_KEYCHAIN_SERVICE = "typesafe-api-key"
export const ALLOW_CUSTOM_JEV_URL_ENV = "TD_OPENCODE_ALLOW_CUSTOM_JEV_URL"
/** Server environment flag that allows a Keychain service name other than the default. */
export const ALLOW_CUSTOM_JEV_KEYCHAIN_ENV = "TD_OPENCODE_ALLOW_CUSTOM_JEV_KEYCHAIN"
/** Keychain services that belong to other credentials. The TypeSafe lookup never reads them. */
export const RESERVED_KEYCHAIN_SERVICES: readonly string[] = ["fuelix-api-key"]

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
/** Jev models only: a version such as `jev-1.14.0` or `jev-1.14`, or the aliases `jev-latest` and `jev-preview`. */
export const JEV_MODEL_PATTERN = /^jev-(?:\d{1,3}\.\d{1,3}(?:\.\d{1,3})?|latest|preview)$/

export interface SafetyPreCheckOptions {
  readonly mode: JevMode
  readonly timeoutMs: number
  /** Probability above which a command is treated as destructive. */
  readonly riskThreshold: number
  /** When Jev is unavailable, ask the user instead of allowing the command. */
  readonly failClosed: boolean
}

export interface TestCompressionOptions {
  readonly mode: JevMode
  readonly timeoutMs: number
  /** Output shorter than this passes through unchanged. */
  readonly maxRawLength: number
}

export interface SkillPruningOptions {
  /** `off` or `shadow`. `enforce` in the user's options becomes `shadow`. */
  readonly mode: "off" | "shadow"
  readonly timeoutMs: number
  readonly maxSkills: number
}

export interface ReasoningBudgetOptions {
  /** `off` or `shadow`. `enforce` in the user's options becomes `shadow`. */
  readonly mode: "off" | "shadow"
  readonly timeoutMs: number
}

export interface JevPointsOptions {
  readonly safetyPreCheck: SafetyPreCheckOptions
  readonly testCompression: TestCompressionOptions
  readonly skillPruning: SkillPruningOptions
  readonly reasoningBudget: ReasoningBudgetOptions
}

export interface JevOptions {
  readonly enabled: boolean
  /** Jev model version or alias (`jev-latest`, `jev-preview`). */
  readonly model: string
  /** Origin without a path. The client appends `/v1/systemone`. */
  readonly baseURL: string
  /** macOS Keychain service of the TypeSafe key. `false` disables the Keychain lookup. */
  readonly keychainService: string | false
  /** Remove `TYPESAFE_API_KEY` from the environment of agent shell commands. */
  readonly scrubShellEnv: boolean
  readonly telemetry: boolean
  readonly points: JevPointsOptions
}

export const DEFAULT_JEV_OPTIONS: JevOptions = {
  enabled: false,
  model: DEFAULT_JEV_MODEL,
  baseURL: DEFAULT_JEV_BASE_URL,
  keychainService: DEFAULT_JEV_KEYCHAIN_SERVICE,
  scrubShellEnv: true,
  telemetry: true,
  points: {
    safetyPreCheck: { mode: "enforce", timeoutMs: 1500, riskThreshold: 0.2, failClosed: true },
    testCompression: { mode: "enforce", timeoutMs: 2500, maxRawLength: 1200 },
    skillPruning: { mode: "off", timeoutMs: 800, maxSkills: 3 },
    reasoningBudget: { mode: "off", timeoutMs: 800 },
  },
}

/** Fields of `jev.json` that this plugin does not support. They add a warning and have no effect. */
const IGNORED_FIELDS = ["categoryRouting", "contextGC", "apiKey", "brokerSocket"] as const

type Section = Record<string, unknown>

function isRecord(value: unknown): value is Section {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Removes a trailing `/` and `/v1`, so that the client can append `/v1/systemone` once. */
function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/v1$/, "").replace(/\/+$/, "")
}

function validateBaseURL(normalized: string, sourceLabel: string, fallback: string, warnings: string[]): string | undefined {
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    warnings.push(`${sourceLabel} is not a valid URL; using ${fallback}`)
    return undefined
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))
  if (!secure) {
    warnings.push(`${sourceLabel} must use https (http is allowed only for localhost); using ${fallback}`)
    return undefined
  }
  if (url.username || url.password || url.search || url.hash) {
    warnings.push(`${sourceLabel} must not contain credentials, a query, or a fragment; using ${fallback}`)
    return undefined
  }
  return normalized
}

function resolveEnvBaseURL(env: Env, warnings: string[]): string | undefined {
  const raw = env[TYPESAFE_BASE_URL_ENV]
  if (typeof raw !== "string" || raw.trim() === "") return undefined
  return validateBaseURL(normalizeBaseURL(raw.trim()), TYPESAFE_BASE_URL_ENV, DEFAULT_JEV_BASE_URL, warnings)
}

/**
 * Chooses the TypeSafe origin. Accepts the TELUS gateway and public TypeSafe origin, a URL from `TYPESAFE_BASE_URL`
 * in the server environment, or a custom `options.jev.baseURL` when `TD_OPENCODE_ALLOW_CUSTOM_JEV_URL=1` is set.
 */
export function resolveJevBaseURL(requested: string, env: Env, warnings: string[]): string {
  const envBaseURL = resolveEnvBaseURL(env, warnings)
  const fallback = envBaseURL ?? DEFAULT_JEV_BASE_URL
  const normalized = normalizeBaseURL(requested)
  if (TRUSTED_JEV_BASE_URLS.includes(normalized) || normalized === envBaseURL) return normalized
  if (env[ALLOW_CUSTOM_JEV_URL_ENV] !== "1") {
    warnings.push(`options.jev.baseURL is ignored because ${ALLOW_CUSTOM_JEV_URL_ENV} is not "1"; using ${fallback}`)
    return fallback
  }
  return validateBaseURL(normalized, "options.jev.baseURL", fallback, warnings) ?? fallback
}

/**
 * @param raw The value of `options.jev`. `undefined` gives the defaults.
 * @param env The service environment, for the custom URL guard.
 * @param warnings Receives one line per problem.
 */
export function parseJevOptions(raw: unknown, env: Env, warnings: string[]): JevOptions {
  const defaults = DEFAULT_JEV_OPTIONS
  if (raw !== undefined && !isRecord(raw)) {
    warnings.push("options.jev must be an object; using defaults")
    return defaults
  }
  const root: Section = raw ?? {}

  const section = (source: Section, path: string, name: string): Section => {
    const value = source[name]
    if (value === undefined) return {}
    if (isRecord(value)) return value
    warnings.push(`options.${path}.${name} must be an object; using defaults`)
    return {}
  }

  const readBoolean = (source: Section, path: string, key: string, fallback: boolean): boolean => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    warnings.push(`options.${path}.${key} must be true or false; using ${fallback}`)
    return fallback
  }

  const readNumber = (source: Section, path: string, key: string, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value
    warnings.push(`options.${path}.${key} must be a number from ${min} to ${max}; using ${fallback}`)
    return fallback
  }

  const readInteger = (source: Section, path: string, key: string, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (value === undefined) return fallback
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value
    warnings.push(`options.${path}.${key} must be an integer from ${min} to ${max}; using ${fallback}`)
    return fallback
  }

  const readMode = <T extends JevMode>(source: Section, path: string, fallback: T, allowed: readonly JevMode[]): T => {
    const value = source.mode
    if (value === undefined) return fallback
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T
    warnings.push(`options.${path}.mode must be ${allowed.map((mode) => JSON.stringify(mode)).join(", ")}; using "${fallback}"`)
    return fallback
  }

  /** Shadow-only points: `enforce` is not supported in this release and becomes `shadow`. */
  const readShadowMode = (source: Section, path: string, fallback: "off" | "shadow"): "off" | "shadow" => {
    if (source.mode === "enforce") {
      warnings.push(`options.${path}.mode "enforce" is not supported yet; using "shadow"`)
      return "shadow"
    }
    return readMode(source, path, fallback, ["off", "shadow"])
  }

  for (const field of IGNORED_FIELDS) {
    if (field in root) warnings.push(`options.jev.${field} is not supported and is ignored`)
  }

  // A project configuration can set options, and the Keychain service decides which stored secret goes to
  // TypeSafe. A name other than the default therefore needs an explicit opt-in in the server environment, and the
  // FueliX service is never accepted. Warnings never contain the supplied name.
  let keychainService: string | false = defaults.keychainService
  if (root.keychainService === false) keychainService = false
  else if (root.keychainService !== undefined) {
    const value = root.keychainService
    if (typeof value !== "string" || value.trim() === "") {
      warnings.push(`options.jev.keychainService must be a non-empty string or false; using ${JSON.stringify(defaults.keychainService)}`)
    } else if (value.trim() !== defaults.keychainService) {
      const name = value.trim()
      if (RESERVED_KEYCHAIN_SERVICES.includes(name.toLowerCase())) {
        warnings.push(`options.jev.keychainService names a service that belongs to another credential and is ignored; using ${JSON.stringify(defaults.keychainService)}`)
      } else if (env[ALLOW_CUSTOM_JEV_KEYCHAIN_ENV] !== "1") {
        warnings.push(`options.jev.keychainService is ignored because ${ALLOW_CUSTOM_JEV_KEYCHAIN_ENV} is not "1"; using ${JSON.stringify(defaults.keychainService)}`)
      } else keychainService = name
    }
  }

  let model = defaults.model
  if (root.model !== undefined) {
    const value = typeof root.model === "string" ? root.model.trim() : ""
    if (JEV_MODEL_PATTERN.test(value)) model = value
    else warnings.push(`options.jev.model must be a Jev model such as "jev-1.14.0", "jev-latest", or "jev-preview"; using ${JSON.stringify(defaults.model)}`)
  }

  let baseURL: string
  if (root.baseURL === undefined) {
    baseURL = resolveEnvBaseURL(env, warnings) ?? defaults.baseURL
  } else if (typeof root.baseURL === "string" && root.baseURL.trim() !== "") {
    baseURL = resolveJevBaseURL(root.baseURL.trim(), env, warnings)
  } else {
    const fallback = resolveEnvBaseURL(env, warnings) ?? DEFAULT_JEV_BASE_URL
    warnings.push(`options.jev.baseURL must be a non-empty string; using ${fallback}`)
    baseURL = fallback
  }

  const pointsRaw = section(root, "jev", "points")
  for (const field of IGNORED_FIELDS) {
    if (field in pointsRaw) warnings.push(`options.jev.points.${field} is not supported and is ignored`)
  }
  const safetyRaw = section(pointsRaw, "jev.points", "safetyPreCheck")
  const compressionRaw = section(pointsRaw, "jev.points", "testCompression")
  const skillsRaw = section(pointsRaw, "jev.points", "skillPruning")
  const reasoningRaw = section(pointsRaw, "jev.points", "reasoningBudget")
  const all: readonly JevMode[] = ["off", "shadow", "enforce"]
  const d = defaults.points

  return {
    enabled: readBoolean(root, "jev", "enabled", defaults.enabled),
    model,
    baseURL,
    keychainService,
    scrubShellEnv: readBoolean(root, "jev", "scrubShellEnv", defaults.scrubShellEnv),
    telemetry: readBoolean(root, "jev", "telemetry", defaults.telemetry),
    points: {
      safetyPreCheck: {
        mode: readMode(safetyRaw, "jev.points.safetyPreCheck", d.safetyPreCheck.mode, all),
        timeoutMs: readInteger(safetyRaw, "jev.points.safetyPreCheck", "timeoutMs", d.safetyPreCheck.timeoutMs, 100, 30_000),
        riskThreshold: readNumber(safetyRaw, "jev.points.safetyPreCheck", "riskThreshold", d.safetyPreCheck.riskThreshold, 0, 1),
        failClosed: readBoolean(safetyRaw, "jev.points.safetyPreCheck", "failClosed", d.safetyPreCheck.failClosed),
      },
      testCompression: {
        mode: readMode(compressionRaw, "jev.points.testCompression", d.testCompression.mode, all),
        timeoutMs: readInteger(compressionRaw, "jev.points.testCompression", "timeoutMs", d.testCompression.timeoutMs, 100, 30_000),
        maxRawLength: readInteger(compressionRaw, "jev.points.testCompression", "maxRawLength", d.testCompression.maxRawLength, 100, 1_000_000),
      },
      skillPruning: {
        mode: readShadowMode(skillsRaw, "jev.points.skillPruning", d.skillPruning.mode),
        timeoutMs: readInteger(skillsRaw, "jev.points.skillPruning", "timeoutMs", d.skillPruning.timeoutMs, 100, 30_000),
        maxSkills: readInteger(skillsRaw, "jev.points.skillPruning", "maxSkills", d.skillPruning.maxSkills, 1, 20),
      },
      reasoningBudget: {
        mode: readShadowMode(reasoningRaw, "jev.points.reasoningBudget", d.reasoningBudget.mode),
        timeoutMs: readInteger(reasoningRaw, "jev.points.reasoningBudget", "timeoutMs", d.reasoningBudget.timeoutMs, 100, 30_000),
      },
    },
  }
}
