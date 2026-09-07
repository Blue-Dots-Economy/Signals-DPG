import { describe, it, expect, vi } from 'vitest';

describe('fetchDiscover', () => {
  it('POSTs /api/v1/network/item/discover with q, filters, geo, and pagination in the BFF body shape', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [{ item_id: 'a' }],
        meta: { total: 1, limit: 20, offset: 0, source: 'signals_search', degraded: false },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    const result = await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      q: 'math tutor',
      filters: [{ field: 'skills', values: ['algebra', 'geometry'] }],
      item_latitude: 19,
      item_longitude: 72,
      distance_meters: 5000,
      limit: 20,
      offset: 0,
    });

    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/network/item/discover',
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        q: 'math tutor',
        filters: [{ field: 'skills', values: ['algebra', 'geometry'] }],
        item_latitude: 19,
        item_longitude: 72,
        distance_meters: 5000,
        limit: 20,
        offset: 0,
      },
      expect.anything(),
    );
    expect(result).toEqual({
      items: [{ item_id: 'a' }],
      meta: { total: 1, limit: 20, offset: 0, source: 'signals_search', degraded: false },
    });
  });

  it('omits q/filters/geo entirely when not provided (a plain relevance-only discover call)', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [],
        meta: { total: 0, limit: 20, offset: 0, source: 'native_fallback', degraded: true },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      limit: 20,
      offset: 0,
    });

    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/network/item/discover',
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        limit: 20,
        offset: 0,
      },
      expect.anything(),
    );
  });

  // Task 2 (#394): the discover BFF's relevance-to-profile ranking keys off
  // `anchor_item_id` (the selected profile's item id, forwarded server-side
  // as `intent.item.id` to signals-search — Task 1). Same optional/omit-if-
  // unset convention as every other optional discover field above.
  it('includes anchor_item_id in the POST body when provided', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [],
        meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      anchor_item_id: 'profile-123',
      limit: 20,
      offset: 0,
    });

    const [, body] = postMock.mock.calls[0];
    expect(body).toHaveProperty('anchor_item_id', 'profile-123');
  });

  it('omits anchor_item_id from the POST body when not provided', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [],
        meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      limit: 20,
      offset: 0,
    });

    const [, body] = postMock.mock.calls[0];
    expect(body).not.toHaveProperty('anchor_item_id');
  });

  it('drops an empty filters array rather than sending filters: []', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: { items: [], meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false } },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      filters: [],
      limit: 20,
      offset: 0,
    });

    const [, body] = postMock.mock.calls[0];
    expect(body).not.toHaveProperty('filters');
  });
});

/**
 * #646 §5.2 follow-up, found on the test cluster.
 *
 * signals-search's `/v1/search` returns `score` as a RAW COSINE similarity
 * (~0-1) — 0.633 for a good match. Its `/v1/relevance` endpoint, which backs
 * the match-score modal, returns a 0-100 percentage instead. Those are two
 * different endpoints with two different scales, and the "one scale end to
 * end" cleanup wrongly assumed both already spoke 0-100. The raw 0.633 then
 * reached the card pill's `Math.round(percent)` and rendered as **1%** on
 * every card.
 *
 * Normalised HERE, at the single point where discover items enter the UI, so
 * neither the pill nor the match-score seed has to remember to scale.
 */
describe('fetchDiscover relevance-score scale', () => {
  const withScores = async (items: unknown[]) => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: { items, meta: { total: items.length, limit: 20, offset: 0, source: 'signals_search', degraded: false } },
    });
    vi.doMock('../api-client', () => ({ createApiClient: () => ({ post: postMock, get: vi.fn() }) }));
    const { fetchDiscover } = await import('../network-api');
    return fetchDiscover({ item_network: 'blue_dot', item_domain: 'provider', item_type: 'job_posting_1.0' });
  };

  it('converts the raw cosine score to the 0-100 scale the UI works in', async () => {
    const r = await withScores([{ item_id: 'a', score: 0.633 }]);
    // 63.3 → the pill rounds to "63%", not "1%".
    expect(r.items[0].score).toBeCloseTo(63.3, 6);
  });

  it('leaves a scoreless item alone rather than defaulting it to 0', async () => {
    // Native-fallback items carry no score at all. A 0 would badge "0%" as
    // though the item had been scored and found irrelevant.
    const r = await withScores([{ item_id: 'a' }, { item_id: 'b', score: null }]);
    expect(r.items[0].score).toBeUndefined();
    expect(r.items[1].score).toBeNull();
  });

  it('clamps to 0-100, since cosine similarity is not bounded below at 0', async () => {
    const r = await withScores([{ item_id: 'a', score: -0.2 }, { item_id: 'b', score: 1.4 }]);
    expect(r.items[0].score).toBe(0);
    expect(r.items[1].score).toBe(100);
  });

  it('keeps meta untouched', async () => {
    const r = await withScores([{ item_id: 'a', score: 0.5 }]);
    expect(r.meta.source).toBe('signals_search');
    expect(r.meta.total).toBe(1);
  });
});
