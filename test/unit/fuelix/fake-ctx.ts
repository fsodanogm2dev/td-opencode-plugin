import type { Plugin } from "@opencode/plugin"

type AnyRecord = Record<string, any>

export interface FakeHook {
  readonly name: string
  readonly callback: (event: any) => void
  readonly options: { providerID?: string } | undefined
  disposed: boolean
}

export interface FakeModel extends AnyRecord {
  id: string
  cost: AnyRecord[]
  limit: AnyRecord
  capabilities: AnyRecord
  variants: AnyRecord[]
}

export interface FakeProviderRecord {
  provider: AnyRecord
  models: Map<string, FakeModel>
}

export interface FakeOptions {
  /** Inactive built-in providers, for example `{ openai: { "gpt-7-new": {...} } }`. */
  readonly upstream?: Record<string, Record<string, AnyRecord>>
  readonly storage?: Record<string, unknown>
  /** One storage map for several fake contexts, as `ctx.storage` is shared by all locations of a plugin. */
  readonly sharedStorage?: Map<string, unknown>
  readonly connectionKey?: string
  /** Provider records that `provider.get` returns, by provider ID (the client shape is `{ data }`). */
  readonly configured?: Record<string, AnyRecord>
  /** Makes `session.hook` throw for this provider ID. */
  readonly failHookFor?: string
  /** Makes `tool.transform` throw. */
  readonly failToolTransform?: boolean
  /** Makes `command.transform` throw. */
  readonly failCommandTransform?: boolean
  /** Makes `session.synthetic` reject. */
  readonly failSynthetic?: boolean | Error
  /** Location directory that `ctx.location.directory` returns. */
  readonly directory?: string
}

export interface FakeCommand {
  readonly name: string
  readonly description?: string
  readonly execute: (input: any) => Promise<void>
}

export interface FakeTool {
  readonly name: string
  readonly description: string
  readonly input: AnyRecord
  readonly execute: (input: unknown, context: any) => Promise<any>
}

