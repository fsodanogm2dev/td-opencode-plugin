// service/main.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// service/backend-port.ts
import { createHash } from "node:crypto";
import { join } from "node:path";

// ../src/guards/schema.ts
var GUARD_STORE_SCHEMA = "td-guards/1";
var GUARD_RUNTIME_SCHEMA = "td-guards-runtime/1";
var LIMITS = {
  array: 16,
  guards: 256,
  activations: 1024,
  operations: 256,
  sessions: 256,
  actions: 32,
  id: 128,
  label: 120,
  summary: 1000,
  request: 4000,
  message: 500,
  program: 128,
  subcommandWords: 8,
  token: 64,
  action: 64,
  resource: 512,
  storeBytes: 4 * 1024 * 1024
};
var LIFECYCLE_REASONS = [
  "running-tracked",
  "observed-start",
  "request-completed",
  "plugin-restarted",
  "event-stream-lost",
  "run-start-unobserved",
  "shutdown",
  "descendant-never-started",
  "subagent-spawn-unobserved",
  "event-time-unknown"
];
class Errors {
  list = [];
  add(path, message) {
    if (this.list.length < 20)
      this.list.push(`${path}: ${message}`);
  }
}
function fail(errors) {
  return { ok: false, errors: errors.list.length > 0 ? errors.list : ["invalid"] };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value, required, optional, path, errors) {
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.add(path, `unknown field ${JSON.stringify(key.slice(0, 40))}`);
      ok = false;
    }
  }
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      errors.add(path, `missing field ${key}`);
      ok = false;
    }
  }
  return ok;
}
var CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
var CONTROL_ANY = /[\u0000-\u001f\u007f\u2028\u2029]/;
function text(value, path, max, errors, options = {}) {
  if (typeof value !== "string") {
    errors.add(path, "must be a string");
    return;
  }
  if (!options.allowEmpty && value.trim() === "") {
    errors.add(path, "must not be empty");
    return;
  }
  if (value.length > max) {
    errors.add(path, `must be at most ${max} characters`);
    return;
  }
  if ((options.multiline ? CONTROL : CONTROL_ANY).test(value)) {
    errors.add(path, "contains control characters");
    return;
  }
  return value;
}
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
var PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
var SUBCOMMAND_WORD = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
var FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/;
var ACTION = /^[a-z][a-z0-9_.:-]*$/;
var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function id(value, path, errors) {
  const result = text(value, path, LIMITS.id, errors);
  if (result !== undefined && !ID.test(result)) {
    errors.add(path, "has unsupported characters");
    return;
  }
  return result;
}
function iso(value, path, errors) {
  if (typeof value !== "string" || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    errors.add(path, "must be an ISO-8601 UTC timestamp");
    return;
  }
  return value;
}
function bounded(value, path, max, errors) {
  if (!Array.isArray(value)) {
    errors.add(path, "must be an array");
    return;
  }
  if (value.length > max) {
    errors.add(path, `must have at most ${max} items`);
    return;
  }
  return value;
}
function validGlob(glob) {
  return !/\*{3,}/.test(glob);
}
function parseRuleInto(input, path, errors) {
  if (!isRecord(input)) {
    errors.add(path, "must be an object");
    return;
  }
  if (input.kind === "command") {
    if (!exact(input, ["kind", "program"], ["subcommands", "flags"], path, errors))
      return;
    const program = text(input.program, `${path}.program`, LIMITS.program, errors);
    if (program !== undefined && !PROGRAM.test(program))
      errors.add(`${path}.program`, "must be an executable name without a path");
    let subcommands;
    if (input.subcommands !== undefined) {
      const list = bounded(input.subcommands, `${path}.subcommands`, LIMITS.array, errors);
      if (list) {
        subcommands = [];
        list.forEach((entry, index) => {
          const words = bounded(entry, `${path}.subcommands[${index}]`, LIMITS.subcommandWords, errors);
          if (!words)
            return;
          if (words.length === 0)
            errors.add(`${path}.subcommands[${index}]`, "must not be empty");
          const parsed = [];
          words.forEach((word, wordIndex) => {
            const value = text(word, `${path}.subcommands[${index}][${wordIndex}]`, LIMITS.token, errors);
            if (value === undefined)
              return;
            if (!SUBCOMMAND_WORD.test(value))
              errors.add(`${path}.subcommands[${index}][${wordIndex}]`, "must be a literal word");
            parsed.push(value);
          });
          subcommands.push(parsed);
        });
      }
    }
    let flags;
    if (input.flags !== undefined) {
      const list = bounded(input.flags, `${path}.flags`, LIMITS.array, errors);
      if (list) {
        flags = [];
        list.forEach((flag, index) => {
          const value = text(flag, `${path}.flags[${index}]`, LIMITS.token, errors);
          if (value === undefined)
            return;
          if (!FLAG.test(value))
            errors.add(`${path}.flags[${index}]`, "must be a literal flag such as --force or -m");
          flags.push(value);
        });
      }
    }
    if (errors.list.length > 0 || program === undefined)
      return;
    return {
      kind: "command",
      program,
      ...subcommands && subcommands.length > 0 ? { subcommands } : {},
      ...flags && flags.length > 0 ? { flags } : {}
    };
  }
  if (input.kind === "permission") {
    if (!exact(input, ["kind", "action"], ["resources"], path, errors))
      return;
    const action = text(input.action, `${path}.action`, LIMITS.action, errors);
    if (action !== undefined && !ACTION.test(action))
      errors.add(`${path}.action`, "must be an exact action name");
    let resources;
    if (input.resources !== undefined) {
      const list = bounded(input.resources, `${path}.resources`, LIMITS.array, errors);
      if (list) {
        resources = [];
        list.forEach((resource, index) => {
          const value = text(resource, `${path}.resources[${index}]`, LIMITS.resource, errors);
          if (value === undefined)
            return;
          if (!validGlob(value))
            errors.add(`${path}.resources[${index}]`, "has an unsupported glob");
          resources.push(value);
        });
      }
    }
    if (errors.list.length > 0 || action === undefined)
      return;
    return { kind: "permission", action, ...resources && resources.length > 0 ? { resources } : {} };
  }
  errors.add(`${path}.kind`, 'must be "command" or "permission"');
  return;
}
function parseRules(input, path, errors) {
  const list = bounded(input, path, LIMITS.array, errors);
  if (!list)
    return;
  if (list.length === 0) {
    errors.add(path, "must have at least one rule");
    return;
  }
  const rules = [];
  list.forEach((entry, index) => {
    const rule = parseRuleInto(entry, `${path}[${index}]`, errors);
    if (rule)
      rules.push(rule);
  });
  return rules;
}
function draftFields(input, path, errors) {
  const label = text(input.label, `${path}.label`, LIMITS.label, errors);
  const summary = text(input.summary, `${path}.summary`, LIMITS.summary, errors, { multiline: true });
  const request = text(input.request, `${path}.request`, LIMITS.request, errors, { multiline: true });
  const message = text(input.message, `${path}.message`, LIMITS.message, errors);
  const rules = parseRules(input.rules, `${path}.rules`, errors);
  if (label === undefined || summary === undefined || request === undefined || message === undefined || rules === undefined)
    return;
  return { label, summary, request, message, rules };
}
function validateGuardDraft(input) {
  const errors = new Errors;
  if (!isRecord(input))
    return { ok: false, errors: ["draft: must be an object"] };
  if (!exact(input, ["label", "summary", "request", "message", "rules"], [], "draft", errors))
    return fail(errors);
  const draft = draftFields(input, "draft", errors);
  return draft && errors.list.length === 0 ? { ok: true, value: draft } : fail(errors);
}
function parseGuard(input, path, errors) {
  if (!isRecord(input)) {
    errors.add(path, "must be an object");
    return;
  }
  if (!exact(input, ["id", "label", "summary", "request", "message", "rules", "createdAt", "updatedAt"], [], path, errors))
    return;
  const guardId = id(input.id, `${path}.id`, errors);
  const draft = draftFields(input, path, errors);
  const createdAt = iso(input.createdAt, `${path}.createdAt`, errors);
  const updatedAt = iso(input.updatedAt, `${path}.updatedAt`, errors);
  if (!guardId || !draft || !createdAt || !updatedAt)
    return;
  return { id: guardId, ...draft, createdAt, updatedAt };
}
function parseActivation(input, path, errors) {
  if (!isRecord(input)) {
    errors.add(path, "must be an object");
    return;
  }
  if (!exact(input, ["id", "guardId", "sessionId", "scope", "createdAt", "expiresAt"], ["guardUpdatedAt", "snapshot"], path, errors))
    return;
  const activationId = id(input.id, `${path}.id`, errors);
  const guardId = id(input.guardId, `${path}.guardId`, errors);
  const sessionId = id(input.sessionId, `${path}.sessionId`, errors);
  let scope;
  if (input.scope === "session" || input.scope === "request")
    scope = input.scope;
  else
    errors.add(`${path}.scope`, 'must be "session" or "request"');
  const createdAt = iso(input.createdAt, `${path}.createdAt`, errors);
  let expiresAt;
  if (input.expiresAt === null)
    expiresAt = null;
  else
    expiresAt = iso(input.expiresAt, `${path}.expiresAt`, errors);
  let guardUpdatedAt;
  if (input.guardUpdatedAt !== undefined)
    guardUpdatedAt = iso(input.guardUpdatedAt, `${path}.guardUpdatedAt`, errors);
  let snapshot;
  if (input.snapshot !== undefined) {
    const raw = input.snapshot;
    if (!isRecord(raw))
      errors.add(`${path}.snapshot`, "must be an object");
    else if (exact(raw, ["label", "message", "rules"], [], `${path}.snapshot`, errors)) {
      const label = text(raw.label, `${path}.snapshot.label`, LIMITS.label, errors);
      const message = text(raw.message, `${path}.snapshot.message`, LIMITS.message, errors);
      const rules = parseRules(raw.rules, `${path}.snapshot.rules`, errors);
      if (label !== undefined && message !== undefined && rules)
        snapshot = { label, message, rules };
    }
  }
  if (!activationId || !guardId || !sessionId || !scope || !createdAt || expiresAt === undefined)
    return;
  if (input.guardUpdatedAt !== undefined && guardUpdatedAt === undefined)
    return;
  if (input.snapshot !== undefined && snapshot === undefined)
    return;
  return {
    id: activationId,
    guardId,
    sessionId,
    scope,
    createdAt,
    expiresAt,
    ...guardUpdatedAt ? { guardUpdatedAt } : {},
    ...snapshot ? { snapshot } : {}
  };
}
function parseGuardStore(input) {
  const errors = new Errors;
  if (!isRecord(input))
    return { ok: false, errors: ["store: must be an object"] };
  if (!exact(input, ["schema", "revision", "guards", "activations"], ["operations"], "store", errors))
    return fail(errors);
  if (input.schema !== GUARD_STORE_SCHEMA)
    errors.add("store.schema", `must be ${GUARD_STORE_SCHEMA}`);
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0)
    errors.add("store.revision", "must be a non-negative integer");
  const guardList = bounded(input.guards, "store.guards", LIMITS.guards, errors);
  const activationList = bounded(input.activations, "store.activations", LIMITS.activations, errors);
  const guards = [];
  const guardIds = new Set;
  guardList?.forEach((entry, index) => {
    const guard = parseGuard(entry, `store.guards[${index}]`, errors);
    if (!guard)
      return;
    if (guardIds.has(guard.id))
      errors.add(`store.guards[${index}].id`, "is duplicated");
    guardIds.add(guard.id);
    guards.push(guard);
  });
  const activations = [];
  const activationIds = new Set;
  activationList?.forEach((entry, index) => {
    const activation = parseActivation(entry, `store.activations[${index}]`, errors);
    if (!activation)
      return;
    if (activationIds.has(activation.id))
      errors.add(`store.activations[${index}].id`, "is duplicated");
    activationIds.add(activation.id);
    activations.push(activation);
  });
  let operations;
  if (input.operations !== undefined) {
    const list = bounded(input.operations, "store.operations", LIMITS.operations, errors);
    if (list) {
      operations = [];
      list.forEach((entry, index) => {
        const path = `store.operations[${index}]`;
        if (!isRecord(entry))
          return errors.add(path, "must be an object");
        if (!exact(entry, ["opId"], ["result"], path, errors))
          return;
        const opId = id(entry.opId, `${path}.opId`, errors);
        if (opId)
          operations.push({ opId, result: entry.result });
      });
    }
  }
  if (errors.list.length > 0)
    return fail(errors);
  return {
    ok: true,
    value: {
      schema: GUARD_STORE_SCHEMA,
      revision: input.revision,
      guards,
      activations,
      ...operations ? { operations } : {}
    }
  };
}
function parseGuardStoreText(source) {
  if (new TextEncoder().encode(source).length > LIMITS.storeBytes)
    return { ok: false, errors: ["store: file is too large"] };
  let json;
  try {
    json = JSON.parse(source);
  } catch {
    return { ok: false, errors: ["store: not valid JSON"] };
  }
  return parseGuardStore(json);
}
function emptyGuardStore() {
  return { schema: GUARD_STORE_SCHEMA, revision: 0, guards: [], activations: [] };
}
var STORE_STATES = ["missing", "ready", "invalid", "unavailable"];
var ACTIVITIES = ["running", "idle", "unknown"];
function parseRuntimeReport(input) {
  const errors = new Errors;
  if (!isRecord(input))
    return { ok: false, errors: ["report: must be an object"] };
  const keys = ["schema", "directory", "instanceId", "registered", "recordedAt", "storeState", "revision", "blockedCount", "uncertainCount", "coveredActions", "sessions"];
  if (!exact(input, keys, [], "report", errors))
    return fail(errors);
  if (input.schema !== GUARD_RUNTIME_SCHEMA)
    errors.add("report.schema", `must be ${GUARD_RUNTIME_SCHEMA}`);
  const directory = input.directory === null ? null : text(input.directory, "report.directory", 4096, errors);
  const instanceId = id(input.instanceId, "report.instanceId", errors);
  if (typeof input.registered !== "boolean")
    errors.add("report.registered", "must be a boolean");
  const recordedAt = iso(input.recordedAt, "report.recordedAt", errors);
  if (typeof input.storeState !== "string" || !STORE_STATES.includes(input.storeState))
    errors.add("report.storeState", "is not a known state");
  if (input.revision !== null && !(typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 0))
    errors.add("report.revision", "must be null or a non-negative integer");
  for (const key of ["blockedCount", "uncertainCount"]) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      errors.add(`report.${key}`, "must be a non-negative integer");
  }
  const covered = bounded(input.coveredActions, "report.coveredActions", LIMITS.actions, errors);
  const coveredActions = [];
  covered?.forEach((action, index) => {
    const value = text(action, `report.coveredActions[${index}]`, LIMITS.action, errors);
    if (value !== undefined)
      coveredActions.push(value);
  });
  const list = bounded(input.sessions, "report.sessions", LIMITS.sessions, errors);
  const sessions = [];
  list?.forEach((entry, index) => {
    const path = `report.sessions[${index}]`;
    if (!isRecord(entry))
      return errors.add(path, "must be an object");
    if (!exact(entry, ["id", "parentId", "activity"], [], path, errors))
      return;
    const sessionId = id(entry.id, `${path}.id`, errors);
    const parentId = entry.parentId === null ? null : id(entry.parentId, `${path}.parentId`, errors);
    if (typeof entry.activity !== "string" || !ACTIVITIES.includes(entry.activity))
      errors.add(`${path}.activity`, "is not a known activity");
    if (sessionId && parentId !== undefined && typeof entry.activity === "string" && ACTIVITIES.includes(entry.activity)) {
      sessions.push({ id: sessionId, parentId, activity: entry.activity });
    }
  });
  if (errors.list.length > 0 || directory === undefined || !instanceId || !recordedAt)
    return fail(errors);
  return {
    ok: true,
    value: {
      schema: GUARD_RUNTIME_SCHEMA,
      directory,
      instanceId,
      registered: input.registered,
      recordedAt,
      storeState: input.storeState,
      revision: input.revision,
      blockedCount: input.blockedCount,
      uncertainCount: input.uncertainCount,
      coveredActions,
      sessions
    }
  };
}
function parseLifecycleFact(input) {
  const errors = new Errors;
  if (!isRecord(input))
    return { ok: false, errors: ["fact: must be an object"] };
  if (!exact(input, ["activationId", "fact", "at", "reason", "instance"], [], "fact", errors))
    return fail(errors);
  const activationId = id(input.activationId, "fact.activationId", errors);
  if (input.fact !== "bound" && input.fact !== "ended" && input.fact !== "uncertain")
    errors.add("fact.fact", "is not a known fact");
  const at = iso(input.at, "fact.at", errors);
  if (typeof input.reason !== "string" || !LIFECYCLE_REASONS.includes(input.reason))
    errors.add("fact.reason", "is not a known reason");
  const instance = id(input.instance, "fact.instance", errors);
  if (errors.list.length > 0 || !activationId || !at || !instance)
    return fail(errors);
  return {
    ok: true,
    value: { activationId, fact: input.fact, at, reason: input.reason, instance }
  };
}
function parseLifecycleLine(line) {
  if (line.length === 0 || line.length > 2048)
    return;
  try {
    const result = parseLifecycleFact(JSON.parse(line));
    return result.ok ? result.value : undefined;
  } catch {
    return;
  }
}

