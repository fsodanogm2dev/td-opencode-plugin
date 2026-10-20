import { spawn, type ChildProcess } from "node:child_process"

export interface RunOptions {
  /** Text written to stdin. */
  readonly input?: string
  readonly timeoutMs: number
  /** Run the child in its own process group. On timeout the whole group is killed. */
  readonly detached?: boolean
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly timedOut: boolean
  readonly error?: string
}

/** Runs a child process to completion. Never throws and never rejects. */
export type RunProcess = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

/** Starts a detached child process and does not wait for it. Never throws. */
export type SpawnDetached = (command: string, args: readonly string[], env?: Readonly<Record<string, string | undefined>>) => void

const STDOUT_LIMIT = 4096

/** Kills the child. A detached child leads its own process group, so the group is killed to reach its descendants. */
function killTree(child: ChildProcess, group: boolean): void {
  if (group && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // Fall back to the child alone.
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // The process is already gone.
  }
}

export const defaultRun: RunProcess = (command, args, options) =>
  new Promise<RunResult>((resolve) => {
    let settled = false
    let stdout = ""
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    try {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "ignore"],
        detached: options.detached === true,
        env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      })
      timer = setTimeout(() => {
        timedOut = true
        killTree(child, options.detached === true)
        finish({ code: null, stdout, timedOut: true })
      }, options.timeoutMs)
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < STDOUT_LIMIT) stdout += chunk.toString("utf8")
      })
      child.stdout?.on("error", () => {})
      child.stdin?.on("error", () => {})
      child.on("error", (error) => finish({ code: null, stdout, timedOut, error: error.message }))
      child.on("close", (code) => finish({ code, stdout, timedOut }))
      child.stdin?.end(options.input ?? "")
    } catch (error) {
      finish({ code: null, stdout, timedOut, error: error instanceof Error ? error.message : String(error) })
    }
  })

export const defaultSpawnDetached: SpawnDetached = (command, args, env) => {
  try {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      env: (env ?? process.env) as NodeJS.ProcessEnv,
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Telemetry never breaks a session.
  }
}
