import z, {
  DiscoverItemsBodySchema,
  DiscoverResponseSchema,
  type DiscoverSort,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  resolveAllowedFacetFilters,
  resolveTextSearchFields,
} from '@/utils/facet_guard';
import { getNetworkConfigById } from '@/network_configs';
import {
  searchSignals,
  SignalsSearchError,
  type SearchSignalsInput,
  type SignalsSearchItem,
  type SignalsSearchFacetInput,
} from '@/services/signals_search_client';
import { fetchItemsAcrossInstances } from '@/utils/inter_instance_fetch';
import { signalsSearchConfig } from '@/config';

// Mirrors signals-search's own default `s_dwithin` radius (#394). Used ONLY
// to REPORT the effective radius in `meta.distance_meters` when
// SIGNALS_SEARCH_DISTANCE_METERS is unset and the request didn't override it
// — we never send this value to signals-search ourselves in that case;
// signals-search applies its own default when `distance_meters` is omitted.
const DEFAULT_SEARCH_DISTANCE_METERS = 30000;

type DiscoverItemsRequest = FastifyRequest<{
  Body: z.infer<typeof DiscoverItemsBodySchema>;
}>;

/**
 * Public `/network/item/discover` BFF (#203 List PR, P-follow-3 Task 2).
 * Mirrors `/network/item/fetch` in being unauthenticated (no `preHandler`) —
 * discovery of the masked public `item_state` needs no auth either way.
 *
 * DIRECT MAP (revised — signals-search PR #87): signals-search's `/v1/search`
 * now returns the full item row per result, so each ranked result is mapped
 * straight to the DPG item response shape below — no local-DB hydrate/
 * re-read by id. signals-search's order is already the ranked order and is
 * preserved as-is. Live-only, single-instance is now signals-search's own
 * indexing invariant rather than something this BFF enforces via a lifecycle
 * filter.
 *
 * NATIVE FALLBACK (#394, revising #203 List PR Task 3): `searchSignals` throws
 * when signals-search is unconfigured (`SIGNALS_SEARCH_URL`/
 * `SIGNALS_SEARCH_API_KEY` unset), when the call times out (`AbortSignal.
 * timeout` in the client), or on any non-2xx/invalid response — all three
 * collapse to the same catch below. On catch, this BFF falls back to the
 * native `fetchItemsAcrossInstances` path (the same distance/recency-ordered,
 * live-only, paged fetch `/network/item/fetch` uses) so a search-service
 * outage degrades the list rather than 5xx-ing it. `q`/`filters` ARE now
 * applied on this native path too (#394) — the same value-match-on-public-
 * `item_state` (`text_search`) and facet (`item_state`) mechanisms the map's
 * `/markers` uses (see `resolveTextSearchFields`/`resolveAllowedFacetFilters`
 * in `facet_guard.ts`, applied by `buildWhereClause`) — so only relevance
 * RANKING is unavailable without signals-search. `meta.source:
 * 'native_fallback'`/`degraded: true` let the UI (Task 6) show the "basic
 * matches" note.
 *
 * PROFILE ANCHOR RELEVANCE (#394): `body.anchor_item_id` (the viewer's own
 * profile item) is forwarded to signals-search as `intent.item`. signals-
 * search returns an anchor error (`404 ANCHOR_NOT_FOUND` when the anchor isn't
 * indexed yet, or `403 INTERACTION_NOT_ALLOWED` when the anchor's domain has
 * no interaction with the browsed domain per the network's interaction matrix
 * — e.g. seeker→seeker) — neither is a search-service outage, so instead of
 * degrading to the native fallback, this retries `searchSignals` exactly once
 * with the anchor removed, still resolving as `source: 'signals_search'`,
 * `degraded: false`. The UI also avoids sending an anchor for non-interacting
 * domain pairs in the first place (schema-driven, see `home-page`); this
 * retry is the server-side safety net. Only a failure of THAT retry (or any
 * other non-anchor error) falls through to the native fallback.
 *
 * CONFIGURABLE SPATIAL RADIUS (#394): `SIGNALS_SEARCH_DISTANCE_METERS`
 * (optional env, `signalsSearchConfig.distanceMeters`) is forwarded to
 * signals-search as `distance_meters` whenever the request doesn't already
 * override it — omitted entirely (not sent) when unset, so signals-search's
 * own ~30km `s_dwithin` default applies. `meta.distance_meters` on every
 * return path reports the EFFECTIVE radius (request override > env >
 * `DEFAULT_SEARCH_DISTANCE_METERS`) so the UI's "within X km" note stays
 * accurate even when nothing was actually sent over the wire. Only present
 * when the request carried a location — a non-geo search has no radius to
 * report.
 */