// service/backend-port.ts
var guardsDir = (root) => join(root, "guards");
var backendSchema = {
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
  runtimePath: (root, directory) => join(guardsDir(root), "runtime", directory === null ? "global.json" : `${createHash("sha256").update(directory, "utf8").digest("hex")}.json`)
};

// service/app.ts
import { createHash as createHash2, timingSafeEqual } from "node:crypto";

// service/contract.ts
var MESSAGES = {
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
  CONFIRMATION_REQUIRED: "Resetting replaces the guard store for all projects: every saved guard and activation is removed, and the old file is kept as a private backup. Send the confirmation to continue.",
  RECOVERY_NOT_NEEDED: "The guard store is readable, so nothing was reset.",
  STORE_UNAVAILABLE: "The guard store cannot be read or written.",
  OUTCOME_UNKNOWN: "The change may already be applied. Reload the guard data or retry the same request.",
  SESSION_BRIDGE_UNAVAILABLE: "OpenCode access is unavailable, so the session cannot be verified.",
  SESSION_LOOKUP_FAILED: "OpenCode did not answer the session lookup.",
  INTERNAL_ERROR: "The guard service failed unexpectedly."
};
var STATUS = {
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
  INTERNAL_ERROR: 503
};

class ApiError extends Error {
  code;
  status;
  constructor(code) {
    super(MESSAGES[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
  }
}

// ../src/guards/lifecycle-state.ts
function resolveActivationLifecycle(activation, facts) {
  if (activation.scope !== "request")
    return { phase: "session", reason: null, instance: null, releasable: false, conflict: false };
  const created = Date.parse(activation.createdAt);
  const instances = new Map;
  let latestUncertain;
  let latestBound;
  for (const fact of facts) {
    if (fact.activationId !== activation.id)
      continue;
    const at = Date.parse(fact.at);
    if (Number.isNaN(at) || Number.isNaN(created) || at < created)
      continue;
    const current = instances.get(fact.instance);
    if (fact.fact === "bound") {
      if (current)
        continue;
      instances.set(fact.instance, { state: "bound", reason: fact.reason });
      latestBound = { reason: fact.reason, instance: fact.instance };
    } else if (fact.fact === "ended") {
      if (!current || current.state !== "bound")
        continue;
      if (fact.reason !== "request-completed")
        continue;
      instances.set(fact.instance, { state: "ended", reason: fact.reason });
    } else {
      if (current?.state === "uncertain")
        continue;
      instances.set(fact.instance, { state: "uncertain", reason: fact.reason });
      latestUncertain = { reason: fact.reason, instance: fact.instance };
    }
  }
  let clean;
  for (const [instance, entry] of instances) {
    if (entry.state === "ended") {
      clean = { reason: entry.reason, instance };
      break;
    }
  }
  if (clean) {
    const conflict = [...instances.entries()].some(([instance, entry]) => entry.state === "uncertain" && instance !== clean.instance);
    return { phase: "ended", reason: clean.reason, instance: clean.instance, releasable: true, conflict };
  }
  if (latestUncertain)
    return { phase: "uncertain", reason: latestUncertain.reason, instance: latestUncertain.instance, releasable: false, conflict: false };
  if (latestBound)
    return { phase: "bound", reason: latestBound.reason, instance: latestBound.instance, releasable: false, conflict: false };
  return { phase: "pending", reason: null, instance: null, releasable: false, conflict: false };
}
function resolveLifecycles(activations, facts) {
  const byActivation = new Map;
  for (const fact of facts) {
    const list = byActivation.get(fact.activationId);
    if (list)
      list.push(fact);
    else
      byActivation.set(fact.activationId, [fact]);
  }
  return new Map(activations.map((activation) => [activation.id, resolveActivationLifecycle(activation, byActivation.get(activation.id) ?? [])]));
}

// ../src/guards/lifecycle-history.ts
var LIFECYCLE_TAIL_BYTES = 1024 * 1024;
var EMPTY_READING = { facts: [], gaps: [], truncated: false, partialTail: false };
var UNREADABLE_READING = { facts: [], gaps: [], truncated: true, partialTail: false };
function parseLifecycleText(text2, truncated) {
  const lines = text2.split(`
`);
  const unterminated = !text2.endsWith(`
`);
  const last = unterminated ? lines.pop() : (lines.pop(), undefined);
  if (truncated)
    lines.shift();
  const facts = [];
  const gaps = [];
  const consume = (line) => {
    if (line.trim() === "")
      return true;
    const fact = parseLifecycleLine(line);
    if (fact === undefined)
      return false;
    facts.push(fact);
    return true;
  };
  for (const line of lines)
    if (!consume(line))
      gaps.push(facts.length);
  let partialTail = false;
  if (last !== undefined && last.trim() !== "") {
    if (!consume(last))
      partialTail = true;
  }
  return { facts, gaps, truncated, partialTail };
}
function resolveLifecycleViews(activations, reading) {
  const resolutions = resolveLifecycles(activations, reading.facts);
  const firstVisible = reading.facts.length > 0 ? Date.parse(reading.facts[0].at) : Number.NaN;
  return activations.map((activation) => {
    const resolution = resolutions.get(activation.id);
    let trust = "ok";
    if (resolution.phase !== "ended" && resolution.phase !== "session") {
      if (reading.facts.some((fact) => fact.activationId === activation.id && fact.fact === "ended"))
        trust = "unverified-end";
      else if (resolution.phase === "pending" && reading.truncated && !(Date.parse(activation.createdAt) >= firstVisible))
        trust = "history-truncated";
    }
    return { ...resolution, activationId: activation.id, trust };
  });
}
function releasedActivationIds(activations, reading) {
  return new Set(resolveLifecycleViews(activations, reading).filter((view) => view.releasable).map((view) => view.activationId));
}

// service/runtime-reader.ts
var HEARTBEAT_STALE_MS = 60000;
var MAX_RUNTIME_BYTES = 1024 * 1024;
async function readRuntime(runtime, schema, root, directory) {
  let text2;
  try {
    text2 = await runtime.fs.readText(schema.runtimePath(root, directory));
  } catch {
    return { status: "invalid", report: null };
  }
  if (text2 === null)
    return { status: "missing", report: null };
  if (text2.length > MAX_RUNTIME_BYTES)
    return { status: "invalid", report: null };
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    return { status: "invalid", report: null };
  }
  const parsed = schema.parseRuntime(json);
  if (!parsed.ok)
    return { status: "invalid", report: null };
  const recorded = Date.parse(parsed.value.recordedAt);
  const age = runtime.now() - recorded;
  if (!Number.isFinite(recorded) || age > HEARTBEAT_STALE_MS || -age > HEARTBEAT_STALE_MS) {
    return { status: "stale", report: null };
  }
  return { status: "live", report: parsed.value };
}
async function readLifecycle(runtime, schema, root) {
  let tail;
  try {
    tail = await runtime.fs.readTail(schema.lifecyclePath(root), LIFECYCLE_TAIL_BYTES);
  } catch {
    return UNREADABLE_READING;
  }
  if (tail === null)
    return EMPTY_READING;
  return parseLifecycleText(tail.text, tail.truncated);
}

// service/session.ts
var SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
var MAX_DEPTH = 32;
var MAX_RESPONSE_BYTES = 1024 * 1024;
function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
function loopbackBase(raw) {
  if (!raw)
    return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== "")
    return null;
  return url;
}
function pick(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value;
  if (typeof record.id === "string")
    return record;
  const inner = record.data;
  if (typeof inner === "object" && inner !== null && typeof inner.id === "string") {
    return inner;
  }
  return null;
}
function createSessionBridge(env, fetchImpl = fetch, timeoutMs = 5000) {
  const base = loopbackBase(env.OPENCHAMBER_OPENCODE_URL);
  const token = env.OPENCHAMBER_SERVICE_TOKEN;
  if (!base || !token)
    return null;
  return {
    async get(sessionId) {
      if (!isSessionId(sessionId))
        throw new ApiError("INVALID_REQUEST");
      const url = new URL(`/api/session/${encodeURIComponent(sessionId)}`, base);
      if (url.origin !== base.origin || !url.pathname.startsWith("/api/session/")) {
        throw new ApiError("SESSION_BRIDGE_UNAVAILABLE");
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED");
      }
      if (response.status === 404)
        return null;
      if (response.status === 401 || response.status === 403)
        throw new ApiError("SESSION_BRIDGE_UNAVAILABLE");
      if (!response.ok)
        throw new ApiError("SESSION_LOOKUP_FAILED");
      let text2;
      try {
        text2 = await response.text();
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED");
      }
      if (text2.length > MAX_RESPONSE_BYTES)
        throw new ApiError("SESSION_LOOKUP_FAILED");
      let json;
      try {
        json = JSON.parse(text2);
      } catch {
        throw new ApiError("SESSION_LOOKUP_FAILED");
      }
      const record = pick(json);
      if (!record || record.id !== sessionId)
        throw new ApiError("SESSION_LOOKUP_FAILED");
      const parent = record.parentID;
      if (parent !== undefined && parent !== null && !isSessionId(parent))
        throw new ApiError("SESSION_LOOKUP_FAILED");
      const directory = typeof record.directory === "string" && record.directory.length > 0 ? record.directory : null;
      return { id: sessionId, parentId: typeof parent === "string" ? parent : null, directory };
    }
  };
}
async function resolveChain(bridge, sessionId) {
  const first = await bridge.get(sessionId);
  if (first === null)
    return null;
  const chain = [first];
  const seen = new Set([first.id]);
  let current = first;
  while (current.parentId !== null) {
    if (chain.length >= MAX_DEPTH || seen.has(current.parentId))
      throw new ApiError("SESSION_LOOKUP_FAILED");
    const parent = await bridge.get(current.parentId);
    if (parent === null)
      throw new ApiError("SESSION_LOOKUP_FAILED");
    chain.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return { chain, root: current, selected: first };
}

// service/store.ts
import { join as join2 } from "node:path";

// service/ports.ts
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
function code(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
function errorCode(error) {
  return code(error);
}
async function readTailFrom(handle, bytes) {
  const { size } = await handle.stat();
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, size - length + total);
    if (bytesRead === 0)
      break;
    total += bytesRead;
  }
  return { text: buffer.subarray(0, total).toString("utf8"), truncated: size > bytes };
}
var nodeFs = {
  async readText(path) {
    try {
      return await fsp.readFile(path, "utf8");
    } catch (error) {
      if (code(error) === "ENOENT")
        return null;
      throw error;
    }
  },
  async readTail(path, bytes) {
    let handle;
    try {
      handle = await fsp.open(path, "r");
    } catch (error) {
      if (code(error) === "ENOENT")
        return null;
      throw error;
    }
    try {
      return await readTailFrom(handle, bytes);
    } finally {
      await handle.close();
    }
  },
  async writeNew(path, text2, mode) {
    const handle = await fsp.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      await handle.writeFile(text2, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async link(from, to) {
    await fsp.link(from, to);
  },
  async mkdirp(path, mode) {
    await fsp.mkdir(path, { recursive: true, mode });
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async removeFile(path) {
    await fsp.rm(path, { force: true });
  },
  async chmod(path, mode) {
    await fsp.chmod(path, mode);
  },
  async removeDir(path) {
    await fsp.rm(path, { recursive: true, force: true });
  },
  async syncDir(path) {
    const handle = await fsp.open(path, "r");
    try {
      await handle.sync();
    } catch (error) {
      if (code(error) !== "EINVAL" && code(error) !== "EPERM" && code(error) !== "ENOTSUP")
        throw error;
    } finally {
      await handle.close();
    }
  },
  async list(path) {
    try {
      return await fsp.readdir(path);
    } catch (error) {
      if (code(error) === "ENOENT")
        return [];
      throw error;
    }
  },
  async mtimeMs(path) {
    try {
      return (await fsp.stat(path)).mtimeMs;
    } catch (error) {
      if (code(error) === "ENOENT")
        return null;
      throw error;
    }
  }
};
var nodeProcess = {
  pid: process.pid,
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
      return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return code(error) === "EPERM";
    }
  },
  startToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
      return null;
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      return out === "" ? null : out;
    } catch {
      return null;
    }
  }
};
function nodeRuntime() {
  return {
    fs: nodeFs,
    proc: nodeProcess,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uuid: () => randomUUID(),
    token: () => randomBytes(12).toString("hex")
  };
}

