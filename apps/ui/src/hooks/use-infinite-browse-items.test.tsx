import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useInfiniteBrowseItems } from './use-infinite-browse-items';
import type { BrowseArea } from '@/lib/browse-discover';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
  fetchDiscover: vi.fn(),
  PROFILE_PAGE_SIZE: 2,
}));
import { fetchNetworkItems, fetchDiscover } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const item = (id: string): Item => ({ item_id: id } as unknown as Item);
const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
const domain = { id: 'student', item_schemas: { 'profile_1.0': {} } } as unknown as DotNetworkDomain;

describe('useInfiniteBrowseItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads pages, appends, exposes total + hasNextPage, sends lat/lng + offset', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => ({
      meta: { total: 3, limit: 2, offset: q.offset ?? 0 },
      items: (q.offset ?? 0) === 0 ? [item('a'), item('b')] : [item('c')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 19, lng: 72 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.total).toBe(3);
    expect(result.current.hasNextPage).toBe(true);
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({ item_latitude: 19, item_longitude: 72, offset: 0 }),
      expect.anything(),
    );
    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasNextPage).toBe(false); // 3 of 3 loaded
  });

  it('is disabled when domain is null (no fetch)', () => {
    renderHook(() => useInfiniteBrowseItems(network, null, null), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });

  it('defaults partial to false when meta.partial is absent', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async () => ({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.partial).toBe(false);
  });

  // #203 §6: `partial` must propagate up to the list feed if ANY loaded page
  // came back partial, even once a later page's peers all answered — earlier
  // items may still be missing, so the feed stays flagged (sticky).
  it('exposes partial=true when any loaded page is partial, and it stays true once a later page is not', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => {
      const offset = q.offset ?? 0;
      return offset === 0
        ? { meta: { total: 3, limit: 2, offset, partial: true, unavailable_instances: ['https://peer.example'] }, items: [item('a'), item('b')] }
        : { meta: { total: 3, limit: 2, offset, partial: false, unavailable_instances: [] }, items: [item('c')] };
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.partial).toBe(true);

    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.length).toBe(3));
    expect(result.current.partial).toBe(true);
  });

  // meta.total sums Redis-cached per-instance counts (TTL >= 300s) while pages
  // are fresh, so a delete/pause inside that window can leave `total` (5) higher
  // than the rows the server can actually return (a short first page of 1, below
  // PROFILE_PAGE_SIZE=2). Without the short-page check, `loaded` (1) < `total`
  // (5) forever, `hasNextPage` never flips false, and the scroll sentinel fires
  // endless empty-page fetches.
  it('stops paging on a short page even when meta.total says more remain', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async () => ({
      meta: { total: 5, limit: 2, offset: 0 },
      items: [item('a')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.total).toBe(5);
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchNetworkItems).toHaveBeenCalledTimes(1);
  });

  it('defaults source to native and degraded to false on the plain browse path', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.source).toBe('native');
    expect(result.current.degraded).toBe(false);
  });

  // #203 List PR Task 4: a non-empty `q` routes to the discover BFF instead
  // of the native paged browse, and a `q` change resets paging (distinct
  // query key -> fresh offset-0 fetch) rather than appending to the old feed.
  it('routes to fetchDiscover when q is set, and resets paging when q changes', async () => {
    vi.mocked(fetchDiscover).mockImplementation(async (q) => ({
      items: q.q === 'foo' ? [item('x')] : [item('y')],
      meta: { total: 1, limit: 2, offset: q.offset ?? 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    }));
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useInfiniteBrowseItems(network, domain, null, { q }),
      { wrapper, initialProps: { q: 'foo' } },
    );
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['x']));
    expect(fetchNetworkItems).not.toHaveBeenCalled();
    expect(fetchDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'foo', offset: 0 }),
      expect.anything(),
    );

    rerender({ q: 'bar' });
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['y']));
    expect(fetchDiscover).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'bar', offset: 0 }),
      expect.anything(),
    );
  });

  it('routes to fetchDiscover when facet filters are set, even without q', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('z')],
      meta: { total: 1, limit: 2, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          filters: [{ field: 'skills', values: ['algebra'] }],
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['z']));
    expect(fetchNetworkItems).not.toHaveBeenCalled();
    expect(fetchDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ field: 'skills', values: ['algebra'] }] }),
      expect.anything(),
    );
  });

  it('routes to fetchDiscover when relevance is forced, even with no q/filters', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('r')],
      meta: { total: 1, limit: 2, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null, { relevance: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(fetchNetworkItems).not.toHaveBeenCalled();
    expect(fetchDiscover).toHaveBeenCalled();
  });

  it('surfaces source and degraded from the discover response (native_fallback case)', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('a')],
      meta: { total: 1, limit: 2, offset: 0, source: 'native_fallback', degraded: true, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null, { q: 'x' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.source).toBe('native_fallback');
    expect(result.current.degraded).toBe(true);
  });

  // Final-review follow-up: `degraded`/`source` are STICKY across infinite-scroll
  // pages (like `partial`). If page 0 fell back to native (signals-search down)
  // its unfiltered/unranked items are already in the feed, so a later page that
  // reaches a recovered signals-search must NOT flip the degraded banner off —
  // that would show the accumulated fallback items as if the filters applied.
  it('keeps degraded=true and source=native_fallback once any page fell back, even if a later page recovers', async () => {
    vi.mocked(fetchDiscover).mockImplementation(async (q) => {
      const offset = q.offset ?? 0;
      return offset === 0
        ? { items: [item('a'), item('b')], meta: { total: 3, limit: 2, offset, source: 'native_fallback' as const, degraded: true, sort_applied: 'relevance' } }
        : { items: [item('c')], meta: { total: 3, limit: 2, offset, source: 'signals_search' as const, degraded: false, sort_applied: 'relevance' } };
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null, { q: 'x' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.degraded).toBe(true);
    expect(result.current.source).toBe('native_fallback');

    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.length).toBe(3));
    expect(result.current.degraded).toBe(true);
    expect(result.current.source).toBe('native_fallback');
  });

  it('does not call fetchDiscover when q is only whitespace and no filters/relevance are set', () => {
    renderHook(
      () => useInfiniteBrowseItems(network, domain, null, { q: '   ' }),
      { wrapper },
    );
    expect(fetchDiscover).not.toHaveBeenCalled();
  });

  // #394 Task 2: threading the profile anchor (Task 1's backend-side
  // `anchor_item_id` -> `intent.item.id` relevance ranking) through the
  // discover data layer. Discover mode must forward it; a change must reset
  // paging (new query key) since switching the selected profile re-ranks.
  it('passes anchor_item_id to fetchDiscover in discover mode', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('a')],
      meta: { total: 1, limit: 2, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          anchorItemId: 'profile-123',
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(fetchDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ anchor_item_id: 'profile-123' }),
      expect.anything(),
    );
  });

  it('resets paging and refetches with the new anchor when anchorItemId changes in discover mode', async () => {
    vi.mocked(fetchDiscover).mockImplementation(async (q) => ({
      items: q.anchor_item_id === 'profile-a' ? [item('x')] : [item('y')],
      meta: { total: 1, limit: 2, offset: q.offset ?? 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    }));
    const { result, rerender } = renderHook(
      ({ anchorItemId }: { anchorItemId: string }) =>
        useInfiniteBrowseItems(network, domain, null, { relevance: true, anchorItemId }),
      { wrapper, initialProps: { anchorItemId: 'profile-a' } },
    );
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['x']));
    expect(fetchDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ anchor_item_id: 'profile-a', offset: 0 }),
      expect.anything(),
    );

    rerender({ anchorItemId: 'profile-b' });
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['y']));
    expect(fetchDiscover).toHaveBeenLastCalledWith(
      expect.objectContaining({ anchor_item_id: 'profile-b', offset: 0 }),
      expect.anything(),
    );
  });

  // #394 Task 2: the discover BFF reports the effective spatial radius as
  // `meta.distance_meters` (present only when the request carried a
  // location) so the list note above the results can show "within X km".
  it('surfaces distanceMeters from the discover response meta.distance_meters', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('a')],
      meta: { total: 1, limit: 2, offset: 0, source: 'signals_search', degraded: false, distance_meters: 30000, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 19, lng: 72 }, { relevance: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.distanceMeters).toBe(30000);
  });

  it('leaves distanceMeters undefined when the discover response omits it (no location sent)', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [item('a')],
      meta: { total: 1, limit: 2, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null, { relevance: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.distanceMeters).toBeUndefined();
  });

  it('leaves distanceMeters undefined on the plain native browse path', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 19, lng: 72 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.distanceMeters).toBeUndefined();
  });

  it('does not send anchor_item_id in native mode and its key is unaffected by anchorItemId', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    });
    const { result, rerender } = renderHook(
      ({ anchorItemId }: { anchorItemId: string }) =>
        useInfiniteBrowseItems(network, domain, null, { anchorItemId }),
      { wrapper, initialProps: { anchorItemId: 'profile-a' } },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(fetchDiscover).not.toHaveBeenCalled();
    expect(fetchNetworkItems).toHaveBeenCalledTimes(1);

    rerender({ anchorItemId: 'profile-b' });
    // Same key in native mode -> no refetch triggered by the anchor change.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchNetworkItems).toHaveBeenCalledTimes(1);
    expect(fetchDiscover).not.toHaveBeenCalled();
  });
});

