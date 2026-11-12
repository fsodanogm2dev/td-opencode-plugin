/**
 * Runtime report writer. One JSON file per location: `<root>/runtime/<sha256 directory>.json`.
 * The report holds counts and session IDs only. It never holds a command, a resource, a path of a resource, or a key.
 * A write failure is nonfatal and logged once per failure streak with a fixed text.
 */

import { join } from "node:path"
import type { Logger } from "../log.ts"
import { GUARD_RUNTIME_SCHEMA, LIMITS, type GuardRuntimeReport } from "./schema.ts"
import { runtimeFileName, type GuardFs } from "./store.ts"

export type RuntimeReportState = Omit<GuardRuntimeReport, "schema" | "directory" | "instanceId" | "recordedAt">

export interface RuntimeReporter {
  /** Schedules a write of the current state. Coalesced. Never throws. */
  update(): void
  /** Resolves when no write is pending. Never rejects. */
  flush(): Promise<void>
  close(): void
}

export function createRuntimeReporter(input: {
  readonly fs: GuardFs
  readonly runtimeDir: string
  readonly directory: string | null
  readonly instanceId: string
  readonly now: () => Date
  readonly log: Logger
  readonly state: () => RuntimeReportState
}): RuntimeReporter {
  const target = join(input.runtimeDir, runtimeFileName(input.directory))
  let dirty = false
  let running = false
  let closed = false
  let current: Promise<void> = Promise.resolve()
  let failing = false

  const build = (): GuardRuntimeReport => {
    const state = input.state()
    return {
      schema: GUARD_RUNTIME_SCHEMA,
      directory: input.directory,
      instanceId: input.instanceId,
      recordedAt: input.now().toISOString(),
      ...state,
      sessions: state.sessions.slice(0, LIMITS.sessions),
    }
  }

  const drain = async () => {
    try {
      while (dirty) {
        dirty = false
        try {
          await input.fs.writeFileAtomic(target, `${JSON.stringify(build(), null, 2)}\n`)
          failing = false
        } catch {
          if (!failing) {
            failing = true
            input.log.warn("guard runtime report write failed")
          }
        }
      }
    } finally {
      running = false
    }
  }

  return {
    update() {
      if (closed) return
      dirty = true
      if (running) return
      running = true
      current = drain()
    },
    async flush() {
      while (running) await current
    },
    close() {
      closed = true
    },
  }
}
