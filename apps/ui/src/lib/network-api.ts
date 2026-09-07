import type { FetchItemsQuery, FetchItemsResponse, Item, ItemLocation } from './item-api';
import type { DotNetworkSchema } from '../engine/types';
import { createApiClient } from './api-client';
import { getRuntimeEnv } from '@/lib/runtime-env';

interface CachedSchemaEntry {
  cache_key: string;
  kind: 'network_config' | 'domain_item_schema' | 'instance_custom_item_schema' | 'item_schema_url' | 'consent_config';
  network?: string;
  domain?: string;
  item_type?: string;
  schema_url?: string;
  brand?: string;
  schema: DotNetworkSchema;
}

const networkApiClient = createApiClient();

// Default page size for network-wide profile browse fetches (Signals home page
// and the orange-dots tourist UI). Override via `VITE_PROFILE_FETCH_LIMIT`
// (e.g. `"500"`). Falls back to 1000 when unset, empty, or invalid.
const DEFAULT_PROFILE_FETCH_LIMIT = 1000;

export function resolveProfileFetchLimit(): number {
  const raw = getRuntimeEnv('VITE_PROFILE_FETCH_LIMIT');
  if (raw === undefined || raw === '') return DEFAULT_PROFILE_FETCH_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROFILE_FETCH_LIMIT;
  return parsed;
}

export const PROFILE_FETCH_LIMIT = resolveProfileFetchLimit();

const DEFAULT_PROFILE_PAGE_SIZE = 50;

export function resolveProfilePageSize(): number {
  const raw = import.meta.env.VITE_PROFILE_PAGE_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_PROFILE_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROFILE_PAGE_SIZE;
  return parsed;
}

export const PROFILE_PAGE_SIZE = resolveProfilePageSize();

// Default cap for map-viewport marker fetches (Signals map/marker layer,
// #203 P4). Override via `VITE_MAP_FETCH_LIMIT` (e.g. `"2000"`). Falls back
// to 25000 when unset, empty, or invalid. Mirrors `resolveProfileFetchLimit`.
// Must not exceed the server markers cap (`MarkersBodySchema` /
// `MarkersQuerySchema` in `packages/schemas`, currently 25000) or the request
// is rejected.
const DEFAULT_MAP_FETCH_LIMIT = 25000;

export function resolveMapFetchLimit(): number {
  const raw = import.meta.env.VITE_MAP_FETCH_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_MAP_FETCH_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAP_FETCH_LIMIT;
  return parsed;
}

export const MAP_FETCH_LIMIT = resolveMapFetchLimit();

export interface FetchNetworkItemsQuery
  extends Omit<FetchItemsQuery, 'created_by_me'> {
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  cache_ttl_seconds?: number;
}

export async function fetchNetworkItems(
  query: FetchNetworkItemsQuery,
  signal?: AbortSignal
): Promise<FetchItemsResponse> {
  const params = new URLSearchParams();

  params.set('item_network', query.item_network);
  params.set('item_domain', query.item_domain);

  if (query.item_type) params.set('item_type', query.item_type);
  if (query.item_id) params.set('item_id', query.item_id);
  if (query.item_instance_url) {
    params.set('item_instance_url', query.item_instance_url);
  }
  if (query.item_schema_url) params.set('item_schema_url', query.item_schema_url);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.item_latitude !== undefined) {
    params.set('item_latitude', String(query.item_latitude));
  }
  if (query.item_longitude !== undefined) {
    params.set('item_longitude', String(query.item_longitude));
  }
  if (query.radius_meters !== undefined) {
    params.set('radius_meters', String(query.radius_meters));
  }
  if (query.cache_ttl_seconds !== undefined) {
    params.set('cache_ttl_seconds', String(query.cache_ttl_seconds));
  }

  const response = await networkApiClient.get<FetchItemsResponse>(
    '/api/v1/network/item/fetch',
    { params, signal }
  );
  return response.data;
}

export interface Marker {
  item_id: string;
  item_domain: string;
  item_instance_url: string | null;
  item_locations: ItemLocation[];
}