// service/lock.ts
function parseOwner(text2) {
  if (text2 === null)
    return null;
  try {
    const value = JSON.parse(text2);
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && typeof value.token === "string" && value.token.length > 0 && (value.startToken === null || typeof value.startToken === "string") && typeof value.acquiredAt === "string") {
      return { pid: value.pid, token: value.token, startToken: value.startToken, acquiredAt: value.acquiredAt };
    }
  } catch {}
  return null;
}
function isBusy(error) {
  return errorCode(error) === "EEXIST";
}
async function tryCreate(runtime, target, owner) {
  const staging = `${target}.new-${owner.pid}-${owner.token}`;
  await runtime.fs.writeNew(staging, JSON.stringify(owner), 384);
  try {
    await runtime.fs.link(staging, target);
    return true;
  } catch (error) {
    if (isBusy(error))
      return false;
    throw error;
  } finally {
    await runtime.fs.removeFile(staging).catch(() => {
      return;
    });
  }
}
function ownerIsDead(runtime, owner) {
  if (!runtime.proc.isAlive(owner.pid))
    return true;
  if (owner.startToken !== null) {
    const current = runtime.proc.startToken(owner.pid);
    if (current !== null && current !== owner.startToken)
      return true;
  }
  return false;
}
async function readOwner(runtime, target) {
  return parseOwner(await runtime.fs.readText(target));
}
async function discard(runtime, target, token) {
  const grave = `${target}.dead-${token}`;
  try {
    await runtime.fs.rename(target, grave);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return;
    throw error;
  }
  await runtime.fs.removeFile(grave).catch(() => {
    return;
  });
}
async function reclaim(runtime, path, dead, me) {
  const guardPath = `${path}.reclaim`;
  const guardOwner = { ...me, token: runtime.token() };
  const got = await tryCreate(runtime, guardPath, guardOwner);
  if (!got) {
    const other = await readOwner(runtime, guardPath);
    if (other !== null && ownerIsDead(runtime, other)) {
      const again = await readOwner(runtime, guardPath);
      if (again !== null && again.token === other.token)
        await discard(runtime, guardPath, guardOwner.token);
    }
    return false;
  }
  try {
    const current = await readOwner(runtime, path);
    if (current !== null && current.token === dead.token && ownerIsDead(runtime, current)) {
      await discard(runtime, path, guardOwner.token);
      return true;
    }
    return false;
  } finally {
    await discard(runtime, guardPath, guardOwner.token).catch(() => {
      return;
    });
  }
}
async function acquireLock(options) {
  const { runtime, path } = options;
  const timeoutMs = options.timeoutMs ?? 2000;
  const pollMs = options.pollMs ?? 15;
  const me = {
    pid: runtime.proc.pid,
    token: runtime.token(),
    startToken: runtime.proc.startToken(runtime.proc.pid),
    acquiredAt: new Date(runtime.now()).toISOString()
  };
  const deadline = runtime.now() + timeoutMs;
  for (;; ) {
    if (await tryCreate(runtime, path, me))
      break;
    const owner = await readOwner(runtime, path);
    if (owner !== null && ownerIsDead(runtime, owner)) {
      if (await reclaim(runtime, path, owner, me) && runtime.now() < deadline)
        continue;
    }
    if (runtime.now() >= deadline)
      throw new ApiError("LOCK_TIMEOUT");
    await runtime.sleep(pollMs);
  }
  return {
    owner: me,
    async assertHeld() {
      const current = await readOwner(runtime, path);
      if (current === null || current.token !== me.token)
        throw new ApiError("LOCK_LOST");
    }
  };
}
async function releaseLock(runtime, path, lock) {
  const current = await readOwner(runtime, path);
  if (current === null || current.token !== lock.owner.token)
    return;
  await discard(runtime, path, lock.owner.token);
}
async function withLock(options, fn) {
  const lock = await acquireLock(options);
  try {
    return await fn(lock);
  } finally {
    await releaseLock(options.runtime, options.path, lock).catch(() => {
      return;
    });
  }
}

