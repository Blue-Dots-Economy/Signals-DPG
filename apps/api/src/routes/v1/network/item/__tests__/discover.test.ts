/**
 * Epic #203 List PR (P-follow-3, Task 2 — REVISED) — unit test for the public
 * `POST /network/item/discover` BFF's DIRECT MAP behavior.
 *
 * signals-search's `/v1/search` now returns the full item row per result
 * (signals-search PR #87), so this BFF maps each ranked result straight to
 * the DPG item response shape — no local-DB hydrate/re-read by id. Because
 * the happy path no longer touches Postgres, this suite mocks
 * `searchSignals`, `getNetworkConfigById`, and `isServedDomainBinding` and
 * runs as a plain (non-integration) unit test — no `docker compose up db`
 * required. The facet-guard-against-a-real-schema case stays covered by
 * `discover.integration.test.ts` (real network config); this file proves the
 * direct-mapping/order/error-passthrough behavior fast and unconditionally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

const NET = 'blue_dot';
const DOMAIN = 'seeker';
const ITEM_TYPE = 'profile_1.0';

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => true,
  replyForUnservedDomain: vi.fn(),
}));

// Mutable so individual tests can flip SIGNALS_SEARCH_DISTANCE_METERS
// on/off (#394) — mirrors the mutation pattern in
// services/__tests__/signals_search_client.test.ts.
vi.mock('@/config', () => ({
  signalsSearchConfig: {
    url: 'https://signals-search.example.com',
    api_key: 'test-key',
    distanceMeters: undefined as number | undefined,
  },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: NET,
    domains: [
      {
        id: DOMAIN,
        item_schemas: {
          [ITEM_TYPE]: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } },
              phone: { type: 'string', private: true },
            },
          },
        },
      },
    ],
  })),
}));

const { searchSignalsMock, fetchItemsAcrossInstancesMock } = vi.hoisted(() => ({
  searchSignalsMock: vi.fn(),
  fetchItemsAcrossInstancesMock: vi.fn(),
}));

vi.mock('@/services/signals_search_client', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/signals_search_client')
  >('@/services/signals_search_client');
  return {
    ...actual,
    searchSignals: searchSignalsMock,
  };
});

vi.mock('@/utils/inter_instance_fetch', () => ({
  fetchItemsAcrossInstances: fetchItemsAcrossInstancesMock,
}));

// Imported after mocks.
import { discover, resolveDiscoverSort } from '../discover.js';
import { SignalsSearchError } from '@/services/signals_search_client';
import { signalsSearchConfig } from '@/config';

function buildApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(discover, { prefix: '/api/v1/network' });
  return app;
}

function baseBody(extra: Record<string, unknown> = {}) {
  return {
    item_network: NET,
    item_domain: DOMAIN,
    item_type: ITEM_TYPE,
    limit: 20,
    offset: 0,
    ...extra,
  };
}

const FULL_ITEM_A = {
  item_network: NET,
  item_domain: DOMAIN,
  item_type: ITEM_TYPE,
  item_id: '11111111-1111-4111-8111-111111111111',
  item_state: { city: 'pune' },
  item_locations: [{ lat: 18.5, lng: 73.8 }],
  item_instance_url: 'http://source-a.local',
  item_schema_url: 'http://source-a.local/schema',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  created_by: 'usr_a',
  lifecycle_status: 'live',
  score: 0.4,
  distanceMeters: 500,
};

const FULL_ITEM_B = {
  item_network: NET,
  item_domain: DOMAIN,
  item_type: ITEM_TYPE,
  item_id: '00000000-0000-4000-8000-000000000000',
  item_state: { city: 'mumbai' },
  item_locations: [{ lat: 19.1, lng: 72.9 }],
  item_instance_url: null,
  item_schema_url: null,
  created_at: '2026-01-03T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
  created_by: null,
  lifecycle_status: 'live',
  score: 0.9,
  distanceMeters: 100,
};

describe('POST /api/v1/network/item/discover — direct map (revised, no hydrate)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('maps signals-search full items directly to the response, preserving signals-search order, with score/distanceMeters and meta.total', async () => {
    // FULL_ITEM_B (lower alphabetical/uuid order) ranked FIRST — a pass-through
    // that silently re-sorted (or hydrated from a DB and re-ordered) would be
    // caught by asserting this exact order.
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_B, FULL_ITEM_A],
      meta: { total: 2, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { total: number; limit: number; offset: number };
      items: Array<Record<string, unknown>>;
    };

    expect(body.items.map((i) => i.item_id)).toEqual([
      FULL_ITEM_B.item_id,
      FULL_ITEM_A.item_id,
    ]);
    expect(body.items[0]).toMatchObject({
      item_id: FULL_ITEM_B.item_id,
      item_instance_url: null,
      item_schema_url: null,
      created_by: null,
      created_at: FULL_ITEM_B.created_at,
      updated_at: FULL_ITEM_B.updated_at,
      lifecycle_status: 'live',
      item_state: { city: 'mumbai' },
      score: 0.9,
      distanceMeters: 100,
    });
    expect(body.items[1]).toMatchObject({
      item_id: FULL_ITEM_A.item_id,
      item_instance_url: 'http://source-a.local',
      item_schema_url: 'http://source-a.local/schema',
      created_by: 'usr_a',
      score: 0.4,
      distanceMeters: 500,
    });
    expect(body.meta).toEqual({
      total: 2,
      limit: 20,
      offset: 0,
      source: 'signals_search',
      degraded: false,
      // #644: every 200 reports the order actually applied.
      sort_applied: 'newest',
    });
  });

  it('passes q, geo, and pagination through to searchSignals (no DB involved)', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 10, offset: 5 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        q: 'plumber',
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        distance_meters: 3000,
        limit: 10,
        offset: 5,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({
      network: NET,
      domain: DOMAIN,
      itemType: ITEM_TYPE,
      q: 'plumber',
      lat: 12.9716,
      lng: 77.5946,
      distanceMeters: 3000,
      limit: 10,
      offset: 5,
    });
  });

  it('returns an empty items array (with meta) when signals-search has no matches, without touching a DB', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      meta: {
        total: 0,
        limit: 20,
        offset: 0,
        source: 'signals_search',
        degraded: false,
        sort_applied: 'newest',
      },
      items: [],
    });
  });
});

describe('POST /api/v1/network/item/discover — profile anchor relevance (#394)', () => {
  let app: FastifyInstance;
  const ANCHOR_ITEM_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('passes anchor_item_id through to searchSignals as anchorItemId', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ anchorItemId: ANCHOR_ITEM_ID });
  });

  it('retries searchSignals once WITHOUT the anchor on ANCHOR_NOT_FOUND (404), returning source:signals_search / degraded:false — not native_fallback', async () => {
    const notFoundErr = new SignalsSearchError('anchor not found');
    notFoundErr.status = 404;
    notFoundErr.code = 'ANCHOR_NOT_FOUND';

    searchSignalsMock.mockRejectedValueOnce(notFoundErr);
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_A],
      meta: { total: 1, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = searchSignalsMock.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCallArgs.anchorItemId).toBeUndefined();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();

    const body = res.json() as {
      meta: { total: number; limit: number; offset: number; source: string; degraded: boolean };
      items: Array<Record<string, unknown>>;
    };
    expect(body.meta).toEqual({
      total: 1,
      limit: 20,
      offset: 0,
      source: 'signals_search',
      degraded: false,
      // #644: every 200 reports the order actually applied.
      sort_applied: 'newest',
    });
    expect(body.items[0]).toMatchObject({ item_id: FULL_ITEM_A.item_id });
  });

  it('retries WITHOUT the anchor on INTERACTION_NOT_ALLOWED (403) — e.g. seeker→seeker — returning source:signals_search / degraded:false', async () => {
    const interactionErr = new SignalsSearchError('seeker → seeker not permitted');
    interactionErr.status = 403;
    interactionErr.code = 'INTERACTION_NOT_ALLOWED';

    searchSignalsMock.mockRejectedValueOnce(interactionErr);
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_A],
      meta: { total: 1, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    expect((searchSignalsMock.mock.calls[1][0] as Record<string, unknown>).anchorItemId).toBeUndefined();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
    const body = res.json() as { meta: { source: string; degraded: boolean } };
    expect(body.meta.source).toBe('signals_search');
    expect(body.meta.degraded).toBe(false);
  });

  it('falls back to native when the anchor retry ALSO fails', async () => {
    const notFoundErr = new SignalsSearchError('anchor not found');
    notFoundErr.status = 404;
    notFoundErr.code = 'ANCHOR_NOT_FOUND';

    searchSignalsMock.mockRejectedValueOnce(notFoundErr);
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('does NOT retry (goes straight to native fallback) on a non-anchor search error even when anchor_item_id is set', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('does NOT retry on a SignalsSearchError with a non-404 status even when anchor_item_id is set', async () => {
    const serverErr = new SignalsSearchError('upstream error');
    serverErr.status = 500;
    serverErr.code = 'INTERNAL_ERROR';

    searchSignalsMock.mockRejectedValueOnce(serverErr);
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });
});

describe('POST /api/v1/network/item/discover — native fallback (#203 List PR, Task 3)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('falls back to the native fetch path and sets meta.source=native_fallback when signals-search throws', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 1, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [
        {
          item_network: NET,
          item_domain: DOMAIN,
          item_type: ITEM_TYPE,
          item_id: FULL_ITEM_A.item_id,
          item_instance_url: FULL_ITEM_A.item_instance_url,
          item_schema_url: FULL_ITEM_A.item_schema_url,
          item_state: FULL_ITEM_A.item_state,
          item_locations: FULL_ITEM_A.item_locations,
          created_by: FULL_ITEM_A.created_by,
          created_at: FULL_ITEM_A.created_at,
          updated_at: FULL_ITEM_A.updated_at,
          lifecycle_status: 'live',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { total: number; limit: number; offset: number; source: string; degraded: boolean };
      items: Array<Record<string, unknown>>;
    };
    expect(body.meta).toEqual({
      total: 1,
      limit: 20,
      offset: 0,
      source: 'native_fallback',
      degraded: true,
      // #644: every 200 reports the order actually applied.
      sort_applied: 'newest',
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ item_id: FULL_ITEM_A.item_id });
    // Native fallback has no server-side facet/text search — score/distanceMeters
    // are search-only fields and are never present on a fallback item.
    expect(body.items[0]).not.toHaveProperty('score');
    expect(body.items[0]).not.toHaveProperty('distanceMeters');
  });

  it('falls back when signals-search times out (AbortSignal-style rejection)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'TimeoutError');
    searchSignalsMock.mockRejectedValueOnce(abortError);
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('falls back when signals-search is unconfigured (client throws a config error)', async () => {
    searchSignalsMock.mockRejectedValueOnce(
      new Error('signals-search is not configured (SIGNALS_SEARCH_URL/SIGNALS_SEARCH_API_KEY unset)')
    );
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
  });

  it('honors page size/offset and the geo filters on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 10, offset: 5, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        distance_meters: 3000,
        limit: 10,
        offset: 5,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters).toMatchObject({
      item_network: NET,
      item_domain: DOMAIN,
      item_type: ITEM_TYPE,
      item_latitude: 12.9716,
      item_longitude: 77.5946,
      radius_meters: 3000,
      limit: 10,
      offset: 5,
      lifecycle_filter: 'live_only',
    });
  });

  it('applies q as a native text_search (public, non-private field allowlist) on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ q: 'plumber' }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: { text_search?: { q: string; fields: string[] } };
    };
    expect(callArgs.filters.text_search).toBeDefined();
    expect(callArgs.filters.text_search?.q).toBe('plumber');
    // 'city' and 'skills' are non-private on the mocked schema; 'phone' is
    // private and must never appear in the allowlist.
    expect(callArgs.filters.text_search?.fields.sort()).toEqual(['city', 'skills']);
  });

  it('does not set text_search on the fallback call when no q was given', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.text_search).toBeUndefined();
  });

  it('applies facet filters as native item_state on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        filters: [
          { field: 'city', values: ['pune'] },
          { field: 'phone', values: ['555'] }, // private — must be dropped
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: { item_state?: Record<string, unknown> };
    };
    expect(callArgs.filters.item_state).toEqual({ city: ['pune'] });
  });

  it('does not set item_state on the fallback call when no filters were given', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.item_state).toBeUndefined();
  });

  it('never leaks text_search/item_state into the happy-path searchSignals call', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ q: 'plumber', filters: [{ field: 'city', values: ['pune'] }] }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('text_search');
    expect(callArgs).not.toHaveProperty('item_state');
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
  });

  // Natively, item_latitude/longitude is BOTH the filter centre and the
  // distance origin — buildWhereClause and buildDistanceOrderBy read the same
  // pair. signals-search can separate them; the native path cannot. Preferring
  // the ordering centre moved the radius onto a different point, so this path
  // filtered a DIFFERENT CIRCLE than signals-search would for the same
  // request — two result sets for one query, depending on whether the search
  // service happened to be up.
  it('nearest filters around the AREA centre, not the ordering centre', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        sort: 'nearest',
        item_latitude: 12.9,
        item_longitude: 77.5,
        distance_meters: 4000,
        ordering_latitude: 13.4,
        ordering_longitude: 77.9,
      }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.item_latitude).toBe(12.9);
    expect(callArgs.filters.item_longitude).toBe(77.5);
    expect(callArgs.filters.radius_meters).toBe(4000);
    expect(callArgs.filters.order_by).toBe('distance');
  });

  it('nearest uses the ordering centre UNBOUNDED when no area was requested', async () => {
    // An ordering centre bounds nothing — that is the whole point of #644.
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ sort: 'nearest', ordering_latitude: 13.4, ordering_longitude: 77.9 }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.item_latitude).toBe(13.4);
    expect(callArgs.filters.radius_meters).toBeUndefined();
    expect(callArgs.filters.order_by).toBe('distance');
  });

  it('returns a clean 500 (never throws) when BOTH signals-search and the native fallback fail', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('POST /api/v1/network/item/discover — input validation (#419 should-fix)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('returns 400 INVALID_ITEM_TYPE (not 500) for an item_type not declared on the domain, without calling searchSignals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_type: 'not_a_real_type' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'INVALID_ITEM_TYPE' });
    expect(searchSignalsMock).not.toHaveBeenCalled();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/network/item/discover — configurable spatial radius (#394)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
  });

  it('with a location + SIGNALS_SEARCH_DISTANCE_METERS set, sends distanceMeters to searchSignals and reports it in meta', async () => {
    signalsSearchConfig.distanceMeters = 5000;
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_latitude: 12.9716, item_longitude: 77.5946 }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.distanceMeters).toBe(5000);
    expect(res.json()).toMatchObject({ meta: { distance_meters: 5000 } });
  });

  it('with a location + SIGNALS_SEARCH_DISTANCE_METERS unset, omits distanceMeters from searchSignals but reports the 30000 default', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_latitude: 12.9716, item_longitude: 77.5946 }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.distanceMeters).toBeUndefined();
    expect(res.json()).toMatchObject({ meta: { distance_meters: 30000 } });
  });

  it('a request-body distance_meters override wins over the env default', async () => {
    signalsSearchConfig.distanceMeters = 5000;
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        distance_meters: 1500,
      }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.distanceMeters).toBe(1500);
    expect(res.json()).toMatchObject({ meta: { distance_meters: 1500 } });
  });

  it('with NO location, sends no actual spatial clause (lat/lng absent means distanceMeters is never applied) and omits meta.distance_meters, regardless of env', async () => {
    signalsSearchConfig.distanceMeters = 5000;
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    // No lat/lng means buildSpatialClause (signals_search_client.ts) never
    // builds a spatial clause at all, regardless of what distanceMeters is
    // set to on the input — so no location sent is the real invariant here.
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.lat).toBeUndefined();
    expect(callArgs.lng).toBeUndefined();
    const body = res.json() as { meta: Record<string, unknown> };
    expect(body.meta.distance_meters).toBeUndefined();
  });

  it('reports meta.distance_meters correctly on the anchor-retry success path', async () => {
    signalsSearchConfig.distanceMeters = 5000;
    const notFoundErr = new SignalsSearchError('anchor not found');
    notFoundErr.status = 404;
    notFoundErr.code = 'ANCHOR_NOT_FOUND';

    searchSignalsMock.mockRejectedValueOnce(notFoundErr);
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        anchor_item_id: '22222222-2222-4222-8222-222222222222',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'signals_search', degraded: false, distance_meters: 5000 },
    });
  });

  it('reports meta.distance_meters on the native_fallback path when a location was sent', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_latitude: 12.9716, item_longitude: 77.5946 }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true, distance_meters: 30000 },
    });
  });

  it('omits meta.distance_meters on the native_fallback path when no location was sent', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { meta: Record<string, unknown> };
    expect(body.meta.distance_meters).toBeUndefined();
  });

  // Whole-branch review fix: the native fallback must apply (be bounded by)
  // the SAME radius it reports in `meta.distance_meters`. The UI never sends
  // `distance_meters` itself (only lat/lng), so gating the fallback's
  // `radius_meters` on the raw request field silently omitted the spatial
  // bound while `meta.distance_meters` still claimed one was applied.
  it('bounds the native fallback to effectiveDistanceMeters (env-set) — not left unbounded', async () => {
    signalsSearchConfig.distanceMeters = 8000;
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_latitude: 12.9716, item_longitude: 77.5946 }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    // effectiveDistanceMeters (8000, from the env) — never body.distance_meters
    // (undefined here, since the UI doesn't send it).
    expect(callArgs.filters.radius_meters).toBe(8000);
    expect(res.json()).toMatchObject({ meta: { distance_meters: 8000 } });
  });

  it('bounds the native fallback to the 30000 default when SIGNALS_SEARCH_DISTANCE_METERS is unset', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_latitude: 12.9716, item_longitude: 77.5946 }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.radius_meters).toBe(30000);
    expect(res.json()).toMatchObject({ meta: { distance_meters: 30000 } });
  });

  it('leaves the native fallback radius_meters undefined when no location was sent', async () => {
    signalsSearchConfig.distanceMeters = 8000;
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.radius_meters).toBeUndefined();
  });
});

// ─── #644: opt-in area filter + explicit sort ────────────────────────────────
//
// Contract: docs/superpowers/plans/2026-09-03-list-view-wire-contract.md §5-§7.

describe('resolveDiscoverSort — defaulting and fallbacks (contract §5.2)', () => {
  const base = { hasAnchor: false, hasQ: false, hasOrderingCenter: false };

  it('defaults to relevance when an anchor is sent', () => {
    expect(resolveDiscoverSort({ ...base, hasAnchor: true })).toBe('relevance');
  });

  it('defaults to newest with no anchor', () => {
    expect(resolveDiscoverSort(base)).toBe('newest');
  });

  it('falls back to newest for relevance with neither anchor nor q', () => {
    // Never errors — the response reports what was actually applied.
    expect(resolveDiscoverSort({ ...base, requested: 'relevance' })).toBe('newest');
  });

  it('honours relevance when q is present without an anchor', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'relevance', hasQ: true })).toBe(
      'relevance',
    );
  });

  it('falls back to newest for nearest with no ordering centre', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'nearest' })).toBe('newest');
  });

  it('honours nearest with an ordering centre', () => {
    expect(
      resolveDiscoverSort({ ...base, requested: 'nearest', hasOrderingCenter: true }),
    ).toBe('nearest');
  });

  it('always honours an explicit newest', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'newest', hasAnchor: true })).toBe(
      'newest',
    );
  });
});

describe('POST /discover — the area filter is opt-in (#644)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
  });

  async function post(
    extra: Record<string, unknown> = {},
    upstreamSort: 'relevance' | 'newest' | 'nearest' = 'newest',
  ) {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: upstreamSort },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(extra),
    });
    return {
      res,
      body: res.json() as { meta: Record<string, unknown> },
      sent: searchSignalsMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined,
    };
  }

  it('sends no coordinates and no radius when no area is requested', async () => {
    const { res, body, sent } = await post();

    expect(res.statusCode).toBe(200);
    expect(sent?.lat).toBeUndefined();
    expect(sent?.lng).toBeUndefined();
    expect(sent?.distanceMeters).toBeUndefined();
    expect(body.meta.distance_meters).toBeUndefined();
  });

  it('does NOT apply the configured env radius without an area filter', async () => {
    // Regression guard for the #644 root cause: the env fallback previously
    // resolved a radius whenever a location was sent, and the UI always sent
    // one — so every signed-in viewer was silently bounded.
    signalsSearchConfig.distanceMeters = 30000;
    const { sent, body } = await post();

    expect(sent?.distanceMeters).toBeUndefined();
    expect(body.meta.distance_meters).toBeUndefined();
  });

  it('sends and reports a radius in radius mode', async () => {
    const { sent, body } = await post({
      item_latitude: 12.97,
      item_longitude: 77.59,
      distance_meters: 25000,
    });

    expect(sent?.lat).toBe(12.97);
    expect(sent?.lng).toBe(77.59);
    expect(sent?.distanceMeters).toBe(25000);
    expect(body.meta.distance_meters).toBe(25000);
  });

  it('applies the env radius when an area filter is requested without one', async () => {
    signalsSearchConfig.distanceMeters = 15000;
    const { sent, body } = await post({ item_latitude: 12.97, item_longitude: 77.59 });

    expect(sent?.distanceMeters).toBe(15000);
    expect(body.meta.distance_meters).toBe(15000);
  });

  it('forwards an ordering centre WITHOUT reporting a radius', async () => {
    // An ordering centre bounds nothing, so a "within X km" note would be a lie.
    const { sent, body } = await post(
      { sort: 'nearest', ordering_latitude: 12.97, ordering_longitude: 77.59 },
      'nearest',
    );

    expect(sent?.orderingLat).toBe(12.97);
    expect(sent?.orderingLng).toBe(77.59);
    expect(sent?.lat).toBeUndefined();
    expect(body.meta.distance_meters).toBeUndefined();
    expect(body.meta.sort_applied).toBe('nearest');
  });
});

describe('POST /discover — sort defaulting and reporting (#644)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
  });

  it('defaults to relevance when an anchor is sent, and forwards it', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: 'relevance' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: '11111111-1111-4111-8111-111111111111' }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock.mock.calls[0][0].sort).toBe('relevance');
    expect((res.json() as { meta: { sort_applied: string } }).meta.sort_applied).toBe(
      'relevance',
    );
  });

  it('defaults to newest with no anchor', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(searchSignalsMock.mock.calls[0][0].sort).toBe('newest');
  });

  it('prefers the upstream sort_applied over its own request', async () => {
    // signals-search is the authority on what it actually did.
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ sort: 'relevance', q: 'solar' }),
    });

    expect(searchSignalsMock.mock.calls[0][0].sort).toBe('relevance');
    expect((res.json() as { meta: { sort_applied: string } }).meta.sort_applied).toBe(
      'newest',
    );
  });

  it('falls back to its own resolved sort when the upstream omits sort_applied', async () => {
    // A signals-search deployed BEFORE #644 sends no sort_applied; the BFF must
    // still answer with a valid value rather than fail serialization.
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ sort: 'newest' }),
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { meta: { sort_applied: string } }).meta.sort_applied).toBe(
      'newest',
    );
  });
});

describe('POST /discover — native fallback ordering (contract §7)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
    searchSignalsMock.mockRejectedValue(new Error('signals-search down'));
    fetchItemsAcrossInstancesMock.mockResolvedValue({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });
  });

  async function post(extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(extra),
    });
    return {
      res,
      body: res.json() as { meta: Record<string, unknown> },
      filters: (fetchItemsAcrossInstancesMock.mock.calls[0]?.[0] as {
        filters: Record<string, unknown>;
      })?.filters,
    };
  }

  it('newest sends no coordinates, so the native ORDER BY is created_at DESC', async () => {
    const { res, body, filters } = await post({ sort: 'newest' });

    expect(res.statusCode).toBe(200);
    expect(filters.item_latitude).toBeUndefined();
    expect(filters.item_longitude).toBeUndefined();
    expect(filters.radius_meters).toBeUndefined();
    expect(body.meta.sort_applied).toBe('newest');
  });

  it('nearest sends coordinates with NO radius — distance-ordered, unbounded', async () => {
    const { filters, body } = await post({
      sort: 'nearest',
      ordering_latitude: 12.97,
      ordering_longitude: 77.59,
    });

    // buildWhereClause only adds a radius clause when lat, lng AND
    // radius_meters are all present, so omitting the radius orders without
    // filtering.
    expect(filters.item_latitude).toBe(12.97);
    expect(filters.item_longitude).toBe(77.59);
    expect(filters.radius_meters).toBeUndefined();
    expect(body.meta.sort_applied).toBe('nearest');
  });

  it('reports newest for a relevance request — the native path cannot rank', async () => {
    const { body } = await post({
      sort: 'relevance',
      anchor_item_id: '11111111-1111-4111-8111-111111111111',
    });

    expect(body.meta.degraded).toBe(true);
    expect(body.meta.sort_applied).toBe('newest');
  });

  it('still honours an explicit area filter on the degraded path', async () => {
    const { filters, body } = await post({
      item_latitude: 12.97,
      item_longitude: 77.59,
      distance_meters: 25000,
    });

    expect(filters.radius_meters).toBe(25000);
    expect(body.meta.distance_meters).toBe(25000);
  });
});

describe('POST /discover — viewport area mode (contract §1.5)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
  });

  const BOX = { min_lat: 12.8, min_lng: 77.4, max_lat: 13.1, max_lng: 77.8 };

  async function post(
    extra: Record<string, unknown> = {},
    upstreamSort: 'relevance' | 'newest' | 'nearest' = 'newest',
  ) {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: upstreamSort },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(extra),
    });
    return {
      res,
      body: res.json() as { meta: Record<string, unknown> },
      sent: searchSignalsMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined,
    };
  }

  it('forwards the four bounds and no radius', async () => {
    // Spec D6 dropped this mode because signals-search had only a Point +
    // radius op, and a circumscribed circle is always LARGER than the
    // rectangle — the list would have shown items that were off the edges of
    // the map. The bbox op makes it exact, so the mode is back.
    const { res, sent } = await post(BOX);

    expect(res.statusCode).toBe(200);
    expect(sent?.minLat).toBe(12.8);
    expect(sent?.minLng).toBe(77.4);
    expect(sent?.maxLat).toBe(13.1);
    expect(sent?.maxLng).toBe(77.8);
    expect(sent?.lat).toBeUndefined();
    expect(sent?.distanceMeters).toBeUndefined();
  });

  it('reports NO radius for a viewport search — it never applied one', async () => {
    // Review finding. `hasAreaFilter` folded the bbox in with the radius pair,
    // so `effectiveDistanceMeters` resolved to DEFAULT_SEARCH_DISTANCE_METERS
    // and went out as `meta.distance_meters`. The UI note is area-mode-blind
    // (`resolveListNote` only checks hasLocation && distanceMeters), so a
    // signed-in viewer who zoomed to one street and hit "Search this area" was
    // told "within 30 km of your profile location" — and still 30 km after
    // zooming out to a whole state. This is precisely the lie the ordering
    // centre was split out to avoid: report a bound only where one applies.
    const { body, sent } = await post(BOX);

    expect(body.meta.distance_meters).toBeUndefined();
    // The bbox itself must still be the filter that travels.
    expect(sent?.minLat).toBe(12.8);
    expect(sent?.distanceMeters).toBeUndefined();
  });

  it('still reports the radius when a viewport carries an ordering centre', async () => {
    // An ordering centre bounds nothing either, so it must not resurrect a
    // reported radius.
    const { body } = await post(
      { ...BOX, sort: 'nearest', ordering_latitude: 12.97, ordering_longitude: 77.59 },
      'nearest',
    );

    expect(body.meta.distance_meters).toBeUndefined();
  });

  it('a viewport contributes NO ordering centre, so nearest degrades', async () => {
    // Contract §1.3 rule 2 is `s_dwithin` only. Deriving a centre from the
    // rectangle's midpoint would let "search this area" silently change the
    // sort the user picked.
    const { body } = await post({ ...BOX, sort: 'nearest' });

    expect(body.meta.sort_applied).toBe('newest');
  });

  it('orders by distance when an ordering centre accompanies the viewport', async () => {
    const { body, sent } = await post(
      { ...BOX, sort: 'nearest', ordering_latitude: 12.97, ordering_longitude: 77.59 },
      'nearest',
    );

    expect(body.meta.sort_applied).toBe('nearest');
    expect(sent?.orderingLat).toBe(12.97);
    expect(sent?.minLat).toBe(12.8);
  });

  it('rejects a partial box rather than defaulting the missing side', async () => {
    // Defaulting a side would search somewhere the caller did not ask about.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ min_lat: 12.8, min_lng: 77.4 }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects transposed bounds rather than silently swapping them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ min_lat: 13.1, min_lng: 77.4, max_lat: 12.8, max_lng: 77.8 }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects an antimeridian-crossing box instead of returning nothing', async () => {
    // signals-search does not support it, and an empty set reads as
    // "nothing here" rather than "unsupported".
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ min_lat: 12.8, min_lng: 170, max_lat: 13.1, max_lng: -170 }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a bbox and a radius together — they are alternative area modes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        ...BOX,
        item_latitude: 12.97,
        item_longitude: 77.59,
        distance_meters: 5000,
      }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('passes the bbox to the NATIVE fallback, which has always supported one', async () => {
    // So the mode works with signals-search down — which is every local run.
    searchSignalsMock.mockRejectedValueOnce(new Error('unavailable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(BOX),
    });

    expect(res.statusCode).toBe(200);
    const nativeFilters = fetchItemsAcrossInstancesMock.mock.calls[0]?.[0]?.filters as
      | Record<string, unknown>
      | undefined;
    expect(nativeFilters?.min_lat).toBe(12.8);
    expect(nativeFilters?.max_lng).toBe(77.8);
    // The bbox filters; the order still comes from `sort`.
    expect(nativeFilters?.order_by).toBe('created_at');
    expect(nativeFilters?.radius_meters).toBeUndefined();
  });
});

/**
 * PARITY. Every area mode and sort has to behave the same whether
 * signals-search answers or the native fallback does — otherwise the list
 * silently changes meaning when the search service is down, which locally is
 * always and in production is an outage.
 *
 * The two implementations necessarily differ (an HTTP envelope vs SQL), so
 * this asserts the OBSERVABLE contract on both: which spatial constraint is
 * applied, and which ordering. It is the test that would have caught the
 * native path still inferring its ORDER BY from the presence of coordinates
 * (#644 P3), where an area filter silently reordered a `newest` list.
 */