export interface MarkersResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
    partial: boolean;
    unavailable_instances: string[];
  };
  markers: Marker[];
}

export interface FetchNetworkMarkersQuery {
  item_network: string;
  item_domain: string;
  item_type?: string;
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  /**
   * Bbox alternative to `item_latitude`/`item_longitude`/`radius_meters`
   * (#203 map-serverside-search Task 4) — mutually exclusive with the radius
   * params on the server (`MarkersQuerySchema`'s refine). The map path sends
   * these (from the viewport's `map.getBounds()` corners); the list's
   * distance path and the tourist app keep sending the radius params.
   */
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  /**
   * Facet filter, one entry per `item_state.<field>`. A value is either a
   * scalar (equality/containment match) or a `string[]` — the #203 Task 7
   * multi-select case (`BrowseFiltersPanel`'s `selectedFields`) — serialized
   * below as repeated params so the server parses it back into `string[]`
   * (see the comment at the serialization site).
   */
  item_state?: Record<string, unknown>;
  /**
   * Free-text search (map-native-text-search). Value-matches public
   * (non-private) `item_state` fields, viewport-scoped — mirrors the list's
   * top-bar search box, now wired through to the map's `/markers` fetch too
   * (see `useMapMarkers`'s `search` param).
   */
  q?: string;
  limit?: number;
  offset?: number;
  cache_ttl_seconds?: number;
}

export async function fetchNetworkMarkers(
  query: FetchNetworkMarkersQuery,
  signal?: AbortSignal
): Promise<MarkersResponse> {
  const params = new URLSearchParams();

  params.set('item_network', query.item_network);
  params.set('item_domain', query.item_domain);

  if (query.item_type) params.set('item_type', query.item_type);
  if (query.item_latitude !== undefined) {
    params.set('item_latitude', String(query.item_latitude));
  }
  if (query.item_longitude !== undefined) {
    params.set('item_longitude', String(query.item_longitude));
  }
  if (query.radius_meters !== undefined) {
    params.set('radius_meters', String(query.radius_meters));
  }
  if (query.min_lat !== undefined) params.set('min_lat', String(query.min_lat));
  if (query.min_lng !== undefined) params.set('min_lng', String(query.min_lng));
  if (query.max_lat !== undefined) params.set('max_lat', String(query.max_lat));
  if (query.max_lng !== undefined) params.set('max_lng', String(query.max_lng));
  // Serialize item_state as qs bracket notation (`item_state[field]=value`),
  // which the server's `fastify-qs` parser (backed by the `qs` library)
  // decodes to a nested object that `MarkersQuerySchema.item_state` (a
  // `z.record`) accepts. A SCALAR value serializes as a single param and
  // buildWhereClause applies it as an `item_state @> jsonb` containment
  // filter (unchanged, pre-#203 behavior).
  //
  // An ARRAY value (#203 Task 7 — the map's multi-select facet filters, e.g.
  // `BrowseFiltersPanel`'s `selectedFields`) is the critical case: it MUST reach
  // the server as a real array, not `String(value)` (which produced a single
  // comma-joined `"a,b"` string — inert against buildWhereClause's
  // `item_state ->> field = ANY(...)` facet filter, Task 3). The fix is to
  // `append` the SAME bracket key once per selected value
  // (`item_state[gender]=female&item_state[gender]=male`) instead of
  // `set`-ing one joined string. `qs`'s default parser auto-arrays repeated
  // keys — with or without a trailing `[]` — back into `item_state.gender:
  // string[]`, which is exactly the shape `buildWhereClause`'s `= ANY(...)`
  // facet path expects.
  if (query.item_state !== undefined) {
    for (const [field, value] of Object.entries(query.item_state)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          params.append(`item_state[${field}]`, String(v));
        }
      } else {
        params.set(`item_state[${field}]`, String(value));
      }
    }
  }
  if (query.q) params.set('q', query.q);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.cache_ttl_seconds !== undefined) {
    params.set('cache_ttl_seconds', String(query.cache_ttl_seconds));
  }

  const response = await networkApiClient.get<MarkersResponse>(
    '/api/v1/network/item/markers',
    { params, signal }
  );
  return response.data;
}

