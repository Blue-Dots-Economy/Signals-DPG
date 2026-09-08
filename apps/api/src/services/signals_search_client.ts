import { randomUUID } from 'node:crypto';
import z, { type DiscoverSort } from '@dpg/schemas';
import { signalsSearchConfig } from '@/config';

/**
 * Client for the signals-search `/v1/search` service (#203 List PR, discover
 * BFF). signals-search cannot be run locally — every test mocks this module
 * or its `fetch` call rather than hitting a real instance.
 *
 * Envelope shape confirmed from the signals-search repo (`src/api/schemas.ts`
 * + `openapi.json`, see `.superpowers/sdd/progress.md`): a Beckn-style
 * `context`/`message` request, single `s_dwithin` spatial clause max, filter
 * clauses targeting `item_state.<field>`.
 *
 * Response shape revised for signals-search PR #87: `/v1/search` now returns
 * the FULL item row per result (not just `item_id` + masked `item_state`), so
 * the discover BFF (`discover.ts`) maps each result directly to the DPG item
 * response shape — no local-DB hydrate/re-read by id.
 */

const SIGNALS_SEARCH_TIMEOUT_MS = 5000;
const MAX_PAGE_SIZE = 100;

export type FacetValue = string | number | boolean;

export interface SignalsSearchFacetInput {
  /** Bare field name — the client prefixes it to `item_state.<field>`. */
  field: string;
  values: FacetValue[];
  /**
   * Whether `item_state.<field>` is a JSON Schema array. Array fields ALWAYS
   * map to `contains_any` (jsonb `?|` overlap — correct for one OR many
   * values); scalar fields map to `in`. Op must not depend on the selection
   * count: signals-search's `in` uses `item_state->>field = ANY(...)`, which
   * extracts an array field as its serialized-array TEXT and so never matches
   * a single scalar value — a one-value selection on an array facet would
   * silently return zero results if it used `in`.
   */
  arrayValued?: boolean;
}

export interface SearchSignalsInput {
  network: string;
  domain: string;
  itemType: string;
  q?: string;
  filters?: SignalsSearchFacetInput[];
  lat?: number;
  lng?: number;
  distanceMeters?: number;
  /**
   * VIEWPORT area mode — the exact rectangle the map is showing (contract
   * §1.5). Mutually exclusive with `lat`/`lng`/`distanceMeters`; all four
   * bounds travel together or none do, enforced on the way in by
   * `DiscoverItemsBodySchema`.
   */
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
  limit: number;
  offset: number;
  /**
   * The viewer's own profile `item_id`, sent as `intent.item.id` (Beckn anchor)
   * so signals-search ranks results by relevance to that profile rather than
   * plain recency/proximity. Omitted entirely (not `null`) when there is no
   * anchor — see `buildSignalsSearchRequest`.
   */
  anchorItemId?: string;
  /**
   * Explicit ordering (#644), forwarded as `intent.sort`. Omitted entirely
   * when undefined so signals-search keeps its historical inferred behaviour
   * (cosine → distance → recency) for any caller that doesn't set it.
   */
  sort?: DiscoverSort;
  /**
   * Ordering centre → `intent.orderingCenter`. Orders ONLY; produces no
   * spatial clause. Deliberately named differently from `lat`/`lng` above —
   * those FILTER — so the two can never be confused at a call site.
   */
  orderingLat?: number;
  orderingLng?: number;
}

const SignalsSearchFilterClauseSchema = z.object({
  op: z.enum([
    'in',
    'contains_any',
    'eq',
    'neq',
    'contains',
    'gt',
    'gte',
    'lt',
    'lte',
  ]),
  target: z.string(),
  value: z.unknown(),
});

// Two ops, discriminated on `op` (contract §1.5). A DISCRIMINATED union, not
// a plain one, so adding a third op makes the compiler point at every site
// that has to branch — which is how signals-search found that its
// anchorless-spatial refine had to be scoped to `s_dwithin` (a bbox carries
// its own bounds, so it must not demand an anchor).
const SignalsSearchSpatialClauseSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('s_dwithin'),
    geometry: z.object({
      type: z.literal('Point'),
      // GeoJSON order — [lng, lat], not [lat, lng].
      coordinates: z.tuple([z.number(), z.number()]),
    }),
    distanceMeters: z.number().optional(),
  }),
  // Named fields rather than a GeoJSON [west,south,east,north] tuple:
  // `orderingCenter` already carries one [lng,lat] transposition hazard and a
  // second was not worth the brevity. camelCase matches signals-search's wire
  // convention; the UI's snake_case `min_lat` etc. map straight across.
  z.object({
    op: z.literal('bbox'),
    minLat: z.number(),
    minLng: z.number(),
    maxLat: z.number(),
    maxLng: z.number(),
  }),
]);

