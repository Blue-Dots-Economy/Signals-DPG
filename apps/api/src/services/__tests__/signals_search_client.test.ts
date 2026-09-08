import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * signals-search cannot be run locally (#203 List PR, Task 2) — every case
 * here mocks either the config (envelope-construction cases) or `global.fetch`
 * (searchSignals cases). No real HTTP call is ever made.
 */
vi.mock('@/config', () => ({
  signalsSearchConfig: {
    url: 'https://signals-search.example.com',
    api_key: 'test-key',
  },
}));

import {
  buildSignalsSearchRequest,
  searchSignals,
  SignalsSearchError,
  type SearchSignalsInput,
} from '../signals_search_client';
import { signalsSearchConfig } from '@/config';

const baseInput: SearchSignalsInput = {
  network: 'blue_dot',
  domain: 'seeker',
  itemType: 'profile_1.0',
  limit: 20,
  offset: 0,
};

describe('buildSignalsSearchRequest — envelope construction', () => {
  it('builds the context block with a unique messageId per call', () => {
    const first = buildSignalsSearchRequest(baseInput);
    const second = buildSignalsSearchRequest(baseInput);

    expect(first.context).toMatchObject({
      version: '1.0.0',
      networkId: 'blue_dot',
      domain: 'seeker',
      itemType: 'profile_1.0',
    });
    expect(typeof first.context.messageId).toBe('string');
    expect(first.context.messageId.length).toBeGreaterThan(0);
    expect(first.context.messageId).not.toBe(second.context.messageId);
  });

  it('maps q to intent.textSearch, omitted when absent', () => {
    const withQuery = buildSignalsSearchRequest({ ...baseInput, q: 'plumber' });
    expect(withQuery.message.intent.textSearch).toBe('plumber');

    const withoutQuery = buildSignalsSearchRequest(baseInput);
    expect(withoutQuery.message.intent.textSearch).toBeUndefined();
  });

  it('maps a multi-value scalar facet to op "in"', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      filters: [{ field: 'city', values: ['pune', 'mumbai'] }],
    });

    expect(req.message.intent.filters).toEqual([
      { op: 'in', target: 'item_state.city', value: ['pune', 'mumbai'] },
    ]);
  });

  it('maps a multi-value array-valued facet to op "contains_any"', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      filters: [
        { field: 'skills', values: ['plumbing', 'wiring'], arrayValued: true },
      ],
    });

    expect(req.message.intent.filters).toEqual([
      {
        op: 'contains_any',
        target: 'item_state.skills',
        value: ['plumbing', 'wiring'],
      },
    ]);
  });

  it('maps a single-value selection on an array-valued facet to op "contains_any" (not "in", which would never match)', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      filters: [{ field: 'skills', values: ['plumbing'], arrayValued: true }],
    });

    // signals-search `in` is `item_state->>field = ANY(...)` (scalar text
    // compare); on an array field that extracts the serialized-array text and
    // never equals a single value. `contains_any` (jsonb `?|`) is correct for
    // one OR many values, so an array facet must always use it.
    expect(req.message.intent.filters).toEqual([
      { op: 'contains_any', target: 'item_state.skills', value: ['plumbing'] },
    ]);
  });

  it('maps anchorItemId to intent.item.id, omitted when absent (#394 profile anchor relevance)', () => {
    const withAnchor = buildSignalsSearchRequest({
      ...baseInput,
      anchorItemId: 'anchor-item-1',
    });
    expect(withAnchor.message.intent.item).toEqual({ id: 'anchor-item-1' });

    const withoutAnchor = buildSignalsSearchRequest(baseInput);
    expect(withoutAnchor.message.intent.item).toBeUndefined();
  });

  it('omits intent.filters when no filters are given', () => {
    const req = buildSignalsSearchRequest(baseInput);
    expect(req.message.intent.filters).toBeUndefined();
  });

  it('builds a single s_dwithin spatial clause with [lng, lat] GeoJSON order', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      lat: 12.9716,
      lng: 77.5946,
      distanceMeters: 5000,
    });

    expect(req.message.intent.spatial).toEqual([
      {
        op: 's_dwithin',
        geometry: { type: 'Point', coordinates: [77.5946, 12.9716] },
        distanceMeters: 5000,
      },
    ]);
  });

  it('omits distanceMeters from the spatial clause when not provided', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, lat: 1, lng: 2 });
    expect(req.message.intent.spatial).toEqual([
      { op: 's_dwithin', geometry: { type: 'Point', coordinates: [2, 1] } },
    ]);
  });

  it('omits intent.spatial when lat/lng are absent', () => {
    const req = buildSignalsSearchRequest(baseInput);
    expect(req.message.intent.spatial).toBeUndefined();
  });

  it('clamps limit to a maximum of 100', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, limit: 5000 });
    expect(req.message.pagination.limit).toBe(100);
  });

  it('clamps limit to a minimum of 1', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, limit: 0 });
    expect(req.message.pagination.limit).toBe(1);
  });

  it('clamps offset to a minimum of 0', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, offset: -10 });
    expect(req.message.pagination.offset).toBe(0);
  });

  it('passes a within-range limit/offset through unchanged', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, limit: 50, offset: 40 });
    expect(req.message.pagination).toEqual({ limit: 50, offset: 40 });
  });
});

