import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Marker, MarkersResponse } from '@/lib/network-api';
import { useMapMarkers } from './use-map-markers';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkMarkers: vi.fn(),
  MAP_FETCH_LIMIT: 5000,
}));
import { fetchNetworkMarkers } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const marker = (id: string, domain: string): Marker => ({
  item_id: id,
  item_domain: domain,
  item_instance_url: null,
  item_locations: [{ lat: 19, lng: 72 }],
});

const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
// Both declare `gender`, because the facet tests below filter on it and a
// facet is only routed to a domain whose schema declares it — the server
// drops an undeclared one silently, so sending it would return that domain
// UNFILTERED (see "per-domain facet routing" at the bottom of this file).
const genderSchema = { properties: { gender: { type: 'string' } } };
const domains = [
  { id: 'student', item_schemas: { 'profile_1.0': genderSchema } },
  { id: 'mentor', item_schemas: { 'profile_1.0': genderSchema } },
] as unknown as DotNetworkDomain[];
const viewport = { lat: 19.076, lng: 72.8777, radiusMeters: 3000 };

describe('useMapMarkers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches per domain with lat/lng/radius+limit and merges markers/total/partial', async () => {
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q): Promise<MarkersResponse> => {
      if (q.item_domain === 'student') {
        return {
          meta: { total: 2, limit: 5000, offset: 0, partial: true, unavailable_instances: ['x'] },
          markers: [marker('a', 'student')],
        };
      }
      return {
        meta: { total: 1, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
        markers: [marker('b', 'mentor')],
      };
    });

    const { result } = renderHook(() => useMapMarkers(network, domains, viewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.markers.map((m) => m.item_id).sort()).toEqual(['a', 'b']);
    expect(result.current.total).toBe(3);
    expect(result.current.partial).toBe(true);

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_latitude: 19.076,
        item_longitude: 72.8777,
        radius_meters: 3000,
        limit: 5000,
        cache_ttl_seconds: 90,
      }),
      expect.anything(),
    );
    // Enum filtering is deferred in P4 — never sent from this hook.
    const call = vi.mocked(fetchNetworkMarkers).mock.calls[0][0];
    expect(call).not.toHaveProperty('item_state');
  });

  it('is disabled when viewport is null (no fetch)', () => {
    renderHook(() => useMapMarkers(network, domains, null), { wrapper });
    expect(fetchNetworkMarkers).not.toHaveBeenCalled();
  });

  it('is disabled when network is null (no fetch)', () => {
    renderHook(() => useMapMarkers(null, domains, viewport), { wrapper });
    expect(fetchNetworkMarkers).not.toHaveBeenCalled();
  });

  it('reuses the cache for a pan within the fetch radius but refetches for a large move (#203 §5.2 jank fix)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    // City-zoom viewport: ~10km radius → bucket cell ~5km. The fetch already
    // covers a ~10km circle, so panning a couple of km stays inside it and must
    // reuse the cache. (The previous fixed ~110m bucket refetched on every such
    // pan, which janked the map — this is the regression guard.)
    const cityVp = { lat: 19.076, lng: 72.8777, radiusMeters: 10000 };
    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof cityVp }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: cityVp } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // ~2.2km pan — would have busted the old fixed bucket, but stays within the
    // radius-relative cell → NO refetch.
    rerender({ vp: { ...cityVp, lat: cityVp.lat + 0.02 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // ~11km move (bigger than the fetched radius) → new cell → refetch.
    rerender({ vp: { ...cityVp, lat: cityVp.lat + 0.1 } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  // #203 map-serverside-search Task 4: once the viewport carries a bbox (both
  // live providers populate it now), the map sends the bbox to the server
  // instead of a client-computed radius, and the query key snaps on the bbox
  // + zoom band + active filters rather than the old lat/lng/radius buckets.
  const bboxViewport = {
    lat: 19.076,
    lng: 72.8777,
    radiusMeters: 3000,
    zoom: 8,
    minLat: 19.0,
    minLng: 72.0,
    maxLat: 19.5,
    maxLng: 72.5,
  };

  it('sends min_lat/min_lng/max_lat/max_lng (not lat/lng/radius) when the viewport has a bbox', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        min_lat: bboxViewport.minLat,
        min_lng: bboxViewport.minLng,
        max_lat: bboxViewport.maxLat,
        max_lng: bboxViewport.maxLng,
      }),
      expect.anything(),
    );
    const call = vi.mocked(fetchNetworkMarkers).mock.calls[0][0];
    expect(call).not.toHaveProperty('item_latitude');
    expect(call).not.toHaveProperty('item_longitude');
    expect(call).not.toHaveProperty('radius_meters');
  });

  it('forwards the active facet filters as item_state when provided', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport, { gender: ['female'] }), {
      wrapper,
    });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalled());

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({ item_state: { gender: ['female'] } }),
      expect.anything(),
    );
  });

  it('reuses the cache for a same/contained bbox + same zoom band + same filters', async () => {
    // Non-empty on purpose: an EMPTY held result now always forces a refetch
    // (see the empty-result test below), so an empty payload here would be
    // asserting the opposite of what this test is about. The cache-reuse
    // behaviour under test is unchanged.
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 1, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp, filters }: { vp: typeof bboxViewport; filters: Record<string, unknown> }) =>
        useMapMarkers(network, [domains[0]], vp, filters),
      { wrapper, initialProps: { vp: bboxViewport, filters: { gender: ['female'] } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // Contained bbox, well within the same snapped grid cell, same filters → no refetch.
    const contained = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.01,
      minLng: bboxViewport.minLng + 0.01,
      maxLat: bboxViewport.maxLat - 0.01,
      maxLng: bboxViewport.maxLng - 0.01,
    };
    rerender({ vp: contained, filters: { gender: ['female'] } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);
  });

  it('refetches when a pan crosses a snapped grid cell', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    const panned = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.1,
      minLng: bboxViewport.minLng + 0.1,
      maxLat: bboxViewport.maxLat + 0.1,
      maxLng: bboxViewport.maxLng + 0.1,
    };
    rerender({ vp: panned });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches when zoom crosses the cluster-disable band, even with the same bbox', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: { ...bboxViewport, zoom: 13 } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: { ...bboxViewport, zoom: 14 } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  // #203 map-serverside-search Task 5: the padded-bbox + truncated-result
  // refetch state machine. `bboxViewport` spans 0.5deg on each axis, so its
  // padded bbox (25% inflate) is [18.9375, 19.5625] x [71.9375, 72.5625].
  const containedBbox = {
    ...bboxViewport,
    minLat: bboxViewport.minLat + 0.01,
    minLng: bboxViewport.minLng + 0.01,
    maxLat: bboxViewport.maxLat - 0.01,
    maxLng: bboxViewport.maxLng - 0.01,
  };

  it('does not refetch a contained zoom-in when the last result was complete (#203 Task 5)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: containedBbox });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Held marker set is reused — no second network call.
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);
  });

  it('refetches a contained zoom-in when the last result was truncated (#203 Task 5, HSR-layout case)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      // Deliberately way over any plausible placeholder cap: a dense area
      // (e.g. 20k profiles in Bangalore) whose held set can't be trusted for
      // a zoomed-in sub-area.
      meta: { total: 200_000, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: containedBbox });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches a contained zoom-in when the last result was EMPTY', async () => {
    // The stranded-map case: a world-zoom fetch answered `total: 0` (the
    // server's >180° bbox resolved to the complement of itself), so the held
    // padded bbox covered every subsequent viewport and, being untruncated,
    // suppressed every refetch — the map stayed blank until a page reload.
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: containedBbox });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches a pan that escapes the padded bbox even when the last result was complete (#203 Task 5)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // Padded bbox is [18.9375, 19.5625] x [71.9375, 72.5625]; a +0.1 shift on
    // every corner pushes maxLat to 19.6, escaping it.
    const pannedOut = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.1,
      minLng: bboxViewport.minLng + 0.1,
      maxLat: bboxViewport.maxLat + 0.1,
      maxLng: bboxViewport.maxLng + 0.1,
    };
    rerender({ vp: pannedOut });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches with the CURRENT (tighter) bbox when a zoom crosses the cluster-disable band, even if that bbox is still contained in the old padded bbox (#203 Task 5 fix)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } }, // zoom: 8 → 'clustered' band
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // `containedBbox` (shrunk by 0.01 on every corner) is still fully inside
    // the old padded bbox [18.9375, 19.5625] x [71.9375, 72.5625] — a pure
    // pan/zoom-in with an unchanged band would SKIP the refetch. Crossing
    // into the 'individual' band (zoom 14) must force a refetch anyway, and
    // that refetch must use THIS tighter bbox, not the original wide one.
    const zoomedInAcrossBand = { ...containedBbox, zoom: 14 };
    rerender({ vp: zoomedInAcrossBand });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));

    const secondCall = vi.mocked(fetchNetworkMarkers).mock.calls[1][0];
    expect(secondCall).toEqual(
      expect.objectContaining({
        min_lat: zoomedInAcrossBand.minLat,
        min_lng: zoomedInAcrossBand.minLng,
        max_lat: zoomedInAcrossBand.maxLat,
        max_lng: zoomedInAcrossBand.maxLng,
      }),
    );
  });

  it('refetches when the active facet filters change, even with the same bbox and zoom', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ filters }: { filters: Record<string, unknown> }) =>
        useMapMarkers(network, [domains[0]], bboxViewport, filters),
      { wrapper, initialProps: { filters: { gender: ['female'] } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ filters: { gender: ['male'] } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  // #203 map-serverside-search Task 6: the zoom-band marker caps
  // (`capForZoom`) replace the flat `MAP_FETCH_LIMIT` on the bbox path, and
  // `meta.total` vs that same cap drives the exposed `truncated` flag the
  // over-dense "N+ in this area — zoom in" indicator reads. `bboxViewport`
  // (zoom: 8) bands as 'clustered' (cap 1000, so limit = 1001); zoom 14+
  // bands as 'individual' (cap 500, so limit = 501) — see `map-caps.ts`'s
  // defaults.
  it('uses the clustered zoom-band cap (+1) as the limit on the bbox path, not the flat MAP_FETCH_LIMIT', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 1001, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1001 }),
      expect.anything(),
    );
  });

  it('uses the individual zoom-band cap (+1) once zoom is at/above the cluster-disable band', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 501, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result } = renderHook(
      () => useMapMarkers(network, [domains[0]], { ...bboxViewport, zoom: 14 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 501 }),
      expect.anything(),
    );
  });

  it('exposes truncated: true when a domain\'s meta.total exceeds the zoom-band cap', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 1500, limit: 1001, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.truncated).toBe(true);
  });

  it('exposes truncated: false when meta.total is within the zoom-band cap', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 42, limit: 1001, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.truncated).toBe(false);
  });

  // map-native-text-search: free-text search now filters the map server-side
  // via `/markers?q=`, mirroring the facet-filter (`filters`) wiring above.
  describe('free-text search (map-native-text-search)', () => {
    it('passes q into fetchNetworkMarkers when search is non-empty', async () => {
      vi.mocked(fetchNetworkMarkers).mockResolvedValue({
        meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
        markers: [],
      });

      renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport, {}, 'jane'), { wrapper });
      await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalled());

      expect(fetchNetworkMarkers).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'jane' }),
        expect.anything(),
      );
    });

    it('sends no q when search is empty or whitespace-only', async () => {
      vi.mocked(fetchNetworkMarkers).mockResolvedValue({
        meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
        markers: [],
      });

      renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport, {}, '   '), { wrapper });
      await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalled());

      const call = vi.mocked(fetchNetworkMarkers).mock.calls[0][0];
      expect(call).not.toHaveProperty('q');
    });

    it('refetches when search changes, even with the same bbox and zoom', async () => {
      vi.mocked(fetchNetworkMarkers).mockResolvedValue({
        meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
        markers: [],
      });

      const { result, rerender } = renderHook(
        ({ search }: { search: string }) => useMapMarkers(network, [domains[0]], bboxViewport, {}, search),
        { wrapper, initialProps: { search: 'jane' } },
      );
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

      rerender({ search: 'john' });
      await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));

      const secondCall = vi.mocked(fetchNetworkMarkers).mock.calls[1][0];
      expect(secondCall).toEqual(expect.objectContaining({ q: 'john' }));
    });
  });
});

