import { randomBytes } from "node:crypto"
import { constants as fsConstants, type Stats } from "node:fs"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

export const BATCH_ARTIFACT_NAMES = [
  "requests.json",
  "results.jsonl",
  "successes.jsonl",
  "failures.jsonl",
  "manifest.json",
] as const

export type BatchArtifactName = (typeof BATCH_ARTIFACT_NAMES)[number]

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** Error raised for unsafe paths or unsafe file system state. Messages never contain artifact content. */
export class BatchArtifactError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "BatchArtifactError"
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
}

function ownerMatches(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid()
}

/**
 * Private, root-configured storage for batch job files. Each job has its own directory (0700) holding
 * allowlisted files (0600). Writes are atomic: a private temporary file in the job directory is renamed
 * over the target. Symlinks and non-regular files are rejected, never followed.
 */
export class BatchArtifacts {
  readonly root: string

  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0 || root.includes("\0") || !isAbsolute(root)) {
      throw new BatchArtifactError("Artifact root must be an absolute path.")
    }
    this.root = resolve(root)
  }

  /** Ensure the job directory exists and return the absolute path of an allowlisted artifact. */
  async path(jobID: string, name: string): Promise<string> {
    const { file } = await this.locate(jobID, name)
    await this.assertTargetSafe(file)
    return file
  }

  async write(jobID: string, name: string, content: string | Uint8Array): Promise<string> {
    const { dir, file } = await this.locate(jobID, name)
    await this.assertTargetSafe(file)
    const temp = join(dir, `.tmp-${randomBytes(12).toString("hex")}`)
    let created = false
    try {
      const handle = await open(
        temp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        FILE_MODE,
      )
      created = true
      try {
        await handle.writeFile(content)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // Re-check just before the rename: the target must still be absent or a regular file.
      await this.assertTargetSafe(file)
      await this.assertDirSafe(dir)
      await rename(temp, file)
      created = false
    } catch (error) {
      if (created) await unlink(temp).catch(() => undefined)
      if (error instanceof BatchArtifactError) throw error
      throw new BatchArtifactError(`Failed to write artifact ${name} for job ${jobID}.`, { cause: error })
    }
    return file
  }

  async read(jobID: string, name: string): Promise<string> {
    const { file } = await this.locate(jobID, name)
    // Reject FIFOs, devices, and symlinks before `open`: opening a FIFO can block. `O_NONBLOCK` covers the
    // race where the target changes after this check; the `fstat` below rejects anything that is not a file.
    await this.assertTargetSafe(file)
    let handle
    try {
      handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    } catch (error) {
      if (isNodeError(error, "ELOOP")) throw new BatchArtifactError(`Artifact ${name} is a symlink.`, { cause: error })
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new BatchArtifactError(`Artifact ${name} is not a regular file.`)
      return await handle.readFile({ encoding: "utf8" })
    } finally {
      await handle.close()
    }
  }

  /** Delete one artifact. A missing artifact is not an error. */
  async remove(jobID: string, name: string): Promise<void> {
    const { file } = await this.locate(jobID, name)
    const stat = await this.lstatOrUndefined(file)
    if (!stat) return
    if (!stat.isFile()) throw new BatchArtifactError(`Artifact ${name} is not a regular file.`)
    try {
      await unlink(file)
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error
    }
  }

  private async locate(jobID: string, name: string): Promise<{ dir: string; file: string }> {
    if (typeof jobID !== "string" || !JOB_ID_PATTERN.test(jobID)) {
      throw new BatchArtifactError("Invalid batch job ID.")
    }
    if (!(BATCH_ARTIFACT_NAMES as readonly string[]).includes(name)) {
      throw new BatchArtifactError("Invalid batch artifact name.")
    }
    await this.ensureDir(dirname(this.root), true)
    await this.ensureDir(this.root, false)
    const dir = join(this.root, jobID)
    await this.ensureDir(dir, false)
    return { dir, file: join(dir, name) }
  }

  private async lstatOrUndefined(path: string): Promise<Stats | undefined> {
    try {
      return await lstat(path)
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined
      throw error
    }
  }

  private async assertDirSafe(dir: string): Promise<void> {
    const stat = await lstat(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BatchArtifactError("Artifact directory is a symlink or not a directory.")
    }
    if (!ownerMatches(stat)) throw new BatchArtifactError("Artifact directory has an unexpected owner.")
    if ((stat.mode & 0o077) !== 0) throw new BatchArtifactError("Artifact directory is accessible by other users.")
  }

  /**
   * Create `dir` with mode 0700 when missing, otherwise require it to be an own, private, real directory.
   * With `parentOnly`, the directory may be any existing directory or symlink to one (ancestors of the
   * root are the caller's choice); missing ones are created recursively.
   */
  private async ensureDir(dir: string, parentOnly: boolean): Promise<void> {
    if (parentOnly) {
      const stat = await this.lstatOrUndefined(dir)
      if (!stat) await mkdir(dir, { recursive: true, mode: DIR_MODE })
      return
    }
    const existing = await this.lstatOrUndefined(dir)
    if (!existing) {
      try {
        await mkdir(dir, { mode: DIR_MODE })
        // Only a directory this call created is chmod-ed; the umask may have narrowed or widened the mode.
        const created = await lstat(dir)
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new BatchArtifactError("Artifact directory is a symlink or not a directory.")
        }
        await chmod(dir, DIR_MODE)
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
      }
    }
    await this.assertDirSafe(dir)
  }

  private async assertTargetSafe(file: string): Promise<void> {
    const stat = await this.lstatOrUndefined(file)
    if (!stat) return
    if (stat.isSymbolicLink()) throw new BatchArtifactError("Artifact target is a symlink.")
    if (!stat.isFile()) throw new BatchArtifactError("Artifact target is not a regular file.")
  }
}