// ─── #644: location no longer FILTERS the list ───────────────────────────────
//
// Before this, the hook forwarded `userLocation` as item_latitude/
// item_longitude on every discover request, and signals-search turns that into
// a hard s_dwithin predicate — so a signed-in viewer's list was silently
// bounded to ~30 km. `userLocation` is now an ORDERING centre only, used when
// the caller asks for sort: 'nearest'.

const discoverPage = (sortApplied: 'relevance' | 'newest' | 'nearest' = 'relevance') => ({
  items: [item('a')],
  meta: {
    total: 1,
    limit: 2,
    offset: 0,
    source: 'signals_search' as const,
    degraded: false,
    sort_applied: sortApplied,
  },
});

describe('useInfiniteBrowseItems — area and sort (#644)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends NO coordinates when area is anywhere, even with a resolved location', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('relevance'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, { lat: 12.97, lng: 77.59 }, {
          relevance: true,
          area: { mode: 'anywhere' },
          sort: 'relevance',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    expect(body.item_latitude).toBeUndefined();
    expect(body.item_longitude).toBeUndefined();
    expect(body.distance_meters).toBeUndefined();
    expect(body.ordering_latitude).toBeUndefined();
  });

  it('sends the area filter in radius mode', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('relevance'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          sort: 'relevance',
          area: { mode: 'radius', center: { lat: 12.97, lng: 77.59 }, meters: 25000 },
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    expect(body.item_latitude).toBe(12.97);
    expect(body.item_longitude).toBe(77.59);
    expect(body.distance_meters).toBe(25000);
  });

  it('sends the viewer location as an ORDERING centre for nearest + anywhere', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('nearest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, { lat: 12.97, lng: 77.59 }, {
          relevance: true,
          area: { mode: 'anywhere' },
          sort: 'nearest',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    expect(body.ordering_latitude).toBe(12.97);
    expect(body.ordering_longitude).toBe(77.59);
    // Orders, does not filter.
    expect(body.item_latitude).toBeUndefined();
    expect(body.distance_meters).toBeUndefined();
  });

  it('omits the ordering centre when an area filter already supplies one', async () => {
    // signals-search reuses the filter's centre for ordering, so sending both
    // would be redundant.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('nearest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, { lat: 1, lng: 2 }, {
          relevance: true,
          sort: 'nearest',
          area: { mode: 'radius', center: { lat: 12.97, lng: 77.59 }, meters: 25000 },
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    expect(body.ordering_latitude).toBeUndefined();
    expect(body.item_latitude).toBe(12.97);
  });

  it('forwards the requested sort', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('newest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          sort: 'newest',
          area: { mode: 'anywhere' },
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());
    expect(vi.mocked(fetchDiscover).mock.calls[0][0].sort).toBe('newest');
  });

  it('changing sort resets paging with a fresh query key', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('relevance'));
    const { rerender } = renderHook(
      ({ sort }: { sort: 'relevance' | 'newest' }) =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          sort,
          area: { mode: 'anywhere' },
        }),
      { wrapper, initialProps: { sort: 'relevance' as 'relevance' | 'newest' } },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalledTimes(1));

    rerender({ sort: 'newest' });
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetchDiscover).mock.calls[1][0].offset).toBe(0);
  });

  it('changing area resets paging', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('relevance'));
    const { rerender } = renderHook(
      ({ area }: { area: BrowseArea }) =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          sort: 'relevance',
          area,
        }),
      { wrapper, initialProps: { area: { mode: 'anywhere' } as BrowseArea } },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalledTimes(1));

    rerender({ area: { mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 } });
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalledTimes(2));
  });

  it('a resolved location alone does NOT change the discover query key', async () => {
    // It is no longer part of the request under relevance/newest, so it must
    // not trigger a refetch either.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('relevance'));
    const { rerender } = renderHook(
      ({ loc }: { loc: { lat: number; lng: number } | null }) =>
        useInfiniteBrowseItems(network, domain, loc, {
          relevance: true,
          sort: 'relevance',
          area: { mode: 'anywhere' },
        }),
      { wrapper, initialProps: { loc: null as { lat: number; lng: number } | null } },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalledTimes(1));

    rerender({ loc: { lat: 12.97, lng: 77.59 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchDiscover).toHaveBeenCalledTimes(1);
  });

  it('surfaces meta.sort_applied so the UI labels what the server did', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('newest'));
    const { result } = renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          sort: 'relevance',
          area: { mode: 'anywhere' },
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.sortApplied).toBe('newest'));
  });

  it('still forwards userLocation on the NATIVE path (out of #644 scope)', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    } as never);
    renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 12.97, lng: 77.59 }),
      { wrapper },
    );
    await waitFor(() => expect(fetchNetworkItems).toHaveBeenCalled());
    expect(vi.mocked(fetchNetworkItems).mock.calls[0][0].item_latitude).toBe(12.97);
  });
});

