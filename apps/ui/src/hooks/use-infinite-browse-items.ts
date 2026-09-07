import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchDiscover, fetchNetworkItems, PROFILE_PAGE_SIZE } from '@/lib/network-api';
import type { DiscoverFacetFilter, DiscoverSource, FetchDiscoverQuery } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';

const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

// Which path served the current data (#203 List PR Task 4): 'native' is the
// plain proximity/recency `/network/item/fetch` browse; the other two mirror
// the discover BFF's own `meta.source` when q/filters/relevance route through
// `/network/item/discover` (Task 6 uses this for the degraded-list UX).
export type BrowseSource = 'native' | DiscoverSource;

interface UseInfiniteBrowseItemsOpts {
  enabled?: boolean;
  // Free-text search (#203 List PR Task 4). A non-empty (trimmed) `q` routes
  // to the discover BFF instead of the native paged fetch.
  q?: string;
  // Facet selections, same shape the discover BFF's `filters` body field
  // expects (`resolveAllowedFacetFilters` re-validates server-side regardless
  // of what's sent). A non-empty array routes to discover.
  filters?: DiscoverFacetFilter[];
  // Forces discover/relevance mode even with no q/filters (e.g. an explicit
  // "sort by relevance" toggle). Defaults to false — plain proximity/recency
  // browse (native) stays the default when nothing else requests discover.
  relevance?: boolean;
  // The active profile's item id (#394 Task 2). Forwarded to the discover BFF
  // as `anchor_item_id` (relevance-to-profile ranking, Task 1) ONLY on the
  // discover path — plain native browse has no ranking concept, so it's
  // neither sent nor part of that path's query key (a profile switch during
  // plain proximity browse must not cause a needless refetch). On the
  // discover path it IS part of the key: switching the selected profile must
  // re-rank, so paging resets and the feed refetches (Task 3 wires the real
  // value in from the page).
  anchorItemId?: string;
  // #644: the area FILTER. Defaults to `{ mode: 'anywhere' }`, which sends no
  // coordinates at all — the list is not location-bounded unless the user
  // explicitly asks. Part of the query key, so changing it resets paging.
  area?: BrowseArea;
  // #644: explicit ordering. Also part of the query key.
  sort?: BrowseSort;
}

interface UseInfiniteBrowseItemsResult {
  items: Item[];
  total: number;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  // True when ANY loaded page's `meta.partial` is true — i.e. a peer instance
  // didn't answer in time on at least one of the pages fetched so far, so the
  // accumulated feed is known-incomplete (#203 §6, mirrors the map's
  // `mapMarkers.partial` from P4). Sticky across pages: once a page comes
  // back partial the feed stays flagged even if a later page's peers all
  // answered, since earlier items may still be missing. Native path only —
  // the discover BFF's response has no per-instance partial concept.
  partial: boolean;
  // See `BrowseSource`. 'native' on the plain browse path; the discover BFF's
  // `meta.source` ('signals_search' | 'native_fallback') on the discover path.
  source: BrowseSource;
  // True when the discover BFF fell back to its native path (signals-search
  // unavailable/unconfigured/timed out) — q/filters were NOT honored
  // server-side in that case. Always false on the native browse path.
  degraded: boolean;
  // #394: the discover BFF's `meta.distance_meters` — the effective spatial
  // radius actually applied (request override > configured env > the
  // documented default), so the list note above the results can show
  // "within X km". Undefined on the native browse path (no such concept) and
  // on discover when no location was sent (a non-geo search has no radius).
  distanceMeters?: number;
  // #644: the order the SERVER actually applied (`meta.sort_applied`), which
  // can differ from what was requested — `relevance` with no anchor and no
  // text degrades to `newest`. The UI must label from THIS, never from the
  // requested value, or it will claim an order it did not get.
  sortApplied?: BrowseSort;
  /** A response arrived without an order — see the return value's comment. */
  sortUnreported: boolean;
}

interface BrowsePage {
  items: Item[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    source: BrowseSource;
    degraded: boolean;
    partial?: boolean;
    distanceMeters?: number;
    sortApplied?: BrowseSort;
  };
}

/**
 * Paged browse feed for ONE domain (spec §5.1): server-ordered (nearest-first
 * when a location is supplied), page size VITE_PROFILE_PAGE_SIZE. The list view
 * consumes this; the map keeps its own fetch (decoupled in P4). Items are raw —
 * own-item filtering / enum filtering stay in the page's view layer.
 *
 * #203 List PR Task 4: when `opts.q` is non-empty, `opts.filters` is
 * non-empty, or `opts.relevance` is set, this switches to the discover BFF
 * (`fetchDiscover`) instead of the native paged fetch — the "discover"
 * condition. Discover items are the SAME `Item` shape the native path
 * returns, so the list renders both uniformly without forking the item type.
 */
