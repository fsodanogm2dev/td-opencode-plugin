import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../log.ts"
import { FUELIX_PROVIDER_IDS } from "./catalog-types.ts"

const FLAG = Symbol.for("td-opencode-plugin.fuelix.stale-config-warned")

export const SECRET_HEADERS = ["authorization", "x-api-key"]
export const SECRET_SETTINGS = ["apiKey", "authToken"]

/** Names the fields of a provider record that hold a credential. Never returns a value. */
export function secretFields(provider: unknown): string[] {
  const found: string[] = []
  const record = provider as { settings?: Record<string, unknown>; headers?: Record<string, unknown> } | null | undefined
  for (const key of SECRET_SETTINGS) {
    const value = record?.settings?.[key]
    if (value !== undefined && value !== null && value !== "") found.push(`settings.${key}`)
  }
  for (const name of Object.keys(record?.headers ?? {})) {
    if (SECRET_HEADERS.includes(name.toLowerCase())) found.push(`headers.${name}`)
  }
  return found
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms)
  })
  return Promise.race([promise, limit]).finally(() => timer && clearTimeout(timer))
}

/** Delays of the checks, in milliseconds. The configuration overlay appears shortly after plugin setup. */
export const DEFAULT_CHECK_DELAYS_MS = [0, 300, 1000]

async function scan(ctx: Pick<Plugin.Context, "provider">, log: Logger, timeoutMs: number): Promise<string[]> {
  const perProvider = await Promise.all(
    FUELIX_PROVIDER_IDS.map(async (providerID) => {
      try {
        const result = (await timeout(Promise.resolve(ctx.provider.get({ providerID })), timeoutMs)) as unknown
        const provider = (result as { data?: unknown } | undefined)?.data ?? result
        return secretFields(provider).map((field) => `${providerID} ${field}`)
      } catch (error) {
        log.debug("could not read provider for the stale configuration check", {
          providerID,
          reason: error instanceof Error ? error.message : "unknown",
        })
        return []
      }
    }),
  )
  return perProvider.flat()
}

/**
 * Detects FueliX provider blocks that stay in the user's configuration with a credential. OpenCode applies a
 * configured provider on top of the plugin provider, and `GET /api/provider` returns the credential. Warns once per
 * process. Never throws. The warning names the provider and the field, never the value.
 *
 * Two facts about OpenCode 2.0.32 (verified on an isolated server) shape this function:
 * - The configuration overlay appears a moment after plugin setup, so the check repeats at `delaysMs` until it finds
 *   something.
 * - After `ctx.provider.reload()`, the plugin client stops showing the overlay. Run the check before the first reload.
 */
export async function warnStaleFuelixConfig(
  ctx: Pick<Plugin.Context, "provider">,
  log: Logger,
  options: { readonly holder?: Record<symbol, unknown>; readonly timeoutMs?: number; readonly delaysMs?: readonly number[] } = {},
): Promise<void> {
  const holder = options.holder ?? (globalThis as unknown as Record<symbol, unknown>)
  if (holder[FLAG]) return
  try {
    for (const delay of options.delaysMs ?? DEFAULT_CHECK_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const findings = await scan(ctx, log, options.timeoutMs ?? 5000)
      if (findings.length === 0 || holder[FLAG]) continue
      holder[FLAG] = true
      log.warn(
        `FueliX provider blocks in the OpenCode configuration hold a credential (${findings.join(", ")}). ` +
          "The key stays visible in GET /api/model and the configuration overrides the plugin catalog. " +
          'Remove the FueliX provider blocks (README, "Install").',
      )
      return
    }
  } catch {
    // The check must never throw.
  }
}
