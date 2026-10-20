/**
 * Runs prompts against an isolated OpenCode server and collects per-step usage from the event stream.
 */

import { type EventFeed, type IsolatedServer, waitFor } from "./harness.ts"

export interface StepTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface StepRecord {
  assistantMessageID: string
  finish: string
  cost: number
  tokens: StepTokens
}

export interface FlowResult {
  sessionID: string
  /** `session.step.ended` events, in order. */
  steps: StepRecord[]
  /** `session.step.failed` messages. A non-empty list means a request failed. */
  failures: string[]
  /** `GET /api/session/{id}` data: cost and token totals. */
  session: { cost: number; tokens: StepTokens; outcome?: string }
}

export interface FlowInput {
  server: IsolatedServer
  feed: EventFeed
  model: { providerID: string; id: string; variant?: string }
  prompts: string[]
  /** Time limit for each prompt. Default 120 s. */
  promptTimeoutMs?: number
}

function stepsOf(feed: EventFeed, sessionID: string, type: "session.step.ended" | "session.step.failed") {
  return feed.events.filter((event) => event.type === type && event.data?.sessionID === sessionID)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Creates a session with an explicit model, sends the prompts one after the other, and waits for each to finish. */
export async function runPromptFlow(input: FlowInput): Promise<FlowResult> {
  const { server, feed } = input
  const timeout = input.promptTimeoutMs ?? 120_000
  const created = await server.api<{ data: { id: string } }>("POST", "/api/session", {
    location: { directory: server.dirs.project },
    model: input.model,
  })
  if (created.status !== 200) throw new Error(`session create failed: HTTP ${created.status} ${JSON.stringify(created.json)}`)
  const sessionID = created.json.data.id

  for (const [index, text] of input.prompts.entries()) {
    const settledBefore = stepsOf(feed, sessionID, "session.step.ended").length + stepsOf(feed, sessionID, "session.step.failed").length
    const sent = await server.api("POST", `/api/session/${sessionID}/prompt`, { text })
    if (sent.status !== 200) throw new Error(`prompt ${index + 1} failed: HTTP ${sent.status} ${JSON.stringify(sent.json)}`)
    // The agent loop is idle again when `wait` returns. Then check that a step settled.
    await withTimeout(server.api("POST", `/api/experimental/session/${sessionID}/wait`), timeout, `prompt ${index + 1} wait`)
    await waitFor(
      async () =>
        stepsOf(feed, sessionID, "session.step.ended").length + stepsOf(feed, sessionID, "session.step.failed").length > settledBefore
          ? true
          : undefined,
      30_000,
      `step event of prompt ${index + 1}`,
    )
  }
  // Let the title generation and trailing events finish.
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const steps = stepsOf(feed, sessionID, "session.step.ended").map((event): StepRecord => ({
    assistantMessageID: event.data.assistantMessageID,
    finish: event.data.finish,
    cost: event.data.cost,
    tokens: event.data.tokens,
  }))
  const failures = stepsOf(feed, sessionID, "session.step.failed").map(
    (event) => `${event.data?.error?.type ?? "error"}: ${event.data?.error?.message ?? ""}`,
  )
  const info = await server.api<{ data: FlowResult["session"] }>("GET", `/api/session/${sessionID}`)
  return { sessionID, steps, failures, session: info.json.data }
}
