/**
 * TypeSafe key resolution. Order, first match wins: macOS Keychain, OpenCode credential store (`/connect`,
 * integration `typesafe-ai`), environment variable `TYPESAFE_API_KEY`.
 *
 * The Keychain read shares the process-wide memo of the FueliX key (`globalKeychainCache`, keyed by service name).
 * A found key stays memoized. A read that found no key repeats at most every five minutes. The credential store and
 * the environment are read again after `ttlMs`, so a key from `/connect` takes effect without a restart.
 *
 * Nothing in this module writes a key to a log line or an error.
 */

import type { Plugin } from "@opencode/plugin"
import {
  globalKeychainCache,
  KEYCHAIN_NOT_FOUND,
  KEYCHAIN_RETRY_MS,
  KEYCHAIN_TIMEOUT_MS,
  type ExecFn,
  type KeychainCache,
  type KeychainEntry,
} from "../fuelix/credentials.ts"
import type { Logger } from "../log.ts"
import { RESERVED_KEYCHAIN_SERVICES } from "./options.ts"
import type { Env, JevKey, JevKeyProvider } from "./types.ts"

export const TYPESAFE_INTEGRATION_ID = "typesafe-ai"
export const TYPESAFE_ENV_NAME = "TYPESAFE_API_KEY"

/** How long a resolution (key or no key) stays valid before the credential store and the environment are read again. */
export const KEY_TTL_MS = 5_000

export interface ResolveJevKeyInput {
  readonly keychainService: string | false
  readonly platform: string
  readonly exec: ExecFn
  readonly env: Env
  readonly integration: Pick<Plugin.Context["integration"], "connection">
  readonly log: Logger
  /** Defaults to the process-wide Keychain memo. */
  readonly keychainCache?: KeychainCache
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function runKeychain(input: ResolveJevKeyInput, service: string): Promise<string | undefined> {
  try {
    const result = await input.exec(["/usr/bin/security", "find-generic-password", "-s", service, "-w"], {
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
    })
    if (result.exitCode === 0) return clean(result.stdout)
    if (result.exitCode !== KEYCHAIN_NOT_FOUND) input.log.debug("jev keychain lookup failed", { exitCode: result.exitCode })
  } catch {
    input.log.debug("jev keychain lookup failed")
  }
  return undefined
}

async function readKeychain(input: ResolveJevKeyInput): Promise<string | undefined> {
  if (input.platform !== "darwin" || input.keychainService === false) return undefined
  const service = input.keychainService
  // Defense in depth: the FueliX key must never be read for TypeSafe, whatever the options say.
  if (RESERVED_KEYCHAIN_SERVICES.includes(service.trim().toLowerCase())) return undefined
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

async function readCredentialStore(input: ResolveJevKeyInput): Promise<string | undefined> {
  try {
    const connection = await input.integration.connection.active(TYPESAFE_INTEGRATION_ID)
    if (!connection) return undefined
    const value = await input.integration.connection.resolve(connection)
    if (value?.type === "key") return clean(value.key)
  } catch {
    input.log.debug("jev credential store lookup failed")
  }
  return undefined
}

/** One resolution pass: Keychain, then credential store, then environment. Never throws. */
export async function resolveJevKey(input: ResolveJevKeyInput): Promise<JevKey | undefined> {
  const keychainKey = await readKeychain(input)
  if (keychainKey) return { key: keychainKey, source: "keychain" }
  const storeKey = await readCredentialStore(input)
  if (storeKey) return { key: storeKey, source: "credential-store" }
  const envKey = clean(input.env[TYPESAFE_ENV_NAME])
  if (envKey) return { key: envKey, source: "env" }
  return undefined
}

export interface JevKeyProviderInput extends ResolveJevKeyInput {
  /** Milliseconds a resolution stays valid. Default `KEY_TTL_MS`. */
  readonly ttlMs?: number
  /** Longest wait for one resolution. A hung lookup is dropped after it. Default `KEY_RESOLUTION_TIMEOUT_MS`. */
  readonly resolutionTimeoutMs?: number
}

/** Longest wait for one key resolution. */
export const KEY_RESOLUTION_TIMEOUT_MS = 5_000

export interface JevKeyProviderHandle extends JevKeyProvider {
  /** Source of the key found by the last resolution, for the startup log. Never the key. */
  readonly lastSource: JevKey["source"] | undefined
}

const TIMED_OUT = Symbol("timed out")

/**
 * Key provider for the client. Concurrent calls share one resolution. A missing key is not remembered beyond
 * `ttlMs` (the Keychain memo has its own five-minute retry), and the provider logs one warning until a key appears.
 *
 * One resolution waits at most `resolutionTimeoutMs`. After that, the call gets no key, nothing is cached, and the
 * next call starts a new lookup. The hung lookup is not awaited again, and its late result is ignored, so it cannot
 * replace the key or the source of a newer lookup.
 */
export function createJevKeyProvider(input: JevKeyProviderInput): JevKeyProviderHandle {
  const now = input.now ?? Date.now
  const ttlMs = input.ttlMs ?? KEY_TTL_MS
  const timeoutMs = input.resolutionTimeoutMs ?? KEY_RESOLUTION_TIMEOUT_MS
  let inflight: Promise<JevKey | undefined> | undefined
  let cached: { readonly at: number; readonly value: JevKey | undefined } | undefined
  let warnedNoKey = false
  let warnedTimeout = false
  let lastSource: JevKey["source"] | undefined
  let attempts = 0

  const start = (): Promise<JevKey | undefined> => {
    const attempt = ++attempts
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    })
    // The lookup never rejects. A result that arrives after its attempt timed out is dropped.
    const lookup = resolveJevKey(input).catch(() => undefined)
    const run = Promise.race([lookup, expired]).then((outcome) => {
      clearTimeout(timer)
      if (outcome === TIMED_OUT) {
        if (!warnedTimeout) {
          warnedTimeout = true
          input.log.warn("TypeSafe key lookup timed out; upstream Jev checks are skipped for this call")
        }
        return undefined
      }
      // An attempt that is no longer the latest one does not change the cache or the source.
      if (attempt !== attempts) return outcome
      cached = { at: now(), value: outcome }
      lastSource = outcome?.source
      warnedTimeout = false
      if (outcome) warnedNoKey = false
      else if (!warnedNoKey) {
        warnedNoKey = true
        input.log.warn("TypeSafe key not found; upstream Jev checks are skipped until one is configured")
      }
      return outcome
    })
    return run
  }

  return {
    get lastSource() {
      return lastSource
    },
    async resolve() {
      if (cached && now() - cached.at < ttlMs) return cached.value
      if (inflight) return inflight
      const run = start()
      inflight = run
      try {
        return await run
      } finally {
        if (inflight === run) inflight = undefined
      }
    },
  }
}
