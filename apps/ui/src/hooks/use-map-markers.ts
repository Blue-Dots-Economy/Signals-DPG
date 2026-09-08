import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchNetworkMarkers, MAP_FETCH_LIMIT } from '@/lib/network-api';
import type { Marker } from '@/lib/network-api';
import type { DotNetworkSchema, DotNetworkDomain, MapViewport } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { snapViewportForKey, padBbox, shouldRefetch, zoomBand, clampBbox, bboxContains } from '@/lib/map-viewport-snap';
import type { RawBbox, ZoomBand } from '@/lib/map-viewport-snap';
import { capForZoom } from '@/lib/map-caps';
import { resolveFacetFieldLabels } from '@/lib/facet-fields';

// Map tier (spec §5.2 / §8): markers are lightweight pins, cached ~90s
// client-side, mirrored by `cache_ttl_seconds` sent to the server so the
// client's freshness intent lines up with the server's own cache knob.
const MAP_STALE_TIME_MS = 90 * 1000;

/** True when any of an item's locations falls inside `bbox`. */
function markerInBbox(
  m: Marker,
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
): boolean {
  return (m.item_locations ?? []).some(
    (l) =>
      l.lat >= bbox.minLat &&
      l.lat <= bbox.maxLat &&
      l.lng >= bbox.minLng &&
      l.lng <= bbox.maxLng,
  );
}
const MAP_CACHE_TTL_SECONDS = 90;

// Viewport bucketing (spec §8 flag-back: "rounded viewport bucket"). Only the
// CACHE KEY is bucketed — the request sent to the server always uses the real,
// unrounded viewport. The bucket cell scales with the fetch RADIUS: the markers
// fetch already covers a circle of ~radius around the center (viewport +
// margin), so a pan that stays well inside that circle can safely reuse the
// same fetched set. We size the cell at ~half the radius, so panning up to
// roughly half a screen reuses the cache; a bigger pan, or a zoom (which
// changes the radius bucket), lands in a new cell and refetches. A fixed
// fine-grained decimal bucket (the previous approach) re-fetched on almost
// every small city-zoom pan, which janked the map — this keys off the zoom
// level instead.
const RADIUS_BUCKET_STEP_METERS = 500;
const METERS_PER_DEG_LAT = 111_320;

function bucketRadius(radiusMeters: number): number {
  return Math.round(radiusMeters / RADIUS_BUCKET_STEP_METERS) * RADIUS_BUCKET_STEP_METERS;
}

/**
 * Bucket a viewport into stable integer cell indices for the cache key. The
 * cell size is ~half the (bucketed) radius, so small pans reuse the entry while
 * real moves/zooms produce a new key.
 */
function viewportBuckets(v: MapViewport): {
  latBucket: number;
  lngBucket: number;
  radiusBucket: number;
} {
  const radiusBucket = bucketRadius(v.radiusMeters);
  const cellMeters = Math.max(radiusBucket / 2, RADIUS_BUCKET_STEP_METERS);
  const latStepDeg = cellMeters / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((v.lat * Math.PI) / 180) || 1;
  const lngStepDeg = cellMeters / (METERS_PER_DEG_LAT * cosLat);
  return {
    latBucket: Math.round(v.lat / latStepDeg),
    lngBucket: Math.round(v.lng / lngStepDeg),
    radiusBucket,
  };
}

interface UseMapMarkersResult {
  markers: Marker[];
  total: number;
  partial: boolean;
  /**
   * Whether any active domain's `meta.total` (the server-side match count
   * *before* the `limit` cutoff) exceeds the zoom-band cap for the current
   * viewport (#203 map-serverside-search Task 6, `capForZoom`). Drives BOTH
   * the Task 5 refetch-on-zoom-in state machine (see `heldRef` below) and the
   * "N+ in this area — zoom in" over-dense indicator (`MapCountPill`) — a
   * zoom-in that drops the true total under the cap flips this back to
   * `false` on its own once the resulting refetch settles.
   */
  truncated: boolean;
  isLoading: boolean;
  /**
   * True when a domain's markers request FAILED. Distinct from "no markers":
   * a rejected or errored fetch previously rendered the same "no listings
   * here" empty state, so a 400 from an out-of-range bbox was indistinguishable
   * from an genuinely empty area — the map claimed a fact it had not
   * established.
   */
  isError: boolean;
}

