import type { JSONSchemaLike } from '../metrics/profile_completion.js';
import type { GoLiveGate } from '@dpg/schemas';
import { passesGoLiveGates } from './go_live_gates.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused' | 'retired';
export type { GoLiveGate };

/**
 * Default gate set when a domain does not declare `go_live_required`:
 * `schema_required` only. `consent_required` is opt-in per domain — a
 * guardian-gated domain has it force-added by `resolveGoLiveGates` so the U18
 * age control can never be dropped by omitting config. The gate vocabulary and
 * per-gate logic live in `go_live_gates.ts` (the registry), not here.
 */
export const DEFAULT_GO_LIVE_GATES: readonly GoLiveGate[] = ['schema_required'];

export interface ClassifierInput {
  schema: JSONSchemaLike | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status BEFORE this write. `paused` and `retired` are
   * sticky — the classifier never flips out of them (`retired` is terminal).
   * For brand-new items pass `'draft'`.
   */
  current_status: LifecycleStatus;
  /**
   * Whether the item owner has accepted `profile_creation` consent by the
   * correct signer (from the consent ledger, not the user-table flags). Only
   * consulted when the `consent_required` gate is active. For a guardian-gated
   * minor the caller must fold the guardian check into this value.
   */
  consent_accepted: boolean;
  /**
   * Which gates must pass for `live`. Defaults to `DEFAULT_GO_LIVE_GATES`.
   * Resolved from the domain's `go_live_required` config by the caller.
   */
  gates?: readonly GoLiveGate[];
  /**
   * `owner_required` only (SS-3, #640). Resolve with
   * `applyDefaultOwnerAndResolveGate` (`item_service.ts`) and pass it whenever
   * `gates` includes `owner_required`.
   *
   * Omitted → FAILS CLOSED (treated as "a default exists and the owner has
   * none"): a call site that configures the gate but forgets the context
   * leaves profiles in `draft`, which is visible and recoverable, where the
   * opposite default would silently publish unowned profiles.
   */
  owner_context?: { has_owner: boolean; default_configured: boolean };
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
}

/**
 * Pure synchronous classifier. Runs inside the item-write transaction over
 * the merged post-write state. See
 * docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md §5.
 *
 * `retired` is terminal and `paused` is sticky; otherwise `live` requires
 * EVERY configured gate to pass, else `draft`. The gate set is config-driven
 * per domain (`go_live_required`), defaulting to `schema_required`.
 *
 * ⚠️ One documented exception to "EVERY configured gate must pass":
 * `owner_required` (SS-3, #640) can let an already-`live` profile through when
 * it does not satisfy the gate. Both guards are load-bearing — read
 * `GO_LIVE_GATE_CHECKS.owner_required` before changing this function.
 * (Completion % is not produced here — the single completion metric is
 * `item_metrics.profile_completion_pct`, computed required-only via
 * `profile_completion_pct`, and is intentionally independent of the gate set.)
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  // Terminal: a retired item is permanently removed — never recompute out of it.
  if (input.current_status === 'retired') {
    return { lifecycle_status: 'retired' };
  }

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused' };
  }

  const gates = input.gates ?? DEFAULT_GO_LIVE_GATES;
  const live = passesGoLiveGates(gates, {
    schema: input.schema,
    state: input.merged_state ?? {},
    consentSatisfied: input.consent_accepted,
    // Fail closed when the caller configured `owner_required` but passed no
    // owner context — see `owner_context` on ClassifierInput.
    hasOwner: input.owner_context?.has_owner ?? false,
    defaultConfigured: input.owner_context?.default_configured ?? true,
    currentStatus: input.current_status,
  });
  return { lifecycle_status: live ? 'live' : 'draft' };
};
