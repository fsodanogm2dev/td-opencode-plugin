import { createHash } from "node:crypto"
import { homedir as osHomedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../../log.ts"
import { BatchArtifacts } from "./artifacts.ts"
import type { BatchRateCard } from "./pricing.ts"
import { registerBatchCommand } from "./command.ts"
import { SAFE_ERROR_NAMES, sanitizeMessage } from "./safe-error.ts"

/** Service surface the tools call. `BatchService` in `service.ts` implements it. Each method returns a bounded JSON summary. */
export interface BatchToolService {
  submit(sessionID: string, inputPath: string, signal?: AbortSignal, options?: { allowDuplicate?: boolean }): Promise<unknown>
  list(sessionID: string, options?: { limit?: number; after?: string }): Promise<unknown>
  inspect(sessionID: string, jobID: string, options?: { limit?: number; after?: string }): Promise<unknown>
  status(sessionID: string, jobID: string, signal?: AbortSignal): Promise<unknown>
  cancel(sessionID: string, jobID: string, signal?: AbortSignal): Promise<unknown>
  collect(sessionID: string, jobID: string, signal?: AbortSignal): Promise<unknown>
  /** Inline submission for `/fuelix-batch`. A replacement service without it makes the command report an error. */
  submitRequests?(sessionID: string, requests: readonly unknown[], source: string, signal?: AbortSignal): Promise<{ jobID: string; batchID?: string; submission: string }>
}

export interface BatchToolsInput {
  readonly baseURL: string
  readonly log: Logger
  /** Resolves the current key candidates. Called per HTTP request, so a rotated or newly connected key takes effect. */
  readonly resolveKeys: () => Promise<{
    readonly key?: string | undefined
    readonly keychainKey?: string | undefined
    readonly credentialStoreKey?: string | undefined
    readonly envKey?: string | undefined
  }>
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
  readonly now?: () => Date
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  /** Verified batch rates for cost estimates. Without them the cost is reported as unavailable. */
  readonly rates?: BatchRateCard
}

/** Test and embedding overrides. */
export interface BatchToolsDeps {
  /** Replaces the default service. */
  readonly service?: BatchToolService
  /** Replaces the default artifact root. Must be absolute. */
  readonly artifactRoot?: string
  readonly homedir?: () => string
}

export const BATCH_TOOL_NAMES = [
  "fuelix_batch_submit",
  "fuelix_batch_list",
  "fuelix_batch_inspect",
  "fuelix_batch_status",
  "fuelix_batch_cancel",
  "fuelix_batch_collect",
] as const

export type BatchToolName = (typeof BATCH_TOOL_NAMES)[number]

/** A tool result larger than this many characters is replaced by a short notice. */
export const MAX_TOOL_OUTPUT_CHARS = 64_000
export const MAX_LIST_LIMIT = 100
const MAX_ID_CHARS = 256
const MAX_CURSOR_CHARS = 1024
const MAX_PATH_CHARS = 4096
/** Upper bound of remembered key candidates. The oldest are forgotten first. */
const MAX_SEEN_KEYS = 256

/** Artifact root outside the repository: `<XDG_DATA_HOME or ~/.local/share>/td-opencode-plugin/batches/<hash of directory>`. */
export function defaultBatchArtifactRoot(
  directory: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = osHomedir,
): string {
  const xdg = env.XDG_DATA_HOME
  const dataHome = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share")
  const hash = createHash("sha256").update(directory).digest("hex").slice(0, 32)
  return join(dataHome, "td-opencode-plugin", "batches", hash)
}

const ID_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ID_CHARS,
  description: "Local job ID or remote batch ID, as returned by fuelix_batch_submit or fuelix_batch_list.",
} as const

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: MAX_LIST_LIMIT,
  description: `Maximum number of entries to return (1-${MAX_LIST_LIMIT}).`,
} as const

const AFTER_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: MAX_CURSOR_CHARS,
  description: "Cursor from the previous result's next field, to read the next page.",
} as const

const HISTORY_NOTE =
  "History is scoped to the session that submitted the batch; other sessions cannot see or change it."

