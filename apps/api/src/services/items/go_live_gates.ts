import { is_populated } from '../metrics/profile_completion.js';
import type { JSONSchemaLike } from '../metrics/profile_completion.js';
import type { GoLiveGate } from '@dpg/schemas';

/**
 * Everything a go-live gate check might read. The caller assembles this once
 * per classification; each gate check picks the fields it needs. Adding a
 * future gate that needs a new signal → add the signal here and set it at the
 * call sites.
 */
export interface GoLiveContext {
  schema: JSONSchemaLike | null | undefined;
  state: Record<string, unknown>;
  /**
   * `consent_required`: whether `profile_creation` consent is accepted by the
   * CORRECT signer. Guardian-awareness is folded in by the caller (a gated
   * minor needs a `source='guardian'` row), so the gate check stays a plain
   * boolean read and the age control can never be a separate, forgettable step.
   */
  consentSatisfied: boolean;
  /** `owner_required`: whether the profile owner has an owning aggregator. */
  hasOwner: boolean;
  /**
   * `owner_required`: whether a default aggregator is nominated for THIS
   * binding. Resolved per (network, domain) by `resolveOwnerGateContext`, so
   * it stays binary even now that several orgs may each be the default for a
   * different binding — the question is only ever "is there one for the
   * binding this item is in". See guard 1 below.
   */
  defaultConfigured: boolean;
  /**
   * The item's lifecycle status BEFORE this write. Read only by
   * `owner_required` (guard 2) — every other gate is a pure function of the
   * item's own state and must stay that way.
   */
  currentStatus: 'draft' | 'live' | 'paused' | 'retired';
}

/**
 * The gate registry — the single place that maps a `go_live_required` token to
 * its logic. The classifier is generic over this: it runs whichever gates a
 * domain lists in `network.json`, in order, and a profile goes live only when
 * every one passes. To add a gate: add the token to `PROFILE_GO_LIVE_GATES`
 * (@dpg/schemas) and one entry here. Nothing else branches on gate identity.
 */
export const GO_LIVE_GATE_CHECKS: Record<GoLiveGate, (ctx: GoLiveContext) => boolean> = {
  schema_required: (ctx) => (ctx.schema?.required ?? []).every((k) => is_populated(ctx.state[k])),
  consent_required: (ctx) => ctx.consentSatisfied,
  /**
   * SS-3 (#640): a profile may not go live while nobody owns its account.
   *
   * ⚠️ This gate is NOT a pure function of the item's own state, unlike the
   * other two. It reads the prior lifecycle status and instance config, and it
   * lets a `live` profile pass a condition it does not satisfy. That breaks the
   * invariant stated in `classifier.ts`'s header — deliberately, and it is
   * repeated there. Do not "tidy" either guard away:
   *
   * Guard 1 — inert while no default aggregator is nominated.
   *   Product's answer to #640 Q1 is that the default arrives POST-launch: a
   *   real aggregator registers and goes live first, and only then is nominated.
   *   Without this guard, every self-signup profile would be frozen in `draft`
   *   from launch until that happens, so Q1 and Q4 would contradict each other.
   *
   *   This is only safe to express as a boolean because the database enforces
   *   that a binding can never be contested, by
   *   `organization_default_binding_exclusive` (migration 0014). If a binding
   *   could be contested, "not configured" and "cannot tell" would need
   *   OPPOSITE answers here, and treating them alike would make the gate fail
   *   open on a misconfiguration.
   *
   * Guard 2 — blocks `draft → live` only; never demotes a profile that is
   *   already live. `classify_item` re-derives draft↔live on EVERY write, not
   *   just at creation. Without this guard, an already-live user with no
   *   owning aggregator who edits one field of their own profile would be
   *   pushed back to `draft`; the transition publishes an item event and every
   *   `item_search` read path is live-only, so their profile would silently
   *   vanish from discover and the map. No admin action, no warning, across the
   *   whole pre-default self-signup population. This is also what encodes
   *   "new registrations only".
   */
  owner_required: (ctx) => {
    if (ctx.currentStatus === 'live') return true;
    if (!ctx.defaultConfigured) return true;
    // `hasOwner` asks "does this owner have ANY owning aggregator", not "does
    // it have the one for THIS item's domain". Those were the same question
    // while a single default existed instance-wide. They still coincide for
    // every account created since `assertSingleDomain` landed, because such an
    // account has exactly one domain, so its owner is that domain's owner.
    //
    // They can differ for a legacy account that already held items in two
    // domains before the lock (migration 0015 records both, so the lock keeps
    // honouring both): a create in the second domain would pass this gate with
    // an owner belonging to the first. No domain enables `owner_required` in
    // any shipped `network.json`, so this is dormant — but it must be resolved
    // before one does, together with the per-profile ownership work in #661.
    return ctx.hasOwner;
  },
};

/** True when every configured gate passes for this context. */
export const passesGoLiveGates = (
  gates: readonly GoLiveGate[],
  ctx: GoLiveContext,
): boolean => gates.every((gate) => GO_LIVE_GATE_CHECKS[gate](ctx));
