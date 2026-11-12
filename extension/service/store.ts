/**
 * Single-writer JSON store with a per-operation cross-process lock.
 *
 * Every mutation takes the lock, reads the latest document, applies the operation, and writes through a
 * temp file (fsync), a rename, and a directory fsync. No caller writes a whole document it read earlier.
 * Reads take no lock: the rename makes each read see one complete document.
 */
import { join } from "node:path"
import { ApiError, type Activation, type Guard, type GuardStoreDocument, type OperationRecord, type SchemaPort } from "./contract.ts"
import { withLock, type HeldLock } from "./lock.ts"
import type { Runtime } from "./ports.ts"


export interface StoreOptions {
  readonly runtime: Runtime
  readonly schema: SchemaPort
  /** Root directory, for example `~/.td-opencode-plugin`. */
  readonly root: string
  readonly lockTimeoutMs?: number
}

export type EndedResolver = (activations: readonly Activation[]) => Promise<ReadonlySet<string>>

export interface Draft {
  guards: Guard[]
  activations: Activation[]
  /** Set by the operation when it changed anything. */
  changed: boolean
}

export interface OperationContext {
  readonly now: Date
  readonly revision: number
}

export interface OperationOutcome<T> {
  readonly result: T
}

export interface TransactionInput<T extends object> {
  readonly opId: string
  /** Stable text for the request body, to detect an `opId` reused for another request. */
  readonly fingerprint: string
  readonly expectedRevision?: number
  readonly apply: (draft: Draft, context: OperationContext) => T
  /** Compact form of the result that the store keeps for retries. Default: the result. */
  readonly record?: (result: T) => unknown
  /** Rebuild the result of a retry from the stored form and the latest document. Default: the stored form. */
  readonly replay?: (stored: unknown, doc: GuardStoreDocument) => T
}

export interface TransactionResult<T> {
  readonly revision: number
  readonly result: T
  readonly replayed: boolean
}

interface StoredOutcome {
  readonly fingerprint: string
  readonly data: unknown
}

function isStoredOutcome(value: unknown): value is StoredOutcome {
  return typeof value === "object" && value !== null && typeof (value as StoredOutcome).fingerprint === "string"
}

