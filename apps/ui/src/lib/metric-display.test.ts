import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveCardMetric, formatCardMetric, describeCardMetric } from './metric-display';

/** Minimal i18n stand-in: returns the key plus its interpolations. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key) as never;

const base = { freeTextScoreEnabled: true, hasProfile: true };

afterEach(() => vi.useRealTimers());

describe('resolveCardMetric — the metric IS the ranking basis (#646 C1)', () => {
  it('relevance → percent', () => {
    expect(resolveCardMetric({ ...base, sortApplied: 'relevance', score: 62 })).toEqual({
      kind: 'relevance',
      percent: 62,
    });
  });

  it('nearest → distance, ignoring any score present', () => {
    // The score is still on the wire; badging it here is exactly the bug.
    expect(
      resolveCardMetric({ ...base, sortApplied: 'nearest', score: 62, distanceMeters: 4200 }),
    ).toEqual({ kind: 'distance', meters: 4200 });
  });

  it('newest → age, ignoring any score present', () => {
    const createdAt = new Date('2026-08-29T00:00:00Z');
    expect(
      resolveCardMetric({ ...base, sortApplied: 'newest', score: 62, createdAt }),
    ).toEqual({ kind: 'age', createdAt });
  });

  it('shows nothing when the driving quantity is missing', () => {
    expect(resolveCardMetric({ ...base, sortApplied: 'relevance', score: null })).toBeNull();
    expect(resolveCardMetric({ ...base, sortApplied: 'nearest', distanceMeters: null })).toBeNull();
    expect(resolveCardMetric({ ...base, sortApplied: 'newest', createdAt: null })).toBeNull();
  });

  it('shows nothing when the server reported no sort', () => {
    expect(resolveCardMetric({ ...base, sortApplied: undefined, score: 62 })).toBeNull();
  });

  it('hides a free-text score when the deployment disables it (spec D15)', () => {
    // No profile means the score is text-vs-item, a different quantity that
    // some instances choose not to surface. Sorting still works; only the
    // number is withheld.
    expect(
      resolveCardMetric({
        sortApplied: 'relevance',
        score: 62,
        hasProfile: false,
        freeTextScoreEnabled: false,
      }),
    ).toBeNull();
  });

  it('still shows a PROFILE score when free-text scores are disabled', () => {
    expect(
      resolveCardMetric({
        sortApplied: 'relevance',
        score: 62,
        hasProfile: true,
        freeTextScoreEnabled: false,
      }),
    ).toEqual({ kind: 'relevance', percent: 62 });
  });

  it('shows a free-text score when the deployment allows it', () => {
    expect(
      resolveCardMetric({
        sortApplied: 'relevance',
        score: 62,
        hasProfile: false,
        freeTextScoreEnabled: true,
      }),
    ).toEqual({ kind: 'relevance', percent: 62 });
  });

  it('treats distance 0 as a real value, not a missing one', () => {
    expect(
      resolveCardMetric({ ...base, sortApplied: 'nearest', distanceMeters: 0 }),
    ).toEqual({ kind: 'distance', meters: 0 });
  });
});

describe('formatCardMetric', () => {
  it('formats a percentage', () => {
    expect(formatCardMetric({ kind: 'relevance', percent: 62 }, t)).toBe('62%');
  });

  it('formats km at or above 1000 m', () => {
    expect(formatCardMetric({ kind: 'distance', meters: 4200 }, t)).toContain('4.2');
  });

  it('formats metres below 1000', () => {
    expect(formatCardMetric({ kind: 'distance', meters: 850 }, t)).toContain('850');
  });

  it('formats a relative age in days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    expect(
      formatCardMetric({ kind: 'age', createdAt: new Date('2026-08-29T00:00:00Z') }, t),
    ).toContain('5');
  });

  it('says today for something posted hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));
    expect(
      formatCardMetric({ kind: 'age', createdAt: new Date('2026-09-03T09:00:00Z') }, t),
    ).toBe('card.metric_today');
  });

  it('returns null for no metric', () => {
    expect(formatCardMetric(null, t)).toBeNull();
  });
});

describe('describeCardMetric — the basis sentence for the tooltip', () => {
  it('names the profile basis when an anchor drove the score', () => {
    expect(describeCardMetric({ kind: 'relevance', percent: 62 }, 'profile', t)).toBe(
      'browse.sort_relevance_profile',
    );
  });

  it('names the search basis only when the text was the query vector', () => {
    expect(describeCardMetric({ kind: 'relevance', percent: 62 }, 'search', t)).toBe(
      'browse.sort_relevance_search',
    );
  });

  it('describes distance and age without a basis', () => {
    expect(describeCardMetric({ kind: 'distance', meters: 1 }, null, t)).toBe(
      'card.metric_distance_desc',
    );
    expect(describeCardMetric({ kind: 'age', createdAt: new Date() }, null, t)).toBe(
      'card.metric_age_desc',
    );
  });
});