describe('POST /discover — signals-search and native parity (contract §7)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    signalsSearchConfig.distanceMeters = undefined;
    app = buildApp();
  });

  const RADIUS = { item_latitude: 12.97, item_longitude: 77.59, distance_meters: 5000 };
  const BOX = { min_lat: 12.8, min_lng: 77.4, max_lat: 13.1, max_lng: 77.8 };

  async function viaSearch(extra: Record<string, unknown>, applied = 'newest') {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, sort_applied: applied },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(extra),
    });
    return {
      applied: (res.json() as { meta: { sort_applied: string } }).meta.sort_applied,
      sent: searchSignalsMock.mock.calls[0]?.[0] as Record<string, unknown>,
    };
  }

  async function viaNative(extra: Record<string, unknown>) {
    searchSignalsMock.mockRejectedValueOnce(new Error('unavailable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(extra),
    });
    return {
      applied: (res.json() as { meta: { sort_applied: string } }).meta.sort_applied,
      filters: fetchItemsAcrossInstancesMock.mock.calls[0]?.[0]?.filters as Record<
        string,
        unknown
      >,
    };
  }

  it('anywhere + newest: neither path applies any spatial constraint', async () => {
    const search = await viaSearch({ sort: 'newest' });
    expect(search.sent.lat).toBeUndefined();
    expect(search.sent.minLat).toBeUndefined();

    const native = await viaNative({ sort: 'newest' });
    expect(native.filters.item_latitude).toBeUndefined();
    expect(native.filters.min_lat).toBeUndefined();
    expect(native.filters.order_by).toBe('created_at');
  });

  it('radius + newest: both bound by the radius, and NEITHER reorders', async () => {
    // The defect this pins: the native ORDER BY used to key off the presence
    // of coordinates, so this exact request came back distance-ordered.
    const search = await viaSearch({ sort: 'newest', ...RADIUS });
    expect(search.sent.lat).toBe(12.97);
    expect(search.sent.distanceMeters).toBe(5000);
    expect(search.applied).toBe('newest');

    const native = await viaNative({ sort: 'newest', ...RADIUS });
    expect(native.filters.item_latitude).toBe(12.97);
    expect(native.filters.radius_meters).toBe(5000);
    expect(native.filters.order_by).toBe('created_at');
    expect(native.applied).toBe('newest');
  });

  it('radius + nearest: both bound AND order by distance', async () => {
    const search = await viaSearch({ sort: 'nearest', ...RADIUS }, 'nearest');
    expect(search.sent.lat).toBe(12.97);
    expect(search.applied).toBe('nearest');

    const native = await viaNative({ sort: 'nearest', ...RADIUS });
    expect(native.filters.item_latitude).toBe(12.97);
    expect(native.filters.order_by).toBe('distance');
    expect(native.applied).toBe('nearest');
  });

  it('viewport + newest: both bound by the box, and NEITHER reorders', async () => {
    const search = await viaSearch({ sort: 'newest', ...BOX });
    expect(search.sent.minLat).toBe(12.8);
    expect(search.sent.maxLng).toBe(77.8);
    expect(search.sent.lat).toBeUndefined();

    const native = await viaNative({ sort: 'newest', ...BOX });
    expect(native.filters.min_lat).toBe(12.8);
    expect(native.filters.max_lng).toBe(77.8);
    expect(native.filters.radius_meters).toBeUndefined();
    expect(native.filters.order_by).toBe('created_at');
  });

  it('viewport alone + nearest: BOTH degrade to newest, having no centre', async () => {
    // A bbox carries no centre, and neither path may invent one from the
    // rectangle's midpoint — that would let "search this area" change the
    // sort (contract §1.3 rule 2 is s_dwithin-only).
    const search = await viaSearch({ sort: 'nearest', ...BOX });
    expect(search.applied).toBe('newest');

    const native = await viaNative({ sort: 'nearest', ...BOX });
    expect(native.applied).toBe('newest');
    expect(native.filters.order_by).toBe('created_at');
  });

  it('viewport + an explicit ordering centre + nearest: both bound by the box and order by distance', async () => {
    const centre = { ordering_latitude: 12.95, ordering_longitude: 77.6 };

    const search = await viaSearch({ sort: 'nearest', ...BOX, ...centre }, 'nearest');
    expect(search.sent.minLat).toBe(12.8);
    expect(search.sent.orderingLat).toBe(12.95);
    expect(search.applied).toBe('nearest');

    const native = await viaNative({ sort: 'nearest', ...BOX, ...centre });
    expect(native.filters.min_lat).toBe(12.8);
    // The native path measures distance from the ordering centre it was given.
    expect(native.filters.item_latitude).toBe(12.95);
    expect(native.filters.order_by).toBe('distance');
    expect(native.applied).toBe('nearest');
  });

  it('nearest with an ordering centre and NO area: both order without bounding', async () => {
    // #644's headline: location may sort without truncating.
    const centre = { ordering_latitude: 12.97, ordering_longitude: 77.59 };

    const search = await viaSearch({ sort: 'nearest', ...centre }, 'nearest');
    expect(search.sent.orderingLat).toBe(12.97);
    expect(search.sent.distanceMeters).toBeUndefined();
    expect(search.sent.minLat).toBeUndefined();

    const native = await viaNative({ sort: 'nearest', ...centre });
    expect(native.filters.item_latitude).toBe(12.97);
    expect(native.filters.order_by).toBe('distance');
    // No bound of any kind.
    expect(native.filters.radius_meters).toBeUndefined();
    expect(native.filters.min_lat).toBeUndefined();
  });
});