interface ToolSpec {
  readonly name: BatchToolName
  readonly description: string
  readonly properties: Record<string, unknown>
  readonly required: readonly string[]
}

const SPECS: readonly ToolSpec[] = [
  {
    name: "fuelix_batch_submit",
    description:
      "Submit a FueliX message batch from a local request file. The user's request to submit is the authorization, so no extra confirmation is needed. " +
      "Reads the file at input_path (absolute, or relative to the project directory), sends it once, and returns promptly with a job summary and batch ID. " +
      "Submission is never retried automatically. If the outcome is uncertain, the job is kept for reconciliation and may still be billed. " +
      "Set allow_duplicate to true only when the user explicitly asks to repeat identical work despite an unresolved prior attempt; this may create another paid batch. " +
      "Requests and results stay in protected local files; the output shows summaries and file paths only. " +
      HISTORY_NOTE,
    properties: {
      input_path: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PATH_CHARS,
        description: "Path of the batch request file, absolute or relative to the project directory.",
      },
      allow_duplicate: {
        type: "boolean",
        description:
          "Set to true only when the user explicitly asks to repeat identical work despite an unresolved prior attempt. This may create another paid batch. Defaults to false.",
      },
    },
    required: ["input_path"],
  },
  {
    name: "fuelix_batch_list",
    description:
      "List the FueliX batches submitted from this session, newest first, from local history. It makes no network call. " +
      "Use fuelix_batch_status to refresh one batch from the gateway. " +
      HISTORY_NOTE,
    properties: { limit: LIMIT_PROPERTY, after: AFTER_PROPERTY },
    required: [],
  },
  {
    name: "fuelix_batch_inspect",
    description:
      "Show the locally recorded details of one batch from this session: requested work, last known processing counts, timing, collection state, cost, and artifact paths. " +
      "It makes no network call and does not print request or result content. " +
      HISTORY_NOTE,
    properties: { batch_id: ID_PROPERTY, limit: LIMIT_PROPERTY, after: AFTER_PROPERTY },
    required: ["batch_id"],
  },
  {
    name: "fuelix_batch_status",
    description:
      "Check one batch on the gateway now and update its local record with processing counts and elapsed time. " +
      "Status is read on demand; nothing polls in the background. " +
      HISTORY_NOTE,
    properties: { batch_id: ID_PROPERTY },
    required: ["batch_id"],
  },
  {
    name: "fuelix_batch_cancel",
    description:
      "Ask the gateway to cancel one batch. This is a cancellation request. Requests that already finished or are in flight may still complete and be billed, " +
      "so cancellation is not guaranteed to be complete. Check the result with fuelix_batch_status. " +
      HISTORY_NOTE,
    properties: { batch_id: ID_PROPERTY },
    required: ["batch_id"],
  },
  {
    name: "fuelix_batch_collect",
    description:
      "Download the results of an ended batch into protected local files, matched by custom_id, with failures kept separate. " +
      "Collection runs on demand. The output shows counts, cost status, and absolute file paths, not the result content. " +
      HISTORY_NOTE,
    properties: { batch_id: ID_PROPERTY },
    required: ["batch_id"],
  },
]

class ToolInputError extends Error {}

function textArg(input: unknown, key: string, maxChars: number, required: true): string
function textArg(input: unknown, key: string, maxChars: number, required: false): string | undefined
function textArg(input: unknown, key: string, maxChars: number, required: boolean): string | undefined {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined
  if (value === undefined || value === null) {
    if (required) throw new ToolInputError(`${key} is required.`)
    return undefined
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > maxChars || value.includes("\0")) {
    throw new ToolInputError(`${key} must be a non-empty string of at most ${maxChars} characters.`)
  }
  return value
}

