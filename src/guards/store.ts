/**
 * Guard storage access for the backend plugin. The backend only READS the intent store.
 * The TD-Plugin extension service is the only writer of `store.json`.
 *
 * The backend writes two other files: `lifecycle.jsonl` (append-only facts) and `runtime/<sha256 directory>.json`
 * (status snapshots). Both writes use `GuardFs`, so tests inject a fake.
 */

import { createHash, randomBytes } from "node:crypto"
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import { join } from "node:path"
import { EMPTY_READING, LIFECYCLE_TAIL_BYTES, parseLifecycleText, UNREADABLE_READING, type LifecycleReading } from "./lifecycle-history.ts"
import { emptyGuardStore, LIMITS, parseGuardStoreText, type GuardStore, type GuardStoreState } from "./schema.ts"

export interface FileSignature {
  readonly mtimeMs: number
  readonly size: number
  readonly ino: number
}

/** Injectable file system. Every method may reject. */
export interface GuardFs {
  /** `null` when the path does not exist. Rejects on any other error. */
  stat(path: string): Promise<FileSignature | null>
  readFile(path: string): Promise<string>
  /**
   * Reads at most `maxBytes` from the end of the file. `truncated` is true when the file is longer. `null` when the
   * file does not exist. Rejects on any other error.
   */
  readTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null>
  /** Appends `data` with one write. Creates the directory (0700) and file (0600). */
  appendFile(path: string, data: string): Promise<void>
  /** Writes through a temporary file and a rename. Directory 0700, file 0600. */
  writeFileAtomic(path: string, data: string): Promise<void>
}

export interface GuardPaths {
  readonly root: string
  readonly store: string
  readonly lifecycle: string
  readonly runtimeDir: string
}

export function guardPaths(home: string): GuardPaths {
  const root = join(home, ".td-opencode-plugin", "guards")
  return { root, store: join(root, "store.json"), lifecycle: join(root, "lifecycle.jsonl"), runtimeDir: join(root, "runtime") }
}

/** SHA-256 of the UTF-8 directory path as hex, or `global` without a directory. */
export function runtimeFileName(directory: string | null): string {
  if (directory === null) return "global.json"
  return `${createHash("sha256").update(Buffer.from(directory, "utf8")).digest("hex")}.json`
}

