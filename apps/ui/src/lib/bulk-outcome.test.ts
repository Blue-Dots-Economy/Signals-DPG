import { describe, it, expect } from 'vitest';
import { resolveBulkOutcome } from './bulk-outcome';
import type { BulkEnvelope } from './bulk';
import type { PerformActionPayload } from './action-api';

const targets = [{ item_id: 'a' }, { item_id: 'b' }, { item_id: 'c' }];
const payloads = ['pa', 'pb', 'pc'] as unknown as PerformActionPayload[];

/** A per-item error carrying a machine code, the shape `guardianOtpErrorOf` reads. */
const err = (index: number, error: string, message = 'nope') => ({
  index,
  status: 'error' as const,
  error,
  message,
});
const ok = (index: number) => ({ index, status: 'success' as const });

const envelope = (
  results: ReturnType<typeof err | typeof ok>[],
): BulkEnvelope<unknown> => ({
  results: results as BulkEnvelope<unknown>['results'],
  summary: {
    total: results.length,
    succeeded: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'error').length,
  },
});

describe('resolveBulkOutcome', () => {
  it('reports every item succeeding', () => {
    expect(resolveBulkOutcome(envelope([ok(0), ok(1)]), targets, payloads)).toEqual({
      kind: 'all',
      succeeded: 2,
    });
  });

  it('routes a guardian-OTP failure to the OTP dialog, carrying only those payloads', () => {
    const out = resolveBulkOutcome(
      envelope([err(0, 'GUARDIAN_OTP_REQUIRED'), err(2, 'GUARDIAN_OTP_REQUIRED')]),
      targets,
      payloads,
    );
    expect(out).toEqual({ kind: 'guardian', payloads: ['pa', 'pc'], otherFailedIds: undefined });
  });

  it('opens the OTP dialog even in a MIXED batch, and carries the other failures along', () => {
    // A GUARDIAN_OTP_REQUIRED failure means a code has already been sent, so
    // falling through to the generic error toast would waste it. The
    // non-guardian failures must survive to be reselected afterwards.
    const out = resolveBulkOutcome(
      envelope([err(0, 'GUARDIAN_OTP_REQUIRED'), err(1, 'SOMETHING_ELSE')]),
      targets,
      payloads,
    );
    expect(out).toEqual({ kind: 'guardian', payloads: ['pa'], otherFailedIds: ['b'] });
  });

  it('reports a partial failure with the failed ids and the first error', () => {
    const out = resolveBulkOutcome(
      envelope([ok(0), err(1, 'RATE_LIMITED', 'slow down'), err(2, 'RATE_LIMITED', 'slow down')]),
      targets,
      payloads,
    );
    expect(out.kind).toBe('partial');
    if (out.kind !== 'partial') throw new Error('expected partial');
    expect(out.failedIds).toEqual(['b', 'c']);
    expect(out.succeeded).toBe(1);
    expect(out.total).toBe(3);
    expect(out.firstError).toBe('slow down');
  });

  it('maps result indices through `targets`, not through position in the failure list', () => {
    // The envelope identifies results only by `index`; reading them
    // positionally would mis-attribute a failure to the wrong item.
    const out = resolveBulkOutcome(envelope([err(2, 'BOOM')]), targets, payloads);
    if (out.kind !== 'partial') throw new Error('expected partial');
    expect(out.failedIds).toEqual(['c']);
  });
});