/** Refetch state held across renders for the bbox path (Task 5). */
interface HeldBboxState {
  /** The raw (unsnapped) bbox actually used for the last fetch's query key + request. */
  bbox: RawBbox;
  /** That bbox, inflated ~25% — the new bbox must stay inside this to skip a refetch. */
  paddedBbox: RawBbox;
  /** Whether any domain's last fetch reported `meta.total > capForZoom(zoom)`. */
  truncated: boolean;
  /**
   * Whether that fetch came back with NO markers at all.
   *
   * Logically a zero result is safe to hold — if a region truly has nothing,
   * neither does any region inside it — so this is not about correctness of
   * the reasoning but about the cost of being wrong. A held empty set is the
   * one outcome the user cannot escape without reloading the page: every
   * subsequent viewport is contained in the padded bbox, so the query key
   * never advances and the map stays blank. That is exactly what a
   * server-side bbox bug produced (a >180° viewport resolved to the
   * complement of itself and answered `total: 0`), and it stranded the map
   * until a refresh. Re-fetching after an empty result costs one request and
   * removes the whole failure mode.
   */
  empty: boolean;
  /**
   * The zoom band (`snapViewportForKey`'s `'clustered' | 'individual'`) the
   * last fetch was made under. A zoom that crosses this band (e.g. smoothly
   * zooming from clustered into individual pins) always forces a refetch at
   * the CURRENT bbox — see the `bandChanged` check below. Without it, a
   * band-crossing zoom-in whose tighter bbox happens to still be contained
   * in the old padded bbox would advance the query key (since the key's
   * zoom-band axis changed) but fetch the STALE wide bbox, because
   * `effectiveBbox` would otherwise stay pinned to the held one.
   */
  zoomBand: ZoomBand;
}

/**
 * Fetch map markers (`/network/item/markers`) for the visible domains within
 * a viewport, one cached query per domain via `useQueries` (mirrors the
 * per-domain `useQueries` pattern).
 *
 * `filters` is the active facet filter set (`item_state.*`, e.g.
 * `{ gender: ['female'] }`) — forwarded to the server as `item_state` and
 * folded into the query key so a filter change always produces a distinct
 * cache entry. Defaults to `{}` (no filters). `home-page.tsx` passes
 * `BrowseFiltersPanel`'s `selectedFields` (as `activeFieldFilters`) here (#203
 * map-serverside-search Task 7); this parameter's shape has been stable
 * since Task 4, which wired the key ahead of the panel actually being
 * connected to it.
 *
 * `search` (map-native-text-search) is the top-bar free-text query. It's
 * trimmed once, forwarded to the server as `q` (value-match against public
 * `item_state` fields, viewport-scoped — same semantics as the list's search),
 * and folded into the query key so a search change always produces a distinct
 * cache entry, mirroring `filters` above. Defaults to `''` (no search).
 */