export interface RecoverResult {
  readonly recovered: true
  /** Base name of the private backup, inside the guards directory. */
  readonly backup: string
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

/** The numeric revision of a corrupt store, when its text is JSON with one. Nothing else is read. */
function rawRevision(text: string): number | null {
  try {
    const value = (JSON.parse(text) as { revision?: unknown } | null)?.revision
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

export class Store {
  private readonly runtime: Runtime
  private readonly schema: SchemaPort
  private readonly root: string
  private readonly lockTimeoutMs: number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: StoreOptions) {
    this.runtime = options.runtime
    this.schema = options.schema
    this.root = options.root
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000
  }

  get dir(): string {
    return this.schema.guardsDir(this.root)
  }

  private get storePath(): string {
    return this.schema.storePath(this.root)
  }

  private get lockPath(): string {
    return join(this.dir, "store.lock")
  }

  /** Latest committed document. A missing file is an empty store. Never creates files. */
  async read(): Promise<GuardStoreDocument> {
    let text: string | null
    try {
      text = await this.runtime.fs.readText(this.storePath)
    } catch {
      throw new ApiError("STORE_UNAVAILABLE")
    }
    if (text === null) return this.schema.emptyStore()
    const parsed = this.schema.parseStoreText(text)
    if (!parsed.ok) throw new ApiError("STORE_CORRUPT")
    return parsed.value
  }

  /**
   * Apply one idempotent operation under the lock. `ended` receives the stored activations and returns the
   * ids that proven lifecycle facts mark as ended; they are removed here, together with expired activations.
   */
  transact<T extends object>(
    input: TransactionInput<T>,
    ended: EndedResolver,
  ): Promise<TransactionResult<T>> {
    // One mutation at a time inside this process; the file lock orders the processes.
    const run = this.queue.then(async () => {
      try {
        return await this.transactLocked(input, ended)
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError("STORE_UNAVAILABLE")
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async transactLocked<T extends object>(
    input: TransactionInput<T>,
    ended: EndedResolver,
  ): Promise<TransactionResult<T>> {
    const { runtime } = this
    try {
      await runtime.fs.mkdirp(this.dir, 0o700)
    } catch {
      throw new ApiError("STORE_UNAVAILABLE")
    }
    return withLock({ runtime, path: this.lockPath, timeoutMs: this.lockTimeoutMs }, async (lock) => {
      await this.sweepGarbage()
      const doc = await this.read()
      const replay = (doc.operations ?? []).find((op) => op.opId === input.opId)
      if (replay) {
        if (!isStoredOutcome(replay.result) || replay.result.fingerprint !== input.fingerprint) {
          throw new ApiError("OP_ID_REUSED")
        }
        const result = input.replay ? input.replay(replay.result.data, doc) : (replay.result.data as T)
        return { revision: doc.revision, result, replayed: true }
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== doc.revision) {
        throw new ApiError("STALE_REVISION")
      }
      const now = new Date(runtime.now())
      const draft: Draft = { guards: [...doc.guards], activations: [...doc.activations], changed: false }
      const pruned = this.prune(draft, now, await ended(draft.activations))
      const result = input.apply(draft, { now, revision: doc.revision })
      if (!draft.changed && !pruned) return { revision: doc.revision, result, replayed: false }
      const stored: OperationRecord = {
        opId: input.opId,
        result: { fingerprint: input.fingerprint, data: input.record ? input.record(result) : result } satisfies StoredOutcome,
      }
      let operations = [...(doc.operations ?? []), stored].slice(-this.schema.maxOperations)
      const build = (): GuardStoreDocument => ({
        schema: "td-guards/1",
        revision: doc.revision + 1,
        guards: draft.guards,
        activations: draft.activations,
        operations,
      })
      let next = build()
      // Keep the file inside its bound by dropping the oldest retry records first.
      while (Buffer.byteLength(JSON.stringify(next, null, 2), "utf8") > this.schema.maxStoreBytes && operations.length > 1) {
        operations = operations.slice(Math.ceil(operations.length / 2))
        next = build()
      }
      if (Buffer.byteLength(JSON.stringify(next, null, 2), "utf8") > this.schema.maxStoreBytes) {
        throw new ApiError("LIMIT_REACHED")
      }
      if (!this.schema.parseStore(next).ok) throw new ApiError("INTERNAL_ERROR")
      await this.write(next, doc.revision, lock)
      return { revision: next.revision, result, replayed: false }
    })
  }

  /** Remove expired activations and activations that proven lifecycle facts name as ended. */
  private prune(draft: Draft, now: Date, ended: ReadonlySet<string>): boolean {
    const before = draft.activations.length
    draft.activations = draft.activations.filter((activation) => {
      if (ended.has(activation.id)) return false
      return activation.expiresAt === null || Date.parse(activation.expiresAt) > now.getTime()
    })
    return draft.activations.length !== before
  }

  /** Under the lock nobody else writes, so every temp or dead-lock leftover is garbage. */
  private async sweepGarbage(): Promise<void> {
    const { fs } = this.runtime
    let names: string[]
    try {
      names = await fs.list(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const stale =
        name.startsWith("store.json.tmp-") ||
        name.startsWith("store.lock.new-") ||
        name.startsWith("store.lock.dead-")
      if (!stale) continue
      const path = join(this.dir, name)
      if (name.startsWith("store.json.tmp-") || !this.stagingIsLive(name)) await fs.removeFile(path).catch(() => undefined)
    }
  }

  /** A `store.lock.new-<pid>-<token>` file may belong to a process that is about to rename it. */
  private stagingIsLive(name: string): boolean {
    const match = /^store\.lock\.(?:new|dead)-(\d+)-/.exec(name)
    const pid = match ? Number(match[1]) : NaN
    return Number.isInteger(pid) && this.runtime.proc.isAlive(pid)
  }

  private async write(next: GuardStoreDocument, baseRevision: number, lock: HeldLock): Promise<void> {
    const { fs } = this.runtime
    const tmp = join(this.dir, `store.json.tmp-${this.runtime.proc.pid}-${this.runtime.token()}`)
    let committed = false
    try {
      await fs.writeNew(tmp, `${JSON.stringify(next, null, 2)}\n`, 0o600)
      // Fence: the lock is still ours and no one moved the revision under us.
      await lock.assertHeld()
      const current = await this.read()
      if (current.revision !== baseRevision) throw new ApiError("LOCK_LOST")
      await fs.rename(tmp, this.storePath)
      committed = true
      await fs.syncDir(this.dir)
    } catch (error) {
      await fs.removeFile(tmp).catch(() => undefined)
      // After the rename the new file is in place. Do not call that a failure, and do not roll it back.
      if (committed) throw new ApiError("OUTCOME_UNKNOWN")
      if (error instanceof ApiError) throw error
      throw new ApiError("STORE_UNAVAILABLE")
    }
  }

  /**
   * Replace a corrupt or unreadable store with a valid empty one, under the same lock as every mutation.
   *
   * A readable store is never reset: an unknown `opId` on a valid store is `RECOVERY_NOT_NEEDED`, and a known
   * `opId` replays its outcome. The old file is kept as `store.corrupt-<UTC stamp>-<nonce>.json` (mode 600).
   * It is hard-linked before the new store is renamed over `store.json`, so the store path never disappears and
   * a failed write leaves the original file as it was. The new revision exceeds the old raw revision (when one
   * can be read) and the current epoch seconds, so a runtime report with an older revision never matches it.
   */
  recover(input: { opId: string; fingerprint: string }): Promise<TransactionResult<RecoverResult>> {
    const run = this.queue.then(async () => {
      try {
        return await this.recoverLocked(input)
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError("STORE_UNAVAILABLE")
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async recoverLocked(input: { opId: string; fingerprint: string }): Promise<TransactionResult<RecoverResult>> {
    const { runtime } = this
    try {
      await runtime.fs.mkdirp(this.dir, 0o700)
    } catch {
      throw new ApiError("STORE_UNAVAILABLE")
    }
    return withLock({ runtime, path: this.lockPath, timeoutMs: this.lockTimeoutMs }, async (lock) => {
      await this.sweepGarbage()
      let text: string | null = null
      let unreadable = false
      try {
        text = await runtime.fs.readText(this.storePath)
      } catch {
        unreadable = true
      }
      if (!unreadable) {
        // A missing file is an empty store, not corruption.
        if (text === null) throw new ApiError("RECOVERY_NOT_NEEDED")
        const parsed = this.schema.parseStoreText(text)
        if (parsed.ok) {
          const replay = (parsed.value.operations ?? []).find((op) => op.opId === input.opId)
          if (!replay) throw new ApiError("RECOVERY_NOT_NEEDED")
          if (!isStoredOutcome(replay.result) || replay.result.fingerprint !== input.fingerprint) {
            throw new ApiError("OP_ID_REUSED")
          }
          return { revision: parsed.value.revision, result: replay.result.data as RecoverResult, replayed: true }
        }
      }
      const known = text === null ? null : rawRevision(text)
      const epochSeconds = Math.floor(runtime.now() / 1000)
      const revision = Math.max(known === null ? 0 : known + 1, epochSeconds)
      const backup = `store.corrupt-${utcStamp(runtime.now())}-${runtime.token()}.json`
      const result: RecoverResult = { recovered: true, backup }
      const next: GuardStoreDocument = {
        schema: "td-guards/1",
        revision,
        guards: [],
        activations: [],
        operations: [{ opId: input.opId, result: { fingerprint: input.fingerprint, data: result } satisfies StoredOutcome }],
      }
      if (!this.schema.parseStore(next).ok) throw new ApiError("INTERNAL_ERROR")
      await this.replaceCorrupt(next, backup, lock)
      return { revision, result, replayed: false }
    })
  }

  private async replaceCorrupt(next: GuardStoreDocument, backup: string, lock: HeldLock): Promise<void> {
    const { fs } = this.runtime
    const tmp = join(this.dir, `store.json.tmp-${this.runtime.proc.pid}-${this.runtime.token()}`)
    const backupPath = join(this.dir, backup)
    let linked = false
    let committed = false
    try {
      await fs.writeNew(tmp, `${JSON.stringify(next, null, 2)}\n`, 0o600)
      await fs.link(this.storePath, backupPath)
      linked = true
      await fs.chmod(backupPath, 0o600)
      await lock.assertHeld()
      await fs.rename(tmp, this.storePath)
      committed = true
      await fs.syncDir(this.dir)
    } catch (error) {
      await fs.removeFile(tmp).catch(() => undefined)
      // After the rename the new store and the backup stay; the outcome is unknown, not failed.
      if (committed) throw new ApiError("OUTCOME_UNKNOWN")
      // Before the rename the original file is untouched; drop the extra link so no backup is left behind.
      if (linked) await fs.removeFile(backupPath).catch(() => undefined)
      if (error instanceof ApiError) throw error
      throw new ApiError("STORE_UNAVAILABLE")
    }
  }
}