describe('useMapMarkers — per-domain facet routing', () => {
  beforeEach(() => vi.clearAllMocks());

  // Two domains declaring DIFFERENT facet fields, mirroring blue_dot, whose
  // seeker and provider schemas share none.
  const splitDomains = [
    {
      id: 'seeker',
      item_schemas: { 'profile_1.0': { properties: { gender: { type: 'string' } } } },
    },
    {
      id: 'provider',
      item_schemas: { 'job_posting_1.0': { properties: { natureOfJob: { type: 'string' } } } },
    },
  ] as unknown as DotNetworkDomain[];

  const okResponse = (domain: string): MarkersResponse => ({
    meta: { total: 1, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
    markers: [marker(`m-${domain}`, domain)],
  });

  it('sends a facet ONLY to the domain that declares it', async () => {
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q) => okResponse(q.item_domain));

    renderHook(
      () => useMapMarkers(network, splitDomains, viewport, { gender: ['Female'] }),
      { wrapper },
    );

    // The server drops an undeclared facet SILENTLY, so sending `gender` to
    // `provider` returned every provider pin UNFILTERED while the UI showed
    // the filter as active. That domain is skipped instead.
    await waitFor(() => expect(vi.mocked(fetchNetworkMarkers)).toHaveBeenCalled());
    const calls = vi.mocked(fetchNetworkMarkers).mock.calls.map(([q]) => q);
    const seeker = calls.find((q) => q.item_domain === 'seeker');
    expect(seeker?.item_state).toEqual({ gender: ['Female'] });
    expect(calls.some((q) => q.item_domain === 'provider')).toBe(false);
  });

  it('queries every domain when no facet is active', async () => {
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q) => okResponse(q.item_domain));

    renderHook(() => useMapMarkers(network, splitDomains, viewport), { wrapper });

    await waitFor(() =>
      expect(vi.mocked(fetchNetworkMarkers).mock.calls).toHaveLength(2),
    );
    for (const [q] of vi.mocked(fetchNetworkMarkers).mock.calls) {
      expect(q.item_state).toBeUndefined();
    }
  });

  it('splits a mixed selection so each domain gets only its own field', async () => {
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q) => okResponse(q.item_domain));

    renderHook(
      () =>
        useMapMarkers(network, splitDomains, viewport, {
          gender: ['Female'],
          natureOfJob: ['Internship'],
        }),
      { wrapper },
    );

    // Neither domain declares BOTH fields, so neither can satisfy the full
    // selection and the map legitimately shows nothing.
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(fetchNetworkMarkers)).not.toHaveBeenCalled();
  });
});

