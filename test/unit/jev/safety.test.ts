import { describe, expect, test } from "bun:test"
import {
  createSafetyHandlers,
  isDestructiveCommand,
  isReadOnlyCommand,
  MAX_COMMAND_CHARS,
  registerSafety,
  type SafetyEvaluateEvent,
} from "../../../src/jev/points/safety.ts"
import { createTaskTracker, type JevDecideRequest, type JevPointRuntime } from "../../../src/jev/runtime.ts"
import type { JevTelemetryEvent } from "../../../src/jev/telemetry.ts"
import type { JevOutcome } from "../../../src/jev/types.ts"

const options = (extra: Record<string, unknown> = {}) => ({ mode: "enforce" as const, timeoutMs: 1500, riskThreshold: 0.2, failClosed: true, ...extra })

const noul = (value: number): JevOutcome => ({
  ok: true,
  value: { model: "jev-1.14.0", requestedModel: "jev-1.14.0", answers: { is_destructive: { type: "noul", noul: value } }, cached: false, latencyMs: 4 },
})

function fakeRuntime(decide: (request: JevDecideRequest) => JevOutcome | Promise<JevOutcome> = () => noul(0.01)) {
  const requests: JevDecideRequest[] = []
  const records: JevTelemetryEvent[] = []
  const state = { disposed: false }
  const runtime: JevPointRuntime = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => 0,
    get disposed() {
      return state.disposed
    },
    async decide(request) {
      requests.push(request)
      return decide(request)
    },
    secrets: async () => [],
    record: (event) => void records.push(event),
    writeLog: async () => {
      throw new Error("unused")
    },
    modelVariants: async () => undefined,
    tasks: createTaskTracker(4),
  }
  return { runtime, requests, records, state }
}

const unarmed = createSafetyHandlers

/** Handlers whose `evaluate` first stores the single resource as the full command, as `tool.execute.before` does. */
function armed(runtime: JevPointRuntime, opts: ReturnType<typeof options>) {
  const handlers = createSafetyHandlers(runtime, opts)
  return {
    ...handlers,
    async evaluate(event: SafetyEvaluateEvent) {
      const id = event.source?.id
      if (id !== undefined) handlers.before({ tool: "shell", sessionID: event.sessionID, id, input: { command: event.resources.join(" ") } })
      return handlers.evaluate(event)
    },
  }
}

const evaluateEvent = (resources: string[], extra: Partial<SafetyEvaluateEvent> = {}): SafetyEvaluateEvent => ({
  sessionID: "ses_1",
  action: "shell",
  resources,
  source: { type: "tool", id: "call_1" },
  effect: "allow",
  ...extra,
})

describe("isDestructiveCommand", () => {
  const destructive = [
    "rm -rf build",
    "rm -fr build",
    "rm -Rf build",
    "rm -r -f build",
    "rm -f -r build",
    "rm --recursive --force build",
    "rm -rfv build",
    "/bin/rm -rf build",
    "\\rm -rf build",
    '"rm" -rf build',
    "FOO=1 rm -rf build",
    "sudo rm -rf /",
    "sudo -u root rm -rf /",
    "env -u HOME rm -rf x",
    "env FOO=1 rm -rf x",
    "nice -n 5 rm -rf x",
    "timeout 10 rm -rf x",
    "xargs rm -rf",
    "cd x && rm -rf y",
    "ls; rm -rf y",
    "true || rm -rf y",
    "echo hi | xargs rm -rf",
    "sh -c 'rm -rf y'",
    "bash -lc \"cd x; rm -rf y\"",
    "eval 'rm -rf y'",
    "echo \"$(rm -rf y)\"",
    "echo `rm -rf y`",
    "(rm -rf y)",
    "{ rm -rf y; }",
    "find . -name '*.o' -delete",
    "find . -exec rm -rf {} \\;",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git push origin :old-branch",
    "git push --force-with-lease",
    "git push --delete origin old",
    "git -C /repo push -f",
    "git -c core.editor=true push --force",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git clean -xdf",
    "git clean --force",
    "psql -c 'DROP TABLE users'",
    "mysql -e \"drop database prod\"",
    "echo 'truncate table users;' | psql",
    "DROP SCHEMA public CASCADE;",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sda1",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "terraform destroy",
    "terraform -chdir=infra destroy -auto-approve",
    "terraform apply -destroy",
    "kubectl delete pod web",
    "kubectl -n prod delete deploy web",
    "shred -u secret.txt",
    "truncate -s 0 big.log",
    "diskutil eraseDisk APFS X disk2",
  ]
  for (const command of destructive) test(`flags: ${command}`, () => expect(isDestructiveCommand(command)).toBe(true))

  const harmless = [
    "ls -la",
    "rm file.txt",
    "rm -r dir",
    "rm -f file",
    "git status",
    "git push origin main",
    "git push -u origin feature",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git clean -nd",
    "git log --oneline",
    "dd if=/dev/zero of=/dev/null count=1",
    "dd if=a of=b",
    "terraform plan",
    "kubectl get pods",
    "kubectl logs delete-pod",
    "echo drop",
    "cat truncate.txt",
    "grep -r foo .",
    "bun test",
    "echo 'rm -rf is dangerous'",
  ]
  for (const command of harmless) test(`does not flag: ${command}`, () => expect(isDestructiveCommand(command)).toBe(false))
})