describe('searchSignals — HTTP call + response mapping', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('POSTs to {url}/v1/search with content-type + x-api-key headers, and a reasonable timeout signal', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        context: {},
        message: { items: [], meta: { total: 0, limit: 20, offset: 0 } },
      }),
    });

    await searchSignals(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, options] = fetchMock.mock.calls[0];
    expect(String(target)).toBe('https://signals-search.example.com/v1/search');
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.headers['x-api-key']).toBe('test-key');
    expect(options.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(options.body as string);
    expect(body.context.networkId).toBe('blue_dot');
  });

  it('parses and returns full items (incl. item_instance_url etc.) + meta from a successful response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        context: {},
        message: {
          items: [
            {
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_id: 'item-1',
              item_state: { city: 'pune' },
              item_locations: [{ lat: 1, lng: 2 }],
              item_instance_url: 'http://source.local',
              item_schema_url: 'http://source.local/schema',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-02T00:00:00.000Z',
              created_by: 'usr_1',
              lifecycle_status: 'live',
              score: 0.9,
              distanceMeters: 120,
            },
          ],
          meta: { total: 1, limit: 20, offset: 0 },
        },
      }),
    });

    const result = await searchSignals(baseInput);

    expect(result.items).toEqual([
      {
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: 'item-1',
        item_state: { city: 'pune' },
        item_locations: [{ lat: 1, lng: 2 }],
        item_instance_url: 'http://source.local',
        item_schema_url: 'http://source.local/schema',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        created_by: 'usr_1',
        lifecycle_status: 'live',
        score: 0.9,
        distanceMeters: 120,
      },
    ]);
    expect(result.meta).toEqual({ total: 1, limit: 20, offset: 0 });
  });

  it('parses item_instance_url/item_schema_url/created_by as null when signals-search sends null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        context: {},
        message: {
          items: [
            {
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_id: 'item-1',
              item_state: {},
              item_locations: [],
              item_instance_url: null,
              item_schema_url: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              created_by: null,
              lifecycle_status: 'live',
            },
          ],
          meta: { total: 1, limit: 20, offset: 0 },
        },
      }),
    });

    const result = await searchSignals(baseInput);

    expect(result.items[0]).toMatchObject({
      item_instance_url: null,
      item_schema_url: null,
      created_by: null,
    });
  });

  it('throws when a required full-item field (e.g. lifecycle_status) is missing from the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        context: {},
        message: {
          items: [
            {
              item_network: 'blue_dot',
              item_domain: 'seeker',
              item_type: 'profile_1.0',
              item_id: 'item-1',
              item_state: {},
              item_locations: [],
              item_instance_url: null,
              item_schema_url: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              created_by: null,
              // lifecycle_status intentionally omitted
            },
          ],
          meta: { total: 1, limit: 20, offset: 0 },
        },
      }),
    });

    await expect(searchSignals(baseInput)).rejects.toThrow();
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'VALIDATION_ERROR', message: 'bad filter' }),
    });

    await expect(searchSignals(baseInput)).rejects.toThrow(/bad filter/);
  });

  it('throws a typed SignalsSearchError carrying status + code (upstream error) on a non-2xx response (#394)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'ANCHOR_NOT_FOUND', message: 'anchor item not found' }),
    });

    let caught: unknown;
    try {
      await searchSignals(baseInput);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SignalsSearchError);
    const typedErr = caught as SignalsSearchError;
    expect(typedErr.status).toBe(404);
    expect(typedErr.code).toBe('ANCHOR_NOT_FOUND');
    expect(typedErr.message).toMatch(/anchor item not found/);
  });

  it('throws when the response body fails schema validation', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ nonsense: true }),
    });

    await expect(searchSignals(baseInput)).rejects.toThrow();
  });

  it('throws without calling fetch when signals-search is not configured', async () => {
    signalsSearchConfig.url = undefined;
    signalsSearchConfig.api_key = undefined;

    await expect(searchSignals(baseInput)).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();

    signalsSearchConfig.url = 'https://signals-search.example.com';
    signalsSearchConfig.api_key = 'test-key';
  });
});

