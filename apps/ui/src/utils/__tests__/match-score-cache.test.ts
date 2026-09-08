import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateCacheKey,
  getCachedMatchScore,
  setCachedMatchScore,
  clearMatchScoreCache,
  sweepLegacyMatchScoreCache,
  formatScorePercentage,
} from '../match-score-cache';

/**
 * #646 §5.2 — one wire scale end to end.
 *
 * The score travelled through THREE scales for one quantity: /v1/relevance
 * emits 0–100, the provider divided by 10, the /discover seed multiplied by
 * 10. Both conversions are deleted; 0–100 is the only scale now.
 *
 * That makes the cache prefix bump mandatory rather than hygiene. A user who
 * viewed a score in the 24 hours before the deploy has a 0–10 value in their
 * browser; read by the new formatter, a 62% match prints as "6%" — silently,
 * with no error. Migrating the values is impossible: nothing in the payload
 * says which scale a stored number is on, so the version prefix IS the marker.
 */

beforeEach(() => localStorage.clear());

describe('formatScorePercentage — 0-100 in, percent out', () => {
  it('formats a 0-100 score directly', () => {
    expect(formatScorePercentage(62)).toBe('62%');
    expect(formatScorePercentage(100)).toBe('100%');
    expect(formatScorePercentage(0)).toBe('0%');
  });

  it('rounds rather than truncating', () => {
    expect(formatScorePercentage(61.6)).toBe('62%');
  });
});

describe('match-score cache — v2', () => {
  it('uses a v2 key prefix', () => {
    expect(generateCacheKey('a', 'b')).toBe('dpg:matchScore:v2:a:b');
  });

  it('round-trips a v2 entry', () => {
    setCachedMatchScore('a', 'b', { provider: 'signals_search', score: 62, raw_response: null });
    expect(getCachedMatchScore('a', 'b')?.score.score).toBe(62);
  });

  it('does NOT read a v1 entry — a stale 0-10 value would render 10x too small', () => {
    // 6.2 on the old scale is a 62% match. The new formatter would print "6%".
    // Unreachability is the fix.
    localStorage.setItem(
      'dpg:matchScore:v1:a:b',
      JSON.stringify({
        score: { provider: 'discover', score: 6.2, source: 'discover' },
        timestamp: Date.now(),
        localItemId: 'a',
        networkItemId: 'b',
      }),
    );
    expect(getCachedMatchScore('a', 'b')).toBeNull();
  });

  it('sweeps v1 entries away rather than orphaning them', () => {
    // localStorage has no expiry of its own — the 24h TTL is enforced in code,
    // on read, and nothing will ever read a v1 key again. clearMatchScoreCache
    // only sweeps the CURRENT prefix, so without this they persist forever.
    localStorage.setItem('dpg:matchScore:v1:a:b', '{}');
    localStorage.setItem('dpg:matchScore:v1:c:d', '{}');
    localStorage.setItem('unrelated:key', 'keep me');

    sweepLegacyMatchScoreCache();

    expect(localStorage.getItem('dpg:matchScore:v1:a:b')).toBeNull();
    expect(localStorage.getItem('dpg:matchScore:v1:c:d')).toBeNull();
    expect(localStorage.getItem('unrelated:key')).toBe('keep me');
  });

  it('leaves v2 entries alone when sweeping', () => {
    setCachedMatchScore('a', 'b', { provider: 'signals_search', score: 62, raw_response: null });
    sweepLegacyMatchScoreCache();
    expect(getCachedMatchScore('a', 'b')?.score.score).toBe(62);
  });

  it('is idempotent', () => {
    localStorage.setItem('dpg:matchScore:v1:a:b', '{}');
    sweepLegacyMatchScoreCache();
    expect(() => sweepLegacyMatchScoreCache()).not.toThrow();
    expect(localStorage.getItem('dpg:matchScore:v1:a:b')).toBeNull();
  });

  it('clear-all removes v2 entries', () => {
    setCachedMatchScore('a', 'b', { provider: 'signals_search', score: 62, raw_response: null });
    clearMatchScoreCache();
    expect(getCachedMatchScore('a', 'b')).toBeNull();
  });
});
