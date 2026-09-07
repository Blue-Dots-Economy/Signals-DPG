/**
 * Unit tests for the go-live gate registry — the single mapping from a
 * `go_live_required` token to its check, plus the `passesGoLiveGates`
 * AND-combinator the classifier is generic over.
 */

import { describe, it, expect } from 'vitest';
import {
  GO_LIVE_GATE_CHECKS,
  passesGoLiveGates,
  type GoLiveContext,
} from '../go_live_gates.js';

const ctx = (over: Partial<GoLiveContext> = {}): GoLiveContext => ({
  schema: { required: ['name', 'phone'] },
  state: { name: 'Asha', phone: '9876500000' },
  consentSatisfied: true,
  // owner_required baseline: an owned profile, a configured default, and a
  // draft that is being promoted — i.e. the gate's only "real" evaluation.
  hasOwner: true,
  defaultConfigured: true,
  currentStatus: 'draft',
  ...over,
});

describe('GO_LIVE_GATE_CHECKS.schema_required', () => {
  it('is true when every required field is populated', () => {
    expect(GO_LIVE_GATE_CHECKS.schema_required(ctx())).toBe(true);
  });

  it('is false when a required field is missing/empty', () => {
    expect(GO_LIVE_GATE_CHECKS.schema_required(ctx({ state: { name: 'Asha' } }))).toBe(false);
  });

  it('is true when the schema declares no required fields', () => {
    expect(GO_LIVE_GATE_CHECKS.schema_required(ctx({ schema: {}, state: {} }))).toBe(true);
    expect(GO_LIVE_GATE_CHECKS.schema_required(ctx({ schema: null, state: {} }))).toBe(true);
    expect(GO_LIVE_GATE_CHECKS.schema_required(ctx({ schema: undefined, state: {} }))).toBe(true);
  });
});

describe('GO_LIVE_GATE_CHECKS.consent_required', () => {
  it('mirrors consentSatisfied', () => {
    expect(GO_LIVE_GATE_CHECKS.consent_required(ctx({ consentSatisfied: true }))).toBe(true);
    expect(GO_LIVE_GATE_CHECKS.consent_required(ctx({ consentSatisfied: false }))).toBe(false);
  });
});

describe('GO_LIVE_GATE_CHECKS.owner_required (SS-3, #640)', () => {
  it('is true when the owner has an owning aggregator', () => {
    expect(GO_LIVE_GATE_CHECKS.owner_required(ctx({ hasOwner: true }))).toBe(true);
  });

  it('is false when a default is configured and the owner has none', () => {
    expect(GO_LIVE_GATE_CHECKS.owner_required(ctx({ hasOwner: false }))).toBe(false);
  });

  // Guard 1 — the default aggregator arrives post-launch (#640 Q1). Without
  // this, every self-signup profile would be frozen in draft from launch.
  it('is inert while no default aggregator is nominated', () => {
    expect(
      GO_LIVE_GATE_CHECKS.owner_required(ctx({ hasOwner: false, defaultConfigured: false })),
    ).toBe(true);
  });


  // Guard 2 — classify_item re-derives draft<->live on EVERY write, so without
  // this an already-live unowned user editing their own profile would be
  // demoted to draft and de-indexed from discover + the map.
  it('never demotes a profile that is already live', () => {
    expect(
      GO_LIVE_GATE_CHECKS.owner_required(ctx({ hasOwner: false, currentStatus: 'live' })),
    ).toBe(true);
  });

  it('still blocks an unowned profile that is only in draft', () => {
    expect(
      GO_LIVE_GATE_CHECKS.owner_required(ctx({ hasOwner: false, currentStatus: 'draft' })),
    ).toBe(false);
  });
});

describe('passesGoLiveGates', () => {
  it('is true when no gates are configured', () => {
    // An empty gate set can never fail — every() over [] is true.
    expect(passesGoLiveGates([], ctx({ consentSatisfied: false, state: {} }))).toBe(true);
  });

  it('requires EVERY configured gate to pass (AND semantics)', () => {
    expect(passesGoLiveGates(['schema_required', 'consent_required'], ctx())).toBe(true);
    // consent gate fails
    expect(
      passesGoLiveGates(['schema_required', 'consent_required'], ctx({ consentSatisfied: false })),
    ).toBe(false);
    // schema gate fails
    expect(
      passesGoLiveGates(['schema_required', 'consent_required'], ctx({ state: { name: 'Asha' } })),
    ).toBe(false);
  });

  it('with schema_required alone, consent is ignored', () => {
    expect(passesGoLiveGates(['schema_required'], ctx({ consentSatisfied: false }))).toBe(true);
  });

  it('with consent_required alone, completeness is ignored', () => {
    expect(passesGoLiveGates(['consent_required'], ctx({ state: {} }))).toBe(true);
  });
});