describe('useInfiniteBrowseItems — viewport area mode', () => {
  // This block asserts on the FIRST call, so the mock must start clean —
  // otherwise `calls[0]` is whatever an earlier test happened to leave.
  beforeEach(() => vi.mocked(fetchDiscover).mockClear());

  const BOUNDS = { minLat: 12.8, minLng: 77.4, maxLat: 13.1, maxLng: 77.8 };

  it('sends all four bounds and no radius', async () => {
    // Regression guard for a silent drop: `fetchDiscover` builds its body from
    // an explicit ALLOWLIST, so a field it does not name is discarded however
    // correctly the caller supplied it. The bbox first shipped inert exactly
    // that way — the hook and the BFF both handled it, this body builder did
    // not, and nothing failed loudly. Measured symptom: the list showed 79 of
    // 79 with a viewport applied, where the API returns 71 for that box.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('newest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, null, {
          relevance: true,
          area: { mode: 'viewport', bounds: BOUNDS },
          sort: 'newest',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    expect(body.min_lat).toBe(12.8);
    expect(body.min_lng).toBe(77.4);
    expect(body.max_lat).toBe(13.1);
    expect(body.max_lng).toBe(77.8);
    // Alternative modes — the BFF rejects both together.
    expect(body.item_latitude).toBeUndefined();
    expect(body.distance_meters).toBeUndefined();
  });

  it('sends the viewport MIDPOINT as the ordering centre under nearest', async () => {
    // A bbox has no centre on the wire, and the BFF deliberately will not
    // derive one from the rectangle (contract §1.3 rule 2 is s_dwithin-only),
    // because that would let "search this area" silently change the sort. So
    // nearest-inside-a-viewport has to send the centre explicitly.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('nearest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, { lat: 1, lng: 2 }, {
          relevance: true,
          area: { mode: 'viewport', bounds: BOUNDS },
          sort: 'nearest',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    const body = vi.mocked(fetchDiscover).mock.calls[0][0];
    // The viewport's own midpoint, NOT the viewer's location — the area the
    // user asked about is the thing to measure from.
    expect(body.ordering_latitude).toBeCloseTo(12.95);
    expect(body.ordering_longitude).toBeCloseTo(77.6);
    expect(body.min_lat).toBe(12.8);
  });

  it('sends no ordering centre for a viewport under newest', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue(discoverPage('newest'));
    renderHook(
      () =>
        useInfiniteBrowseItems(network, domain, { lat: 1, lng: 2 }, {
          relevance: true,
          area: { mode: 'viewport', bounds: BOUNDS },
          sort: 'newest',
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchDiscover).toHaveBeenCalled());

    expect(vi.mocked(fetchDiscover).mock.calls[0][0].ordering_latitude).toBeUndefined();
  });
});
