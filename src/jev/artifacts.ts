/**
 * Private storage for Jev files, under `<XDG_DATA_HOME or ~/.local/share>/td-opencode-plugin/jev`.
 *
 * - Directories have mode 0700 and files have mode 0600. Symlinks are never followed in the root, in a directory
 *   below it, or as a file target. Owners must match the current user.
 * - Logs of full test output are stored as redacted artifacts only. The raw output never reaches disk. Names are
 *   cryptographic hashes of the session and call IDs, so no ID reaches the path.
 * - Cleanup deletes only files that this module names: `logs/<32 hex>/<32 hex>.log` and `.tmp-<24 hex>`, regular,
 *   owned, old enough. Retention is by time. No total size limit applies to the logs.
 */

import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants, type Stats } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { exceedsRedactLimit, redactText, type RedactOptions } from "./redact.ts"
import type { Env } from "./types.ts"

export const JEV_DIR_MODE = 0o700
export const JEV_FILE_MODE = 0o600
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Entries that one cleanup pass looks at. */
const CLEANUP_MAX_ENTRIES = 20_000

const HASH_NAME = /^[0-9a-f]{32}$/
const LOG_NAME = /^[0-9a-f]{32}\.log$/
/** Name of the temporary file of an atomic write: `.tmp-` and 24 hex characters. A crash can leave one behind. */
const TEMP_NAME = /^\.tmp-[0-9a-f]{24}$/

export class JevArtifactError extends Error {
  readonly code: "invalid-root" | "invalid-name" | "unsafe-path" | "too-large" | "io"
  constructor(code: JevArtifactError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "JevArtifactError"
    this.code = code
  }
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? ((error as { code?: unknown }).code as string | undefined) : undefined
}

function ownedByUser(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid()
}

export async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return undefined
    throw error
  }
}

/** First 32 hex characters of the SHA-256 of `value`. Used for session and call names. */
export function hashName(value: string): string {
  return createHash("sha256").update("td-opencode-plugin.jev.name\0").update(value).digest("hex").slice(0, 32)
}

/** `<XDG_DATA_HOME if absolute, else <home>/.local/share>/td-opencode-plugin/jev`. */
export function defaultJevRoot(env: Env, homeDir: string): string {
  const xdg = env.XDG_DATA_HOME
  const dataHome = xdg && isAbsolute(xdg) && !xdg.includes("\0") ? xdg : join(homeDir, ".local", "share")
  return join(dataHome, "td-opencode-plugin", "jev")
}

/**
 * Creates `dir` with mode 0700 when missing. An existing directory must be a real directory (no symlink) that the
 * current user owns. Looser permissions are tightened to 0700.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  let stat = await lstatOrUndefined(dir)
  if (!stat) {
    try {
      await mkdir(dir, { mode: JEV_DIR_MODE })
    } catch (error) {
      if (nodeCode(error) !== "EEXIST") throw error
    }
    stat = await lstat(dir)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new JevArtifactError("unsafe-path", "Jev directory is a symlink or not a directory.")
  if (!ownedByUser(stat)) throw new JevArtifactError("unsafe-path", "Jev directory has an unexpected owner.")
  if ((stat.mode & 0o077) !== 0) {
    await chmod(dir, JEV_DIR_MODE)
    const after = await lstat(dir)
    if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o077) !== 0) {
      throw new JevArtifactError("unsafe-path", "Jev directory is accessible by other users.")
    }
  }
}

/** Validates the root path. The root must be absolute, free of NUL, and not the file system root. */
export function assertValidRoot(root: unknown): asserts root is string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
    throw new JevArtifactError("invalid-root", "Jev root must be an absolute path.")
  }
  if (dirname(resolve(root)) === resolve(root)) throw new JevArtifactError("invalid-root", "Jev root must not be the file system root.")
}

/** Creates the root (and missing ancestors, 0700) and verifies the root itself. Ancestors may be symlinks. */
export async function ensureRoot(root: string): Promise<void> {
  assertValidRoot(root)
  const parent = dirname(root)
  if (!(await lstatOrUndefined(parent))) await mkdir(parent, { recursive: true, mode: JEV_DIR_MODE })
  await ensurePrivateDir(root)
}

/**
 * Opens a private file for appending. Never follows a symlink. The file must be a regular file with one link that
 * the current user owns. A looser mode is tightened to 0600.
 */
export async function openPrivateAppend(path: string) {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    JEV_FILE_MODE,
  ).catch((error: unknown) => {
    if (nodeCode(error) === "ELOOP") throw new JevArtifactError("unsafe-path", "Jev file is a symlink.", { cause: error })
    throw error
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || !ownedByUser(stat)) {
      throw new JevArtifactError("unsafe-path", "Jev file is not a private regular file.")
    }
    if ((stat.mode & 0o077) !== 0) await handle.chmod(JEV_FILE_MODE)
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  return handle
}

/**
 * Stats `path` and returns the result only for a real directory (no symlink) that the current user owns and that
 * group and others cannot write to. Returns `undefined` for anything else, including a missing path.
 */
async function safeDir(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByUser(stat) || (stat.mode & 0o022) !== 0) return undefined
    return stat
  } catch {
    return undefined
  }
}