export function useInfiniteBrowseItems(
  network: DotNetworkSchema | null,
  domain: DotNetworkDomain | null,
  userLocation: { lat: number; lng: number } | null,
  opts?: UseInfiniteBrowseItemsOpts,
): UseInfiniteBrowseItemsResult {
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
  const enabled = !!network && !!domain && (opts?.enabled ?? true);

  const q = opts?.q?.trim() ?? '';
  const filters = opts?.filters ?? [];
  const useDiscover = q.length > 0 || filters.length > 0 || (opts?.relevance ?? false);
  const anchorItemId = opts?.anchorItemId;
  const area = opts?.area ?? DEFAULT_BROWSE_AREA;
  const sort = opts?.sort ?? 'relevance';

  // The AREA FILTER's centre — only in radius mode. #644: `anywhere` sends
  // nothing, so signals-search builds no s_dwithin clause and the candidate
  // set is the whole network.
  // Left `undefined` rather than `{}` when inactive: spreading `undefined` into
  // an object literal is a no-op, so no fallback is needed (Sonar S7744).
  // Typed as the exact request fields rather than `Record<string, number>`:
  // the loose form is assignable to anything and let the bbox spread into
  // `fetchDiscover` unnoticed while that function's allowlist dropped it.
  let areaFilter:
    | Pick<FetchDiscoverQuery, 'item_latitude' | 'item_longitude' | 'distance_meters'>
    | Pick<FetchDiscoverQuery, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'>
    | undefined;
  if (area.mode === 'radius') {
    areaFilter = {
      item_latitude: area.center.lat,
      item_longitude: area.center.lng,
      distance_meters: area.meters,
    };
  } else if (area.mode === 'viewport') {
    // The exact rectangle (contract §1.5). All four bounds travel together —
    // a partial box is rejected by the BFF rather than defaulted.
    areaFilter = {
      min_lat: area.bounds.minLat,
      min_lng: area.bounds.minLng,
      max_lat: area.bounds.maxLat,
      max_lng: area.bounds.maxLng,
    };
  }

  // The ORDERING centre — only for `nearest`.
  //
  // A RADIUS area already supplies a centre and signals-search reuses it
  // (contract §1.3 rule 2), so sending one too would be redundant. A VIEWPORT
  // does NOT: a bbox has no centre on the wire, and the BFF deliberately will
  // not derive one from the rectangle's midpoint, because that would let
  // "search this area" silently change the sort. So nearest-inside-a-viewport
  // has to send the centre explicitly, and the viewport's own midpoint is the
  // right one — it is the area the user is asking about.
  const needsExplicitCenter = area.mode !== 'radius';
  const nearestCenter =
    area.mode === 'viewport'
      ? {
          lat: (area.bounds.minLat + area.bounds.maxLat) / 2,
          lng: (area.bounds.minLng + area.bounds.maxLng) / 2,
        }
      : userLocation;
  const orderingCenter =
    sort === 'nearest' && needsExplicitCenter && nearestCenter
      ? { ordering_latitude: nearestCenter.lat, ordering_longitude: nearestCenter.lng }
      : undefined;

  // Location + q/filters/mode are all part of the key so any change resets
  // paging (spec §5.1; #203 List PR Task 4 extends this to discover inputs) —
  // useInfiniteQuery starts a fresh query (pageParam back at 0) rather than
  // appending to the previous feed whenever the key changes. `anchorItemId`
  // (#394 Task 2) is included ONLY in discover mode: it has no effect on the
  // native path, so leaving it out of that path's key means a profile switch
  // during plain proximity browse doesn't trigger a needless refetch, while a
  // profile switch during discover DOES change the key (re-ranking depends
  // on the anchor).
  const filterKey = {
    limit: PROFILE_PAGE_SIZE,
    mode: useDiscover ? ('discover' as const) : ('native' as const),
    q,
    filters,
    // Only the coordinates that actually reach the request belong in the key.
    // #644: on the discover path a resolved location no longer affects a
    // `relevance` or `newest` request at all, so keying on it would cause a
    // needless refetch the moment geolocation resolves. The native path still
    // orders by proximity, so it keeps lat/lng.
    ...(useDiscover
      ? {
          area,
          sort,
          anchorItemId: anchorItemId ?? null,
          ordering: orderingCenter ?? null,
        }
      : { lat: userLocation?.lat ?? null, lng: userLocation?.lng ?? null }),
  };

  const query = useInfiniteQuery({
    queryKey:
      network && domain
        ? queryKeys.browseItems(network.id, domain.id, filterKey)
        : (['browse-items', null] as const),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<BrowsePage> => {
      if (useDiscover) {
        const res = await fetchDiscover(
          {
            item_network: network!.id,
            item_domain: domain!.id,
            item_type: itemType,
            limit: PROFILE_PAGE_SIZE,
            offset: pageParam,
            ...(q ? { q } : {}),
            ...(filters.length > 0 ? { filters } : {}),
            ...areaFilter,
            ...orderingCenter,
            sort,
            ...(anchorItemId ? { anchor_item_id: anchorItemId } : {}),
          },
          signal,
        );
        return {
          items: res.items,
          meta: {
            total: res.meta.total,
            limit: res.meta.limit,
            offset: res.meta.offset,
            source: res.meta.source,
            degraded: res.meta.degraded,
            distanceMeters: res.meta.distance_meters,
            sortApplied: res.meta.sort_applied,
          },
        };
      }

      const res = await fetchNetworkItems(
        {
          item_network: network!.id,
          item_domain: domain!.id,
          item_type: itemType,
          limit: PROFILE_PAGE_SIZE,
          offset: pageParam,
          cache_ttl_seconds: BROWSE_CACHE_TTL_SECONDS,
          ...(userLocation
            ? { item_latitude: userLocation.lat, item_longitude: userLocation.lng }
            : {}),
        },
        signal,
      );
      return {
        items: res.items,
        meta: {
          total: res.meta.total,
          limit: res.meta.limit,
          offset: res.meta.offset,
          source: 'native',
          degraded: false,
          partial: res.meta.partial === true,
        },
      };
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      // Stop when the server returned a short page (fewer than a full page) OR
      // we've loaded at least the reported total. meta.total is a sum of
      // Redis-cached per-instance counts and can transiently overstate the real
      // row count (deletes/pauses within the count-cache TTL); the short-page
      // check prevents an endless "load more" in that case.
      if (lastPage.items.length < PROFILE_PAGE_SIZE) return undefined;
      return loaded < lastPage.meta.total ? loaded : undefined;
    },
    staleTime: BROWSE_STALE_TIME_MS,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const total = lastPage?.meta.total ?? 0;
  const partial = query.data?.pages.some((p) => p.meta.partial === true) ?? false;
  // `degraded`/`source` are STICKY across pages (like `partial`): once ANY
  // loaded page fell back to native, later pages that happen to hit a
  // recovered signals-search must not flip the "basic matches" note off
  // mid-scroll — the accumulated feed still mixes native (unranked) pages with
  // ranked ones, so the note stays until a full refetch. (The native fallback
  // DOES apply search + filters now — #394 list-native-fallback — so this is
  // about ranking consistency, not "unfiltered shown as filtered".)
  const degraded = query.data?.pages.some((p) => p.meta.degraded) ?? false;
  const anyFallback = query.data?.pages.some((p) => p.meta.source === 'native_fallback') ?? false;
  const source: BrowseSource = anyFallback
    ? 'native_fallback'
    : (lastPage?.meta.source ?? (useDiscover ? 'signals_search' : 'native'));

  return {
    items,
    total,
    hasNextPage: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    partial,
    source,
    degraded,
    // Not sticky like `partial`/`degraded`/`source`: the effective radius is
    // a static property of the request (location + config), not something
    // that can meaningfully change page-to-page within the same feed, so the
    // latest loaded page's value is the correct one to surface.
    distanceMeters: lastPage?.meta.distanceMeters,
    // Same reasoning as distanceMeters: a property of the current request, so
    // the latest loaded page's value is the correct one to surface.
    sortApplied: lastPage?.meta.sortApplied,
    // A page HAS arrived and it carried no order. Distinct from `sortApplied`
    // being undefined because nothing has loaded yet, which is why this cannot
    // be derived from `sortApplied` alone — and the difference matters: before
    // the first response the UI optimistically shows what it asked for (no
    // flicker), whereas afterwards an absent order must not be assumed.
    sortUnreported: lastPage !== undefined && lastPage.meta.sortApplied === undefined,
  };
}