describe("isReadOnlyCommand", () => {
  for (const command of ["ls", "ls -la", "ls -1 src test", "pwd", "pwd -P", "git status", "git status -sb", "git status --porcelain=v2", "git diff", "git diff --stat", "git diff --cached --name-only", "git log --oneline -n 5", "git log -5", "git log --pretty=oneline --graph", "git show HEAD", "git show HEAD --stat", "git diff main..feature -- src/a.ts"]) {
    test(`accepts: ${command}`, () => expect(isReadOnlyCommand(command)).toBe(true))
  }
  for (const command of [
    "",
    "cat file",
    "ls > out.txt",
    "ls | wc -l",
    "ls; rm x",
    "ls && touch x",
    "ls $(pwd)",
    "ls `pwd`",
    "ls 'a b'",
    "FOO=1 ls",
    "git diff --output=patch.txt",
    "git diff --output patch.txt",
    "git log --output=x",
    "git show --output=x HEAD",
    "git diff --ext-diff",
    "git -c core.pager=less diff",
    "git -C /tmp status",
    "git status --unknown",
    "git log -n",
    "git log -n abc",
    "git log --format=%H",
    "git commit -m x",
    "git branch -D x",
    "rg --pre ./script foo",
    "rg --pre-glob '*.x' foo",
    "grep -r foo .",
    "ls -la\nrm x",
    "pwd -x",
  ]) {
    test(`rejects: ${JSON.stringify(command)}`, () => expect(isReadOnlyCommand(command)).toBe(false))
  }
})

