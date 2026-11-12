/**
 * Cross-process lock for the single-writer guard store.
 *
 * The lock is a file with the owner record. A process writes `<lock>.new-<pid>-<token>` completely, then
 * hard-links it to `<lock>`. A link onto an existing name fails and never replaces it, and the lock never
 * exists without its complete owner record. This replaces `mkdir` plus a separate owner write, which leaves
 * a window where a crash strands an owner-less lock.
 *
 * Only an owner that is proven dead is reclaimed. Reclaim runs under a second lock, `<lock>.reclaim`, and
 * compares the owner token again before the lock moves, so a new owner is not displaced. A lock file whose
 * owner record is unreadable is never reclaimed: waiters fail with `LOCK_TIMEOUT`.
 *
 * The lock does not replace a CAS. Writers also re-check the lock owner (`assertHeld`) and the store
 * revision just before the rename.
 */
import { ApiError } from "./contract.ts"
import { errorCode, type Runtime } from "./ports.ts"

export interface LockOwner {
  readonly pid: number
  readonly token: string
  readonly startToken: string | null
  readonly acquiredAt: string
}

export interface HeldLock {
  readonly owner: LockOwner
  /** Throws `LOCK_LOST` when the lock directory no longer names this owner. */
  assertHeld(): Promise<void>
}

export interface LockOptions {
  readonly runtime: Runtime
  /** Lock directory path, for example `<guards>/store.lock`. */
  readonly path: string
  readonly timeoutMs?: number
  readonly pollMs?: number
}

function parseOwner(text: string | null): LockOwner | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      (value.startToken === null || typeof value.startToken === "string") &&
      typeof value.acquiredAt === "string"
    ) {
      return { pid: value.pid, token: value.token, startToken: value.startToken, acquiredAt: value.acquiredAt }
    }
  } catch {
    // fall through
  }
  return null
}

function isBusy(error: unknown): boolean {
  return errorCode(error) === "EEXIST"
}

/** Try to create `target` atomically with a complete owner record. */
async function tryCreate(runtime: Runtime, target: string, owner: LockOwner): Promise<boolean> {
  const staging = `${target}.new-${owner.pid}-${owner.token}`
  await runtime.fs.writeNew(staging, JSON.stringify(owner), 0o600)
  try {
    await runtime.fs.link(staging, target)
    return true
  } catch (error) {
    if (isBusy(error)) return false
    throw error
  } finally {
    await runtime.fs.removeFile(staging).catch(() => undefined)
  }
}

function ownerIsDead(runtime: Runtime, owner: LockOwner): boolean {
  if (!runtime.proc.isAlive(owner.pid)) return true
  if (owner.startToken !== null) {
    const current = runtime.proc.startToken(owner.pid)
    // Same pid, different start time: the pid was reused by another process.
    if (current !== null && current !== owner.startToken) return true
  }
  return false
}

async function readOwner(runtime: Runtime, target: string): Promise<LockOwner | null> {
  return parseOwner(await runtime.fs.readText(target))
}

async function discard(runtime: Runtime, target: string, token: string): Promise<void> {
  const grave = `${target}.dead-${token}`
  try {
    await runtime.fs.rename(target, grave)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }
  await runtime.fs.removeFile(grave).catch(() => undefined)
}

/**
 * Move a dead owner's lock out of the way. Returns `true` only when this attempt removed the lock, so the
 * caller may try to create it again at once. Any other result (another reclaimer is live, the lock changed
 * owner) is no progress: the caller waits and its deadline applies.
 */
async function reclaim(runtime: Runtime, path: string, dead: LockOwner, me: LockOwner): Promise<boolean> {
  const guardPath = `${path}.reclaim`
  const guardOwner: LockOwner = { ...me, token: runtime.token() }
  const got = await tryCreate(runtime, guardPath, guardOwner)
  if (!got) {
    // Another process reclaims, or a reclaimer died. Remove only a dead reclaimer's guard.
    const other = await readOwner(runtime, guardPath)
    if (other !== null && ownerIsDead(runtime, other)) {
      const again = await readOwner(runtime, guardPath)
      if (again !== null && again.token === other.token) await discard(runtime, guardPath, guardOwner.token)
    }
    return false
  }
  try {
    const current = await readOwner(runtime, path)
    if (current !== null && current.token === dead.token && ownerIsDead(runtime, current)) {
      await discard(runtime, path, guardOwner.token)
      return true
    }
    return false
  } finally {
    await discard(runtime, guardPath, guardOwner.token).catch(() => undefined)
  }
}

export async function acquireLock(options: LockOptions): Promise<HeldLock> {
  const { runtime, path } = options
  const timeoutMs = options.timeoutMs ?? 2000
  const pollMs = options.pollMs ?? 15
  const me: LockOwner = {
    pid: runtime.proc.pid,
    token: runtime.token(),
    startToken: runtime.proc.startToken(runtime.proc.pid),
    acquiredAt: new Date(runtime.now()).toISOString(),
  }
  const deadline = runtime.now() + timeoutMs
  for (;;) {
    if (await tryCreate(runtime, path, me)) break
    const owner = await readOwner(runtime, path)
    if (owner !== null && ownerIsDead(runtime, owner)) {
      // Progress only when the dead lock was removed. Otherwise fall through to the deadline and the wait.
      if ((await reclaim(runtime, path, owner, me)) && runtime.now() < deadline) continue
    }
    if (runtime.now() >= deadline) throw new ApiError("LOCK_TIMEOUT")
    await runtime.sleep(pollMs)
  }
  return {
    owner: me,
    async assertHeld() {
      const current = await readOwner(runtime, path)
      if (current === null || current.token !== me.token) throw new ApiError("LOCK_LOST")
    },
  }
}

export async function releaseLock(runtime: Runtime, path: string, lock: HeldLock): Promise<void> {
  const current = await readOwner(runtime, path)
  if (current === null || current.token !== lock.owner.token) return
  await discard(runtime, path, lock.owner.token)
}

export async function withLock<T>(options: LockOptions, fn: (lock: HeldLock) => Promise<T>): Promise<T> {
  const lock = await acquireLock(options)
  try {
    return await fn(lock)
  } finally {
    await releaseLock(options.runtime, options.path, lock).catch(() => undefined)
  }
}