// The ORDERING centre (#644). Same GeoJSON shape as the spatial clause's
// geometry, but a separate schema because it must never be mistaken for one:
// signals-search turns `spatial` into a hard ST_DWithin predicate, so an
// ordering centre leaking in there would silently truncate the candidate set
// to the default radius — the exact bug #644 fixes.
const SignalsSearchOrderingCenterSchema = z.object({
  type: z.literal('Point'),
  // GeoJSON order — [lng, lat], not [lat, lng].
  coordinates: z.tuple([z.number(), z.number()]),
});

const SignalsSearchRequestSchema = z.object({
  context: z.object({
    version: z.literal('1.0.0'),
    messageId: z.string(),
    networkId: z.string(),
    domain: z.string(),
    itemType: z.string(),
  }),
  message: z.object({
    intent: z.object({
      textSearch: z.string().optional(),
      filters: z.array(SignalsSearchFilterClauseSchema).optional(),
      spatial: z.array(SignalsSearchSpatialClauseSchema).max(1).optional(),
      item: z.object({ id: z.string() }).optional(),
      // #644. Both live INSIDE `intent` on purpose: signals-search's result
      // cache key hashes the whole intent, so placing them on `message`
      // alongside `pagination` would make two different sorts share a cache
      // entry.
      sort: z.enum(['relevance', 'newest', 'nearest']).optional(),
      orderingCenter: SignalsSearchOrderingCenterSchema.optional(),
    }),
    pagination: z.object({
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE),
      offset: z.number().int().min(0),
    }),
  }),
});

export type SignalsSearchRequest = z.infer<typeof SignalsSearchRequestSchema>;

const SignalsSearchItemLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  label: z.string().optional(),
});

const SignalsSearchItemSchema = z.object({
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_id: z.string(),
  // Masked public projection — signals-search never sees item_private_state.
  item_state: z.record(z.string(), z.unknown()),
  item_locations: z.array(SignalsSearchItemLocationSchema),
  // Full item fields (PR #87 on signals-search): `/v1/search` now returns the
  // whole item row, not just id + state, so the discover BFF can map directly
  // to the DPG item response shape without a local-DB hydrate round trip.
  item_instance_url: z.string().nullable(),
  item_schema_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string().nullable(),
  lifecycle_status: z.string(),
  score: z.number().optional(),
  distanceMeters: z.number().optional(),
});

export type SignalsSearchItem = z.infer<typeof SignalsSearchItemSchema>;

const SignalsSearchResponseSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  message: z.object({
    items: z.array(SignalsSearchItemSchema),
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      // #644: the order signals-search actually applied. OPTIONAL here, not
      // required, and that is deliberate — this BFF must keep working against
      // a signals-search deployed BEFORE its sort change. The two repos ship
      // independently and either PR may reach production first, so the BFF
      // falls back to the sort it requested when the field is absent.
      sort_applied: z.enum(['relevance', 'newest', 'nearest']).optional(),
    }),
  }),
});

export interface SearchSignalsResult {
  items: SignalsSearchItem[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    /** Absent when talking to a signals-search without #644's sort support. */
    sort_applied?: DiscoverSort;
  };
}

/**
 * Thrown by `searchSignals` for a non-2xx `/v1/search` response. Carries the
 * upstream HTTP `status` and the upstream `error` code (e.g.
 * `'ANCHOR_NOT_FOUND'` for an unindexed/invalid anchor `item_id`) so callers
 * — specifically the discover BFF's anchor-retry (#394) — can distinguish
 * "anchor not found, retry without it" from any other search failure without
 * string-matching the message.
 */