describe("permission evaluate hook", () => {
  test("a destructive pattern asks without an upstream call", async () => {
    const { runtime, requests, records } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    const event = evaluateEvent(["rm -rf build"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(event.message).toContain("destructive")
    expect(requests).toEqual([])
    expect(records[0]).toMatchObject({ point: "safetyPreCheck", applied: true })
  })

  test("a destructive pattern asks even with no TypeSafe key and with failClosed false", async () => {
    const { runtime, requests } = fakeRuntime(() => ({ ok: false, error: { code: "no-key" } }))
    const handlers = createSafetyHandlers(runtime, options({ failClosed: false }))
    const event = evaluateEvent(["git push --force"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("the full command from tool.execute.before catches what the resources hide", async () => {
    const { runtime, requests } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "ls && rm -rf build" } })
    const event = evaluateEvent(["ls"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("the destructive check runs on every resource when the full command is unknown", async () => {
    const { runtime } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    const event = evaluateEvent(["ls", "rm -rf build"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
  })

  test("a read-only full command skips every check", async () => {
    const { runtime, requests, records } = fakeRuntime(() => noul(0.99))
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "git status -sb" } })
    const event = evaluateEvent(["git status -sb"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("allow")
    expect(requests).toEqual([])
    expect(records).toEqual([])
  })

  test("without the full command nothing is skipped and nothing goes upstream: failClosed asks", async () => {
    const { runtime, requests, records } = fakeRuntime(() => noul(0.01))
    const handlers = unarmed(runtime, options())
    for (const resources of [["pwd"], ["ls"], ["git status"]]) {
      const event = evaluateEvent(resources)
      await handlers.evaluate(event)
      expect(event.effect).toBe("ask")
    }
    expect(requests).toEqual([])
    expect(records[0]).toMatchObject({ errorCode: "invalid-request", applied: true })
  })

  test("without the full command failClosed false keeps allow, and still sends nothing", async () => {
    const { runtime, requests, records } = fakeRuntime(() => noul(0.99))
    const event = evaluateEvent(["pwd"])
    await unarmed(runtime, options({ failClosed: false })).evaluate(event)
    expect(event.effect).toBe("allow")
    expect(requests).toEqual([])
    expect(records[0]).toMatchObject({ errorCode: "invalid-request", applied: false })
  })

  test("without the full command and with no key, the result is the same as with a key", async () => {
    const { runtime, requests } = fakeRuntime(() => ({ ok: false, error: { code: "no-key" } }))
    const event = evaluateEvent(["pwd"])
    await unarmed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("without the full command, existing ask and deny stay unchanged", async () => {
    for (const effect of ["ask", "deny"] as const) {
      const { runtime, requests } = fakeRuntime()
      const event = evaluateEvent(["pwd"], { effect, message: "rule" })
      await unarmed(runtime, options()).evaluate(event)
      expect(event.effect).toBe(effect)
      expect(event.message).toBe("rule")
      expect(requests).toEqual([])
    }
  })

  test("without a tool source the full command is unknown", async () => {
    const { runtime, requests } = fakeRuntime()
    const handlers = unarmed(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "pwd" } })
    const event = evaluateEvent(["pwd"], { source: undefined })
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("an evicted full command is unknown", async () => {
    const { runtime, requests } = fakeRuntime()
    const handlers = unarmed(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "pwd" } })
    for (let i = 0; i < 300; i++) handlers.before({ tool: "shell", sessionID: "ses_1", id: `c${i}`, input: { command: "pwd" } })
    const event = evaluateEvent(["pwd"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("shadow without the full command records and never edits", async () => {
    const { runtime, records } = fakeRuntime()
    const event = evaluateEvent(["pwd"])
    await unarmed(runtime, options({ mode: "shadow" })).evaluate(event)
    expect(event.effect).toBe("allow")
    expect(records[0]).toMatchObject({ mode: "shadow", errorCode: "invalid-request", applied: false })
  })

  test("a read-only resource does not skip when the full command has a redirection", async () => {
    const { runtime, requests } = fakeRuntime(() => noul(0.99))
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "ls > /etc/hosts" } })
    const event = evaluateEvent(["ls"])
    await handlers.evaluate(event)
    expect(requests.length).toBe(1)
    expect(requests[0]!.state).toBe("ls > /etc/hosts")
    expect(event.effect).toBe("ask")
  })

  test("after removes the stored command", async () => {
    const { runtime, requests } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "ls" } })
    handlers.after({ tool: "shell", sessionID: "ses_1", id: "call_1" })
    const event = evaluateEvent(["ls"])
    await handlers.evaluate(event)
    // The command is unknown again: it is not skipped as read-only and it goes nowhere upstream.
    expect(event.effect).toBe("ask")
    expect(requests).toEqual([])
  })

  test("stored commands are bounded and keyed by session and call", async () => {
    const { runtime, requests } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "touch x" } })
    // Another session with the same call ID has no stored command.
    const other = evaluateEvent(["touch x"], { sessionID: "ses_2", source: { type: "tool", id: "call_1" } })
    await handlers.evaluate(other)
    expect(other.effect).toBe("ask")
    expect(requests).toEqual([])
    for (let i = 0; i < 400; i++) handlers.before({ tool: "shell", sessionID: "ses_1", id: `c${i}`, input: { command: "touch x" } })
    const evicted = evaluateEvent(["touch x"], { source: { type: "tool", id: "call_1" } })
    await handlers.evaluate(evicted)
    expect(evicted.effect).toBe("ask")
    const kept = evaluateEvent(["touch x"], { source: { type: "tool", id: "c399" } })
    await handlers.evaluate(kept)
    expect(kept.effect).toBe("allow")
    expect(requests.length).toBe(1)
  })

  test("a low probability keeps allow, and the request carries the whole command", async () => {
    const { runtime, requests, records } = fakeRuntime(() => noul(0.05))
    const handlers = createSafetyHandlers(runtime, options())
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: "touch a b" } })
    const event = evaluateEvent(["touch a b"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("allow")
    expect(requests[0]!.state).toBe("touch a b")
    expect(requests[0]!.timeoutMs).toBe(1500)
    expect(Object.keys(requests[0]!.questions)).toEqual(["is_destructive"])
    expect(records[0]).toMatchObject({ probability: 0.05, threshold: 0.2, applied: false, model: "jev-1.14.0" })
  })

  test("a probability above the threshold asks", async () => {
    const { runtime, records } = fakeRuntime(() => noul(0.21))
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("ask")
    expect(records[0]).toMatchObject({ applied: true })
  })

  test("a probability equal to the threshold does not ask", async () => {
    const { runtime } = fakeRuntime(() => noul(0.2))
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("allow")
  })

  test("ask and deny never change, and no upstream call is made for them", async () => {
    for (const effect of ["ask", "deny"] as const) {
      const { runtime, requests } = fakeRuntime(() => noul(0.99))
      const event = evaluateEvent(["rm -rf build"], { effect, message: "rule" })
      await armed(runtime, options()).evaluate(event)
      expect(event.effect).toBe(effect)
      expect(event.message).toBe("rule")
      expect(requests).toEqual([])
    }
  })

  test("other actions are ignored", async () => {
    const { runtime, requests } = fakeRuntime(() => noul(0.99))
    const event = evaluateEvent(["rm -rf build"], { action: "edit" })
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("allow")
    expect(requests).toEqual([])
  })

  test("an existing message stays", async () => {
    const { runtime } = fakeRuntime()
    const event = evaluateEvent(["rm -rf build"], { message: "existing" })
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("ask")
    expect(event.message).toBe("existing")
  })

  for (const error of [{ code: "timeout" }, { code: "http-error", status: 500 }, { code: "invalid-response" }, { code: "network" }, { code: "aborted" }] as const) {
    test(`failClosed asks on ${error.code}`, async () => {
      const { runtime, records } = fakeRuntime(() => ({ ok: false, error }))
      const event = evaluateEvent(["touch x"])
      await armed(runtime, options()).evaluate(event)
      expect(event.effect).toBe("ask")
      expect(event.message).not.toContain(error.code)
      expect(records[0]).toMatchObject({ errorCode: error.code, applied: true })
    })
  }

  test("failClosed false keeps allow on an upstream failure", async () => {
    const { runtime } = fakeRuntime(() => ({ ok: false, error: { code: "timeout" } }))
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options({ failClosed: false })).evaluate(event)
    expect(event.effect).toBe("allow")
  })

  test("with no TypeSafe key the existing decision stays, even with failClosed", async () => {
    const { runtime, records } = fakeRuntime(() => ({ ok: false, error: { code: "no-key" } }))
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("allow")
    expect(records[0]).toMatchObject({ errorCode: "no-key", applied: false })
  })

  test("a command above the cap is never cut: it counts as a failure", async () => {
    const { runtime, requests } = fakeRuntime()
    const long = `echo ${"a".repeat(MAX_COMMAND_CHARS)}`
    const closed = evaluateEvent([long])
    await armed(runtime, options()).evaluate(closed)
    expect(closed.effect).toBe("ask")
    const open = evaluateEvent([long])
    await armed(runtime, options({ failClosed: false })).evaluate(open)
    expect(open.effect).toBe("allow")
    expect(requests).toEqual([])
  })

  test("a destructive pattern after the cap is still found", async () => {
    const { runtime } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options({ failClosed: false }))
    handlers.before({ tool: "shell", sessionID: "ses_1", id: "call_1", input: { command: `echo ${"a".repeat(MAX_COMMAND_CHARS * 2)}; rm -rf x` } })
    const event = evaluateEvent(["echo"])
    await handlers.evaluate(event)
    expect(event.effect).toBe("ask")
  })

  test("a throw from decide becomes a failure value, not a rejection", async () => {
    const { runtime } = fakeRuntime(() => {
      throw new Error("boom")
    })
    const event = evaluateEvent(["touch x"])
    await expect(armed(runtime, options()).evaluate(event)).resolves.toBeUndefined()
    expect(event.effect).toBe("ask")
    const open = evaluateEvent(["touch x"])
    await expect(armed(runtime, options({ failClosed: false })).evaluate(open)).resolves.toBeUndefined()
    expect(open.effect).toBe("allow")
  })

  test("an invalid answer shape asks under failClosed", async () => {
    const { runtime } = fakeRuntime(() => ({
      ok: true,
      value: { model: "m", requestedModel: "m", answers: {}, cached: false, latencyMs: 1 },
    }))
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("ask")
  })

  test("shadow records and never edits, even for a destructive command or a failure", async () => {
    const shadow = options({ mode: "shadow" })
    const a = fakeRuntime(() => noul(0.99))
    const destructive = evaluateEvent(["rm -rf build"])
    await armed(a.runtime, shadow).evaluate(destructive)
    expect(destructive.effect).toBe("allow")
    expect(destructive.message).toBeUndefined()
    expect(a.records[0]).toMatchObject({ mode: "shadow", applied: false })

    const b = fakeRuntime(() => noul(0.99))
    const risky = evaluateEvent(["touch x"])
    await armed(b.runtime, shadow).evaluate(risky)
    expect(risky.effect).toBe("allow")
    expect(b.records[0]).toMatchObject({ probability: 0.99, applied: false })

    const c = fakeRuntime(() => ({ ok: false, error: { code: "timeout" } }))
    const failed = evaluateEvent(["touch x"])
    await armed(c.runtime, shadow).evaluate(failed)
    expect(failed.effect).toBe("allow")
  })

  test("a disposed runtime does nothing", async () => {
    const { runtime, requests, state } = fakeRuntime()
    state.disposed = true
    const event = evaluateEvent(["rm -rf x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("allow")
    expect(requests).toEqual([])
  })

  test("a disposed runtime that finishes an upstream call leaves the decision alone", async () => {
    const { runtime, state } = fakeRuntime(() => {
      state.disposed = true
      return noul(0.99)
    })
    const event = evaluateEvent(["touch x"])
    await armed(runtime, options()).evaluate(event)
    expect(event.effect).toBe("allow")
  })

  test("no approval is remembered: the same command asks every time", async () => {
    const { runtime } = fakeRuntime()
    const handlers = createSafetyHandlers(runtime, options())
    for (let i = 0; i < 3; i++) {
      const event = evaluateEvent(["rm -rf build"])
      await handlers.evaluate(event)
      expect(event.effect).toBe("ask")
    }
  })

  test("telemetry never carries command text", async () => {
    const { runtime, records } = fakeRuntime(() => noul(0.5))
    await armed(runtime, options()).evaluate(evaluateEvent(["touch secret-file-name"]))
    expect(JSON.stringify(records)).not.toContain("secret-file-name")
  })
})

describe("registerSafety", () => {
  const registration = (log: string[], name: string) => ({ dispose: async () => void log.push(`dispose ${name}`) })

  test("registers before, evaluate, and after", async () => {
    const log: string[] = []
    const host = (kind: string) => ({
      hook: async (name: string) => {
        log.push(`${kind}.${name}`)
        return registration(log, `${kind}.${name}`)
      },
    })
    const result = await registerSafety({ permission: host("permission"), tool: host("tool") }, fakeRuntime().runtime, options())
    expect(result.length).toBe(3)
    expect(log).toEqual(["tool.execute.before", "permission.evaluate", "tool.execute.after"])
  })

  test("a failure disposes the earlier registrations in reverse order", async () => {
    const log: string[] = []
    const tool = { hook: async (name: string) => registration(log, name) }
    const permission = {
      hook: async () => {
        throw new Error("typesafe says no")
      },
    }
    await expect(registerSafety({ permission, tool }, fakeRuntime().runtime, options())).rejects.toThrow()
    expect(log).toEqual(["dispose execute.before"])
  })
})
