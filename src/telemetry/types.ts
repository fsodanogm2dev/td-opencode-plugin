/** Shared types of the td-telemetry emitter. */

export type AttributeValue = string | number | boolean

/** One td-telemetry log record, before OTLP encoding. */
export interface TelemetryRecord {
  /** `event.name` without the `claude_code.` prefix, for example `api_request`. */
  readonly eventName: string
  /** Root session ID. Child-session activity is reported under the root. */
  readonly sessionID: string
  /** Decimal string of the event time in nanoseconds since the Unix epoch. */
  readonly timeUnixNano: string
  readonly attributes: Readonly<Record<string, AttributeValue>>
}

/** The parts of an OpenCode event that the emitter reads. */
export interface OpenCodeEvent {
  readonly type: string
  /** Event time in epoch milliseconds. */
  readonly created?: number
  readonly data?: Readonly<Record<string, unknown>>
}

export function msToUnixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString()
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function str(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

export function num(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function obj(source: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return isRecord(value) ? value : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
