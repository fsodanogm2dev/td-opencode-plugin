/**
 * Reads what the backend writes: runtime snapshots and lifecycle facts. The service never writes them.
 * Parsing goes through the backend `SchemaPort`; malformed content is ignored, never repaired.
 */
import type { GuardRuntimeReport, SchemaPort } from "./contract.ts"
import {
  EMPTY_READING,
  LIFECYCLE_TAIL_BYTES,
  UNREADABLE_READING,
  parseLifecycleText,
  type LifecycleReading,
} from "../../src/guards/lifecycle-history.ts"
import type { Runtime } from "./ports.ts"

export const HEARTBEAT_STALE_MS = 60_000
const MAX_RUNTIME_BYTES = 1024 * 1024

export type RuntimeStatus = "live" | "stale" | "missing" | "invalid"

export interface RuntimeRead {
  readonly status: RuntimeStatus
  /** `null` unless the snapshot is valid and fresh. */
  readonly report: GuardRuntimeReport | null
}

export async function readRuntime(
  runtime: Runtime,
  schema: SchemaPort,
  root: string,
  directory: string | null,
): Promise<RuntimeRead> {
  let text: string | null
  try {
    text = await runtime.fs.readText(schema.runtimePath(root, directory))
  } catch {
    return { status: "invalid", report: null }
  }
  if (text === null) return { status: "missing", report: null }
  if (text.length > MAX_RUNTIME_BYTES) return { status: "invalid", report: null }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { status: "invalid", report: null }
  }
  const parsed = schema.parseRuntime(json)
  if (!parsed.ok) return { status: "invalid", report: null }
  const recorded = Date.parse(parsed.value.recordedAt)
  const age = runtime.now() - recorded
  if (!Number.isFinite(recorded) || age > HEARTBEAT_STALE_MS || -age > HEARTBEAT_STALE_MS) {
    return { status: "stale", report: null }
  }
  return { status: "live", report: parsed.value }
}

/**
 * The lifecycle log as the shared core parser reads it (`src/guards/lifecycle-history.ts`). The service holds
 * no parser of its own. A log that cannot be read proves nothing, so it reads as truncated and empty.
 */
export async function readLifecycle(runtime: Runtime, schema: SchemaPort, root: string): Promise<LifecycleReading> {
  let tail: { text: string; truncated: boolean } | null
  try {
    tail = await runtime.fs.readTail(schema.lifecyclePath(root), LIFECYCLE_TAIL_BYTES)
  } catch {
    return UNREADABLE_READING
  }
  if (tail === null) return EMPTY_READING
  return parseLifecycleText(tail.text, tail.truncated)
}