// ─── #644: explicit sort + an ordering centre that never filters ─────────────
//
// Contract: docs/superpowers/plans/2026-09-03-list-view-wire-contract.md
// §1 (envelope) and §5.1 (discover → envelope mapping).

describe('buildSignalsSearchRequest — sort and ordering centre (#644)', () => {
  it('places sort INSIDE intent, so the upstream cache key covers it', () => {
    const req = buildSignalsSearchRequest({ ...baseInput, sort: 'nearest' });

    expect(req.message.intent.sort).toBe('nearest');
    // Placement guard: signals-search hashes the WHOLE intent for its result
    // cache key. On `message` beside `pagination`, two different sorts would
    // silently share a cache entry.
    expect((req.message as Record<string, unknown>).sort).toBeUndefined();
  });

  it('omits sort entirely when not supplied, preserving inferred ordering', () => {
    const req = buildSignalsSearchRequest(baseInput);
    expect('sort' in req.message.intent).toBe(false);
  });

  it('emits orderingCenter as a GeoJSON Point in [lng, lat] order', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      sort: 'nearest',
      orderingLat: 12.97,
      orderingLng: 77.59,
    });

    expect(req.message.intent.orderingCenter).toEqual({
      type: 'Point',
      coordinates: [77.59, 12.97],
    });
  });

  it('builds NO spatial clause for an ordering centre alone — nearest must not filter', () => {
    // The crux of #644: signals-search applies `spatial` as a hard ST_DWithin
    // predicate. If an ordering centre leaked into it, sorting by distance
    // would silently truncate the candidate set to the default radius.
    const req = buildSignalsSearchRequest({
      ...baseInput,
      sort: 'nearest',
      orderingLat: 12.97,
      orderingLng: 77.59,
    });

    expect(req.message.intent.spatial).toBeUndefined();
  });

  it('omits orderingCenter when only one coordinate is supplied', () => {
    expect(
      buildSignalsSearchRequest({ ...baseInput, orderingLat: 12.97 }).message.intent
        .orderingCenter,
    ).toBeUndefined();
    expect(
      buildSignalsSearchRequest({ ...baseInput, orderingLng: 77.59 }).message.intent
        .orderingCenter,
    ).toBeUndefined();
  });

  it('still builds a spatial clause for an area filter', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      lat: 12.97,
      lng: 77.59,
      distanceMeters: 25000,
    });

    expect(req.message.intent.spatial).toEqual([
      {
        op: 's_dwithin',
        geometry: { type: 'Point', coordinates: [77.59, 12.97] },
        distanceMeters: 25000,
      },
    ]);
  });

  it('carries the two centres independently when both are supplied', () => {
    const req = buildSignalsSearchRequest({
      ...baseInput,
      sort: 'nearest',
      lat: 1,
      lng: 2,
      distanceMeters: 500,
      orderingLat: 3,
      orderingLng: 4,
    });

    const clause = req.message.intent.spatial?.[0];
    // `spatial` is a discriminated union since the bbox op landed (§1.5), so
    // narrow before reaching for the Point's geometry.
    expect(clause?.op).toBe('s_dwithin');
    if (clause?.op !== 's_dwithin') throw new Error('expected an s_dwithin clause');
    expect(clause.geometry.coordinates).toEqual([2, 1]);
    expect(req.message.intent.orderingCenter?.coordinates).toEqual([4, 3]);
  });

  it('cross-repo contract fixture (wire-contract §9)', () => {
    // Asserted independently in signals-search too, so a divergence between
    // the repos fails a test rather than only failing on the dev cluster.
    const req = buildSignalsSearchRequest({
      ...baseInput,
      anchorItemId: '00000000-0000-4000-8000-0000000000aa',
      q: 'solar',
      sort: 'nearest',
      orderingLat: 12.97,
      orderingLng: 77.59,
    });

    expect(req.message.intent).toMatchObject({
      item: { id: '00000000-0000-4000-8000-0000000000aa' },
      textSearch: 'solar',
      sort: 'nearest',
      orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] },
    });
    expect(req.message.intent.spatial).toBeUndefined();
  });
});