/**
 * Default and validate the requested order (#644, wire contract §5.2).
 *
 * Exported and pure so the decision table is testable without a route. Mirrors
 * `resolveSort` in signals-search rather than sharing a package with it: the
 * two services deploy independently, and the two layers legitimately know
 * different things (this one knows about `anchor_item_id`, the other about a
 * resolved query vector).
 *
 * Never errors. An order the request cannot have degrades to `newest`, and the
 * response reports what was actually applied — so the UI can label from what
 * happened rather than from what it asked for.
 */
export function resolveDiscoverSort(input: {
  requested?: DiscoverSort;
  hasAnchor: boolean;
  hasQ: boolean;
  hasOrderingCenter: boolean;
}): DiscoverSort {
  if (input.requested === 'relevance') {
    // Cosine needs a query vector, which comes from the anchor or the text.
    return input.hasAnchor || input.hasQ ? 'relevance' : 'newest';
  }
  if (input.requested === 'nearest') {
    return input.hasOrderingCenter ? 'nearest' : 'newest';
  }
  if (input.requested === 'newest') return 'newest';

  // Unspecified: relevance whenever there is a QUERY VECTOR to rank against —
  // an anchor or the text, exactly as the explicit branch above decides it.
  //
  // `hasQ` was missing here, and because `buildSearchInput` now always sends
  // `sort`, this default OVERRODE signals-search's own inference: a
  // pre-existing caller POSTing just `{ item_network, item_domain, item_type,
  // q }` got date-ordered rows where it used to get cosine, and still paid for
  // the embed. `sort` is a new field, so no existing non-UI caller sets it —
  // they are all in this path.
  return input.hasAnchor || input.hasQ ? 'relevance' : 'newest';
}

/**
 * The geo params the NATIVE fallback should receive (#644, contract §7).
 *
 * `buildDistanceOrderBy` keys off lat/lng ONLY, while `buildWhereClause` adds
 * a radius clause only when lat, lng AND radius_meters are all present. So
 * `nearest` sends coordinates with NO radius — distance-ordered and unbounded
 * — while every other sort sends them only when an area filter was actually
 * requested. Pure and separate from the handler so those three cases are
 * readable on their own.
 */
function resolveNativeGeoFilters(input: {
  sortApplied: DiscoverSort;
  hasAreaFilter: boolean;
  effectiveDistanceMeters: number | undefined;
  body: Pick<
    z.infer<typeof DiscoverItemsBodySchema>,
    | 'item_latitude'
    | 'item_longitude'
    | 'ordering_latitude'
    | 'ordering_longitude'
    | 'min_lat'
    | 'min_lng'
    | 'max_lat'
    | 'max_lng'
  >;
}): {
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  order_by?: 'distance' | 'created_at';
} {
  const { sortApplied, hasAreaFilter, effectiveDistanceMeters, body } = input;

  // VIEWPORT: the native path has supported a bbox all along
  // (`buildWhereClause`'s min_lat/min_lng/max_lat/max_lng), so this mode works
  // even with signals-search down — which is every local run. The bbox
  // filters; the order still comes from `sort`, and `nearest` inside a
  // viewport uses the ordering centre the UI sends alongside it.
  if (body.min_lat !== undefined) {
    const nearestCentreGiven =
      sortApplied === 'nearest' &&
      body.ordering_latitude !== undefined &&
      body.ordering_longitude !== undefined;
    return {
      min_lat: body.min_lat,
      min_lng: body.min_lng,
      max_lat: body.max_lat,
      max_lng: body.max_lng,
      ...(nearestCentreGiven
        ? {
            item_latitude: body.ordering_latitude,
            item_longitude: body.ordering_longitude,
            order_by: 'distance' as const,
          }
        : { order_by: 'created_at' as const }),
    };
  }

  if (sortApplied === 'nearest') {
    return {
      item_latitude: body.ordering_latitude ?? body.item_latitude,
      item_longitude: body.ordering_longitude ?? body.item_longitude,
      radius_meters: effectiveDistanceMeters,
      order_by: 'distance',
    };
  }
  if (hasAreaFilter) {
    return {
      item_latitude: body.item_latitude,
      item_longitude: body.item_longitude,
      radius_meters: effectiveDistanceMeters,
      // The area narrows the SET; it must not also choose the order. Leaving
      // this to inference made `sort: 'newest'` + an area return
      // distance-ordered rows, because the native ORDER BY keyed off the mere
      // presence of coordinates (#644 P3, on the native path).
      order_by: 'created_at',
    };
  }
  return { order_by: 'created_at' };
}