export class SignalsSearchError extends Error {
  status?: number;
  code?: string;
  override name = 'SignalsSearchError';
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

function clampOffset(offset: number): number {
  return Math.max(Math.trunc(offset), 0);
}

function buildFilterClause(facet: SignalsSearchFacetInput) {
  // Array fields → `contains_any` regardless of how many values are selected
  // (see SignalsSearchFacetInput.arrayValued): a single-value selection on an
  // array facet must NOT use `in`, which would never match.
  const useContainsAny = Boolean(facet.arrayValued);

  return {
    op: useContainsAny ? ('contains_any' as const) : ('in' as const),
    target: `item_state.${facet.field}`,
    value: facet.values,
  };
}

/**
 * The ONE spatial clause, or none.
 *
 * A bbox wins over a radius when both somehow arrive, but that state is
 * already rejected by `DiscoverItemsBodySchema` — the envelope's `spatial`
 * array is `.max(1)`, so there is no shape in which both could be sent
 * anyway. The ordering here is a last line of defence, not a policy.
 */
function buildSpatialClause(input: SearchSignalsInput) {
  if (
    input.minLat !== undefined &&
    input.minLng !== undefined &&
    input.maxLat !== undefined &&
    input.maxLng !== undefined
  ) {
    return {
      op: 'bbox' as const,
      minLat: input.minLat,
      minLng: input.minLng,
      maxLat: input.maxLat,
      maxLng: input.maxLng,
    };
  }

  if (input.lat === undefined || input.lng === undefined) {
    return undefined;
  }

  return {
    op: 's_dwithin' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [input.lng, input.lat] as [number, number],
    },
    ...(input.distanceMeters !== undefined
      ? { distanceMeters: input.distanceMeters }
      : {}),
  };
}

// Ordering centre → GeoJSON Point. Kept separate from `buildSpatialClause`
// (rather than sharing a helper) so there is no code path by which an ordering
// centre can become an `s_dwithin` clause.
function buildOrderingCenter(input: SearchSignalsInput) {
  if (input.orderingLat === undefined || input.orderingLng === undefined) {
    return undefined;
  }

  return {
    type: 'Point' as const,
    coordinates: [input.orderingLng, input.orderingLat] as [number, number],
  };
}

/**
 * Builds the Beckn-envelope request body for `/v1/search`. Exported
 * separately from `searchSignals` so envelope construction (facet/spatial
 * mapping, pagination clamping, messageId presence) is unit-testable without
 * mocking `fetch`.
 */
export function buildSignalsSearchRequest(
  input: SearchSignalsInput
): SignalsSearchRequest {
  const filters = (input.filters ?? []).map(buildFilterClause);
  const spatial = buildSpatialClause(input);
  const orderingCenter = buildOrderingCenter(input);

  return SignalsSearchRequestSchema.parse({
    context: {
      version: '1.0.0',
      messageId: randomUUID(),
      networkId: input.network,
      domain: input.domain,
      itemType: input.itemType,
    },
    message: {
      intent: {
        ...(input.q ? { textSearch: input.q } : {}),
        ...(filters.length > 0 ? { filters } : {}),
        ...(spatial ? { spatial: [spatial] } : {}),
        ...(input.anchorItemId ? { item: { id: input.anchorItemId } } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
        ...(orderingCenter ? { orderingCenter } : {}),
      },
      pagination: {
        limit: clampLimit(input.limit),
        offset: clampOffset(input.offset),
      },
    },
  });
}

/**
 * Calls signals-search `/v1/search`. Throws on missing config, a non-2xx
 * response, or an invalid response body — this task's BFF (discover.ts)
 * catches and converts that into a clean error reply; the native fallback
 * (Task 3) is what makes a search-service failure non-fatal for callers.
 */
export async function searchSignals(
  input: SearchSignalsInput
): Promise<SearchSignalsResult> {
  if (!signalsSearchConfig.url || !signalsSearchConfig.api_key) {
    throw new Error(
      'signals-search is not configured (SIGNALS_SEARCH_URL/SIGNALS_SEARCH_API_KEY unset)'
    );
  }

  const requestBody = buildSignalsSearchRequest(input);
  const target = new URL('/v1/search', signalsSearchConfig.url);

  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': signalsSearchConfig.api_key,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(SIGNALS_SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    const searchError = new SignalsSearchError(
      `signals-search /v1/search error ${response.status}: ${
        errorBody?.message ?? response.statusText
      }`
    );
    searchError.status = response.status;
    searchError.code = errorBody?.error;
    throw searchError;
  }

  const parsed = SignalsSearchResponseSchema.parse(await response.json());
  return parsed.message;
}
