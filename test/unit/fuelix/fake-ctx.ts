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
  readonly connectionKey?: string
}

/** Builds a fake plugin context. Casts once; tests read the recorded state. */
export function createFakeCtx(options: FakeOptions = {}) {
  const providers = new Map<string, FakeProviderRecord>()
  const integrationMethods: AnyRecord[] = []
  const integrationNames = new Map<string, string>()
  const hooks: FakeHook[] = []
  const storage = new Map<string, unknown>(Object.entries(options.storage ?? {}))
  const providerTransforms: ((editor: any) => void)[] = []
  const integrationTransforms: ((editor: any) => void)[] = []
  const state = { reloads: 0, transformRuns: 0, storageWrites: 0 }

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

  const registration = (list: unknown[], item: unknown) => {
    list.push(item)
    return { dispose: async () => {} }
  }

  const ctx = {
    integration: {
      transform: async (callback: (editor: any) => void) => {
        integrationTransforms.push(callback)
        callback(integrationEditor)
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => (options.connectionKey ? { id: "connection-1" } : undefined),
        resolve: async () => (options.connectionKey ? { type: "key", key: options.connectionKey } : undefined),
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        providerTransforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads++
        runProviderTransforms()
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => void, hookOptions?: { providerID?: string }) => {
        const hook: FakeHook = { name, callback, options: hookOptions, disposed: false }
        hooks.push(hook)
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
    storage,
    state,
    integrationMethods,
    integrationNames,
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
