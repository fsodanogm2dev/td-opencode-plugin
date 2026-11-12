/**
 * Types shared inside the guard service, and the seam to the backend schema.
 *
 * The backend owns validation (`src/guards/schema.ts`). The service only reaches it
 * through `SchemaPort`, so no looser copy of the validation lives here.
 */

import type {
  Activation,
  ActivationScope,
  Guard,
  GuardDraft,
  GuardRuntimeReport,
  GuardOperation as OperationRecord,
  GuardStore as GuardStoreDocument,
  LifecycleFact,
  ParseResult,
} from "../../src/guards/schema.ts"

export type { Activation, ActivationScope, Guard, GuardDraft, GuardRuntimeReport, GuardStoreDocument, LifecycleFact, OperationRecord }

/** What the service needs from `src/guards/schema.ts` and the backend path layout. `backend-port.ts` binds it. */
export interface SchemaPort {
  /** Strict draft validation. */
  parseDraft(input: unknown): ParseResult<GuardDraft>
  /** Strict store validation, including the size bound. */
  parseStoreText(text: string): ParseResult<GuardStoreDocument>
  /** Strict validation of an in-memory document. */
  parseStore(input: unknown): ParseResult<GuardStoreDocument>
  parseRuntime(input: unknown): ParseResult<GuardRuntimeReport>
  emptyStore(): GuardStoreDocument
  readonly maxStoreBytes: number
  readonly maxGuards: number
  readonly maxActivations: number
  readonly maxOperations: number
  /** Directory that holds the guard files, for example `~/.td-opencode-plugin/guards`. */
  guardsDir(root: string): string
  storePath(root: string): string
  lifecyclePath(root: string): string
  /** `directory === null` selects the global snapshot. */
  runtimePath(root: string, directory: string | null): string
}

export type ErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INVALID_DRAFT"
  | "SESSION_NOT_FOUND"
  | "STALE_REVISION"
  | "OP_ID_REUSED"
  | "GUARD_NOT_FOUND"
  | "LIMIT_REACHED"
  | "LOCK_TIMEOUT"
  | "LOCK_LOST"
  | "STORE_CORRUPT"
  | "CONFIRMATION_REQUIRED"
  | "RECOVERY_NOT_NEEDED"
  | "STORE_UNAVAILABLE"
  | "OUTCOME_UNKNOWN"
  | "SESSION_BRIDGE_UNAVAILABLE"
  | "SESSION_LOOKUP_FAILED"
  | "INTERNAL_ERROR"

const MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "The request has no valid service token.",
  NOT_FOUND: "No such route.",
  METHOD_NOT_ALLOWED: "This route does not accept that method.",
  PAYLOAD_TOO_LARGE: "The request body is larger than 64 KiB.",
  INVALID_JSON: "The request body is not valid JSON.",
  INVALID_REQUEST: "The request is not valid.",
  INVALID_DRAFT: "The guard draft is not valid.",
  SESSION_NOT_FOUND: "OpenCode has no session with that id.",
  STALE_REVISION: "The guards changed since this view loaded. Reload and try again.",
  OP_ID_REUSED: "This operation id was already used for a different request.",
  GUARD_NOT_FOUND: "The guard does not exist.",
  LIMIT_REACHED: "The store reached its size limit. Delete a guard or release an activation first.",
  LOCK_TIMEOUT: "Another process holds the guard store. Try again in a moment.",
  LOCK_LOST: "The guard store lock was lost during the write. Nothing was saved.",
  STORE_CORRUPT: "The guard store file is not valid. The service did not change it.",
  CONFIRMATION_REQUIRED:
    "Resetting replaces the guard store for all projects: every saved guard and activation is removed, and the old file is kept as a private backup. Send the confirmation to continue.",
  RECOVERY_NOT_NEEDED: "The guard store is readable, so nothing was reset.",
  STORE_UNAVAILABLE: "The guard store cannot be read or written.",
  OUTCOME_UNKNOWN: "The change may already be applied. Reload the guard data or retry the same request.",
  SESSION_BRIDGE_UNAVAILABLE: "OpenCode access is unavailable, so the session cannot be verified.",
  SESSION_LOOKUP_FAILED: "OpenCode did not answer the session lookup.",
  INTERNAL_ERROR: "The guard service failed unexpectedly.",
}

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_JSON: 400,
  INVALID_REQUEST: 400,
  INVALID_DRAFT: 400,
  SESSION_NOT_FOUND: 400,
  STALE_REVISION: 409,
  OP_ID_REUSED: 409,
  GUARD_NOT_FOUND: 409,
  LIMIT_REACHED: 409,
  LOCK_TIMEOUT: 503,
  LOCK_LOST: 503,
  CONFIRMATION_REQUIRED: 400,
  RECOVERY_NOT_NEEDED: 409,
  STORE_CORRUPT: 503,
  STORE_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 503,
  SESSION_BRIDGE_UNAVAILABLE: 503,
  SESSION_LOOKUP_FAILED: 503,
  INTERNAL_ERROR: 503,
}

/** An error with a fixed code, status, and safe message. */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  constructor(code: ErrorCode) {
    super(MESSAGES[code])
    this.name = "ApiError"
    this.code = code
    this.status = STATUS[code]
  }
}
