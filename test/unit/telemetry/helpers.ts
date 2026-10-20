import { readFileSync } from "node:fs"
import path from "node:path"
import { Mapper } from "../../../src/telemetry/mapper.ts"
import type { OpenCodeEvent, TelemetryRecord } from "../../../src/telemetry/types.ts"

export const FIXTURES = path.join(import.meta.dir, "..", "..", "fixtures", "telemetry")

export interface PromptEntry {
  hook: "prompt"
  at: number
  sessionID: string
  messageID: string
  prompt?: unknown
}
export type FixtureEntry = PromptEntry | OpenCodeEvent

export function loadFixture(name: string): FixtureEntry[] {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as FixtureEntry[]
}

export function isPrompt(entry: FixtureEntry): entry is PromptEntry {
  return "hook" in entry
}

export function newMapper(): Mapper {
  return new Mapper({ subagentToolNames: ["task", "subagent"], now: () => 9999 })
}

export function runFixture(name: string, mapper: Mapper = newMapper()): TelemetryRecord[] {
  const out: TelemetryRecord[] = []
  for (const entry of loadFixture(name)) {
    if (isPrompt(entry)) out.push(...mapper.promptHook(entry.sessionID, entry.messageID, entry.at))
    else out.push(...mapper.event(entry))
  }
  return out
}

/** Compact view of a record: name, session, time in ms, attributes. */
export function view(record: TelemetryRecord) {
  return {
    name: record.eventName,
    session: record.sessionID,
    ms: Number(BigInt(record.timeUnixNano) / 1_000_000n),
    attributes: record.attributes,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface FakeTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Fires every active timer whose delay is at least `minMs`. */
  fire(minMs: number): void
  active(): number[]
}

export function createFakeTimers(): FakeTimers {
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let next = 1
  return {
    setTimeout(callback, ms) {
      const id = next++
      timers.set(id, { callback, ms })
      return id
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    fire(minMs) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms >= minMs && timers.delete(id)) timer.callback()
      }
    },
    active: () => [...timers.values()].map((timer) => timer.ms),
  }
}