/** Builds a fake plugin context. Casts once; tests read the recorded state. */
export function createFakeCtx(options: FakeOptions = {}) {
  const providers = new Map<string, FakeProviderRecord>()
  const integrationMethods: AnyRecord[] = []
  const integrationNames = new Map<string, string>()
  const hooks: FakeHook[] = []
  const aisdkHooks: FakeHook[] = []
  const storage = options.sharedStorage ?? new Map<string, unknown>()
  for (const [key, value] of Object.entries(options.storage ?? {})) storage.set(key, value)
  const providerTransforms: ((editor: any) => void)[] = []
  const integrationTransforms: ((editor: any) => void)[] = []
  const shellHooks: { name: string; callback: (event: any) => void }[] = []
  const gets: string[] = []
  const order: string[] = []
  let connectionKey = options.connectionKey
  const state = { reloads: 0, transformRuns: 0, storageWrites: 0 }
  const tools = new Map<string, FakeTool>()
  const commands = new Map<string, FakeCommand>()
  const commandRegistrations: { disposed: boolean }[] = []
  const synthetics: AnyRecord[] = []
  const toolRegistrations: { callback: (editor: any) => void; disposed: boolean }[] = []

  const seedUpstream = () => {
    for (const [providerID, models] of Object.entries(options.upstream ?? {})) {
      providers.set(providerID, {
        provider: { id: providerID, activation: "disabled" },
        models: new Map(Object.entries(models).map(([id, model]) => [id, { id, ...model } as FakeModel])),
      })
    }
  }

  const providerEditor = {
    get: (id: string) => providers.get(id),
    list: () => [...providers.values()],
    add: (input: { info: AnyRecord; models: FakeModel[] }) => {
      providers.set(input.info.id, {
        provider: structuredClone(input.info),
        models: new Map(input.models.map((model) => [model.id, structuredClone(model)])),
      })
    },
    update: () => {},
    remove: () => {},
    models: {
      set: () => {},
      remove: () => {},
      update: (providerID: string, modelID: string, update: (model: FakeModel) => void) => {
        const model = providers.get(providerID)?.models.get(modelID)
        if (model) update(model)
      },
    },
  }

  const integrationEditor = {
    get: (id: string) => (integrationNames.has(id) ? { id, name: integrationNames.get(id) } : undefined),
    list: () => [],
    update: (id: string, update: (integration: AnyRecord) => void) => {
      const integration = { id, name: integrationNames.get(id) ?? id }
      update(integration)
      integrationNames.set(id, integration.name)
    },
    remove: () => {},
    method: {
      list: () => integrationMethods,
      update: (input: AnyRecord) => void integrationMethods.push(input),
      remove: () => {},
    },
  }

  const toolEditor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => {},
    add: (tool: FakeTool) => void tools.set(tool.name, tool),
    update: () => {},
    remove: (id: string) => void tools.delete(id),
  }

  const registration = (list: unknown[], item: unknown) => {
    list.push(item)
    return { dispose: async () => {} }
  }

  const ctx = {
    location: { directory: options.directory ?? "/fake/project" },
    command: {
      transform: async (callback: (editor: any) => void) => {
        if (options.failCommandTransform) throw new Error("command transform failed")
        const entry = { disposed: false }
        commandRegistrations.push(entry)
        callback({ add: (command: FakeCommand) => void commands.set(command.name, command) })
        return {
          dispose: async () => {
            entry.disposed = true
            commands.clear()
          },
        }
      },
      list: async () => [...commands.values()],
      reload: async () => {},
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        if (options.failToolTransform) throw new Error("tool transform failed")
        const entry = { callback, disposed: false }
        toolRegistrations.push(entry)
        callback(toolEditor)
        return {
          dispose: async () => {
            entry.disposed = true
            for (const name of [...tools.keys()]) tools.delete(name)
          },
        }
      },
      list: async () => [...tools.values()],
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        integrationTransforms.push(callback)
        callback(integrationEditor)
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => (connectionKey ? { id: "connection-1" } : undefined),
        resolve: async () => (connectionKey ? { type: "key", key: connectionKey } : undefined),
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        order.push("provider.transform")
        providerTransforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads++
        runProviderTransforms()
      },
      get: async (input: { providerID: string }) => {
        gets.push(input.providerID)
        const data = options.configured?.[input.providerID]
        if (!data) throw new Error("not found")
        return { data }
      },
    },
    shell: {
      hook: async (name: string, callback: (event: any) => void) => {
        shellHooks.push({ name, callback })
        return { dispose: async () => {} }
      },
    },
    session: {
      synthetic: async (input: AnyRecord) => {
        if (options.failSynthetic) throw options.failSynthetic instanceof Error ? options.failSynthetic : new Error("synthetic failed")
        synthetics.push(input)
        return { id: "msg-synthetic", sessionID: input.sessionID, type: "synthetic" }
      },
      hook: async (name: string, callback: (event: any) => void, hookOptions?: { providerID?: string }) => {
        if (options.failHookFor && hookOptions?.providerID === options.failHookFor) throw new Error("hook failed")
        order.push(`hook:${hookOptions?.providerID ?? ""}`)
        const hook: FakeHook = { name, callback, options: hookOptions, disposed: false }
        hooks.push(hook)
        return {
          dispose: async () => {
            hook.disposed = true
          },
        }
      },
    },
    aisdk: {
      hook: async (name: string, callback: (event: any) => void, hookOptions?: { providerID?: string }) => {
        const hook: FakeHook = { name, callback, options: hookOptions, disposed: false }
        aisdkHooks.push(hook)
        return {
          dispose: async () => {
            hook.disposed = true
          },
        }
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        state.storageWrites++
        storage.set(key, structuredClone(value))
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async (scan: { prefix: string; after?: string; limit?: number }) => {
        const keys = [...storage.keys()]
          .filter((key) => key.startsWith(scan.prefix) && (scan.after === undefined || key > scan.after))
          .sort()
        const limit = scan.limit ?? keys.length
        const page = keys.slice(0, limit)
        return {
          entries: page.map((key) => ({ key, value: structuredClone(storage.get(key)) })),
          ...(keys.length > limit ? { next: page[page.length - 1] } : {}),
        }
      },
    },
  }
  void registration

  function runProviderTransforms() {
    state.transformRuns++
    providers.clear()
    seedUpstream()
    for (const callback of providerTransforms) callback(providerEditor)
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    providers,
    hooks,
    aisdkHooks,
    storage,
    state,
    integrationMethods,
    integrationNames,
    shellHooks,
    tools,
    toolRegistrations,
    commands,
    commandRegistrations,
    /** Messages that commands wrote to a session through `session.synthetic`. */
    synthetics,
    /** Runs a registered command as OpenCode does: the invocation carries the session ID, prompt payload, and delivery. */
    runCommand: async (name: string, invocation: { sessionID: string; prompt: AnyRecord; delivery?: "steer" | "queue" }) => {
      const command = commands.get(name)
      if (!command) throw new Error(`command not registered: ${name}`)
      return command.execute({ delivery: "queue", ...invocation })
    },
    /** Runs a registered tool as OpenCode does: the context carries the session ID and an abort signal. */
    runTool: async (name: string, input: unknown, context: { sessionID: string; signal?: AbortSignal }) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`tool not registered: ${name}`)
      return tool.execute(input, { agent: "build", messageID: "msg-1", id: "call-1", progress: async () => {}, signal: new AbortController().signal, ...context })
    },
    order,
    gets,
    setConnectionKey: (key: string | undefined) => {
      connectionKey = key
    },
    /** Runs the registered provider transforms against a fresh editor, as OpenCode does on load. */
    runProviderTransforms,
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
