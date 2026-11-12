/**
 * The only place the panel imports the backend guard modules. The schema
 * validator and the matcher are the same code the plugin uses to enforce
 * guards, so the preview and the sample test cannot disagree with enforcement.
 */
export type {
  Activation,
  CommandRule,
  GuardDraft as Draft,
  Guard,
  GuardRuntimeReport,
  GuardRuntimeSession,
  LifecycleFact,
  PermissionRule,
  Rule,
} from "../../../src/guards/schema.ts"
export { LIFECYCLE_REASONS, LIMITS, MUTATING_ACTIONS, validateGuardDraft, type LifecycleReason } from "../../../src/guards/schema.ts"
export { COMMAND_ACTIONS, previewCommand, previewPermission, type RuleMatch } from "../../../src/guards/matcher.ts"

export { activationRelationship, type Relationship } from "../../../src/guards/policy.ts"
export type { LifecyclePhase } from "../../../src/guards/lifecycle-state.ts"
// Type only. The panel never resolves lifecycles itself; the service sends one view per activation.
export type { LifecycleTrust, LifecycleView } from "../../../src/guards/lifecycle-history.ts"