export function useMapMarkers(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  viewport: MapViewport | null,
  filters: Record<string, unknown> = {},
  search: string = '',
): UseMapMarkersResult {
  const q = search.trim();
  const active = network && viewport ? domains : [];

  // Route each active facet to the domains that can actually honour it.
  //
  // The map issues ONE markers request per selected domain but used to send
  // the same `filters` object to all of them. The server honours a facet only
  // when the field is declared, non-private, on that domain's schema and
  // drops any other one SILENTLY (`resolveAllowedFacetFields` — never a 4xx,
  // so a caller cannot probe for private fields). With blue_dot's seeker and
  // provider schemas sharing zero field names, filtering on a seeker field
  // while both domains were selected returned every PROVIDER unfiltered.
  //
  // A domain that cannot satisfy an active facet is dropped from the fetch
  // entirely rather than queried without it: the user constrained on an
  // attribute those items do not have, so the honest answer is that none of
  // them match — not all of them.
  const facetRouting = React.useMemo(() => {
    const activeFields = Object.keys(filters);
    return new Map(
      active.map((domain) => {
        if (activeFields.length === 0) return [domain.id, { filters: {}, satisfiable: true }];
        const declared = resolveFacetFieldLabels([domain]);
        const applicable: Record<string, unknown> = {};
        let satisfiable = true;
        for (const field of activeFields) {
          if (field in declared) applicable[field] = filters[field];
          else satisfiable = false;
        }
        return [domain.id, { filters: applicable, satisfiable }];
      }),
    );
  }, [active, filters]);

  // Bbox path (#203 map-serverside-search Task 4): both live map providers
  // now report `map.getBounds()` corners on every emit, so `viewport` has a
  // bbox in practice.
  const rawBbox: RawBbox | null =
    viewport &&
    viewport.minLat !== undefined &&
    viewport.minLng !== undefined &&
    viewport.maxLat !== undefined &&
    viewport.maxLng !== undefined
      ? // Clamped before anything else touches it: a zoomed-out provider
        // reports bounds beyond ±180° / ±90°, which the markers endpoint
        // rejects with a 400 — so the fetch never happened and the map looked
        // empty rather than broken.
        clampBbox({
          minLat: viewport.minLat,
          minLng: viewport.minLng,
          maxLat: viewport.maxLat,
          maxLng: viewport.maxLng,
        })
      : null;

  // Refetch state machine (#203 map-serverside-search Task 5). `heldRef` is
  // only ever WRITTEN from the effect below (after a fetch settles), never
  // during render, so it always reflects the last completed fetch's outcome.
  const heldRef = React.useRef<HeldBboxState | null>(null);
  // The REAL current zoom band (not the held one) — a band crossing (e.g.
  // smoothly zooming from clustered into individual pins) must force a
  // refetch at the current, tighter bbox even when that bbox is otherwise
  // contained in the old padded one and the held result was complete: the
  // query key already advances on a band change (`snappedKey.zoomBand`
  // below), and if `effectiveBbox` didn't also advance here, the resulting
  // fetch would be scoped to the STALE wide bbox instead of the viewport the
  // user is actually looking at.
  const currentZoomBand = zoomBand(viewport?.zoom ?? 0);
  const bandChanged = heldRef.current !== null && currentZoomBand !== heldRef.current.zoomBand;
  const needsRefetch = !rawBbox
    ? false
    : !heldRef.current
      ? true // no prior fetch to compare against — must fetch
      : bandChanged ||
        heldRef.current.empty ||
        shouldRefetch({
          newBbox: rawBbox,
          paddedBbox: heldRef.current.paddedBbox,
          lastTruncated: heldRef.current.truncated,
        });
  // The bbox actually used to build the query key + the request this render:
  // the real viewport bbox when refetching, or the last fetch's held bbox
  // when the new viewport is a contained zoom-in/pan over a complete result.
  // Holding it stable is what makes the skip work — React Query only
  // refetches on a query-key change, so an unchanged key here serves the
  // held marker set and lets the map provider re-cluster it locally instead
  // of hitting the network.
  const effectiveBbox: RawBbox | null = !rawBbox ? null : needsRefetch ? rawBbox : heldRef.current!.bbox;

  // Zoom-band marker cap (#203 map-serverside-search Task 6, `capForZoom`):
  // the bbox (live-map) path fetches `cap + 1` — one more than the cap the
  // truncation check below compares `meta.total` against, so a total that
  // exactly equals the cap still comes back as a complete (non-truncated)
  // set. The radius path (hand-built radius viewports — the list/tourist
  // callers that predate the bbox work) keeps requesting the older, larger
  // flat `MAP_FETCH_LIMIT` unchanged; unifying it into the zoom-band cap is
  // out of scope here (it has no clustering/individual-pin distinction to
  // band on).
  const cap = capForZoom(viewport?.zoom ?? 0);
  const limit = effectiveBbox ? cap + 1 : MAP_FETCH_LIMIT;

  // A snapped-bbox grid cell alone (Task 4) can't be trusted to force a new
  // query key here: a contained zoom-in can coincidentally snap to the SAME
  // grid cell as the held bbox even when the held result was truncated and
  // MUST be refetched (the "20k profiles in Bangalore → zoom into HSR
  // Layout" case). `bboxToken` is bumped exactly once per genuinely new
  // viewport bbox while the held result is truncated, guaranteeing the query
  // key changes in that case regardless of how the snap grid rounds it. It
  // is deliberately NOT bumped before the first fetch settles (`heldRef`
  // still null) so noisy initial viewport reports keep deduping the way
  // Task 4 intends, and not bumped for a plain contained+complete zoom-in
  // either (the whole point of holding `effectiveBbox` stable). Writing
  // these refs during render is the sanctioned "derived from a changed prop"
  // pattern (compare-then-conditionally-write), not an arbitrary side
  // effect — see https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  // Safe under Strict Mode's dev-only double-render: the guard reads
  // `lastRawBboxKeyRef` BEFORE writing it, so if React invokes this render
  // twice for the same commit (same `rawBbox`), the first invocation's write
  // makes the second invocation's guard see `rawBboxKey === lastRawBboxKeyRef.current`
  // and skip the body entirely — no double-increment. It only ever mutates
  // once per commit that actually changed `rawBbox`, which is exactly the
  // "did a genuinely new viewport arrive" signal this needs; a duplicate
  // render for an unchanged `rawBbox` is a no-op both times.
  const bboxTokenRef = React.useRef(0);
  const lastRawBboxKeyRef = React.useRef<string | null | undefined>(undefined);
  if (rawBbox) {
    const rawBboxKey = `${rawBbox.minLat},${rawBbox.minLng},${rawBbox.maxLat},${rawBbox.maxLng}`;
    if (rawBboxKey !== lastRawBboxKeyRef.current) {
      lastRawBboxKeyRef.current = rawBboxKey;
      // Bumped for an EMPTY held result as well as a truncated one, and for
      // the same reason: `needsRefetch` alone is not enough, because a
      // contained zoom-in can snap to the SAME grid cell as the held bbox,
      // leaving the query key unchanged and the refetch silently skipped.
      if (heldRef.current?.truncated === true || heldRef.current?.empty === true) {
        bboxTokenRef.current += 1;
      }
    }
  }

  // The zoom band always reflects the REAL current zoom (not the held bbox)
  // so crossing the cluster-disable band still forces a new key even when
  // the bbox itself is held stable.
  const snappedKey = effectiveBbox ? snapViewportForKey({ ...effectiveBbox, zoom: viewport?.zoom }) : null;
  // Legacy radius-bucket fallback, kept for callers that hand-build a
  // radius-only `MapViewport` (existing tests, anything predating the bbox
  // work) — the request itself still sends the real, unrounded radius.
  const buckets = viewport && !snappedKey ? viewportBuckets(viewport) : null;
  const latBucket = buckets?.latBucket ?? null;
  const lngBucket = buckets?.lngBucket ?? null;
  const radiusBucket = buckets?.radiusBucket ?? null;

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      // Per-domain, so the cache key matches what is actually sent and two
      // domains under the same facet selection don't share an entry.
      const routed = facetRouting.get(domain.id) ?? { filters: {}, satisfiable: true };
      const domainFilters = routed.filters;
      const keyFilters = snappedKey
        ? {
            snappedBbox: snappedKey.snappedBbox,
            zoomBand: snappedKey.zoomBand,
            bboxToken: bboxTokenRef.current,
            filters: domainFilters,
            satisfiable: routed.satisfiable,
            q,
            limit,
          }
        : {
            latBucket,
            lngBucket,
            radiusBucket,
            filters: domainFilters,
            satisfiable: routed.satisfiable,
            q,
            limit,
          };
      return {
        queryKey: queryKeys.markers(network!.id, domain.id, keyFilters),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchNetworkMarkers(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              // Bbox and radius are mutually exclusive on the server — send
              // whichever the viewport actually has (bbox once both
              // providers' first report has landed; radius otherwise). Uses
              // `effectiveBbox`, not the raw viewport, so a held/skipped
              // fetch and its query key always agree on what was requested.
              ...(effectiveBbox
                ? {
                    min_lat: effectiveBbox.minLat,
                    min_lng: effectiveBbox.minLng,
                    max_lat: effectiveBbox.maxLat,
                    max_lng: effectiveBbox.maxLng,
                  }
                : {
                    item_latitude: viewport!.lat,
                    item_longitude: viewport!.lng,
                    radius_meters: viewport!.radiusMeters,
                  }),
              ...(Object.keys(domainFilters).length > 0 ? { item_state: domainFilters } : {}),
              ...(q ? { q } : {}),
              limit,
              cache_ttl_seconds: MAP_CACHE_TTL_SECONDS,
            },
            signal,
          ),
        staleTime: MAP_STALE_TIME_MS,
        // A domain that cannot honour one of the active facets contributes
        // nothing. Skipping the request (rather than sending it and letting
        // the server drop the facet) is what makes the map agree with the
        // filter: the alternative returned that domain's pins UNFILTERED.
        enabled: routed.satisfiable,
      };
    }),
  });

  // Memoize the aggregation so a plain re-render (e.g. the map firing a viewport
  // report that doesn't change the bucketed key) returns the SAME `markers`
  // array reference — otherwise the map would re-resolve and re-plot every pin
  // on every render, janking pan/zoom. The signature captures each query's data
  // identity (`dataUpdatedAt`) so it recomputes only when a query's data
  // actually changes.
  const dataSignature = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join('|');
  // `truncated` is decided per-domain and ORed together: if any active
  // domain's `meta.total` exceeds the zoom-band cap (#203 Task 6,
  // `capForZoom`), the whole aggregated result is treated as truncated —
  // both for the Task 5 refetch-on-zoom-in decision below and for the
  // over-dense "N+ in this area — zoom in" indicator this hook's caller
  // renders, so neither trusts a set that's only representative for some
  // domains.
  // The bbox the user is LOOKING at, which is not always the one last fetched
  // — see the count derivation below.
  const shownBbox =
    viewport?.minLat !== undefined &&
    viewport.minLng !== undefined &&
    viewport.maxLat !== undefined &&
    viewport.maxLng !== undefined
      ? {
          minLat: viewport.minLat,
          minLng: viewport.minLng,
          maxLat: viewport.maxLat,
          maxLng: viewport.maxLng,
        }
      : null;
  const shownBboxSignature = shownBbox
    ? `${shownBbox.minLat},${shownBbox.minLng},${shownBbox.maxLat},${shownBbox.maxLng}`
    : null;

  // Recounting from the returned markers is only sound when the fetch covered
  // AT LEAST the area on screen. The displayed viewport can be WIDER than
  // `effectiveBbox` for a render or two — the bbox is snapped and held, and a
  // zoom-out has to wait for the next fetch to land — and in that window the
  // marker set knows nothing about items outside the fetched box. Counting it
  // then under-reports: a fully zoomed-out map read "94" while 8 items simply
  // had not been fetched yet. `meta.total` is the honest answer until the
  // wider fetch settles.
  const canRecount =
    shownBbox !== null &&
    effectiveBbox !== null &&
    bboxContains(effectiveBbox, {
      minLat: shownBbox.minLat,
      minLng: shownBbox.minLng,
      maxLat: shownBbox.maxLat,
      maxLng: shownBbox.maxLng,
    });

  const aggregated = React.useMemo(() => {
    const markers: Marker[] = [];
    let total = 0;
    let partial = false;
    let truncated = false;
    for (const result of results) {
      if (result.data) {
        markers.push(...result.data.markers);
        const serverTotal = result.data.meta.total;
        const domainTruncated = serverTotal > cap;
        partial = partial || result.data.meta.partial;
        truncated = truncated || domainTruncated;

        // COUNT WHAT IS ON SCREEN, not what was last requested.
        //
        // `shouldRefetch` deliberately reuses a cached result whenever the new
        // bbox is CONTAINED in the previous padded one (zooming in, or
        // returning to the map at a tighter viewport). The markers stay
        // correct — they are a superset, and the out-of-view ones simply are
        // not on screen — but `meta.total` still describes the LARGER fetched
        // area. That is why zooming out to 72 and coming back to a city
        // viewport kept reading "72 listings" while showing a city's worth of
        // pins.
        //
        // When a domain is not truncated its `markers` array IS the complete
        // set for the fetched area, so filtering to the shown bbox gives the
        // exact on-screen count. When it IS truncated we do not hold the full
        // set, and the caller renders an "N+ in this area" pill from
        // `truncated` anyway, so the server total remains the right input.
        total +=
          canRecount && shownBbox && !domainTruncated
            ? result.data.markers.filter((m) => markerInBbox(m, shownBbox)).length
            : serverTotal;
      }
    }
    return { markers, total, partial, truncated };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataSignature captures the results' data identity; cap, shownBboxSignature and canRecount are cheap derived primitives listed explicitly
  }, [dataSignature, cap, shownBboxSignature, canRecount]);

  // Update the held refetch state (Task 5) once every active domain's query
  // for `effectiveBbox` has settled — in an effect, not during render, so
  // `heldRef` only ever reflects the LAST COMPLETED fetch's outcome. Reuses
  // `aggregated.truncated` (computed above from the same `results`) rather
  // than recomputing it, so the two can never disagree.
  const effectiveBboxSignature = effectiveBbox
    ? `${effectiveBbox.minLat},${effectiveBbox.minLng},${effectiveBbox.maxLat},${effectiveBbox.maxLng}`
    : null;
  React.useEffect(() => {
    if (!effectiveBbox || results.length === 0) return;
    if (results.some((r) => r.isLoading)) return;
    if (!results.some((r) => r.data)) return;
    heldRef.current = {
      bbox: effectiveBbox,
      paddedBbox: padBbox(effectiveBbox),
      truncated: aggregated.truncated,
      empty: aggregated.markers.length === 0,
      zoomBand: currentZoomBand,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveBboxSignature + dataSignature (+ currentZoomBand, captured via closure) capture the relevant identity of effectiveBbox/results for this effect
  }, [effectiveBboxSignature, dataSignature, aggregated.truncated]);

  return {
    ...aggregated,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}
