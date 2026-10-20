import { chmod, mkdir, writeFile } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import path from "node:path"
import type { Logger } from "../log.ts"
import type { RunProcess } from "./process.ts"
import { realTimers } from "./transport.ts"
import type { Timers } from "./transport.ts"
import { errorMessage } from "./types.ts"

/**
 * Maps OpenCode root sessions to td-telemetry segments. OpenCode sessions persist and no process exits per session,
 * so the plugin runs the Claude Code hook scripts itself:
 *
 * - `SessionStart` on the first activity of a root session, or on the first activity after an idle `SessionEnd`.
 * - `UserPromptSubmit` on each root prompt.
 * - `SessionEnd` after `idleMinutes` without activity, on session deletion, and on cleanup.
 */

export interface SegmentFs {
  mkdir(dir: string): Promise<void>
  writeFile(file: string, content: string): Promise<void>
}

export const defaultSegmentFs: SegmentFs = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  },
  async writeFile(file, content) {
    await writeFile(file, content, { mode: 0o600 })
    // `writeFile` keeps the mode of an existing file. Make sure it is private.
    await chmod(file, 0o600)
  },
}

export interface SegmentsOptions {
  readonly root: string
  readonly node: string
  readonly idleMinutes: number
  readonly log: Logger
  readonly run: RunProcess
  /** Directory used when a session has no known directory. */
  readonly defaultDirectory: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homedir?: string
  readonly fs?: SegmentFs
  readonly timers?: Timers
}

export interface SegmentInfo {
  readonly directory?: string | undefined
  readonly title?: string | undefined
}

type HookEvent = "SessionStart" | "UserPromptSubmit" | "SessionEnd"

interface Active {
  directory: string
  ready: Promise<void>
  idleTimer: unknown
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/
const HOOK_TIMEOUT_MS = 15_000

export class Segments {
  private readonly active = new Map<string, Active>()
  private readonly titles = new Map<string, string>()
  private readonly timers: Timers
  private readonly fs: SegmentFs
  private readonly idleMs: number
  private readonly transcriptDir: string

  constructor(private readonly options: SegmentsOptions) {
    this.timers = options.timers ?? realTimers
    this.fs = options.fs ?? defaultSegmentFs
    this.idleMs = options.idleMinutes * 60_000
    const env = options.env ?? process.env
    const home = options.homedir ?? osHomedir()
    const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : path.join(home, ".local", "share")
    this.transcriptDir = path.join(dataHome, "td-opencode-plugin", "transcripts")
  }

  isActive(rootID: string): boolean {
    return this.active.has(rootID)
  }

  activeRoots(): string[] {
    return [...this.active.keys()]
  }

  /** Resolves when the session's `SessionStart` hook has finished. Resolves at once for an inactive session. */
  ready(rootID: string): Promise<void> {
    return this.active.get(rootID)?.ready ?? Promise.resolve()
  }

  /** Records activity of a root session. Starts a segment when none is active. */
  touch(rootID: string, info: SegmentInfo = {}): void {
    if (info.title) this.titles.set(rootID, info.title)
    const existing = this.active.get(rootID)
    if (existing) {
      this.resetIdle(rootID, existing)
      return
    }
    const entry: Active = {
      directory: info.directory ?? this.options.defaultDirectory,
      ready: Promise.resolve(),
      idleTimer: undefined,
    }
    this.active.set(rootID, entry)
    entry.ready = this.runHook(rootID, entry.directory, "SessionStart", HOOK_TIMEOUT_MS)
    this.resetIdle(rootID, entry)
  }

  /** Records a root prompt. The hook runs in the background and never blocks the caller. */
  prompt(rootID: string, info: SegmentInfo = {}): void {
    this.touch(rootID, info)
    const entry = this.active.get(rootID)
    if (!entry) return
    entry.ready = entry.ready.then(() => this.runHook(rootID, entry.directory, "UserPromptSubmit", HOOK_TIMEOUT_MS))
  }

  /** Remembers a new title. Writes the title file now when a segment is active. */
  setTitle(rootID: string, title: string): void {
    if (!title || this.titles.get(rootID) === title) return
    this.titles.set(rootID, title)
    const entry = this.active.get(rootID)
    if (entry) entry.ready = entry.ready.then(() => this.writeTitle(rootID)).then(() => {})
  }

  /** Runs `SessionEnd` for the session and drops its segment. */
  end(rootID: string, timeoutMs: number = HOOK_TIMEOUT_MS): Promise<void> {
    const entry = this.active.get(rootID)
    if (!entry) return Promise.resolve()
    this.active.delete(rootID)
    if (entry.idleTimer !== undefined) this.timers.clearTimeout(entry.idleTimer)
    return entry.ready.then(() => this.runHook(rootID, entry.directory, "SessionEnd", timeoutMs))
  }

  forgetTitle(rootID: string): void {
    this.titles.delete(rootID)
  }

  /** Ends all active segments. Stops waiting after `budgetMs`. */
  async endAll(budgetMs: number): Promise<void> {
    const pending = this.activeRoots().map((id) => this.end(id, budgetMs))
    if (pending.length === 0) return
    let handle: unknown
    const budget = new Promise<void>((resolve) => {
      handle = this.timers.setTimeout(resolve, budgetMs)
    })
    await Promise.race([Promise.all(pending).then(() => {}), budget])
    this.timers.clearTimeout(handle)
  }

  /** Stops idle timers without running hooks. */
  dispose(): void {
    for (const entry of this.active.values()) {
      if (entry.idleTimer !== undefined) this.timers.clearTimeout(entry.idleTimer)
    }
  }

  private resetIdle(rootID: string, entry: Active): void {
    if (entry.idleTimer !== undefined) this.timers.clearTimeout(entry.idleTimer)
    entry.idleTimer = this.timers.setTimeout(() => {
      void this.end(rootID).catch(() => {})
    }, this.idleMs)
  }

  private transcriptPath(rootID: string): string | undefined {
    return SESSION_ID.test(rootID) ? path.join(this.transcriptDir, `${rootID}.jsonl`) : undefined
  }

  /** Writes the title file. Returns its path, or `null` when there is no title or the write fails. */
  private async writeTitle(rootID: string): Promise<string | null> {
    const title = this.titles.get(rootID)
    const file = this.transcriptPath(rootID)
    if (!title || !file) return null
    try {
      await this.fs.mkdir(path.dirname(file))
      await this.fs.writeFile(file, `${JSON.stringify({ type: "custom-title", customTitle: title })}\n`)
      return file
    } catch (error) {
      this.options.log.debug("telemetry title file write failed", { error: errorMessage(error) })
      return null
    }
  }

  private async runHook(rootID: string, cwd: string, event: HookEvent, timeoutMs: number): Promise<void> {
    try {
      const transcriptPath = await this.writeTitle(rootID)
      const script = event === "SessionEnd" ? "hook-session-end.mjs" : "hook-record-feature.mjs"
      const input = JSON.stringify({
        session_id: rootID,
        cwd,
        transcript_path: transcriptPath,
        hook_event_name: event,
      })
      const result = await this.options.run(this.options.node, [path.join(this.options.root, "scripts", script)], {
        input,
        timeoutMs,
        ...(this.options.env ? { env: this.options.env } : {}),
      })
      if (result.timedOut || (result.code !== 0 && result.code !== null) || result.error) {
        this.options.log.debug("telemetry hook did not finish cleanly", {
          event,
          code: result.code,
          timedOut: result.timedOut,
          error: result.error,
        })
      }
    } catch (error) {
      this.options.log.debug("telemetry hook failed", { event, error: errorMessage(error) })
    }
  }
}
