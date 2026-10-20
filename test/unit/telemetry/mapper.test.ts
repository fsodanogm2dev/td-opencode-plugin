import { describe, expect, test } from "bun:test"
import { newMapper, runFixture, view } from "./helpers.ts"

describe("mapper: root turn", () => {
  const records = runFixture("root-turn.json").map(view)

  test("emits the exact records in order", () => {
    expect(records).toEqual([
      { name: "user_prompt", session: "ses_root", ms: 2000, attributes: { "prompt.id": "msg_user1", "event.sequence": 1 } },
      {
        name: "tool_decision",
        session: "ses_root",
        ms: 2500,
        attributes: { tool_use_id: "call_1", tool_name: "read", decision: "accept", source: "config", "prompt.id": "msg_user1" },
      },
      {
        name: "tool_result",
        session: "ses_root",
        ms: 2600,
        attributes: { tool_name: "read", duration_ms: 100, success: "true", tool_use_id: "call_1", "prompt.id": "msg_user1" },
      },
      {
        name: "tool_decision",
        session: "ses_root",
        ms: 3000,
        attributes: { tool_use_id: "call_2", tool_name: "bash", decision: "accept", source: "user_permanent", "prompt.id": "msg_user1" },
      },
      {
        name: "tool_result",
        session: "ses_root",
        ms: 3200,
        attributes: { tool_name: "bash", duration_ms: 500, success: "true", tool_use_id: "call_2", "prompt.id": "msg_user1" },
      },
      {
        name: "api_request",
        session: "ses_root",
        ms: 3300,
        attributes: {
          request_id: "msg_a1:0",
          cost_usd: 0.0123,
          model: "claude-sonnet-5-5",
          query_source: "repl_main_thread",
          "agent.name": "build",
          "prompt.id": "msg_user1",
          input_tokens: 1000,
          output_tokens: 250,
          cache_read_tokens: 300,
          cache_creation_tokens: 40,
          duration_ms: 1200,
        },
      },
      {
        name: "skill_activated",
        session: "ses_root",
        ms: 3500,
        attributes: { "skill.name": "brainstorm", "skill.source": "opencode", "prompt.id": "msg_user1" },
      },
      {
        name: "api_request",
        session: "ses_root",
        ms: 4400,
        attributes: {
          request_id: "msg_a2:0",
          cost_usd: 0.5,
          model: "claude-sonnet-5-5",
          query_source: "repl_main_thread",
          "agent.name": "build",
          "prompt.id": "msg_user1",
          input_tokens: 1500,
          output_tokens: 100,
          cache_read_tokens: 1000,
          cache_creation_tokens: 0,
          duration_ms: 1000,
        },
      },
    ])
  })

  test("a reject reply maps to reject and user_reject", () => {
    const mapper = newMapper()
    mapper.registerSession("s", {})
    mapper.event({ type: "session.tool.called", created: 10, data: { sessionID: "s", id: "c", name: "edit" } })
    mapper.event({ type: "permission.asked", created: 11, data: { id: "p", sessionID: "s", source: { type: "tool", messageID: "m", id: "c" } } })
    const decision = mapper.event({ type: "permission.replied", created: 12, data: { sessionID: "s", requestID: "p", reply: "reject" } })
    expect(decision.map(view)[0]?.attributes).toEqual({ tool_use_id: "c", tool_name: "edit", decision: "reject", source: "user_reject" })
    const result = mapper.event({ type: "session.tool.failed", created: 13, data: { sessionID: "s", id: "c", error: {} } })
    expect(result.map((record) => record.eventName)).toEqual(["tool_result"])
    expect(result[0]?.attributes.success).toBe("false")
  })

  test("a once reply maps to user_temporary", () => {
    const mapper = newMapper()
    mapper.event({ type: "session.tool.called", created: 10, data: { sessionID: "s", id: "c", name: "edit" } })
    mapper.event({ type: "permission.asked", created: 11, data: { id: "p", sessionID: "s", source: { type: "tool", messageID: "m", id: "c" } } })
    const decision = mapper.event({ type: "permission.replied", created: 12, data: { sessionID: "s", requestID: "p", reply: "once" } })
    expect(decision[0]?.attributes).toMatchObject({ decision: "accept", source: "user_temporary" })
  })

  test("a second step on the same message gets the next index", () => {
    const mapper = newMapper()
    const end = (created: number) =>
      mapper.event({ type: "session.step.ended", created, data: { sessionID: "s", assistantMessageID: "m", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
    expect(end(1)[0]?.attributes.request_id).toBe("m:0")
    expect(end(2)[0]?.attributes.request_id).toBe("m:1")
  })
})

describe("mapper: subagent", () => {
  const records = runFixture("subagent.json").map(view)

  test("child activity is reported under the root session", () => {
    expect(new Set(records.map((record) => record.session))).toEqual(new Set(["ses_root"]))
  })

  test("child steps use the agent query source", () => {
    const child = records.find((record) => record.name === "api_request" && record.attributes.request_id === "msg_c1:0")
    expect(child?.attributes).toEqual({
      request_id: "msg_c1:0",
      cost_usd: 0.002,
      model: "claude-haiku-5",
      query_source: "agent:builtin:explorer",
      "agent.name": "explorer",
      "prompt.id": "msg_user1",
      input_tokens: 400,
      output_tokens: 70,
      cache_read_tokens: 100,
      cache_creation_tokens: 20,
      duration_ms: 500,
    })
  })

  test("the task tool is reported as Task", () => {
    const result = records.find((record) => record.name === "tool_result" && record.attributes.tool_use_id === "call_task")
    expect(result?.attributes).toEqual({
      tool_name: "Task",
      duration_ms: 800,
      success: "true",
      tool_use_id: "call_task",
      "prompt.id": "msg_user1",
    })
    const grep = records.find((record) => record.name === "tool_result" && record.attributes.tool_use_id === "call_grep")
    expect(grep?.attributes.tool_name).toBe("grep")
  })

  test("a child prompt produces no user_prompt", () => {
    expect(records.filter((record) => record.name === "user_prompt")).toHaveLength(1)
  })

  test("subagent_completed sums the child steps", () => {
    const completed = records.filter((record) => record.name === "subagent_completed")
    expect(completed).toEqual([
      {
        name: "subagent_completed",
        session: "ses_root",
        ms: 3000,
        attributes: {
          agent_type: "explorer",
          "agent.source": "opencode",
          is_built_in: "false",
          is_async: "false",
          total_tokens: 590,
          total_tool_uses: 1,
          duration_ms: 670,
          model: "claude-haiku-5",
          final_model: "claude-haiku-5",
          model_swapped: "false",
          "prompt.id": "msg_user1",
          "event.sequence": 2,
        },
      },
    ])
  })

  test("the accumulators reset after a completion", () => {
    const mapper = newMapper()
    runFixture("subagent.json", mapper)
    const again = mapper.event({ type: "session.execution.interrupted", created: 5000, data: { sessionID: "ses_child", reason: "user" } })
    expect(again[0]?.attributes).toMatchObject({ total_tokens: 0, total_tool_uses: 0, "event.sequence": 3 })
  })
})

describe("mapper: failed step", () => {
  const records = runFixture("failed-step.json").map(view)

  test("a failed step with cost and tokens reports an api_request", () => {
    const request = records.filter((record) => record.name === "api_request")
    expect(request).toHaveLength(1)
    expect(request[0]?.attributes).toEqual({
      request_id: "msg_f1:0",
      cost_usd: 0.004,
      model: "claude-sonnet-5-5",
      query_source: "repl_main_thread",
      "agent.name": "build",
      "prompt.id": "msg_user1",
      input_tokens: 800,
      output_tokens: 30,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 500,
    })
  })

  test("a failed step without cost and tokens reports nothing", () => {
    expect(records.some((record) => record.attributes.request_id === "msg_f2:0")).toBe(false)
  })
})

describe("mapper: privacy", () => {
  test("prompt, tool, permission, and skill text never reach a record", () => {
    const records = runFixture("secret-prompt.json")
    expect(records.length).toBe(5)
    expect(JSON.stringify(records)).not.toContain("SECRET-PROMPT-TEXT")
  })
})

describe("mapper: sessions", () => {
  test("an unknown session is a root", () => {
    const mapper = newMapper()
    expect(mapper.rootOf("unknown")).toBe("unknown")
    expect(mapper.isRoot("unknown")).toBe(true)
  })

  test("a lazily registered child resolves to its root", () => {
    const mapper = newMapper()
    mapper.registerSession("root", {})
    mapper.registerSession("child", { parentID: "root" })
    mapper.registerSession("grandchild", { parentID: "child" })
    expect(mapper.rootOf("grandchild")).toBe("root")
  })

  test("a parent cycle does not loop", () => {
    const mapper = newMapper()
    mapper.registerSession("a", { parentID: "b" })
    mapper.registerSession("b", { parentID: "a" })
    expect(typeof mapper.rootOf("a")).toBe("string")
  })

  test("a result for an unknown call produces nothing", () => {
    const mapper = newMapper()
    expect(mapper.event({ type: "session.tool.success", created: 1, data: { sessionID: "s", id: "never-called" } })).toEqual([])
  })

  test("a model_swapped child reports both models", () => {
    const mapper = newMapper()
    mapper.registerSession("r", {})
    mapper.registerSession("c", { parentID: "r", agent: "explorer" })
    const started = (id: string, model: string, at: number) =>
      mapper.event({ type: "session.step.started", created: at, data: { sessionID: "c", assistantMessageID: id, agent: "explorer", model: { id: model, providerID: "p" }, started: at } })
    started("m1", "model-a", 10)
    started("m2", "model-b", 20)
    const completed = mapper.event({ type: "session.execution.succeeded", created: 30, data: { sessionID: "c" } })
    expect(completed[0]?.attributes).toMatchObject({ model: "model-a", final_model: "model-b", model_swapped: "true" })
  })
})

describe("mapper: tool name source", () => {
  test("the tool name comes from session.tool.input.started, as in OpenCode 2.0.32", () => {
    const mapper = newMapper()
    mapper.registerSession("s", {})
    mapper.event({ type: "session.tool.input.started", created: 5, data: { sessionID: "s", assistantMessageID: "m", id: "c", name: "read" } })
    mapper.event({ type: "session.tool.called", created: 10, data: { sessionID: "s", assistantMessageID: "m", id: "c", input: {}, executed: false } })
    const records = mapper.event({ type: "session.tool.success", created: 30, data: { sessionID: "s", assistantMessageID: "m", id: "c", content: [], executed: true } })
    expect(records.map(view)).toEqual([
      { name: "tool_decision", session: "s", ms: 10, attributes: { tool_use_id: "c", tool_name: "read", decision: "accept", source: "config" } },
      { name: "tool_result", session: "s", ms: 30, attributes: { tool_name: "read", duration_ms: 20, success: "true", tool_use_id: "c" } },
    ])
  })

  test("a permission reply before the call event still finds the tool name", () => {
    const mapper = newMapper()
    mapper.event({ type: "session.tool.input.started", created: 5, data: { sessionID: "s", id: "c", name: "bash" } })
    mapper.event({ type: "permission.asked", created: 6, data: { id: "p", sessionID: "s", source: { type: "tool", messageID: "m", id: "c" } } })
    const decision = mapper.event({ type: "permission.replied", created: 7, data: { sessionID: "s", requestID: "p", reply: "once" } })
    expect(decision[0]?.attributes).toMatchObject({ tool_name: "bash", decision: "accept", source: "user_temporary" })
    mapper.event({ type: "session.tool.called", created: 8, data: { sessionID: "s", id: "c", input: {} } })
    const records = mapper.event({ type: "session.tool.success", created: 9, data: { sessionID: "s", id: "c" } })
    expect(records.map((record) => record.eventName)).toEqual(["tool_result"])
  })
})