function limitArg(input: unknown): number | undefined {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>).limit : undefined
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new ToolInputError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`)
  }
  return value
}

function allowDuplicateArg(input: unknown): boolean {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>).allow_duplicate : undefined
  if (value === undefined) return false
  if (typeof value !== "boolean") throw new ToolInputError("allow_duplicate must be a boolean.")
  return value
}

function pageOptions(input: unknown): { limit?: number; after?: string } {
  const limit = limitArg(input)
  const after = textArg(input, "after", MAX_CURSOR_CHARS, false)
  return { ...(limit !== undefined ? { limit } : {}), ...(after !== undefined ? { after } : {}) }
}

function sessionOf(context: { readonly sessionID?: unknown }): string {
  const id = context.sessionID
  if (typeof id !== "string" || id === "") throw new ToolInputError("The tool call has no session.")
  return id
}

function toJSON(result: unknown): string {
  let text: string
  try {
    text = JSON.stringify(result ?? null, null, 2) ?? "null"
  } catch {
    return JSON.stringify({ error: "The batch result could not be serialized." })
  }
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    return JSON.stringify({
      truncated: true,
      note: "The summary exceeded the output limit. Use limit and after to read smaller pages, or open the artifact files.",
    })
  }
  return text
}

/**
 * Registers the six `fuelix_batch_*` tools. Nothing touches the file system until a tool runs.
 * Returns the registration; dispose it on shutdown.
 */
export async function setupBatchTools(
  ctx: Plugin.Context,
  input: BatchToolsInput,
  deps: BatchToolsDeps = {},
): Promise<{ dispose: () => Promise<void> }> {
  const { log } = input
  const env = input.env ?? process.env
  let servicePromise: Promise<BatchToolService> | undefined

  // Recent key candidates for this plugin instance, in memory only. A key can rotate between the HTTP call and a
  // later content check, so redaction also covers previously resolved keys within the bounded history.
  const seenKeys = new Set<string>()
  const resolveBatchKeys = async () => {
    const keys = await input.resolveKeys()
    for (const value of [keys.keychainKey, keys.credentialStoreKey, keys.envKey, keys.key]) {
      if (typeof value !== "string" || value === "") continue
      seenKeys.delete(value)
      seenKeys.add(value)
      if (seenKeys.size > MAX_SEEN_KEYS) seenKeys.delete(seenKeys.values().next().value as string)
    }
    return keys
  }
  const collectSecrets = async (): Promise<readonly string[]> => {
    try {
      await resolveBatchKeys()
    } catch (error) {
      // A failed refresh must not discard keys already used by this plugin instance.
      if (seenKeys.size === 0) throw error
    }
    return [...seenKeys]
  }

  const getService = (): Promise<BatchToolService> => {
    if (deps.service) return Promise.resolve(deps.service)
    servicePromise ??= (async () => {
      const [{ BatchService }, { BatchClient }] = await Promise.all([import("./service.ts"), import("./client.ts")])
      const directory = ctx.location.directory
      const root = deps.artifactRoot ?? defaultBatchArtifactRoot(directory, env, deps.homedir)
      const client = new BatchClient({
        baseURL: input.baseURL,
        resolveKey: async () => (await resolveBatchKeys()).key,
        ...(input.fetch ? { fetch: input.fetch } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
      return new BatchService({
        storage: ctx.storage,
        artifacts: new BatchArtifacts(root),
        client,
        directory,
        ...(input.now ? { now: input.now } : {}),
        secrets: collectSecrets,
        ...(input.rates ? { rates: input.rates } : {}),
      }) as BatchToolService
    })()
    // A failed construction must not stay cached.
    servicePromise.catch(() => {
      servicePromise = undefined
    })
    return servicePromise
  }

  const run = async (
    name: BatchToolName,
    context: { readonly sessionID?: unknown; readonly signal?: AbortSignal },
    call: (service: BatchToolService, sessionID: string) => Promise<unknown>,
    parse: () => void = () => {},
  ) => {
    try {
      parse()
      const sessionID = sessionOf(context)
      const result = await call(await getService(), sessionID)
      return { content: toJSON(result), metadata: { tool: name } }
    } catch (error) {
      if (error instanceof ToolInputError) throw new Error(`Invalid input for ${name}. ${error.message}`)
      if (context.signal?.aborted) throw new Error(`${name} was cancelled.`)
      let secrets: readonly string[] = [...seenKeys]
      try {
        secrets = await collectSecrets()
      } catch {
        // Redaction is best effort; the message is already restricted to fixed strings.
      }
      const code = (error as { code?: unknown } | undefined)?.code
      log.warn("FueliX batch tool failed", {
        tool: name,
        errorName: error instanceof Error ? sanitizeMessage(error.name, secrets) : "unknown",
        ...(typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? { code: sanitizeMessage(code, secrets) } : {}),
      })
      if (error instanceof Error && SAFE_ERROR_NAMES.has(error.name)) {
        const ambiguous = (error as { ambiguous?: unknown }).ambiguous === true
        const message = sanitizeMessage(error.message, secrets)
        throw new Error(
          ambiguous
            ? `${message}. The submission may have reached the gateway and may be billed. It was not retried; check fuelix_batch_list.`
            : message,
        )
      }
      throw new Error(`${name} failed. The error details are not shown; check the plugin log.`)
    }
  }

  type Ctx = { readonly sessionID?: unknown; readonly signal?: AbortSignal }
  const executors: Record<BatchToolName, (args: unknown, context: Ctx) => Promise<{ content: string; metadata: object }>> = {
    fuelix_batch_submit: (args, context) => {
      let inputPath = ""
      let allowDuplicate = false
      return run(
        "fuelix_batch_submit",
        context,
        (service, sessionID) =>
          allowDuplicate
            ? service.submit(sessionID, inputPath, context.signal, { allowDuplicate: true })
            : service.submit(sessionID, inputPath, context.signal),
        () => {
          inputPath = textArg(args, "input_path", MAX_PATH_CHARS, true)
          allowDuplicate = allowDuplicateArg(args)
        },
      )
    },
    fuelix_batch_list: (args, context) => {
      let options: { limit?: number; after?: string } = {}
      return run("fuelix_batch_list", context, (service, sessionID) => service.list(sessionID, options), () => {
        options = pageOptions(args)
      })
    },
    fuelix_batch_inspect: (args, context) => {
      let batchID = ""
      let options: { limit?: number; after?: string } = {}
      return run(
        "fuelix_batch_inspect",
        context,
        (service, sessionID) => service.inspect(sessionID, batchID, options),
        () => {
          batchID = textArg(args, "batch_id", MAX_ID_CHARS, true)
          options = pageOptions(args)
        },
      )
    },
    fuelix_batch_status: (args, context) => remoteCall("fuelix_batch_status", "status", args, context),
    fuelix_batch_cancel: (args, context) => remoteCall("fuelix_batch_cancel", "cancel", args, context),
    fuelix_batch_collect: (args, context) => remoteCall("fuelix_batch_collect", "collect", args, context),
  }

  function remoteCall(name: BatchToolName, method: "status" | "cancel" | "collect", args: unknown, context: Ctx) {
    let batchID = ""
    return run(
      name,
      context,
      (service, sessionID) => service[method](sessionID, batchID, context.signal),
      () => {
        batchID = textArg(args, "batch_id", MAX_ID_CHARS, true)
      },
    )
  }

  const tools = await ctx.tool.transform((editor) => {
    for (const spec of SPECS) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: {
          type: "object",
          properties: spec.properties,
          required: [...spec.required],
          additionalProperties: false,
        },
        execute: (args: unknown, context) => executors[spec.name](args, context as Ctx),
      })
    }
  })

  let command: { dispose: () => Promise<void> } | undefined
  try {
    command = await registerBatchCommand(ctx, {
      log,
      getService,
      collectSecrets,
      seenSecrets: () => [...seenKeys],
    })
  } catch {
    // The tools keep working without the command. Error metadata is not logged: its name is arbitrary text.
    log.warn("could not register the FueliX batch command")
  }
  return {
    dispose: async () => {
      const results = await Promise.allSettled([tools.dispose(), command?.dispose()])
      const failed = results.find((result) => result.status === "rejected")
      if (failed) throw (failed as PromiseRejectedResult).reason
    },
  }
}