describe('resolveDiscoverSort — review findings', () => {
  it('keeps relevance for an UNSPECIFIED sort when only text is present', () => {
    // Compat regression. `hasQ` was honoured in the explicit-relevance branch
    // but ignored in the unspecified default, which returned 'newest'. Since
    // `buildSearchInput` now always sends `sort`, that default OVERRODE
    // signals-search's own inference — so every pre-existing caller POSTing
    // just `{ item_network, item_domain, item_type, q }` silently lost cosine
    // ordering and got date-ordered rows, while still paying for the embed.
    // `sort` is a new field, so no existing non-UI caller sets it.
    expect(
      resolveDiscoverSort({ hasAnchor: false, hasQ: true, hasOrderingCenter: false }),
    ).toBe('relevance');
  });

  it('still degrades an unspecified sort to newest with neither anchor nor text', () => {
    expect(
      resolveDiscoverSort({ hasAnchor: false, hasQ: false, hasOrderingCenter: false }),
    ).toBe('newest');
  });

  it('agrees with its own explicit-relevance branch about what a query vector is', () => {
    // The two branches must not disagree: whatever makes explicit relevance
    // satisfiable must make it the inferred default too.
    for (const [hasAnchor, hasQ] of [[true, false], [false, true], [true, true]] as const) {
      expect(resolveDiscoverSort({ requested: 'relevance', hasAnchor, hasQ, hasOrderingCenter: false })).toBe(
        resolveDiscoverSort({ hasAnchor, hasQ, hasOrderingCenter: false }),
      );
    }
  });
});