export function createNodeGuardFs(): GuardFs {
  const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")))
  return {
    async stat(path) {
      try {
        const info = await stat(path)
        return { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino }
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "ENOENT") return null
        throw error
      }
    },
    readFile: (path) => readFile(path, "utf8"),
    async readTail(path, maxBytes) {
      let handle
      try {
        handle = await open(path, "r")
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "ENOENT") return null
        throw error
      }
      try {
        const { size } = await handle.stat()
        const length = Math.min(size, maxBytes)
        const buffer = Buffer.alloc(length)
        let read = 0
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read)
          if (bytesRead === 0) break
          read += bytesRead
        }
        return { text: buffer.subarray(0, read).toString("utf8"), truncated: size > maxBytes }
      } finally {
        await handle.close()
      }
    },
    async appendFile(path, data) {
      await mkdir(dirOf(path), { recursive: true, mode: 0o700 })
      await appendFile(path, data, { mode: 0o600 })
    },
    async writeFileAtomic(path, data) {
      const dir = dirOf(path)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temporary = join(dir, `.${randomBytes(8).toString("hex")}.tmp`)
      try {
        await writeFile(temporary, data, { flag: "wx", mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    },
  }
}

export function defaultHome(): string {
  return osHomedir()
}

// ---------------------------------------------------------------------------------------------------------------
// Store reader

export interface StoreSnapshot {
  readonly state: GuardStoreState
  /** Effective store: the last good store, or the empty store when none was ever read. */
  readonly store: GuardStore
  readonly revision: number | null
  /** True when no good store was ever read and the file exists but cannot be used. Mutating actions fail closed. */
  readonly failClosed: boolean
  /** Increases at every change of the effective store or state. */
  readonly version: number
}

export interface StoreReader {
  /** Re-reads the file when its signature changed. Never rejects. */
  refresh(): Promise<StoreSnapshot>
  current(): StoreSnapshot
}

export function createStoreReader(input: { readonly fs: GuardFs; readonly path: string }): StoreReader {
  let lastGood: GuardStore | null = null
  let signature: string | null = null
  let snapshot: StoreSnapshot = { state: "missing", store: emptyGuardStore(), revision: null, failClosed: false, version: 0 }
  let inFlight: Promise<StoreSnapshot> | undefined
  let initial = true
  // The first read of a store failed and no good store exists. Stays set until a valid store is read, so a
  // temporary absence during a repair does not open the guards.
  let failedStart = false

  const publish = (state: GuardStoreState, failClosed: boolean) => {
    const store = lastGood ?? emptyGuardStore()
    const revision = lastGood ? lastGood.revision : null
    if (!initial && snapshot.state === state && snapshot.store === store && snapshot.failClosed === failClosed) return
    initial = false
    snapshot = { state, store, revision, failClosed, version: snapshot.version + 1 }
  }

  const run = async (): Promise<StoreSnapshot> => {
    let info: FileSignature | null
    try {
      info = await input.fs.stat(input.path)
    } catch {
      if (lastGood === null) failedStart = true
      publish("unavailable", lastGood === null)
      signature = null
      return snapshot
    }
    if (info === null) {
      // Missing at first read means no guards. A file that disappears after a good read keeps the last good store:
      // the service never releases a guard by deleting the file, only by writing a valid store.
      signature = null
      publish("missing", lastGood === null && failedStart)
      return snapshot
    }
    const next = `${info.mtimeMs}:${info.size}:${info.ino}`
    if (next === signature && !initial) return snapshot
    if (info.size > LIMITS.storeBytes) {
      signature = next
      if (lastGood === null) failedStart = true
      publish("invalid", lastGood === null)
      return snapshot
    }
    let source: string
    try {
      source = await input.fs.readFile(input.path)
    } catch {
      signature = null // Retry at the next refresh.
      if (lastGood === null) failedStart = true
      publish("unavailable", lastGood === null)
      return snapshot
    }
    signature = next
    const parsed = parseGuardStoreText(source)
    if (parsed.ok) {
      lastGood = parsed.value
      failedStart = false
      publish("ready", false)
    } else {
      if (lastGood === null) failedStart = true
      publish("invalid", lastGood === null)
    }
    return snapshot
  }

  return {
    refresh() {
      inFlight ??= run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    current: () => snapshot,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle reader

export interface LifecycleSnapshot {
  readonly reading: LifecycleReading
  /** Increases at every change of the reading. */
  readonly version: number
}

export interface LifecycleReader {
  /** Re-reads the log tail when its signature changed. Never rejects. */
  refresh(): Promise<LifecycleSnapshot>
}

/**
 * Reads the shared lifecycle log. A missing file is an empty reading. A stat or read failure is an unreadable reading:
 * no facts, so nothing is released.
 */
export function createLifecycleReader(input: { readonly fs: GuardFs; readonly path: string }): LifecycleReader {
  let signature: string | null = null
  let snapshot: LifecycleSnapshot = { reading: EMPTY_READING, version: 0 }
  let inFlight: Promise<LifecycleSnapshot> | undefined

  const publish = (reading: LifecycleReading) => {
    snapshot = { reading, version: snapshot.version + 1 }
  }

  const run = async (): Promise<LifecycleSnapshot> => {
    let info: FileSignature | null
    try {
      info = await input.fs.stat(input.path)
    } catch {
      signature = null
      if (snapshot.reading !== UNREADABLE_READING) publish(UNREADABLE_READING)
      return snapshot
    }
    if (info === null) {
      signature = null
      if (snapshot.reading !== EMPTY_READING) publish(EMPTY_READING)
      return snapshot
    }
    const next = `${info.mtimeMs}:${info.size}:${info.ino}`
    if (next === signature) return snapshot
    try {
      const tail = await input.fs.readTail(input.path, LIFECYCLE_TAIL_BYTES)
      signature = next
      publish(tail === null ? EMPTY_READING : parseLifecycleText(tail.text, tail.truncated))
    } catch {
      signature = null // Retry at the next refresh.
      if (snapshot.reading !== UNREADABLE_READING) publish(UNREADABLE_READING)
    }
    return snapshot
  }

  return {
    refresh() {
      inFlight ??= run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}
