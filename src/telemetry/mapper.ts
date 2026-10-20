import { isRecord, msToUnixNano, num, obj, str } from "./types.ts"
import type { AttributeValue, OpenCodeEvent, TelemetryRecord } from "./types.ts"

/**
 * Pure state machine. Maps OpenCode events and prompt-hook calls to td-telemetry records.
 *
 * The mapper never reads prompt text, tool input or output, skill text, or file contents. It reads IDs, names,
 * counts, timestamps, tokens, and the cost that OpenCode records on each step. It never computes cost.
 */

export interface MapperOptions {
  readonly subagentToolNames: readonly string[]
  readonly now: () => number
}

export interface SessionInfo {
  readonly parentID?: string | undefined
  readonly directory?: string | undefined
  readonly title?: string | undefined
  readonly agent?: string | undefined
}

interface ChildStats {
  startedMs?: number
  tokens: number
  toolUses: number
  firstModel?: string
  lastModel?: string
}

interface SessionState {
  parentID?: string
  directory?: string
  title?: string
  agent?: string
  /** Root sessions only. */
  promptID?: string
  /** Root sessions only. Counts `user_prompt` and `subagent_completed` records. */
  sequence: number
  child: ChildStats
}

interface MessageState {
  readonly sessionID: string
  readonly agent?: string
  readonly model?: string
  readonly startedMs?: number
  endedCount: number
}

interface ToolState {
  readonly sessionID: string
  readonly name: string
  readonly startMs: number
  decided: boolean
}

const MAX_TRACKED = 5000
const MAX_DEPTH = 16

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_TRACKED) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

function freshState(info: SessionInfo = {}): SessionState {
  const state: SessionState = { sequence: 0, child: { tokens: 0, toolUses: 0 } }
  if (info.parentID !== undefined) state.parentID = info.parentID
  if (info.directory !== undefined) state.directory = info.directory
  if (info.title !== undefined) state.title = info.title
  if (info.agent !== undefined) state.agent = info.agent
  return state
}

function modelID(model: unknown): string | undefined {
  // OpenCode 2.0.32 `Model.Ref` is `{ id, providerID, variant? }`.
  return str(model, "id") ?? str(model, "modelID")
}

function tokenTotal(tokens: Record<string, unknown>): number {
  const cache = obj(tokens, "cache")
  return (
    (num(tokens, "input") ?? 0) +
    (num(tokens, "output") ?? 0) +
    (num(tokens, "reasoning") ?? 0) +
    (num(cache, "read") ?? 0) +
    (num(cache, "write") ?? 0)
  )
}

export class Mapper {
  private readonly sessions = new Map<string, SessionState>()
  private readonly messages = new Map<string, MessageState>()
  private readonly tools = new Map<string, ToolState>()
  private readonly permissions = new Map<string, { callID?: string }>()
  private readonly subagentTools: ReadonlySet<string>

  constructor(private readonly options: MapperOptions) {
    this.subagentTools = new Set(options.subagentToolNames.map((name) => name.toLowerCase()))
  }

  knows(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  registerSession(sessionID: string, info: SessionInfo): void {
    const existing = this.sessions.get(sessionID)
    if (!existing) {
      setBounded(this.sessions, sessionID, freshState(info))
      return
    }
    if (info.parentID !== undefined) existing.parentID = info.parentID
    if (info.directory !== undefined) existing.directory = info.directory
    if (info.title !== undefined) existing.title = info.title
    if (info.agent !== undefined) existing.agent = info.agent
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  parentOf(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.parentID
  }

  /** The root of the session tree. An unknown session counts as a root. */
  rootOf(sessionID: string): string {
    let current = sessionID
    const seen = new Set<string>()
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      seen.add(current)
      const parent = this.sessions.get(current)?.parentID
      if (parent === undefined || seen.has(parent)) return current
      current = parent
    }
    return current
  }

  isRoot(sessionID: string): boolean {
    return this.rootOf(sessionID) === sessionID
  }

  directoryOf(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.directory
  }

  titleOf(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.title
  }

  /** Called for each prompt that reaches a session. Child-session prompts produce no record. */
  promptHook(sessionID: string, messageID: string, atMs: number = this.options.now()): TelemetryRecord[] {
    if (!this.sessions.has(sessionID)) this.registerSession(sessionID, {})
    if (!this.isRoot(sessionID)) return []
    const root = this.sessions.get(sessionID) as SessionState
    root.promptID = messageID
    root.sequence += 1
    return [this.record("user_prompt", sessionID, atMs, { "prompt.id": messageID, "event.sequence": root.sequence })]
  }

  event(event: OpenCodeEvent): TelemetryRecord[] {
    const data = isRecord(event.data) ? event.data : {}
    const sessionID = str(data, "sessionID")
    const at = typeof event.created === "number" && Number.isFinite(event.created) ? event.created : this.options.now()
    switch (event.type) {
      case "session.created":
        if (sessionID) {
          this.registerSession(sessionID, {
            parentID: str(data, "parentID"),
            directory: str(obj(data, "location"), "directory"),
            title: str(data, "title"),
            agent: str(data, "agent"),
          })
        }
        return []
      case "session.renamed": {
        const title = str(data, "title")
        if (sessionID && title) this.registerSession(sessionID, { title })
        return []
      }
      case "session.step.started":
        return sessionID ? this.stepStarted(sessionID, data) : []
      case "session.step.ended":
      case "session.step.failed":
        return sessionID ? this.stepEnded(sessionID, data, at, event.type === "session.step.failed") : []
      case "session.tool.input.started":
        // OpenCode 2.0.32 puts the tool name only on this event. `session.tool.called` and the result events carry none.
        return sessionID ? this.toolInputStarted(sessionID, data, at) : []
      case "session.tool.called":
        return sessionID ? this.toolCalled(sessionID, data, at) : []
      case "session.tool.success":
      case "session.tool.failed":
        return this.toolEnded(data, at, event.type === "session.tool.success")
      case "permission.asked":
        return this.permissionAsked(data)
      case "permission.replied":
        return sessionID ? this.permissionReplied(sessionID, data, at) : []
      case "session.skill.activated":
        return sessionID ? this.skillActivated(sessionID, data, at) : []
      case "session.execution.started":
        if (sessionID && !this.isRoot(sessionID)) (this.sessions.get(sessionID) as SessionState).child.startedMs = at
        return []
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return sessionID ? this.executionEnded(sessionID, at) : []
      default:
        return []
    }
  }

  private state(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = freshState()
      setBounded(this.sessions, sessionID, state)
    }
    return state
  }