// service/store.ts
function isStoredOutcome(value) {
  return typeof value === "object" && value !== null && typeof value.fingerprint === "string";
}
function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
function rawRevision(text2) {
  try {
    const value = JSON.parse(text2)?.revision;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

class Store {
  runtime;
  schema;
  root;
  lockTimeoutMs;
  queue = Promise.resolve();
  constructor(options) {
    this.runtime = options.runtime;
    this.schema = options.schema;
    this.root = options.root;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  }
  get dir() {
    return this.schema.guardsDir(this.root);
  }
  get storePath() {
    return this.schema.storePath(this.root);
  }
  get lockPath() {
    return join2(this.dir, "store.lock");
  }
  async read() {
    let text2;
    try {
      text2 = await this.runtime.fs.readText(this.storePath);
    } catch {
      throw new ApiError("STORE_UNAVAILABLE");
    }
    if (text2 === null)
      return this.schema.emptyStore();
    const parsed = this.schema.parseStoreText(text2);
    if (!parsed.ok)
      throw new ApiError("STORE_CORRUPT");
    return parsed.value;
  }
  transact(input, ended) {
    const run = this.queue.then(async () => {
      try {
        return await this.transactLocked(input, ended);
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError("STORE_UNAVAILABLE");
      }
    });
    this.queue = run.catch(() => {
      return;
    });
    return run;
  }
  async transactLocked(input, ended) {
    const { runtime } = this;
    try {
      await runtime.fs.mkdirp(this.dir, 448);
    } catch {
      throw new ApiError("STORE_UNAVAILABLE");
    }
    return withLock({ runtime, path: this.lockPath, timeoutMs: this.lockTimeoutMs }, async (lock) => {
      await this.sweepGarbage();
      const doc = await this.read();
      const replay = (doc.operations ?? []).find((op) => op.opId === input.opId);
      if (replay) {
        if (!isStoredOutcome(replay.result) || replay.result.fingerprint !== input.fingerprint) {
          throw new ApiError("OP_ID_REUSED");
        }
        const result2 = input.replay ? input.replay(replay.result.data, doc) : replay.result.data;
        return { revision: doc.revision, result: result2, replayed: true };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== doc.revision) {
        throw new ApiError("STALE_REVISION");
      }
      const now = new Date(runtime.now());
      const draft = { guards: [...doc.guards], activations: [...doc.activations], changed: false };
      const pruned = this.prune(draft, now, await ended(draft.activations));
      const result = input.apply(draft, { now, revision: doc.revision });
      if (!draft.changed && !pruned)
        return { revision: doc.revision, result, replayed: false };
      const stored = {
        opId: input.opId,
        result: { fingerprint: input.fingerprint, data: input.record ? input.record(result) : result }
      };
      let operations = [...doc.operations ?? [], stored].slice(-this.schema.maxOperations);
      const build = () => ({
        schema: "td-guards/1",
        revision: doc.revision + 1,
        guards: draft.guards,
        activations: draft.activations,
        operations
      });
      let next = build();
      while (Buffer.byteLength(JSON.stringify(next, null, 2), "utf8") > this.schema.maxStoreBytes && operations.length > 1) {
        operations = operations.slice(Math.ceil(operations.length / 2));
        next = build();
      }
      if (Buffer.byteLength(JSON.stringify(next, null, 2), "utf8") > this.schema.maxStoreBytes) {
        throw new ApiError("LIMIT_REACHED");
      }
      if (!this.schema.parseStore(next).ok)
        throw new ApiError("INTERNAL_ERROR");
      await this.write(next, doc.revision, lock);
      return { revision: next.revision, result, replayed: false };
    });
  }
  prune(draft, now, ended) {
    const before = draft.activations.length;
    draft.activations = draft.activations.filter((activation) => {
      if (ended.has(activation.id))
        return false;
      return activation.expiresAt === null || Date.parse(activation.expiresAt) > now.getTime();
    });
    return draft.activations.length !== before;
  }
  async sweepGarbage() {
    const { fs } = this.runtime;
    let names;
    try {
      names = await fs.list(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const stale = name.startsWith("store.json.tmp-") || name.startsWith("store.lock.new-") || name.startsWith("store.lock.dead-");
      if (!stale)
        continue;
      const path = join2(this.dir, name);
      if (name.startsWith("store.json.tmp-") || !this.stagingIsLive(name))
        await fs.removeFile(path).catch(() => {
          return;
        });
    }
  }
  stagingIsLive(name) {
    const match = /^store\.lock\.(?:new|dead)-(\d+)-/.exec(name);
    const pid = match ? Number(match[1]) : NaN;
    return Number.isInteger(pid) && this.runtime.proc.isAlive(pid);
  }
  async write(next, baseRevision, lock) {
    const { fs } = this.runtime;
    const tmp = join2(this.dir, `store.json.tmp-${this.runtime.proc.pid}-${this.runtime.token()}`);
    let committed = false;
    try {
      await fs.writeNew(tmp, `${JSON.stringify(next, null, 2)}
`, 384);
      await lock.assertHeld();
      const current = await this.read();
      if (current.revision !== baseRevision)
        throw new ApiError("LOCK_LOST");
      await fs.rename(tmp, this.storePath);
      committed = true;
      await fs.syncDir(this.dir);
    } catch (error) {
      await fs.removeFile(tmp).catch(() => {
        return;
      });
      if (committed)
        throw new ApiError("OUTCOME_UNKNOWN");
      if (error instanceof ApiError)
        throw error;
      throw new ApiError("STORE_UNAVAILABLE");
    }
  }
  recover(input) {
    const run = this.queue.then(async () => {
      try {
        return await this.recoverLocked(input);
      } catch (error) {
        throw error instanceof ApiError ? error : new ApiError("STORE_UNAVAILABLE");
      }
    });
    this.queue = run.catch(() => {
      return;
    });
    return run;
  }
  async recoverLocked(input) {
    const { runtime } = this;
    try {
      await runtime.fs.mkdirp(this.dir, 448);
    } catch {
      throw new ApiError("STORE_UNAVAILABLE");
    }
    return withLock({ runtime, path: this.lockPath, timeoutMs: this.lockTimeoutMs }, async (lock) => {
      await this.sweepGarbage();
      let text2 = null;
      let unreadable = false;
      try {
        text2 = await runtime.fs.readText(this.storePath);
      } catch {
        unreadable = true;
      }
      if (!unreadable) {
        if (text2 === null)
          throw new ApiError("RECOVERY_NOT_NEEDED");
        const parsed = this.schema.parseStoreText(text2);
        if (parsed.ok) {
          const replay = (parsed.value.operations ?? []).find((op) => op.opId === input.opId);
          if (!replay)
            throw new ApiError("RECOVERY_NOT_NEEDED");
          if (!isStoredOutcome(replay.result) || replay.result.fingerprint !== input.fingerprint) {
            throw new ApiError("OP_ID_REUSED");
          }
          return { revision: parsed.value.revision, result: replay.result.data, replayed: true };
        }
      }
      const known = text2 === null ? null : rawRevision(text2);
      const epochSeconds = Math.floor(runtime.now() / 1000);
      const revision = Math.max(known === null ? 0 : known + 1, epochSeconds);
      const backup = `store.corrupt-${utcStamp(runtime.now())}-${runtime.token()}.json`;
      const result = { recovered: true, backup };
      const next = {
        schema: "td-guards/1",
        revision,
        guards: [],
        activations: [],
        operations: [{ opId: input.opId, result: { fingerprint: input.fingerprint, data: result } }]
      };
      if (!this.schema.parseStore(next).ok)
        throw new ApiError("INTERNAL_ERROR");
      await this.replaceCorrupt(next, backup, lock);
      return { revision, result, replayed: false };
    });
  }
  async replaceCorrupt(next, backup, lock) {
    const { fs } = this.runtime;
    const tmp = join2(this.dir, `store.json.tmp-${this.runtime.proc.pid}-${this.runtime.token()}`);
    const backupPath = join2(this.dir, backup);
    let linked = false;
    let committed = false;
    try {
      await fs.writeNew(tmp, `${JSON.stringify(next, null, 2)}
`, 384);
      await fs.link(this.storePath, backupPath);
      linked = true;
      await fs.chmod(backupPath, 384);
      await lock.assertHeld();
      await fs.rename(tmp, this.storePath);
      committed = true;
      await fs.syncDir(this.dir);
    } catch (error) {
      await fs.removeFile(tmp).catch(() => {
        return;
      });
      if (committed)
        throw new ApiError("OUTCOME_UNKNOWN");
      if (linked)
        await fs.removeFile(backupPath).catch(() => {
          return;
        });
      if (error instanceof ApiError)
        throw error;
      throw new ApiError("STORE_UNAVAILABLE");
    }
  }
}

// service/app.ts
var MAX_BODY_BYTES = 64 * 1024;
var RESET_CONFIRMATION = "reset-global-guards";
var MAX_EXPIRY_MINUTES = 60 * 24 * 30;
var MAX_DIRECTORY_LENGTH = 4096;
var OP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
var ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
function digest(value) {
  return createHash2("sha256").update(value, "utf8").digest();
}
function authorized(header, token) {
  const supplied = header !== undefined && header.startsWith("Bearer ") ? header.slice(7) : "";
  const ok = timingSafeEqual(digest(supplied), digest(token));
  return ok && supplied.length > 0;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function failure(error) {
  return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
}
function success(data) {
  return { status: 200, body: { ok: true, data } };
}
function parseJsonObject(body) {
  if (body === null || body.trim() === "")
    throw new ApiError("INVALID_REQUEST");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
    throw new ApiError("PAYLOAD_TOO_LARGE");
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ApiError("INVALID_JSON");
  }
  if (!isRecord2(json))
    throw new ApiError("INVALID_REQUEST");
  return json;
}
function onlyKeys(record, allowed) {
  for (const key of Object.keys(record))
    if (!allowed.includes(key))
      throw new ApiError("INVALID_REQUEST");
}
function readOpId(record) {
  const { opId } = record;
  if (typeof opId !== "string" || !OP_ID_PATTERN.test(opId))
    throw new ApiError("INVALID_REQUEST");
  return opId;
}
function readExpectedRevision(record) {
  const value = record.expectedRevision;
  if (value === undefined)
    return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new ApiError("INVALID_REQUEST");
  return value;
}
function readDirectory(value) {
  if (value === null || value === "")
    return null;
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  if (!absolute || value.length > MAX_DIRECTORY_LENGTH || value.includes("\x00"))
    throw new ApiError("INVALID_REQUEST");
  return value;
}
function stable(value) {
  if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`;
  if (isRecord2(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function createApp(options) {
  const { runtime, schema, root, token, bridge } = options;
  const store = new Store({ runtime, schema, root, lockTimeoutMs: options.lockTimeoutMs });
  const endedIds = async (activations) => releasedActivationIds(activations, await readLifecycle(runtime, schema, root));
  async function mutate(record, fingerprintSource, apply, retry) {
    const outcome = await store.transact({
      opId: readOpId(record),
      fingerprint: stable(fingerprintSource),
      expectedRevision: readExpectedRevision(record),
      apply,
      record: retry?.record,
      replay: retry?.replay
    }, endedIds);
    return success({ revision: outcome.revision, ...outcome.result, ...outcome.replayed ? { replayed: true } : {} });
  }
  async function createGuard(body) {
    const record = parseJsonObject(body);
    onlyKeys(record, ["opId", "expectedRevision", "draft"]);
    readOpId(record);
    const parsed = schema.parseDraft(record.draft);
    if (!parsed.ok)
      throw new ApiError("INVALID_DRAFT");
    const draft = parsed.value;
    return mutate(record, { kind: "create", draft }, (state2, context) => {
      if (state2.guards.length >= schema.maxGuards)
        throw new ApiError("LIMIT_REACHED");
      const at = context.now.toISOString();
      const guard = { ...draft, id: runtime.uuid(), createdAt: at, updatedAt: at };
      state2.guards.push(guard);
      state2.changed = true;
      return { guard };
    }, {
      record: (result) => ({ guardId: result.guard.id }),
      replay: (stored, doc) => {
        const guardId = isRecord2(stored) ? stored.guardId : undefined;
        return { guard: doc.guards.find((guard) => guard.id === guardId) ?? null };
      }
    });
  }
  async function deleteGuard(id2, record) {
    return mutate(record, { kind: "delete-guard", id: id2 }, (state2) => {
      const found = state2.guards.some((guard) => guard.id === id2);
      const endedActivationIds = state2.activations.filter((a) => a.guardId === id2).map((a) => a.id);
      if (found || endedActivationIds.length > 0) {
        state2.guards = state2.guards.filter((guard) => guard.id !== id2);
        state2.activations = state2.activations.filter((a) => a.guardId !== id2);
        state2.changed = true;
      }
      return { guardId: id2, removed: found, endedActivationIds };
    }, {
      record: (result) => ({ ...result, endedActivationIds: result.endedActivationIds.slice(0, 32) }),
      replay: (stored) => stored
    });
  }
  async function activate(body) {
    const record = parseJsonObject(body);
    onlyKeys(record, ["opId", "expectedRevision", "guardId", "sessionId", "scope", "expiresInMinutes"]);
    readOpId(record);
    const { guardId, sessionId, scope, expiresInMinutes } = record;
    if (typeof guardId !== "string" || !ID_PATTERN.test(guardId))
      throw new ApiError("INVALID_REQUEST");
    if (!isSessionId(sessionId))
      throw new ApiError("INVALID_REQUEST");
    if (scope !== "session" && scope !== "request")
      throw new ApiError("INVALID_REQUEST");
    if (expiresInMinutes !== undefined && expiresInMinutes !== null) {
      if (typeof expiresInMinutes !== "number" || !Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > MAX_EXPIRY_MINUTES) {
        throw new ApiError("INVALID_REQUEST");
      }
    }
    const minutes = typeof expiresInMinutes === "number" ? expiresInMinutes : null;
    if (bridge === null)
      throw new ApiError("SESSION_BRIDGE_UNAVAILABLE");
    const chain = await resolveChain(bridge, sessionId);
    if (chain === null)
      throw new ApiError("SESSION_NOT_FOUND");
    const activationScope = scope;
    const anchor = activationScope === "request" ? chain.root.id : sessionId;
    return mutate(record, { kind: "activate", guardId, sessionId, scope, minutes }, (state2, context) => {
      const guard = state2.guards.find((candidate) => candidate.id === guardId);
      if (!guard)
        throw new ApiError("GUARD_NOT_FOUND");
      const existing = state2.activations.find((a) => a.guardId === guardId && a.sessionId === anchor && a.scope === activationScope);
      if (existing)
        return { activation: existing, alreadyActive: true };
      if (state2.activations.length >= schema.maxActivations)
        throw new ApiError("LIMIT_REACHED");
      const activation = {
        id: runtime.uuid(),
        guardId,
        sessionId: anchor,
        scope: activationScope,
        createdAt: context.now.toISOString(),
        expiresAt: minutes === null ? null : new Date(context.now.getTime() + minutes * 60000).toISOString(),
        guardUpdatedAt: guard.updatedAt,
        snapshot: { label: guard.label, message: guard.message, rules: guard.rules }
      };
      state2.activations.push(activation);
      state2.changed = true;
      return { activation, alreadyActive: false };
    });
  }
  async function recoverStore(body) {
    const record = parseJsonObject(body);
    onlyKeys(record, ["opId", "confirmation"]);
    const opId = readOpId(record);
    if (record.confirmation !== RESET_CONFIRMATION)
      throw new ApiError("CONFIRMATION_REQUIRED");
    const outcome = await store.recover({ opId, fingerprint: stable({ kind: "recover" }) });
    return success({ revision: outcome.revision, ...outcome.result, ...outcome.replayed ? { replayed: true } : {} });
  }
  async function releaseActivation(id2, record) {
    return mutate(record, { kind: "release", id: id2 }, (state2) => {
      const found = state2.activations.some((a) => a.id === id2);
      if (found) {
        state2.activations = state2.activations.filter((a) => a.id !== id2);
        state2.changed = true;
      }
      return { activationId: id2, removed: found };
    });
  }
  async function state(query) {
    const sessionIdParam = query.get("sessionId");
    if (sessionIdParam !== null && sessionIdParam !== "" && !isSessionId(sessionIdParam)) {
      throw new ApiError("INVALID_REQUEST");
    }
    const sessionId = sessionIdParam === "" ? null : sessionIdParam;
    let directory = readDirectory(query.get("directory"));
    const doc = await store.read();
    let chain = null;
    let bridgeStatus = "none";
    if (sessionId !== null) {
      if (bridge === null) {
        bridgeStatus = "unavailable";
      } else {
        try {
          chain = await resolveChain(bridge, sessionId);
          bridgeStatus = chain === null ? "not-found" : "ok";
        } catch {
          bridgeStatus = "unavailable";
        }
      }
    }
    if (chain?.selected.directory)
      directory = chain.selected.directory;
    const nowMs = runtime.now();
    const activations = doc.activations.filter((a) => a.expiresAt === null || Date.parse(a.expiresAt) > nowMs);
    const ids = new Set(activations.map((a) => a.id));
    const [snapshot, reading] = await Promise.all([
      readRuntime(runtime, schema, root, directory),
      readLifecycle(runtime, schema, root)
    ]);
    const lifecycles = resolveLifecycleViews(activations, reading);
    const ended = new Set(lifecycles.filter((view) => view.releasable).map((view) => view.activationId));
    const effective = chain === null ? null : {
      sessionId: chain.selected.id,
      rootSessionId: chain.root.id,
      activationIds: activations.filter((a) => !ended.has(a.id) && chain.chain.some((s) => s.id === a.sessionId)).map((a) => a.id)
    };
    return success({
      revision: doc.revision,
      guards: doc.guards,
      activations,
      runtime: snapshot.report,
      runtimeStatus: snapshot.status,
      lifecycle: reading.facts.filter((fact) => ids.has(fact.activationId)),
      lifecycles,
      lifecycleHistory: {
        truncated: reading.truncated,
        malformedLines: reading.gaps.length,
        partialTail: reading.partialTail
      },
      effective,
      bridge: bridgeStatus
    });
  }
  async function route(request, url) {
    const { pathname } = url;
    const method = request.method.toUpperCase();
    const allowed = (...methods) => {
      if (!methods.includes(method))
        throw new ApiError("METHOD_NOT_ALLOWED");
    };
    if (pathname === "/health") {
      allowed("GET");
      return { status: 200, body: { ok: true } };
    }
    if (pathname === "/state") {
      allowed("GET");
      return state(url.searchParams);
    }
    if (pathname === "/guards") {
      allowed("POST");
      return createGuard(request.body);
    }
    if (pathname === "/store/recover") {
      allowed("POST");
      return recoverStore(request.body);
    }
    if (pathname === "/activations") {
      allowed("POST");
      return activate(request.body);
    }
    const guardMatch = /^\/guards\/([^/]+)$/.exec(pathname);
    const activationMatch = /^\/activations\/([^/]+)$/.exec(pathname);
    if (guardMatch || activationMatch) {
      allowed("DELETE");
      const id2 = (guardMatch ?? activationMatch)?.[1] ?? "";
      if (!ID_PATTERN.test(id2))
        throw new ApiError("INVALID_REQUEST");
      const record = request.body !== null && request.body.trim() !== "" ? parseJsonObject(request.body) : { opId: url.searchParams.get("opId") ?? undefined };
      onlyKeys(record, ["opId", "expectedRevision"]);
      readOpId(record);
      return guardMatch ? deleteGuard(id2, record) : releaseActivation(id2, record);
    }
    throw new ApiError("NOT_FOUND");
  }
  return {
    store,
    async handle(request) {
      try {
        if (!authorized(request.headers.authorization, token))
          throw new ApiError("UNAUTHORIZED");
        let url;
        try {
          url = new URL(request.url, "http://127.0.0.1");
        } catch {
          throw new ApiError("INVALID_REQUEST");
        }
        return await route(request, url);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status >= 500)
            options.log?.(error.code);
          return failure(error);
        }
        options.log?.("INTERNAL_ERROR");
        return failure(new ApiError("INTERNAL_ERROR"));
      }
    }
  };
}

// service/http.ts
import { createServer } from "node:http";
function readBody(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new ApiError("PAYLOAD_TOO_LARGE"));
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (overflow)
        return;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => overflow ? reject(new ApiError("PAYLOAD_TOO_LARGE")) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new ApiError("INVALID_REQUEST")));
  });
}
function send(response, status, body) {
  const text2 = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text2),
    "Cache-Control": "no-store"
  });
  response.end(text2);
}
function createHttpServer(app) {
  const server = createServer((request, response) => {
    (async () => {
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      let body = null;
      const method = request.method ?? "GET";
      try {
        if (method === "POST" || method === "DELETE") {
          const pre = await app.handle({ method: "GET", url: "/health", headers, body: null });
          if (pre.status === 401) {
            request.resume();
            send(response, pre.status, pre.body);
            return;
          }
          body = await readBody(request);
        }
        const result = await app.handle({ method, url: request.url ?? "/", headers, body });
        send(response, result.status, result.body);
      } catch (error) {
        const api = error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR");
        send(response, api.status, { ok: false, error: { code: api.code, message: api.message } });
      }
    })();
  });
  server.headersTimeout = 1e4;
  server.requestTimeout = 30000;
  return server;
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) {
  console.error("td-guards service: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var app = createApp({
  runtime: nodeRuntime(),
  schema: backendSchema,
  root: join3(homedir(), ".td-opencode-plugin"),
  token,
  bridge: createSessionBridge(process.env),
  log: (code2) => console.error(`td-guards service: ${code2}`)
});
var server = createHttpServer(app);
server.listen(port, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
