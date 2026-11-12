/**
 * Injectable boundaries: file system, process inspection, clock, and sleep.
 * Tests replace them. The Node implementations use only `node:` built-ins.
 */
import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { constants, promises as fsp } from "node:fs"

export interface FsPort {
  /** `null` when the file does not exist. */
  readText(path: string): Promise<string | null>
  /** Last `bytes` bytes as text, and whether the file is longer. `null` when missing. */
  readTail(path: string, bytes: number): Promise<{ text: string; truncated: boolean } | null>
  /** Create a new file (fails when it exists), write, fsync, close. */
  writeNew(path: string, text: string, mode: number): Promise<void>
  /** Hard link. Throws `EEXIST` when `to` exists. Atomic, so it makes a file appear with complete content. */
  link(from: string, to: string): Promise<void>
  mkdirp(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  removeDir(path: string): Promise<void>
  syncDir(path: string): Promise<void>
  list(path: string): Promise<string[]>
  mtimeMs(path: string): Promise<number | null>
}

export interface ProcessPort {
  readonly pid: number
  isAlive(pid: number): boolean
  /** A stable token for one process incarnation (its start time), or `null` when unknown. */
  startToken(pid: number): string | null
}

export interface Runtime {
  fs: FsPort
  proc: ProcessPort
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** A new unique id (UUID). */
  uuid: () => string
  /** A new random token for lock ownership and temp names. */
  token: () => string
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined
}

export function errorCode(error: unknown): string | undefined {
  return code(error)
}

/** The part of a file handle that `readTailFrom` uses. */
export interface TailHandle {
  stat(): Promise<{ size: number }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
}

/**
 * Last `bytes` bytes of a file. `read` may return fewer bytes than asked, so it loops until the wanted
 * length or end of file, and decodes only what was read. `truncated` is true when the file is longer.
 */
export async function readTailFrom(handle: TailHandle, bytes: number): Promise<{ text: string; truncated: boolean }> {
  const { size } = await handle.stat()
  const length = Math.min(size, bytes)
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, size - length + total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return { text: buffer.subarray(0, total).toString("utf8"), truncated: size > bytes }
}

export const nodeFs: FsPort = {
  async readText(path) {
    try {
      return await fsp.readFile(path, "utf8")
    } catch (error) {
      if (code(error) === "ENOENT") return null
      throw error
    }
  },
  async readTail(path, bytes) {
    let handle: fsp.FileHandle
    try {
      handle = await fsp.open(path, "r")
    } catch (error) {
      if (code(error) === "ENOENT") return null
      throw error
    }
    try {
      return await readTailFrom(handle, bytes)
    } finally {
      await handle.close()
    }
  },
  async writeNew(path, text, mode) {
    const handle = await fsp.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    try {
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  async link(from, to) {
    await fsp.link(from, to)
  },
  async mkdirp(path, mode) {
    await fsp.mkdir(path, { recursive: true, mode })
  },
  async rename(from, to) {
    await fsp.rename(from, to)
  },
  async removeFile(path) {
    await fsp.rm(path, { force: true })
  },
  async chmod(path, mode) {
    await fsp.chmod(path, mode)
  },
  async removeDir(path) {
    await fsp.rm(path, { recursive: true, force: true })
  },
  async syncDir(path) {
    const handle = await fsp.open(path, "r")
    try {
      await handle.sync()
    } catch (error) {
      // Some platforms refuse fsync on a directory. The rename already happened.
      if (code(error) !== "EINVAL" && code(error) !== "EPERM" && code(error) !== "ENOTSUP") throw error
    } finally {
      await handle.close()
    }
  },
  async list(path) {
    try {
      return await fsp.readdir(path)
    } catch (error) {
      if (code(error) === "ENOENT") return []
      throw error
    }
  },
  async mtimeMs(path) {
    try {
      return (await fsp.stat(path)).mtimeMs
    } catch (error) {
      if (code(error) === "ENOENT") return null
      throw error
    }
  },
}

export const nodeProcess: ProcessPort = {
  pid: process.pid,
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      return code(error) === "EPERM"
    }
  },
  startToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return out === "" ? null : out
    } catch {
      return null
    }
  },
}

export function nodeRuntime(): Runtime {
  return {
    fs: nodeFs,
    proc: nodeProcess,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uuid: () => randomUUID(),
    token: () => randomBytes(12).toString("hex"),
  }
}
