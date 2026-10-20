import { execFile } from "node:child_process"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
}

/** Runs a command without a shell. Resolves with the exit code; rejects only when the command cannot start. */
export type ExecFn = (command: readonly string[], options: { readonly timeoutMs: number }) => Promise<ExecResult>

export const defaultExec: ExecFn = (command, options) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command
    if (!file) return reject(new Error("empty command"))
    execFile(file, args, { timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (!error) return resolve({ exitCode: 0, stdout })
      const code = (error as { code?: unknown }).code
      if (typeof code === "number") return resolve({ exitCode: code, stdout: "" })
      reject(new Error(error.killed ? "command timed out" : "command failed"))
    })
  })

export const KEYCHAIN_NOT_FOUND = 44
export const KEYCHAIN_TIMEOUT_MS = 3000
export const FUELIX_INTEGRATION_ID = "fuelix"
export const FUELIX_ENV_NAME = "FUELIX_API_KEY"

export interface ResolvedKeys {
  readonly keychainKey?: string
  readonly credentialStoreKey?: string
  readonly envKey?: string
  /** First match in the order keychain, credential store, env. */
  readonly key?: string
  readonly source?: "keychain" | "credential-store" | "env"
}

export interface ResolveKeysInput {
  readonly keychainService: string | false
  readonly platform: string
  readonly exec: ExecFn
  readonly env: Readonly<Record<string, string | undefined>>
  readonly integration: Pick<Plugin.Context["integration"], "connection">
  readonly log: Logger
  /** Memo of Keychain reads. Defaults to the process-wide memo. */
  readonly keychainCache?: KeychainCache
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
}

/** Minimum time between two Keychain reads that found no key. */
export const KEYCHAIN_RETRY_MS = 5 * 60_000

export interface KeychainEntry {
  readonly promise: Promise<string | undefined>
  readonly startedAt: number
  /** Set when the read finished without a key. */
  missedAt?: number
}

export type KeychainCache = Map<string, KeychainEntry>

const KEYCHAIN_CACHE_KEY = Symbol.for("td-opencode-plugin.fuelix.keychain")

/**
 * Keychain reads shared by all plugin instances in this process. Each instance (one per project) would otherwise
 * run its own `security` process at startup.
 */
export function globalKeychainCache(): KeychainCache {
  const holder = globalThis as unknown as Record<symbol, KeychainCache | undefined>
  let cache = holder[KEYCHAIN_CACHE_KEY]
  if (!cache) {
    cache = new Map()
    holder[KEYCHAIN_CACHE_KEY] = cache
  }
  return cache
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function runKeychain(input: ResolveKeysInput, service: string): Promise<string | undefined> {
  try {
    const result = await input.exec(["/usr/bin/security", "find-generic-password", "-s", service, "-w"], {
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    })
    if (result.exitCode === 0) return clean(result.stdout)
    if (result.exitCode !== KEYCHAIN_NOT_FOUND) input.log.debug("keychain lookup failed", { exitCode: result.exitCode })
  } catch (error) {
    input.log.debug("keychain lookup failed", { reason: error instanceof Error ? error.message : "unknown" })
  }
  return undefined
}

/**
 * Memoized Keychain read. A found key stays memoized. A read that found no key (or timed out) repeats at most once
 * every `KEYCHAIN_RETRY_MS`.
 */
async function readKeychain(input: ResolveKeysInput): Promise<string | undefined> {
  if (input.platform !== "darwin" || input.keychainService === false) return undefined
  const service = input.keychainService
  const cache = input.keychainCache ?? globalKeychainCache()
  const now = input.now ?? Date.now
  const existing = cache.get(service)
  if (existing && (existing.missedAt === undefined || now() - existing.missedAt < KEYCHAIN_RETRY_MS)) return existing.promise
  const entry: KeychainEntry = {
    startedAt: now(),
    promise: runKeychain(input, service).then((key) => {
      if (key === undefined) entry.missedAt = now()
      return key
    }),
  }
  cache.set(service, entry)
  return entry.promise
}

async function readCredentialStore(input: ResolveKeysInput): Promise<string | undefined> {
  try {
    const connection = await input.integration.connection.active(FUELIX_INTEGRATION_ID)
    if (!connection) return undefined
    const value = await input.integration.connection.resolve(connection)
    if (value?.type === "key") return clean(value.key)
  } catch (error) {
    input.log.debug("credential store lookup failed", { reason: error instanceof Error ? error.message : "unknown" })
  }
  return undefined
}

export async function resolveKeys(input: ResolveKeysInput): Promise<ResolvedKeys> {
  const keychainKey = await readKeychain(input)
  const credentialStoreKey = await readCredentialStore(input)
  const envKey = clean(input.env[FUELIX_ENV_NAME])
  const source = keychainKey ? "keychain" : credentialStoreKey ? "credential-store" : envKey ? "env" : undefined
  const key = keychainKey ?? credentialStoreKey ?? envKey
  return {
    ...(keychainKey ? { keychainKey } : {}),
    ...(credentialStoreKey ? { credentialStoreKey } : {}),
    ...(envKey ? { envKey } : {}),
    ...(key ? { key } : {}),
    ...(source ? { source } : {}),
  }
}
