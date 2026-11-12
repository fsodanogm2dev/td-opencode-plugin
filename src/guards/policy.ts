/**
 * Guard policy. Decides whether a permission evaluation must be denied.
 *
 * The policy only ever denies. It never changes an effect to `allow`, so ordinary approvals and auto-approval cannot
 * override a guard. A guard applies to its root session and to every descendant session. When the ancestry of a
 * session cannot be resolved, the policy assumes that the guard applies.
 */

import { isExpired, type Activation, type Guard, type GuardRuntimeSession, type GuardStore, type Rule } from "./schema.ts"
import { matchRules } from "./matcher.ts"
import { FAIL_CLOSED_MESSAGE, MUTATING_ACTIONS, sanitizeMessage } from "./schema.ts"
import { MAX_ANCESTRY_DEPTH, type SessionTracker } from "./sessions.ts"
import type { StoreSnapshot } from "./store.ts"

export type Relationship = "direct" | "inherited" | "none" | "unknown"

/**
 * Pure relation between an activation root and a target session, from a runtime session list.
 * `unknown` means the chain is incomplete or cyclic. A caller must not treat `unknown` as `none`.
 */
export function activationRelationship(
  activationSessionId: string,
  targetSessionId: string,
  sessions: readonly GuardRuntimeSession[],
): Relationship {
  if (activationSessionId === targetSessionId) return "direct"
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let current = byId.get(targetSessionId)
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (!current || seen.has(current.id)) return "unknown"
    seen.add(current.id)
    if (current.parentId === null) return "none"
    if (current.parentId === activationSessionId) return "inherited"
    current = byId.get(current.parentId)
  }
  return "unknown"
}

export interface PolicyInput {
  readonly sessionId: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Record<string, unknown>
}

export type PolicyDecision =
  | { readonly deny: false }
  | { readonly deny: true; readonly message: string; readonly kind: "guard" | "fail-closed"; readonly guardId?: string; readonly activationId?: string }

/** The rules and message that an activation enforces. A snapshot wins over the guard record. */
export function effectiveRules(activation: Activation, guards: readonly Guard[]): { rules: readonly Rule[]; message: string } | undefined {
  if (activation.snapshot) return { rules: activation.snapshot.rules, message: activation.snapshot.message }
  const guard = guards.find((entry) => entry.id === activation.guardId)
  return guard ? { rules: guard.rules, message: guard.message } : undefined
}

export interface PolicyDeps {
  readonly sessions: SessionTracker
  readonly isReleased: (activationId: string) => boolean
  readonly now: () => Date
}

/** Evaluates one action. Never throws: an internal error fails closed for mutating actions. */
export async function decide(snapshot: StoreSnapshot, input: PolicyInput, deps: PolicyDeps): Promise<PolicyDecision> {
  const failClosed = (): PolicyDecision =>
    (MUTATING_ACTIONS as readonly string[]).includes(input.action)
      ? { deny: true, message: FAIL_CLOSED_MESSAGE, kind: "fail-closed" }
      : { deny: false }
  try {
    if (snapshot.failClosed) return failClosed()
    const store: GuardStore = snapshot.store
    const now = deps.now().getTime()
    const active = store.activations.filter((activation) => !isExpired(activation, now) && !deps.isReleased(activation.id))
    if (active.length === 0) return { deny: false }
    const { chain, certain } = await deps.sessions.ancestors(input.sessionId)
    for (const activation of active) {
      if (certain && !chain.includes(activation.sessionId)) continue
      const effective = effectiveRules(activation, store.guards)
      if (!effective) continue
      if (matchRules(effective.rules, input)) {
        return { deny: true, message: sanitizeMessage(effective.message), kind: "guard", guardId: activation.guardId, activationId: activation.id }
      }
    }
    return { deny: false }
  } catch {
    return failClosed()
  }
}