/**
 * The search-envelope input for one discover request (contract §5.1).
 *
 * Pure and separate from the handler so the three mutually-exclusive spatial
 * shapes — bbox, radius, neither — are readable side by side, and so the
 * handler is not carrying their branches.
 */
function buildSearchInput(input: {
  body: z.infer<typeof DiscoverItemsBodySchema>;
  filters: SignalsSearchFacetInput[];
  sortApplied: DiscoverSort;
  hasBbox: boolean;
  hasRadiusCenter: boolean;
  hasOrderingCenter: boolean;
}): SearchSignalsInput {
  const { body, filters, sortApplied, hasBbox, hasRadiusCenter, hasOrderingCenter } = input;

  const bbox = hasBbox
    ? {
        minLat: body.min_lat,
        minLng: body.min_lng,
        maxLat: body.max_lat,
        maxLng: body.max_lng,
      }
    : undefined;

  const radius = hasRadiusCenter
    ? {
        lat: body.item_latitude,
        lng: body.item_longitude,
        // Sent radius, NOT `effectiveDistanceMeters`: when neither the request
        // nor the env sets one we send nothing and let signals-search apply
        // its own default, exactly as before. `effectiveDistanceMeters` folds
        // in DEFAULT_SEARCH_DISTANCE_METERS for *reporting* only — sending it
        // would hardcode our mirror of their default onto the wire and
        // silently pin it if theirs moved.
        distanceMeters: body.distance_meters ?? signalsSearchConfig.distanceMeters,
      }
    : undefined;

  const ordering = hasOrderingCenter
    ? { orderingLat: body.ordering_latitude, orderingLng: body.ordering_longitude }
    : undefined;

  return {
    network: body.item_network,
    domain: body.item_domain,
    itemType: body.item_type,
    q: body.q,
    filters,
    ...bbox,
    ...radius,
    ...ordering,
    sort: sortApplied,
    limit: body.limit,
    offset: body.offset,
    anchorItemId: body.anchor_item_id,
  };
}

function mapSignalsSearchItemToDiscoverItem(item: SignalsSearchItem) {
  return {
    item_id: item.item_id,
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_instance_url: item.item_instance_url,
    item_schema_url: item.item_schema_url,
    item_state: item.item_state,
    item_locations: item.item_locations,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
    lifecycle_status: item.lifecycle_status,
    score: item.score,
    distanceMeters: item.distanceMeters,
  };
}

type NativeFetchResult = Awaited<ReturnType<typeof fetchItemsAcrossInstances>>;
type NativeItem = NativeFetchResult['items'][number];

// Native fallback (Task 3): `fetchItemsAcrossInstances` already returns the
// same DPG item response shape (`ItemResponseSchema`) the discover response
// item extends, so this mapper is a narrow pass-through — no `score`/
// `distanceMeters` since the native path does no ranking (nearest-first is
// ordering only, not a comparable score).
function mapNativeItemToDiscoverItem(item: NativeItem) {
  return {
    item_id: item.item_id,
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_instance_url: item.item_instance_url,
    item_schema_url: item.item_schema_url,
    item_state: item.item_state,
    item_locations: item.item_locations,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
    lifecycle_status: item.lifecycle_status,
  };
}

