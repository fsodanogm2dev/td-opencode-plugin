import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../../log.ts"
import { SAFE_ERROR_NAMES, safeErrorCode, sanitizeMessage } from "./safe-error.ts"

export const BATCH_COMMAND_NAME = "fuelix-batch"
/** Raw FueliX batch alias of Haiku 5.5 (US Anthropic deployment). The generic `claude-haiku-5-5` is not the batch alias. */
export const BATCH_COMMAND_MODEL = "claude-haiku-5-5-anthropic"
export const BATCH_COMMAND_MAX_TOKENS = 4096
export const BATCH_COMMAND_CUSTOM_ID = "prompt"
/** Stored as the job input. It is a label, not a file path. */
export const BATCH_COMMAND_SOURCE = "inline:/fuelix-batch"

/** Service surface of the command. `BatchService` implements it. */
export interface BatchCommandService {
  submitRequests(
    sessionID: string,
    requests: readonly unknown[],
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly jobID: string; readonly batchID?: string; readonly submission: string }>
}

export interface BatchCommandInput {
  readonly log: Logger
  /** Returns the service, or `undefined` when the service cannot submit requests. */
  readonly getService: () => Promise<Partial<BatchCommandService> | undefined>
  /** Active and recently seen key candidates, for redaction of error text. */
  readonly collectSecrets: () => Promise<readonly string[]>
  /** Returns the key candidates seen so far without resolving new ones. */
  readonly seenSecrets: () => readonly string[]
}

const USAGE =
  `Usage: /${BATCH_COMMAND_NAME} <prompt>\n` +
  `Sends the prompt text as one deferred FueliX batch request (model ${BATCH_COMMAND_MODEL}, output limit ${BATCH_COMMAND_MAX_TOKENS} tokens). ` +
  "No session history, files, or attachments are included. The command returns a job ID; it does not wait for the answer. " +
  "Ask the assistant to check or collect the job with the fuelix_batch_status and fuelix_batch_collect tools."

const UNSUPPORTED =
  `/${BATCH_COMMAND_NAME} accepts plain prompt text only. Remove attached files, agent mentions, and skills ` +
  "and run it again. Nothing was submitted."

type Invocation = {
  readonly sessionID: string
  readonly prompt: { readonly text?: unknown; readonly files?: unknown; readonly agents?: unknown; readonly skills?: unknown }
  readonly delivery: "steer" | "queue"
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null
}

/** Registers `/fuelix-batch <prompt>`. The command submits one batch request and reports a safe summary. */
export async function registerBatchCommand(
  ctx: Plugin.Context,
  input: BatchCommandInput,
): Promise<{ dispose: () => Promise<void> }> {
  const { log } = input

  const tell = async (invocation: Invocation, text: string, description: string) => {
    await ctx.session.synthetic({
      sessionID: invocation.sessionID as never,
      text,
      description,
      delivery: invocation.delivery,
      // Feedback only. It must not start a model turn.
      resume: false,
    })
  }

  const describeFailure = async (error: unknown): Promise<string> => {
    let secrets: readonly string[] = input.seenSecrets()
    try {
      secrets = await input.collectSecrets()
    } catch {
      // Redaction is best effort; the message is restricted to fixed strings.
    }
    const code = safeErrorCode(error)
    log.warn("FueliX batch command failed", {
      errorName: error instanceof Error ? sanitizeMessage(error.name, secrets) : "unknown",
      ...(code === undefined ? {} : { code }),
    })
    if (error instanceof Error && SAFE_ERROR_NAMES.has(error.name)) {
      const jobID = (error as { jobID?: unknown }).jobID
      if (code === "duplicate_submission") {
        return (
          `The same prompt already has an unresolved submission${typeof jobID === "string" ? ` (job ${sanitizeMessage(jobID, secrets)})` : ""}. ` +
          "That batch may exist and may be billed. Nothing was sent. Check it with fuelix_batch_list first."
        )
      }
      const message = sanitizeMessage(error.message, secrets)
      return (error as { ambiguous?: unknown }).ambiguous === true
        ? `${message}. The submission may have reached the gateway and may be billed. It was not retried; check fuelix_batch_list.`
        : message
    }
    return `/${BATCH_COMMAND_NAME} failed. The error details are not shown; check the plugin log.`
  }

  const execute = async (invocation: Invocation): Promise<void> => {
    const prompt = invocation.prompt ?? {}
    const text = prompt.text
    if (hasItems(prompt.files) || hasItems(prompt.agents) || hasItems(prompt.skills)) {
      await tell(invocation, UNSUPPORTED, "FueliX batch not submitted")
      return
    }
    if (typeof text !== "string" || text.trim() === "") {
      await tell(invocation, USAGE, "FueliX batch usage")
      return
    }

    let message: string
    try {
      const service = await input.getService()
      if (!service || typeof service.submitRequests !== "function") {
        throw new Error("The batch service cannot submit inline requests.")
      }
      const job = await service.submitRequests(
        invocation.sessionID,
        [
          {
            custom_id: BATCH_COMMAND_CUSTOM_ID,
            params: {
              model: BATCH_COMMAND_MODEL,
              max_tokens: BATCH_COMMAND_MAX_TOKENS,
              messages: [{ role: "user", content: text }],
            },
          },
        ],
        BATCH_COMMAND_SOURCE,
      )
      message =
        `FueliX batch submitted. Job ${job.jobID}${job.batchID ? `, batch ${job.batchID}` : ""}, state ${job.submission}. ` +
        `Model ${BATCH_COMMAND_MODEL}, output limit ${BATCH_COMMAND_MAX_TOKENS} tokens, one request (custom_id ${BATCH_COMMAND_CUSTOM_ID}). ` +
        "Collect the result separately: ask the assistant to check or collect it with fuelix_batch_status and fuelix_batch_collect."
    } catch (error) {
      const failure = await describeFailure(error)
      try {
        await tell(invocation, failure, "FueliX batch submission needs attention")
      } catch {
        log.warn("FueliX batch command feedback failed")
        // No other channel exists. The message is already restricted to safe text.
        throw new Error(failure)
      }
      return
    }
    // The batch exists. A feedback failure must not look like a failed submission, and nothing is sent again.
    try {
      await tell(invocation, message, "FueliX batch submitted")
    } catch {
      log.warn("FueliX batch command feedback failed")
    }
  }

  return ctx.command.transform((editor) => {
    editor.add({
      name: BATCH_COMMAND_NAME,
      description: `Send the text as one deferred FueliX batch request (${BATCH_COMMAND_MODEL}) and report the job ID`,
      execute: (invocation) => execute(invocation as unknown as Invocation),
    })
  })
}
