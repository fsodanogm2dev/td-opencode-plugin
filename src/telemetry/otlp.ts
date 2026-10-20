import type { AttributeValue, TelemetryRecord } from "./types.ts"

/** Attributes that always use `doubleValue`, even for whole numbers. */
const DOUBLE_KEYS: ReadonlySet<string> = new Set(["cost_usd"])

export const SERVICE_NAME = "td-opencode-plugin"

export interface OtlpValue {
  stringValue?: string
  intValue?: string
  doubleValue?: number
}
export interface OtlpAttribute {
  key: string
  value: OtlpValue
}

/**
 * Encodes one attribute in the wire shape of Claude Code: strings as `stringValue`, whole numbers as `intValue`
 * (decimal string), other numbers as `doubleValue`, booleans as the strings "true" and "false".
 * Returns `undefined` for a value that cannot be encoded (NaN or infinity).
 */
export function encodeAttribute(key: string, value: AttributeValue): OtlpAttribute | undefined {
  if (typeof value === "string") return { key, value: { stringValue: value } }
  if (typeof value === "boolean") return { key, value: { stringValue: value ? "true" : "false" } }
  if (!Number.isFinite(value)) return undefined
  if (DOUBLE_KEYS.has(key) || !Number.isInteger(value)) return { key, value: { doubleValue: value } }
  return { key, value: { intValue: String(value) } }
}

export interface OtlpPayload {
  resourceLogs: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeLogs: Array<{
      scope: { name: string }
      logRecords: Array<{
        timeUnixNano: string
        observedTimeUnixNano: string
        attributes: OtlpAttribute[]
      }>
    }>
  }>
}

export interface BuildOptions {
  readonly serviceVersion: string
  /** Observation time in epoch milliseconds. */
  readonly observedMs: number
}

function isoFromNano(nano: string): string {
  const ms = Number(BigInt(nano) / 1_000_000n)
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

export function buildOtlpPayload(records: readonly TelemetryRecord[], options: BuildOptions): OtlpPayload {
  const observed = (BigInt(Math.trunc(options.observedMs)) * 1_000_000n).toString()
  const logRecords = records.map((record) => {
    const attributes: OtlpAttribute[] = [
      { key: "session.id", value: { stringValue: record.sessionID } },
      { key: "event.name", value: { stringValue: record.eventName } },
      { key: "event.timestamp", value: { stringValue: isoFromNano(record.timeUnixNano) } },
      { key: "td.session.kind", value: { stringValue: "work" } },
    ]
    for (const [key, value] of Object.entries(record.attributes)) {
      const encoded = encodeAttribute(key, value)
      if (encoded) attributes.push(encoded)
    }
    return { timeUnixNano: record.timeUnixNano, observedTimeUnixNano: observed, attributes }
  })
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: SERVICE_NAME } },
            { key: "service.version", value: { stringValue: options.serviceVersion } },
          ],
        },
        scopeLogs: [{ scope: { name: SERVICE_NAME }, logRecords }],
      },
    ],
  }
}