export const discover: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/item/discover',
    method: 'POST',
    schema: {
      tags: ['network'],
      body: DiscoverItemsBodySchema,
      response: {
        200: DiscoverResponseSchema,
      },
    },
    handler: discover_items_handler,
  });
};

const discover_items_handler = async (
  request: DiscoverItemsRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(reply, body.item_network, body.item_domain);
  }

  try {
    const networkConfig = await getNetworkConfigById(body.item_network);

    // Validate item_type up-front (should-fix, PR #419 review): an unknown
    // item_type otherwise throws inside resolveAllowedFacetFilters →
    // getDomainItemSchema → the outer catch → a 500 that logs the client's
    // request body at error level. Treat a bogus item_type as a 400 bad
    // request, mirroring the served-domain guard's early return, and don't
    // log client input at error for it.
    const domainConfig = networkConfig.domains.find(
      (entry) => entry.id === body.item_domain
    );
    if (!domainConfig || domainConfig.item_schemas?.[body.item_type] === undefined) {
      return reply.code(400).send({
        error: 'INVALID_ITEM_TYPE',
        message: `item_type "${body.item_type}" is not defined for domain "${body.item_domain}" in network "${body.item_network}".`,
      });
    }

    // Server-resolved: the client's field list is never trusted, even though
    // item_state is already the masked public projection (defense-in-depth).
    const allowedFilters = resolveAllowedFacetFilters(
      networkConfig,
      body.item_domain,
      body.item_type,
      body.filters ?? []
    );

    // AREA FILTER, opt-in (#644). Present only when the client explicitly
    // asked for `radius` mode. In the default `anywhere` mode all three area
    // fields are absent, so no spatial clause is built and — critically — the
    // SIGNALS_SEARCH_DISTANCE_METERS env fallback does NOT apply.
    //
    // This gate IS the #644 fix. Previously the UI forwarded the resolved
    // viewer location on every list request and signals-search treats a
    // spatial clause as a hard `s_dwithin` predicate, so every signed-in
    // viewer silently saw only items within ~30 km with no way to widen it.
    // Either area mode counts as "the caller asked to be bounded". `radius`
    // sends a centre + distance; `viewport` sends a rectangle (contract §1.5).
    const hasBbox = body.min_lat !== undefined;
    // A radius centre. Declared before `hasAreaFilter` because the reported
    // radius keys off THIS, not off "some area filter exists".
    const hasRadiusCenter =
      body.item_latitude !== undefined && body.item_longitude !== undefined;
    const hasAreaFilter = hasRadiusCenter || hasBbox;

    // Effective reported radius (#394): only meaningful for a RADIUS filter.
    // Precedence: the request's own override, then the configured env, then the
    // documented constant that mirrors signals-search's own default — so the
    // UI's "within X km" note is accurate whether or not
    // SIGNALS_SEARCH_DISTANCE_METERS is set.
    //
    // Deliberately NOT `hasAreaFilter`: a VIEWPORT applies no radius, so
    // reporting one is the same lie the ordering centre was split out to
    // prevent. It was believed, too — `resolveListNote` shows its km note on
    // `hasLocation && distanceMeters !== undefined` without consulting the area
    // mode, so a viewer who zoomed to one street and hit "Search this area" was
    // told "within 30 km of your profile location", and still 30 km after
    // zooming out to a whole state.
    const effectiveDistanceMeters = hasRadiusCenter
      ? (body.distance_meters ??
        signalsSearchConfig.distanceMeters ??
        DEFAULT_SEARCH_DISTANCE_METERS)
      : undefined;

    // ORDERING centre (#644): orders without filtering. Never contributes a
    // spatial clause and never sets `meta.distance_meters`.
    const hasOrderingCenter =
      body.ordering_latitude !== undefined && body.ordering_longitude !== undefined;

    // `nearest` needs a centre from somewhere. A RADIUS area's centre serves
    // as one (`hasRadiusCenter` above; signals-search reuses it, contract §1.3
    // rule 2) — a VIEWPORT does NOT: a bbox has no centre on the wire, and
    // deriving one from the rectangle's midpoint would let "search this area"
    // silently change the sort the user chose. So nearest-within-a-viewport
    // requires the UI to send `ordering_latitude`/`ordering_longitude`
    // alongside the bbox.
    const sortApplied = resolveDiscoverSort({
      requested: body.sort,
      hasAnchor: body.anchor_item_id !== undefined,
      hasQ: body.q !== undefined,
      hasOrderingCenter: hasOrderingCenter || hasRadiusCenter,
    });

    const searchInput = buildSearchInput({
      body,
      filters: allowedFilters,
      sortApplied,
      hasBbox,
      hasRadiusCenter,
      hasOrderingCenter,
    });

    // Native fallback (#394, revising Task 3): thrown for a request timeout, a
    // non-2xx/invalid response, OR signals-search being unconfigured (the
    // client throws for all three). A search-service outage must never surface
    // as a 5xx, so this falls back to the native, distance/recency-ordered
    // paged fetch `/network/item/fetch` uses — but now applying `q`/`filters`
    // natively too (value-match on public item_state + declared, non-private
    // facet fields; #394 dropped the `filterable` gate — see
    // `resolveTextSearchFields`/`resolveAllowedFacetFilters` in `facet_guard.ts`,
    // applied by `buildWhereClause`), the same mechanisms `/markers` uses. So
    // only relevance RANKING is unavailable; `meta.source: 'native_fallback'`/
    // `degraded: true` tell the UI to show the "basic matches" note.
    //
    // Radius honesty (#394 review fix): `radius_meters` below is
    // `effectiveDistanceMeters`, NOT `body.distance_meters` — the UI never
    // sends `distance_meters` (only lat/lng), so gating on the raw body field
    // would silently skip the radius bound in `buildWhereClause` while
    // `meta.distance_meters` still reported a radius as if it were applied.
    // `effectiveDistanceMeters` is undefined exactly when no location was
    // sent, matching `buildWhereClause`'s own radius-clause gate.
    //
    // Multi-instance limitation (single-instance is the target): the facet
    // `item_state` filter forwards to peers (each re-guards it), but `q` does
    // NOT (the peer `/fetch_local` body has no `q`), so on a federated network
    // a text query filters only this instance's rows; peers contribute live,
    // public, facet-filtered (but not text-filtered) rows. Documented follow-up.
    const nativeGeoFilters = resolveNativeGeoFilters({
      sortApplied,
      hasAreaFilter,
      effectiveDistanceMeters,
      body,
    });

    const fallBackToNative = async (logErr: unknown) => {
      request.log.warn(
        { err: logErr, body },
        'signals-search unavailable; falling back to native item fetch for discover (search/filters applied natively, no ranking)'
      );

      const nativeResult = await fetchItemsAcrossInstances({
        networkConfig,
        filters: {
          item_network: body.item_network,
          item_domain: body.item_domain,
          item_type: body.item_type,
          // Native ordering (#644, contract §7). `buildDistanceOrderBy` keys
          // off lat/lng ONLY, while `buildWhereClause` adds a radius clause
          // only when lat, lng AND radius_meters are all present
          // (item_fetch_runtime.ts:328-332). So `nearest` sends coordinates
          // with NO radius — distance-ordered and unbounded — and `newest`
          // sends none at all, falling through to created_at DESC.
          ...nativeGeoFilters,
          limit: body.limit,
          offset: body.offset,
          lifecycle_filter: 'live_only',
          item_state:
            allowedFilters.length > 0
              ? Object.fromEntries(
                  allowedFilters.map((filter) => [filter.field, filter.values])
                )
              : undefined,
          text_search: body.q
            ? {
                q: body.q,
                fields: resolveTextSearchFields(
                  networkConfig,
                  body.item_domain,
                  body.item_type
                ),
              }
            : undefined,
        },
        log: request.log,
      });

      const items = nativeResult.items.map(mapNativeItemToDiscoverItem);

      return reply.code(200).send({
        meta: {
          total: nativeResult.meta.total,
          limit: nativeResult.meta.limit,
          offset: nativeResult.meta.offset,
          source: 'native_fallback' as const,
          degraded: true,
          distance_meters: effectiveDistanceMeters,
          // The native path does no ranking, so a relevance request genuinely
          // got recency. Report that rather than claiming an order we did not
          // deliver.
          sort_applied: sortApplied === 'relevance' ? ('newest' as const) : sortApplied,
        },
        items,
      });
    };

    try {
      const searchResult = await searchSignals(searchInput);

      // signals-search's order is already the ranked order — mapped straight
      // through, no local-DB hydrate/re-read by id (see module doc comment).
      const items = searchResult.items.map(mapSignalsSearchItemToDiscoverItem);

      return reply.code(200).send({
        meta: {
          total: searchResult.meta.total,
          limit: searchResult.meta.limit,
          offset: searchResult.meta.offset,
          source: 'signals_search' as const,
          degraded: false,
          distance_meters: effectiveDistanceMeters,
          // signals-search is the authority on what it actually did. Absent
          // when talking to a version without #644's sort support, in which
          // case our own resolved value is the best available answer.
          sort_applied: searchResult.meta.sort_applied ?? sortApplied,
        },
        items,
      });
    } catch (searchErr) {
      // Anchor relevance (#394): an anchor signals-search can't use is a
      // client-input condition, not a search-service outage — retry ONCE
      // without the anchor rather than degrading to the native fallback
      // (which loses ranking). Two anchor cases: `404 ANCHOR_NOT_FOUND` (the
      // anchor isn't indexed yet) and `403 INTERACTION_NOT_ALLOWED` (the
      // anchor's domain has no interaction with the browsed domain per the
      // network's interaction matrix — e.g. a seeker anchor browsing seekers;
      // the UI already avoids sending the anchor for such pairs, this is the
      // server-side safety net). Any other error (no anchor sent, or a real
      // search failure) falls straight through to the native fallback below.
      const isRecoverableAnchorError =
        body.anchor_item_id !== undefined &&
        searchErr instanceof SignalsSearchError &&
        (searchErr.status === 404 ||
          searchErr.status === 403 ||
          searchErr.code === 'ANCHOR_NOT_FOUND' ||
          searchErr.code === 'INTERACTION_NOT_ALLOWED');

      if (isRecoverableAnchorError) {
        // Logged because this path is otherwise INVISIBLE: it returns 200 with
        // `source: 'signals_search'` and `degraded: false`, so the only
        // outward sign is `sort_applied` coming back as something other than
        // the requested `relevance`. On the test cluster that surfaced purely
        // as "the sort control looks broken", with nothing to grep for.
        request.log.warn(
          {
            err: searchErr,
            anchorItemId: body.anchor_item_id,
            itemNetwork: body.item_network,
            itemDomain: body.item_domain,
            requestedSort: body.sort,
            resolvedSort: sortApplied,
          },
          'signals-search rejected the discover anchor; retrying without it (relevance ranking will degrade to newest)'
        );

        try {
          const retryResult = await searchSignals({
            ...searchInput,
            anchorItemId: undefined,
          });

          const items = retryResult.items.map(mapSignalsSearchItemToDiscoverItem);

          return reply.code(200).send({
            meta: {
              total: retryResult.meta.total,
              limit: retryResult.meta.limit,
              offset: retryResult.meta.offset,
              source: 'signals_search' as const,
              degraded: false,
              distance_meters: effectiveDistanceMeters,
              // Anchor-less retry: `sortApplied` was resolved WITH the
              // anchor, so it may say `relevance` when the retry has no
              // query vector left to rank by. Re-resolve without the anchor
              // for the fallback, so an older signals-search that sends no
              // sort_applied doesn't make us claim an order we didn't get.
              sort_applied:
                retryResult.meta.sort_applied ??
                resolveDiscoverSort({
                  requested: body.sort,
                  hasAnchor: false,
                  hasQ: body.q !== undefined,
                  // `hasRadiusCenter`, matching the primary call above — a
                  // viewport supplies no centre, so it cannot make `nearest`
                  // satisfiable here either.
                  hasOrderingCenter: hasOrderingCenter || hasRadiusCenter,
                }),
            },
            items,
          });
        } catch (retryErr) {
          return await fallBackToNative(retryErr);
        }
      }

      return await fallBackToNative(searchErr);
    }
  } catch (err) {
    request.log.error(
      { err, body },
      'Failed to discover items'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to discover items',
    });
  }
};
