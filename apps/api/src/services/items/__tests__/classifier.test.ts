import { describe, it, expect } from 'vitest';
import { classify_item } from '../classifier.js';

const schema = (required: string[]) => ({
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  required,
});

const BOTH_GATES = ['schema_required', 'consent_required'] as const;

describe('classify_item', () => {
  it('all required populated + consent accepted → live', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: true,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('all required populated but consent pending → draft (consent_required gate)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('one of two required missing (consent accepted) → draft', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('vacuous required (empty) + consent accepted → live', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('vacuous required (empty) but consent pending, consent_required gate → draft', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
        consent_accepted: false,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('paused is sticky against the classifier (complete state + consent)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });

  it('optional fields do not affect live/draft (only required counts)', () => {
    expect(
      classify_item({
        schema: schema(['a']),
        merged_state: { a: 'x', b: 'y', c: 'z' },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('empty string + empty array are not populated → draft', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: '', b: [] },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('schema with no required key + consent accepted → vacuous live', () => {
    expect(
      classify_item({
        schema: { type: 'object', properties: {} },
        merged_state: {},
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('paused is sticky even when required incomplete', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'paused',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });

  it('retired is terminal — never recomputes out (complete state + consent)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'retired',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'retired' });
  });
});

describe('classify_item — config-driven gates (go_live_required)', () => {
  it('default gates = schema_required only: complete + consent pending → live', () => {
    // No `gates` → DEFAULT_GO_LIVE_GATES (schema_required). Consent is ignored.
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('consent_required only: incomplete required but consent satisfied → live', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' }, // b missing — schema_required NOT a gate here
        current_status: 'draft',
        consent_accepted: true,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('consent_required only: consent not satisfied → draft even if complete', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('both gates: needs complete AND consent', () => {
    const both = (state: Record<string, unknown>, consent: boolean) =>
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: state,
        current_status: 'draft',
        consent_accepted: consent,
        gates: BOTH_GATES,
      }).lifecycle_status;
    expect(both({ a: 'x', b: 'y' }, true)).toBe('live');
    expect(both({ a: 'x', b: 'y' }, false)).toBe('draft');
    expect(both({ a: 'x' }, true)).toBe('draft');
  });

  it('paused stays sticky regardless of which gates are configured', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
        consent_accepted: true,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });
});

describe('owner_required through classify_item (SS-3, #640)', () => {
  const OWNER_GATES = ['schema_required', 'owner_required'] as const;
  const complete = { a: 'x', b: 'y' };

  const run = (
    current: 'draft' | 'live',
    owner_context?: { has_owner: boolean; default_configured: boolean },
  ) =>
    classify_item({
      schema: schema(['a', 'b']),
      merged_state: complete,
      current_status: current,
      consent_accepted: true,
      gates: OWNER_GATES,
      owner_context,
    }).lifecycle_status;

  it('goes live when the owner has an aggregator', () => {
    expect(run('draft', { has_owner: true, default_configured: true })).toBe('live');
  });

  it('stays draft when a default exists but the owner has no aggregator', () => {
    expect(run('draft', { has_owner: false, default_configured: true })).toBe('draft');
  });

  it('goes live while no default aggregator is nominated (guard 1)', () => {
    expect(run('draft', { has_owner: false, default_configured: false })).toBe('live');
  });


  it('leaves an already-live unowned profile live (guard 2)', () => {
    expect(run('live', { has_owner: false, default_configured: true })).toBe('live');
  });

  // A call site that configures the gate but forgets to resolve the context
  // must leave profiles in draft (visible, recoverable) rather than silently
  // publishing unowned ones.
  it('fails closed when the gate is configured but no owner context is passed', () => {
    expect(run('draft', undefined)).toBe('draft');
  });

  it('is not evaluated at all when the domain does not configure it', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: complete,
        current_status: 'draft',
        consent_accepted: true,
        gates: ['schema_required'],
      }).lifecycle_status,
    ).toBe('live');
  });
});