// The discover BFF's per-field facet selection (#203 List PR Task 4). Shape
// mirrors `DiscoverFacetFilterSchema` in `packages/schemas/src/api/discover_schemas.ts`
// exactly (`field` + a non-empty `values` array) — the BFF re-validates the
// field against the schema's declared, non-private facets server-side
// (`resolveAllowedFacetFilters`) and maps the array to an `in`/`contains_any`
// op depending on whether the field itself is array-valued, so the client
// only ever sends the raw value set, never an op.
export interface DiscoverFacetFilter {
  field: string;
  values: (string | number | boolean)[];
}

export interface FetchDiscoverQuery {
  item_network: string;
  item_domain: string;
  item_type: string;
  q?: string;
  filters?: DiscoverFacetFilter[];
  item_latitude?: number;
  item_longitude?: number;
  distance_meters?: number;
  // #644 VIEWPORT area mode: the exact rectangle the map is showing (contract
  // §1.5). Mutually exclusive with the radius trio above — the BFF rejects
  // both together. All four travel or none do; a partial box is a 400.
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  limit?: number;
  offset?: number;
  // The active profile's item id (#394 Task 2, threading Task 1's backend
  // anchor through the UI data layer). Forwarded verbatim as `anchor_item_id`
  // in the BFF body; the BFF re-maps it to `intent.item.id` for signals-search
  // relevance-to-profile ranking. Omitted entirely when unset (Task 3 is what
  // wires an actual profile id in from the page).
  anchor_item_id?: string;
  // #644: explicit ordering. Optional — the BFF defaults it and reports what
  // it actually applied via `meta.sort_applied`.
  sort?: DiscoverSortMode;
  // #644: the ORDERING centre for `sort: 'nearest'`. Distinct from
  // `item_latitude`/`item_longitude` above, which are the AREA FILTER: these
  // two order the whole network nearest-first without bounding it.
  ordering_latitude?: number;
  ordering_longitude?: number;
}

export type DiscoverSource = 'signals_search' | 'native_fallback';

export type DiscoverSortMode = 'relevance' | 'newest' | 'nearest';

export interface DiscoverResponse {
  items: Item[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    source: DiscoverSource;
    degraded: boolean;
    // Effective spatial radius (meters, #394) actually applied to this
    // search — only present when the request carried a location (see
    // `DiscoverResponseSchema` in `@dpg/schemas`). The list note above the
    // results (`resolveListNote`) uses this to show "within X km".
    distance_meters?: number;
    // #644: the order the server ACTUALLY applied, after its own defaulting
    // and fallbacks. The UI labels from this rather than from what it
    // requested, so it can never claim an order it did not get.
    //
    // ABSENT means the search service did not report one — see the BFF's
    // `DiscoverResponseSchema`. Treated as UNKNOWN, not as "assume what we
    // asked for": a `?? requestedSort` here is exactly the claim this field
    // exists to prevent.
    sort_applied?: DiscoverSortMode;
  };
}

/**
 * POST `/api/v1/network/item/discover` (#203 List PR Task 4). Field names
 * mirror the BFF's `DiscoverItemsBodySchema` exactly (`item_latitude`/
 * `item_longitude`/`distance_meters`, `limit`/`offset`), same convention as
 * `fetchNetworkItems`'s query params. `items` are the SAME `Item` shape
 * `fetchNetworkItems` returns — the list renders both uniformly.
 */
/**
 * The optional fields `fetchDiscover` forwards — an explicit ALLOWLIST.
 *
 * A field missing from this list is silently dropped, however correctly the
 * caller supplied it. That is how the viewport bbox first shipped inert: the
 * hook and the BFF both handled `min_lat`…`max_lng`, this builder did not, and
 * nothing failed loudly — the list showed 79 of 79 where the API returns 71.
 * Keeping the allowlist as one named list rather than a chain of `if`s is what
 * makes such an omission visible.
 *
 * `satisfies` ties it to the query type, so a renamed field breaks the build
 * instead of quietly ceasing to be sent.
 */
