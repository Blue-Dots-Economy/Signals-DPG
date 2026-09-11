import { describe, it, expect } from 'vitest';
import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  it('disables focus-refetch and retries twice', () => {
    const client = createQueryClient();
    const q = client.getDefaultOptions().queries;
    expect(q?.refetchOnWindowFocus).toBe(false);
    const retry = q?.retry as (n: number, e: unknown) => boolean;
    expect(typeof retry).toBe('function');
    const err = { response: { status: 500 } };
    expect(retry(0, err)).toBe(true);
    expect(retry(1, err)).toBe(true);
    expect(retry(2, err)).toBe(false);
  });

  it('never retries an auth failure — it cannot succeed without new credentials', () => {
    // `retry: 2` used to turn every 401 into THREE requests. Measured on an
    // expired session: four polling queries produced bursts of nine 401s per
    // cycle, indefinitely.
    const retry = createQueryClient().getDefaultOptions().queries?.retry as (
      n: number,
      e: unknown,
    ) => boolean;
    for (const status of [401, 403]) {
      expect(retry(0, { response: { status } })).toBe(false);
      // Some callers surface the status flat rather than under `response`.
      expect(retry(0, { status })).toBe(false);
    }
  });

  it('still retries a 401-less failure and a bare error', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry as (
      n: number,
      e: unknown,
    ) => boolean;
    expect(retry(0, new Error('network down'))).toBe(true);
    expect(retry(0, { response: { status: 404 } })).toBe(true);
    expect(retry(0, undefined)).toBe(true);
  });

  it('does not set a global staleTime (per-query tiers own it)', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.staleTime).toBeUndefined();
  });

  it('returns a fresh instance each call', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