function sameDir(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino
}

export interface JevArtifactsDeps {
  /** Clock in milliseconds. For tests. */
  readonly now?: () => number
}

export interface CleanupResult {
  readonly deleted: number
  readonly kept: number
}

export class JevArtifacts {
  readonly root: string
  readonly logsDir: string
  private readonly now: () => number

  constructor(root: string, deps: JevArtifactsDeps = {}) {
    assertValidRoot(root)
    this.root = resolve(root)
    this.logsDir = join(this.root, "logs")
    this.now = deps.now ?? Date.now
  }

  /** Absolute path of the log of one call. Does not touch the file system. */
  logPath(sessionID: string, callID: string): string {
    this.assertName(sessionID)
    this.assertName(callID)
    return join(this.logsDir, hashName(sessionID), `${hashName(callID)}.log`)
  }

  /**
   * Stores the redacted text of `content` as `logs/<session hash>/<call hash>.log` with mode 0600, and returns the
   * path. The write is atomic. An existing log of the same call is replaced. `content` is redacted as a whole, with
   * the literal secrets in `options.secrets`, before it reaches disk.
   */
  async writeLog(sessionID: string, callID: string, content: string, options: RedactOptions = {}): Promise<string> {
    const file = this.logPath(sessionID, callID)
    const dir = dirname(file)
    // A text above the redaction limit cannot be redacted safely, and a cut copy would not be a full log.
    if (exceedsRedactLimit(content)) throw new JevArtifactError("too-large", "Output is too large to store as a redacted log.")
    const data = redactText(content, options)
    try {
      await ensureRoot(this.root)
      await ensurePrivateDir(this.logsDir)
      await ensurePrivateDir(dir)
      const existing = await lstatOrUndefined(file)
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new JevArtifactError("unsafe-path", "Jev log target is a symlink or not a regular file.")
      }
      const temp = join(dir, `.tmp-${randomBytes(12).toString("hex")}`)
      let created = false
      try {
        const handle = await open(
          temp,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          JEV_FILE_MODE,
        )
        created = true
        try {
          await handle.writeFile(data, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temp, file)
        created = false
      } finally {
        if (created) await unlink(temp).catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof JevArtifactError) throw error
      throw new JevArtifactError("io", "Failed to write a Jev log.", { cause: error })
    }
    return file
  }

  /**
   * Deletes logs older than `maxAgeMs` (default 7 days). Looks only at `logs/<32 hex>/<32 hex>.log` regular files
   * of the current user, and the `.tmp-<24 hex>` remnants of interrupted writes in the same directories (counted as
   * deleted). It never deletes anything else.
   *
   * Retention is by time only. There is no limit on the total size of the logs.
   *
   * The root, `logs`, and each session directory must be real directories (no symlink) that the current user owns
   * and that other users cannot write to. Otherwise the pass skips them without a change. Permissions are never
   * changed here. Each directory is checked again by device and inode after it is listed, and before every delete,
   * so a directory that is replaced during the pass stops the pass. A missing logs directory is not an error.
   */
  async cleanup(maxAgeMs: number = LOG_RETENTION_MS): Promise<CleanupResult> {
    const cutoff = this.now() - maxAgeMs
    let deleted = 0
    let kept = 0
    let visited = 0
    const root = await safeDir(this.root)
    if (!root) return { deleted, kept }
    const logs = await safeDir(this.logsDir)
    if (!logs) return { deleted, kept }
    /** True while root and logs are still the directories that were checked first. */
    const stable = async (): Promise<boolean> => sameDir(await safeDir(this.root), root) && sameDir(await safeDir(this.logsDir), logs)
    let sessions: string[]
    try {
      sessions = await readdir(this.logsDir)
    } catch {
      return { deleted, kept }
    }
    if (!(await stable())) return { deleted, kept }
    for (const session of sessions) {
      if (!HASH_NAME.test(session) || ++visited > CLEANUP_MAX_ENTRIES) continue
      const dir = join(this.logsDir, session)
      try {
        const dirStat = await safeDir(dir)
        if (!dirStat) continue
        const names = await readdir(dir)
        if (!sameDir(await safeDir(dir), dirStat) || !(await stable())) continue
        for (const name of names) {
          if (!(LOG_NAME.test(name) || TEMP_NAME.test(name)) || ++visited > CLEANUP_MAX_ENTRIES) continue
          const file = join(dir, name)
          try {
            const stat = await lstat(file)
            if (stat.isSymbolicLink() || !stat.isFile() || !ownedByUser(stat)) continue
            if (stat.mtimeMs >= cutoff) {
              kept++
              continue
            }
            if (!sameDir(await safeDir(dir), dirStat) || !(await stable())) continue
            await unlink(file)
            deleted++
          } catch {
            // A file that vanished or cannot be removed stays out of the count.
          }
        }
        if (sameDir(await safeDir(dir), dirStat)) await rmdir(dir).catch(() => undefined)
      } catch {
        // Skip a session directory that cannot be read.
      }
    }
    return { deleted, kept }
  }

  private assertName(value: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
      throw new JevArtifactError("invalid-name", "Invalid session or call ID.")
    }
  }
}