describe('useMapMarkers — the count matches what is on screen (N4)', () => {
  beforeEach(() => vi.clearAllMocks());

  const wideViewport = {
    lat: 19, lng: 72, radiusMeters: 500000,
    minLat: 10, minLng: 65, maxLat: 28, maxLng: 80, zoom: 5,
  };
  // Fully inside `wideViewport`, so `shouldRefetch` reuses the cached result.
  const cityViewport = {
    lat: 19, lng: 72, radiusMeters: 5000,
    minLat: 18.9, minLng: 71.9, maxLat: 19.1, maxLng: 72.1, zoom: 12,
  };

  const at = (id: string, lat: number, lng: number): Marker => ({
    item_id: id,
    item_domain: 'student',
    item_instance_url: null,
    item_locations: [{ lat, lng }],
  });

  it('recounts for a contained viewport instead of reusing the fetched total', async () => {
    // Two pins in the city, one far outside it but inside the wide bbox.
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [at('a', 19.0, 72.0), at('b', 19.05, 72.05), at('c', 27, 79)],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof wideViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: wideViewport } },
    );

    await waitFor(() => expect(result.current.total).toBe(3));

    // Zoom in. The bbox is contained, so no refetch happens and the markers
    // are reused — but the count must follow the screen, not the last fetch.
    rerender({ vp: cityViewport });
    await waitFor(() => expect(result.current.total).toBe(2));
    // Markers themselves are still the reused superset; only the count narrows.
    expect(result.current.markers).toHaveLength(3);
  });

  it('keeps the server total when the domain is truncated', async () => {
    // Above the zoom-band cap: we do NOT hold the full set, so counting the
    // returned markers would understate it. The caller renders "N+" from
    // `truncated` in this case.
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 100000, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [at('a', 19.0, 72.0)],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], cityViewport), {
      wrapper,
    });

    await waitFor(() => expect(result.current.truncated).toBe(true));
    expect(result.current.total).toBe(100000);
  });
});