  private promptIDOf(sessionID: string): string | undefined {
    return this.sessions.get(this.rootOf(sessionID))?.promptID
  }

  private record(
    eventName: string,
    sessionID: string,
    atMs: number,
    attributes: Record<string, AttributeValue | undefined>,
  ): TelemetryRecord {
    const clean: Record<string, AttributeValue> = {}
    for (const [key, value] of Object.entries(attributes)) if (value !== undefined) clean[key] = value
    return { eventName, sessionID: this.rootOf(sessionID), timeUnixNano: msToUnixNano(atMs), attributes: clean }
  }

  private stepStarted(sessionID: string, data: Record<string, unknown>): TelemetryRecord[] {
    const messageID = str(data, "assistantMessageID")
    if (!messageID) return []
    const state = this.state(sessionID)
    const agent = str(data, "agent")
    const model = modelID(data.model)
    const startedMs = num(data, "started")
    const previous = this.messages.get(messageID)
    const entry: MessageState = {
      sessionID,
      endedCount: previous?.endedCount ?? 0,
      ...(agent !== undefined ? { agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(startedMs !== undefined ? { startedMs } : {}),
    }
    setBounded(this.messages, messageID, entry)
    if (agent !== undefined) state.agent = agent
    if (model !== undefined) {
      state.child.firstModel ??= model
      state.child.lastModel = model
    }
    if (startedMs !== undefined) state.child.startedMs ??= startedMs
    return []
  }

  private stepEnded(sessionID: string, data: Record<string, unknown>, at: number, failed: boolean): TelemetryRecord[] {
    const messageID = str(data, "assistantMessageID")
    if (!messageID) return []
    const tokens = obj(data, "tokens")
    const cost = num(data, "cost")
    if (failed && cost === undefined && tokens === undefined) return []
    const state = this.state(sessionID)
    const message = this.messages.get(messageID)
    const agent = message?.agent ?? state.agent
    const index = message?.endedCount ?? 0
    if (message) message.endedCount += 1
    else setBounded(this.messages, messageID, { sessionID, endedCount: 1 })
    const isRoot = this.isRoot(sessionID)
    const cache = obj(tokens, "cache")
    if (!isRoot && tokens) state.child.tokens += tokenTotal(tokens)
    const attributes: Record<string, AttributeValue | undefined> = {
      request_id: `${messageID}:${index}`,
      // The cost comes from OpenCode. The emitter never computes it from tokens.
      cost_usd: cost ?? 0,
      model: message?.model,
      query_source: isRoot ? "repl_main_thread" : `agent:builtin:${agent ?? "unknown"}`,
      "agent.name": agent,
      "prompt.id": this.promptIDOf(sessionID),
    }
    if (tokens) {
      attributes.input_tokens = num(tokens, "input") ?? 0
      attributes.output_tokens = (num(tokens, "output") ?? 0) + (num(tokens, "reasoning") ?? 0)
      attributes.cache_read_tokens = num(cache, "read") ?? 0
      attributes.cache_creation_tokens = num(cache, "write") ?? 0
    }
    if (message?.startedMs !== undefined) attributes.duration_ms = Math.max(0, Math.round(at - message.startedMs))
    return [this.record("api_request", sessionID, at, attributes)]
  }

  private toolName(name: string): string {
    return this.subagentTools.has(name.toLowerCase()) ? "Task" : name
  }

  private toolInputStarted(sessionID: string, data: Record<string, unknown>, at: number): TelemetryRecord[] {
    const id = str(data, "id")
    const name = str(data, "name")
    if (id && name) setBounded(this.tools, id, { sessionID, name, startMs: at, decided: false })
    return []
  }

  private toolCalled(sessionID: string, data: Record<string, unknown>, at: number): TelemetryRecord[] {
    const id = str(data, "id")
    if (!id) return []
    const existing = this.tools.get(id)
    const name = str(data, "name") ?? existing?.name
    // The call starts here. The input stream started earlier.
    if (name) setBounded(this.tools, id, { sessionID, name, startMs: at, decided: existing?.decided ?? false })
    return []
  }

  private toolEnded(data: Record<string, unknown>, at: number, success: boolean): TelemetryRecord[] {
    const id = str(data, "id")
    if (!id) return []
    const call = this.tools.get(id)
    // The result event carries no tool name. A call from before the plugin started cannot be attributed.
    if (!call) return []
    this.tools.delete(id)
    const promptID = this.promptIDOf(call.sessionID)
    const toolName = this.toolName(call.name)
    const records: TelemetryRecord[] = []
    if (!call.decided) {
      records.push(
        this.record("tool_decision", call.sessionID, call.startMs, {
          tool_use_id: id,
          tool_name: toolName,
          decision: "accept",
          source: "config",
          "prompt.id": promptID,
        }),
      )
    }
    records.push(
      this.record("tool_result", call.sessionID, at, {
        tool_name: toolName,
        duration_ms: Math.max(0, Math.round(at - call.startMs)),
        success: success ? "true" : "false",
        tool_use_id: id,
        "prompt.id": promptID,
      }),
    )
    if (!this.isRoot(call.sessionID)) this.state(call.sessionID).child.toolUses += 1
    return records
  }

  private permissionAsked(data: Record<string, unknown>): TelemetryRecord[] {
    const requestID = str(data, "id")
    if (!requestID) return []
    const source = obj(data, "source")
    const callID = str(source, "type") === "tool" ? str(source, "id") : undefined
    setBounded(this.permissions, requestID, callID !== undefined ? { callID } : {})
    return []
  }

  private permissionReplied(sessionID: string, data: Record<string, unknown>, at: number): TelemetryRecord[] {
    const requestID = str(data, "requestID")
    const reply = str(data, "reply")
    if (!requestID || !reply) return []
    const request = this.permissions.get(requestID)
    this.permissions.delete(requestID)
    // A permission request that is not tied to a tool call has no `tool_use_id` to report.
    if (!request?.callID) return []
    const call = this.tools.get(request.callID)
    if (call) call.decided = true
    const source = reply === "always" ? "user_permanent" : reply === "reject" ? "user_reject" : "user_temporary"
    return [
      this.record("tool_decision", sessionID, at, {
        tool_use_id: request.callID,
        tool_name: call ? this.toolName(call.name) : undefined,
        decision: reply === "reject" ? "reject" : "accept",
        source,
        "prompt.id": this.promptIDOf(sessionID),
      }),
    ]
  }

  private skillActivated(sessionID: string, data: Record<string, unknown>, at: number): TelemetryRecord[] {
    const name = str(data, "name")
    if (!name) return []
    return [
      this.record("skill_activated", sessionID, at, {
        "skill.name": name,
        "skill.source": "opencode",
        "prompt.id": this.promptIDOf(sessionID),
      }),
    ]
  }

  private executionEnded(sessionID: string, at: number): TelemetryRecord[] {
    if (this.isRoot(sessionID)) return []
    const state = this.state(sessionID)
    const child = state.child
    const root = this.state(this.rootOf(sessionID))
    root.sequence += 1
    const attributes: Record<string, AttributeValue | undefined> = {
      agent_type: state.agent ?? "unknown",
      "agent.source": "opencode",
      is_built_in: "false",
      is_async: "false",
      total_tokens: child.tokens,
      total_tool_uses: child.toolUses,
      duration_ms: child.startedMs !== undefined ? Math.max(0, Math.round(at - child.startedMs)) : undefined,
      model: child.firstModel,
      final_model: child.lastModel,
      model_swapped: child.firstModel !== undefined && child.firstModel !== child.lastModel ? "true" : "false",
      "prompt.id": root.promptID,
      "event.sequence": root.sequence,
    }
    state.child = { tokens: 0, toolUses: 0 }
    return [this.record("subagent_completed", sessionID, at, attributes)]
  }
}