const OPTIONAL_DISCOVER_BODY_KEYS = [
  'q',
  'filters',
  'item_latitude',
  'item_longitude',
  'distance_meters',
  'min_lat',
  'min_lng',
  'max_lat',
  'max_lng',
  'limit',
  'offset',
  'anchor_item_id',
  'sort',
  'ordering_latitude',
  'ordering_longitude',
] as const satisfies readonly (keyof FetchDiscoverQuery)[];

/**
 * Raw cosine → the 0-100 scale the rest of the UI works in (#646 §5.2).
 *
 * The two signals-search endpoints disagree about scale, which is the whole
 * reason this exists: `/v1/relevance` (behind `/api/v1/match-score/calculate`,
 * the modal) returns a 0-100 percentage, while `/v1/search` (behind
 * `/discover`, this feed) returns the RAW cosine similarity, ~0-1. The
 * "one scale end to end" cleanup took both to be 0-100 already; the raw 0.633
 * then reached the card pill's `Math.round(percent)` and every card badged
 * **1%**.
 *
 * Done here rather than at the two consumers (`resolveCardMetric` and
 * `seedFromDiscoverScore`) so there is exactly ONE place that knows the wire
 * scale, and neither of them can drift from it again.
 *
 * NOT done in the BFF: `/discover` deliberately reports the score its search
 * backend produced. Rescaling it there would make the API's own response
 * disagree with signals-search for every other consumer.
 *
 * Clamped because cosine similarity runs -1..1 in principle, and a negative
 * percentage renders as a nonsense badge.
 */
function toPercentScale(score: number): number {
  return Math.min(100, Math.max(0, score * 100));
}

/** Discover items carry a relevance score on a different scale — see `toPercentScale`. */
function normalizeDiscoverItemScore(item: Item): Item {
  // `null` is preserved as-is: only `undefined`/`null` mean "never scored",
  // and coercing either to 0 would badge "0%" as if the item had been scored
  // and found irrelevant.
  if (typeof item.score !== 'number') return item;
  return { ...item, score: toPercentScale(item.score) };
}

export async function fetchDiscover(
  query: FetchDiscoverQuery,
  signal?: AbortSignal
): Promise<DiscoverResponse> {
  const body: Record<string, unknown> = {
    item_network: query.item_network,
    item_domain: query.item_domain,
    item_type: query.item_type,
  };

  for (const key of OPTIONAL_DISCOVER_BODY_KEYS) {
    const value = query[key];
    // `undefined` = not asked for. An empty string or empty array is also
    // "not asked for" (this preserves the old per-field falsy checks on `q`,
    // `anchor_item_id` and `filters`), but a numeric 0 is NOT — `offset: 0` is
    // the first page and must travel.
    if (value === undefined) continue;
    if (value === '' || (Array.isArray(value) && value.length === 0)) continue;
    body[key] = value;
  }

  const response = await networkApiClient.post<DiscoverResponse>(
    '/api/v1/network/item/discover',
    body,
    { signal }
  );
  return {
    ...response.data,
    items: (response.data.items ?? []).map(normalizeDiscoverItemScore),
  };
}

export async function fetchNetworkConfigs(): Promise<DotNetworkSchema[]> {
  const response = await networkApiClient.get<CachedSchemaEntry[]>(
    '/api/v1/network/schemas'
  );
  const configs = response.data.filter((e) => e.kind === 'network_config');
  return configs.map((c) => c.schema);
}

export async function fetchNetworkConfig(
  networkId: string
): Promise<DotNetworkSchema> {
  const response = await networkApiClient.get<CachedSchemaEntry[]>(
    '/api/v1/network/schemas',
    { params: { network: networkId } }
  );
  const config = response.data.find((e) => e.kind === 'network_config');
  if (!config) {
    throw new Error(`Network "${networkId}" not found`);
  }
  return config.schema;
}
