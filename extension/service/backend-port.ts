/**
 * Binds `SchemaPort` to the backend module `src/guards/schema.ts`. The service reuses its validators.
 *
 * Path layout (shared with the backend writer), all under `<root>/guards/`:
 *   store.json                        intent, written only by this service
 *   lifecycle.jsonl                   lifecycle facts, appended by the backend
 *   runtime/<sha256(directory)>.json  runtime snapshot per location directory
 *   runtime/global.json               snapshot without a directory
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  LIMITS,
  emptyGuardStore,
  parseGuardStore,
  parseGuardStoreText,
  parseRuntimeReport,
  validateGuardDraft,
} from "../../src/guards/schema.ts"
import type { SchemaPort } from "./contract.ts"

const guardsDir = (root: string): string => join(root, "guards")

export const backendSchema: SchemaPort = {
  parseDraft: validateGuardDraft,
  parseStoreText: parseGuardStoreText,
  parseStore: parseGuardStore,
  parseRuntime: parseRuntimeReport,
  emptyStore: emptyGuardStore,
  maxStoreBytes: LIMITS.storeBytes,
  maxGuards: LIMITS.guards,
  maxActivations: LIMITS.activations,
  maxOperations: LIMITS.operations,
  guardsDir,
  storePath: (root) => join(guardsDir(root), "store.json"),
  lifecyclePath: (root) => join(guardsDir(root), "lifecycle.jsonl"),
  runtimePath: (root, directory) =>
    join(
      guardsDir(root),
      "runtime",
      directory === null ? "global.json" : `${createHash("sha256").update(directory, "utf8").digest("hex")}.json`,
    ),
}
