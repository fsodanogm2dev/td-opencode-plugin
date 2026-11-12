/**
 * Pure lifecycle resolver. The backend, the extension service, and the panel all call this one function, so they
 * cannot disagree about when a request-scope activation is released. No I/O. Only type imports.
 *
 * Input: one activation and the lifecycle facts in FILE ORDER (the order of the append-only log).
 *
 * Rules:
 * - A session-scope activation has phase `session` and is never released by a fact.
 * - A fact is valid only when it names this activation, has `at` at or after `activation.createdAt`, and has a
 *   fixed reason. Other facts are ignored.
 * - Each instance follows its own sequence: `bound`, then `ended` (reason `request-completed`) from the SAME instance.
 *   `ended` without an earlier `bound` of the same instance is ignored (missing or truncated bind). A second
 *   `bound` is ignored. `uncertain` ends the instance's sequence as uncertain. An `uncertain` that follows an `ended`
 *   of the same instance makes that instance uncertain (the log contradicts itself, so it fails closed).
 * - Across instances: a clean `bound` -> `ended` sequence of one instance releases the activation, even when another
 *   instance reported `uncertain` (that instance lost its own coverage; the first instance watched the whole run).
 *   `conflict` is then true, so a UI can say so. Without a clean end, any `uncertain` gives `uncertain` (final, with
 *   the latest reason in file order); otherwise any `bound` gives `bound`; otherwise `pending`.
 *
 * Only phase `ended` is releasable. `pending`, `bound`, and `uncertain` stay enforced until the user releases.
 */

import type { Activation, LifecycleFact, LifecycleReason } from "./schema.ts"

export type LifecyclePhase = "session" | "pending" | "bound" | "ended" | "uncertain"

export interface LifecycleResolution {
  readonly phase: LifecyclePhase
  /** Reason of the deciding fact. `null` for `session` and `pending`. */
  readonly reason: LifecycleReason | null
  /** Instance of the deciding fact. `null` for `session` and `pending`. */
  readonly instance: string | null
  /** `true` only for phase `ended`: the service may delete the activation and the backend stops enforcing. */
  readonly releasable: boolean
  /** Another instance reported `uncertain` although one instance completed the request. */
  readonly conflict: boolean
}

type InstanceState = "bound" | "ended" | "uncertain"

export function resolveActivationLifecycle(
  activation: Pick<Activation, "id" | "scope" | "createdAt">,
  facts: readonly LifecycleFact[],
): LifecycleResolution {
  if (activation.scope !== "request") return { phase: "session", reason: null, instance: null, releasable: false, conflict: false }
  const created = Date.parse(activation.createdAt)
  const instances = new Map<string, { state: InstanceState; reason: LifecycleReason }>()
  let latestUncertain: { reason: LifecycleReason; instance: string } | undefined
  let latestBound: { reason: LifecycleReason; instance: string } | undefined

  for (const fact of facts) {
    if (fact.activationId !== activation.id) continue
    const at = Date.parse(fact.at)
    if (Number.isNaN(at) || Number.isNaN(created) || at < created) continue
    const current = instances.get(fact.instance)
    if (fact.fact === "bound") {
      if (current) continue // A repeated bound, or a bound after the sequence ended, is stale.
      instances.set(fact.instance, { state: "bound", reason: fact.reason })
      latestBound = { reason: fact.reason, instance: fact.instance }
    } else if (fact.fact === "ended") {
      if (!current || current.state !== "bound") continue // Missing or truncated bind: ignore.
      if (fact.reason !== "request-completed") continue
      instances.set(fact.instance, { state: "ended", reason: fact.reason })
    } else {
      if (current?.state === "uncertain") continue
      instances.set(fact.instance, { state: "uncertain", reason: fact.reason })
      latestUncertain = { reason: fact.reason, instance: fact.instance }
    }
  }

  // An instance whose sequence became uncertain after it ended is no longer a clean end.
  let clean: { reason: LifecycleReason; instance: string } | undefined
  for (const [instance, entry] of instances) {
    if (entry.state === "ended") {
      clean = { reason: entry.reason, instance }
      break
    }
  }
  if (clean) {
    const conflict = [...instances.entries()].some(([instance, entry]) => entry.state === "uncertain" && instance !== clean!.instance)
    return { phase: "ended", reason: clean.reason, instance: clean.instance, releasable: true, conflict }
  }
  if (latestUncertain) return { phase: "uncertain", reason: latestUncertain.reason, instance: latestUncertain.instance, releasable: false, conflict: false }
  if (latestBound) return { phase: "bound", reason: latestBound.reason, instance: latestBound.instance, releasable: false, conflict: false }
  return { phase: "pending", reason: null, instance: null, releasable: false, conflict: false }
}

/** Resolves many activations from one fact list. Groups the facts once. */
export function resolveLifecycles(
  activations: readonly Pick<Activation, "id" | "scope" | "createdAt">[],
  facts: readonly LifecycleFact[],
): Map<string, LifecycleResolution> {
  const byActivation = new Map<string, LifecycleFact[]>()
  for (const fact of facts) {
    const list = byActivation.get(fact.activationId)
    if (list) list.push(fact)
    else byActivation.set(fact.activationId, [fact])
  }
  return new Map(activations.map((activation) => [activation.id, resolveActivationLifecycle(activation, byActivation.get(activation.id) ?? [])]))
}
