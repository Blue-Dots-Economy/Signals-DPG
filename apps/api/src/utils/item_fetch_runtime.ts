import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from './item_decrypt';
import { getNetworkConfigById } from '@/network_configs';
import { splitLngRange } from '@/utils/lng_chunks';

/** Minimal pino-compatible surface (`request.log`) for debug-level diagnostics. */
export interface ItemFetchLog {
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

export type ItemFetchFilters = {
  item_id?: string;
  item_network: string;
  item_domain: string;
  item_type?: string;
  created_by?: string;
  item_instance_url?: string | null;
  item_schema_url?: string | null;
  /**
   * Per-field `item_state` filter values. Both a **scalar** value (string/
   * number/boolean) and an **array** value are facet filters applied via the
   * SAME guarded path: a scalar `v` is normalized to `[v]`, then every value
   * set (single or multi) is applied as `item_state->>'field' = ANY(values)`
   * (#203 Task 3, closing the "documented follow-up" noted at
   * `apps/ui/src/lib/network-api.ts`'s `item_state[field]` comment), which
   * only Task 1's per-field expression btree indexes accelerate (a `@>`
   * containment check cannot express "any of these values" for one key).
   * SECURITY (#394): a value is only honored when the field is declared in
   * the network config's schema `properties` AND not `private: true` for the
   * item's domain — see `resolveAllowedFacetFields` below — otherwise it is
   * dropped silently (never surfaced as a 4xx) so a caller can't use
   * found/not-found responses to enumerate a private/undeclared field's
   * values. This guard used to apply ONLY to array values; a scalar value
   * went through an unguarded `item_state @> {...}` containment check
   * instead, which let a single-value filter enumerate a private/undeclared
   * field — #394 closed that hole by unifying both shapes onto this one
   * guarded `= ANY` path, with no remaining unguarded branch. (There used to
   * be an additional `filterable: true` marker gating this further; a prior
   * #394 change dropped it — every declared, non-private field is a filter
   * again. The proper schema-driven search/filter declaration is tracked in
   * #360.)
   */
  item_state?: Record<string, unknown>;
  /**
   * Free-text value-match search (#394 map native text search). `q` is the
   * raw search term; `fields` is the SERVER-resolved allowlist of non-private
   * `item_state` field keys to match against — resolved by the route handler
   * via `resolveAllowedFacetFields` (facet_guard.ts) from the network
   * config, never from the client. `buildWhereClause` below ANDs this into
   * whatever bbox/radius condition is already present, so a text match is
   * inherently viewport-scoped — no separate geo logic needed here. An empty
   * `fields` (no non-private field declared for the domain/item_type) makes
   * the match unsatisfiable by design rather than matching everything.
   */
  text_search?: { q: string; fields: string[] };
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  /**
   * The ORDER, stated rather than inferred (#644 P3). `'distance'` needs
   * `item_latitude`/`item_longitude`; `'created_at'` ignores them, which is
   * what lets an area filter narrow the set WITHOUT also reordering it.
   *
   * Omit to keep the historical behaviour (coordinates present ⇒ nearest
   * first) — `/network/item/fetch` and the markers path rely on it.
   */
  order_by?: 'distance' | 'created_at';
  // Bounding-box viewport search (#203 Task 2 schema, Task 3 SQL), mutually
  // exclusive with the radius-center params above — see
  // withGeoSearchRefinement in packages/schemas/src/api/item_schemas.ts.
  // Consumed by buildWhereClause below (Option B: item_search.geo join).
  // Bbox filtering gates on the item_search read-model when it has rows for
  // the network+domain, and falls back to items.item_locations when it has
  // none — see hasSearchIndexRows below.
  min_lat?: number;
  min_lng?: number;
  max_lat?: number;
  max_lng?: number;
  limit: number;
  offset: number;
  /**
   * When true, the encrypted item_private_state blob is decrypted and merged
   * over item_state. Callers MUST verify ownership/authorization before passing
   * true.
   */
  includePrivateState?: boolean;
  /**
   * When 'live_only', restricts results to items with lifecycle_status = 'live'.
   * Defaults to returning all lifecycle states when undefined.
   */
  lifecycle_filter?: 'live_only' | 'all';
  /**
   * When true, excludes `retired` items (#347). Set by the owner "My Profiles"
   * fetch so a retired profile never lists there. Other reads (e.g. the
   * contact-details masked view) must still be able to see a retired item to
   * message the counterparty, so this is opt-in — NOT a blanket filter.
   */
  exclude_retired?: boolean;
};

const itemResponseColumns = {
  item_network: items.item_network,
  item_domain: items.item_domain,
  item_type: items.item_type,
  item_id: items.item_id,
  item_instance_url: items.item_instance_url,
  item_schema_url: items.item_schema_url,
  item_state: items.item_state,
  item_private_state: items.item_private_state,
  item_locations: items.item_locations,
  created_by: items.created_by,
  created_at: items.created_at,
  updated_at: items.updated_at,
  lifecycle_status: items.lifecycle_status,
};

/**
 * #203 Task 3 security guard: resolves the set of `item_state` field names a
 * caller is allowed to facet-filter on for a given network/domain — every
 * schema property (across every item_type declared for the domain) that is
 * declared at all AND NOT `private: true`. Sourced from the network config
 * (the same `getNetworkConfigById` cache used elsewhere in the app), never
 * from the request — a client cannot expand its own allowed facet set by
 * naming more fields.
 *
 * #394: this used to additionally require `filterable: true` (a per-field
 * marker in network.json). That gate has been removed — every declared,
 * non-private enum field is a filter again in both the map and list views
 * (restoring pre-Map-PR behavior). The `private !== true` check below is the
 * enumeration guard and MUST stay: it is the only thing standing between a
 * client and using found/not-found responses to enumerate a private field's
 * values. The proper long-term schema-driven search/filter declaration is
 * tracked in #360 — this function is the code to revisit when that lands.
 *
 * Fails closed: an unconfigured network/domain (bad `item_network`/
 * `item_domain`, or a network config load error) yields an empty set, so
 * every facet filter for that request is dropped rather than applied
 * unvalidated.
 */
async function resolveAllowedFacetFields(
  networkId: string,
  domain: string
): Promise<Set<string>> {
  const allowed = new Set<string>();

  let networkConfig;
  try {
    networkConfig = await getNetworkConfigById(networkId);
  } catch {
    return allowed;
  }

  const domainConfig = networkConfig.domains.find((entry) => entry.id === domain);
  if (!domainConfig) {
    return allowed;
  }

  for (const schema of Object.values(domainConfig.item_schemas)) {
    const properties = (schema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') continue;

    for (const [field, definition] of Object.entries(
      properties as Record<string, unknown>
    )) {
      if (!definition || typeof definition !== 'object') continue;
      const declared = definition as { private?: unknown };
      if (declared.private !== true) {
        allowed.add(field);
      }
    }
  }

  return allowed;
}

/**
 * Map bbox fallback (spec 2026-08-06-map-bbox-index-fallback-design): whether
 * the signals-search ingestion worker has ever indexed anything for this
 * network+domain. `item_search` is maintained ONLY by that worker; in
 * environments without it (local dev, worker-less deploys, fresh data
 * migrations) the table is empty and the bbox branch below would otherwise
 * exclude every item. Index-only probe on the leading PK columns —
 * sub-millisecond — so it runs per call with no cache and no config knob.
 * Deliberately empty-vs-not-empty, not per-item: one indexed row means "a
 * worker exists, trust the index" (its ~60s reconciliation sweep is the
 * recovery path for partial lag).
 */
async function hasSearchIndexRows(
  item_network: string,
  item_domain: string
): Promise<boolean> {
  const result = await db.execute<{ has_rows: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM item_search
      WHERE item_network = ${item_network} AND item_domain = ${item_domain}
    ) AS has_rows
  `);
  const rows: Array<{ has_rows: boolean }> = Array.isArray(result)
    ? (result as Array<{ has_rows: boolean }>)
    : ((result as { rows?: Array<{ has_rows: boolean }> }).rows ?? []);
  return rows[0]?.has_rows === true;
}

async function buildWhereClause(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset'>,
  log?: ItemFetchLog
) {
  const conditions = [];

  if (filters.item_id) {
    conditions.push(eq(items.item_id, filters.item_id));
  }

  conditions.push(eq(items.item_network, filters.item_network));
  conditions.push(eq(items.item_domain, filters.item_domain));

  // A retired profile is permanently removed (#347). Opt-in exclusion — the
  // owner "My Profiles" fetch sets this so a retired profile never lists there.
  // Not blanket: contact-details must still resolve a retired item to message
  // the counterparty. Discovery paths already restrict to live via
  // lifecycle_filter, so they're unaffected either way.
  if (filters.exclude_retired) {
    conditions.push(ne(items.lifecycle_status, 'retired'));
  }

  if (filters.item_type) {
    conditions.push(eq(items.item_type, filters.item_type));
  }

  if (filters.created_by) {
    conditions.push(eq(items.created_by, filters.created_by));
  }

  if (filters.item_instance_url) {
    conditions.push(eq(items.item_instance_url, filters.item_instance_url));
  }

  if (filters.item_schema_url) {
    conditions.push(eq(items.item_schema_url, filters.item_schema_url));
  }

  if (filters.item_state) {
    // Every requested item_state entry — scalar or array — is normalized to
    // an array and routed through the SAME guarded `= ANY` path (#394 fix): a
    // scalar `v` becomes `[v]`, which matches exactly like the old
    // `@> {field: v}` containment check for an allowed field, but (unlike the
    // old unguarded scalar branch) is dropped when the field isn't declared
    // and non-private for this domain. Single- and multi-value facets are
    // therefore identical from here on — there is no separate scalar
    // containment branch any more.
    //
    // Caveat: "matches exactly" holds for STRING values — every configured
    // facet today is a string enum, and `->> field` extracts JSON text, so
    // `= ANY(ARRAY[...])` compares text to text just like the old containment
    // check did. A numeric or boolean scalar facet would NOT be exact: `->>`
    // still yields text (e.g. `'true'`, `'42'`), so the comparison becomes a
    // text comparison rather than the JSON-typed equality `@>` used to do.
    // Not an issue while facets stay string enums; revisit if a non-string
    // facet is ever declared.
    //
    // The `= ANY` text comparison is ALSO wrong for a field whose schema type
    // is `array`, which is why a guarded containment clause is OR'd in below —
    // see the comment at that predicate.
    const facetEntries: Array<[string, unknown[]]> = Object.entries(
      filters.item_state
    ).map(([field, value]) => [field, Array.isArray(value) ? value : [value]]);

    if (facetEntries.length > 0) {
      const allowedFacetFields = await resolveAllowedFacetFields(
        filters.item_network,
        filters.item_domain
      );

      for (const [field, values] of facetEntries) {
        if (!allowedFacetFields.has(field)) {
          log?.debug(
            {
              item_network: filters.item_network,
              item_domain: filters.item_domain,
              field,
            },
            'Dropping item_state facet filter: field is not declared and non-private for this domain'
          );
          continue;
        }

        if (values.length === 0) {
          // An explicit empty value set matches nothing — distinct from
          // "field not present", which applies no restriction at all.
          conditions.push(sql`false`);
          continue;
        }

        const valuesArrayLiteral = sql.join(
          values.map((value) => sql`${value}`),
          sql.raw(', ')
        );

        // ARRAY-valued facets need containment, not text equality.
        //
        // `->> field` extracts the field as TEXT, and for a field whose schema
        // type is `array` the stored value is a JSON array — so `->>` yields
        // `["Full-time","Flexible"]` and comparing that to `'Full-time'` is
        // false for every row, always. Two array facets on blue_dot's seeker
        // schema (`natureOfJobsInterestedIn`, `otherHelpNeeded`) were therefore
        // matching NOTHING natively while matching correctly through
        // signals-search: the map lost all its pins the moment you filtered on
        // one, and `useBrowseTotals` reported every match as "not on the map"
        // because its `mappable` count comes from this path.
        //
        // `-> field @> to_jsonb(value)` is true when the stored array CONTAINS
        // the value, and also when the stored scalar EQUALS it (a jsonb scalar
        // contains itself), so it covers both shapes. One clause per value,
        // OR'd, because `@>` with a multi-element array would mean "contains
        // ALL of these" — the wrong quantifier for a facet.
        //
        // Kept alongside the `->>` equality rather than replacing it: the
        // scalar path has per-field btree expression indexes
        // (`items_item_state_*_idx`), while `@>` is served by the GIN index on
        // `item_state`. Both stay index-backed.
        //
        // This is containment for a GUARDED field only — the field has already
        // passed `allowedFacetFields` above, which is what the unguarded
        // whole-object `@> {...}` branch removed in #394 lacked.
        const arrayContainment = sql.join(
          values.map(
            (value) => sql`${items.item_state} -> ${field} @> to_jsonb(${value}::text)`
          ),
          sql.raw(' OR ')
        );

        conditions.push(
          sql`(${items.item_state} ->> ${field} = ANY(ARRAY[${valuesArrayLiteral}]) OR ${arrayContainment})`
        );
      }
    }
  }

  if (filters.text_search) {
    const { q, fields } = filters.text_search;

    if (fields.length === 0) {
      // No non-private field is declared for this domain/item_type (e.g. an
      // unconfigured item_type, or a schema with no public fields at all) —
      // the match is unsatisfiable rather than silently matching every row.
      conditions.push(sql`false`);
    } else {
      // Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) in the raw user
      // query so `q` can never inject its own wildcards into the pattern —
      // only a literal substring match is ever performed.
      const likePattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const fieldsArrayLiteral = sql.join(
        fields.map((field) => sql`${field}`),
        sql.raw(', ')
      );

      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM jsonb_each_text(${items.item_state}) e
            WHERE e.key = ANY(ARRAY[${fieldsArrayLiteral}])
              AND e.value ILIKE ${likePattern} ESCAPE '\\'
          )
        `
      );
    }
  }

  if (filters.lifecycle_filter === 'live_only') {
    conditions.push(eq(items.lifecycle_status, 'live'));
  }

  if (
    filters.item_latitude !== undefined &&
    filters.item_longitude !== undefined &&
    filters.radius_meters !== undefined
  ) {
    conditions.push(
      sql`
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
          WHERE earth_box(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}), ${filters.radius_meters})
                  @> ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
            AND earth_distance(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
                  ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)) <= ${filters.radius_meters}
        )
      `
    );
  } else if (
    filters.min_lat !== undefined &&
    filters.min_lng !== undefined &&
    filters.max_lat !== undefined &&
    filters.max_lng !== undefined
  ) {
    // #203 Task 3 — bbox viewport search (Option B): join the GiST-indexed
    // `item_search.geo` (geography MultiPoint) rather than filtering
    // `items.item_locations` directly. `&&` (bounding-box overlap) is what
    // `item_search_geo_gist` accelerates, but `&&` only compares the
    // ENVELOPE of `geo` (the bbox around every point of a multi-location
    // item) against the viewport envelope — for a multi-location item whose
    // individual points straddle the viewport such that their aggregate
    // envelope overlaps it but no single point actually falls inside, `&&`
    // alone false-positives (wrong pin + inflated meta.total). `&&` stays as
    // the index-served pre-filter; `ST_Intersects` is the exact recheck that
    // corrects it to genuine "any location in the box" — the same guarantee
    // the radius branch above already gives via per-location `earth_box`/
    // `earth_distance`. Single-location items were already exact under `&&`
    // alone (a single point's envelope IS the point), so this only changes
    // behavior for multi-location items.
    if (filters.min_lat >= filters.max_lat || filters.min_lng >= filters.max_lng) {
      // Inverted/degenerate box (e.g. swapped corners): defined as an empty
      // result rather than an error, so a malformed viewport never 500s —
      // it just shows no markers. Checked before the index probe so a
      // malformed viewport never costs a query.
      conditions.push(sql`false`);
    } else if (await hasSearchIndexRows(filters.item_network, filters.item_domain)) {
      // Longitude is chunked (`splitLngRange`) before any envelope is built:
      // `::geography` resolves a span wider than 180° as the SHORT way round
      // the globe — the complement of the intended box — so a world-zoom
      // viewport silently matched nothing (179.9° of span returned every
      // marker, 180.1° returned zero). Every chunk is a normal geography
      // polygon, so the GiST index still serves each `&&`; the chunks are
      // OR-ed because an item need only fall in one of them.
      const lngChunks = splitLngRange(filters.min_lng, filters.max_lng);
      const chunkClauses = lngChunks.map(
        (chunk) => sql`(
          s.geo && ST_MakeEnvelope(${chunk.minLng}, ${filters.min_lat!}, ${chunk.maxLng}, ${filters.max_lat!}, 4326)::geography
          AND ST_Intersects(s.geo, ST_MakeEnvelope(${chunk.minLng}, ${filters.min_lat!}, ${chunk.maxLng}, ${filters.max_lat!}, 4326)::geography)
        )`
      );
      // Seeded with `false` rather than relying on the first element:
      // `splitLngRange` never returns an empty array today, but a no-initial
      // `reduce` throws outright if that ever changes, and `false OR (...)` is
      // both the correct identity for a disjunction and the right answer for
      // no chunks at all.
      const geoClause = chunkClauses.reduce(
        (acc, clause) => sql`${acc} OR ${clause}`,
        sql`false`
      );
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM item_search s
            WHERE s.item_network = ${items.item_network} AND s.item_id = ${items.item_id}
              AND s.lifecycle_status = 'live'
              AND (${geoClause})
          )
        `
      );
    } else {
      // Fallback: item_search has NEVER been populated for this
      // network+domain (see hasSearchIndexRows above), so gate on the item's
      // own item_locations. A bbox on lat/lng is a pure numeric range check —
      // equivalent modulo geodesic-vs-planar edge treatment, immaterial at
      // viewport scale, to the ST_Intersects recheck (geography ST_Intersects
      // treats the box's edges as geodesics; this BETWEEN check treats them
      // as constant-coordinate lines), computed without the read-model. Fine
      // at the <10k-item scale of worker-less environments; the moment the
      // worker indexes its first row for the domain, the probe flips and the
      // GiST path above takes over with no restart.
      //
      // Unlike the index branch above, this branch has no lifecycle
      // predicate of its own (`s.lifecycle_status = 'live'` there has no
      // counterpart here) — a caller relying on this fallback for
      // live-only results MUST pass `lifecycle_filter: 'live_only'`, which
      // adds the separate items-side `lifecycle_status = 'live'` condition
      // elsewhere in this function.
      log?.debug(
        { item_network: filters.item_network, item_domain: filters.item_domain },
        'bbox: item_search has no rows for this network+domain — falling back to items.item_locations'
      );
      conditions.push(
        sql`
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
            WHERE (loc->>'lat')::float8 BETWEEN ${filters.min_lat} AND ${filters.max_lat}
              AND (loc->>'lng')::float8 BETWEEN ${filters.min_lng} AND ${filters.max_lng}
          )
        `
      );
    }
  }

  return conditions.length ? and(...conditions) : undefined;
}

export async function countLocalItems(
  filters: Omit<ItemFetchFilters, 'limit' | 'offset' | 'includePrivateState'>,
  log?: ItemFetchLog
) {
  const whereClause = await buildWhereClause(filters, log);
  const [{ count }] = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(items)
    .where(whereClause);

  return Number(count);
}

/**
 * §4.1/§4.3 shared ORDER BY, used by both fetchLocalItems and
 * fetchLocalMarkers so the ordering can never drift between the two
 * projections.
 *
 * `order_by` makes the choice EXPLICIT. Without it the order was inferred
 * from whether a lat/lng happened to be present, which is #644's P3 defect
 * ("ordering is implicit and unchangeable... inferred from which inputs
 * happen to be present") reproduced on the native path: an AREA filter sends
 * coordinates to FILTER by radius, and this then also ORDERED by distance, so
 * `sort: 'newest'` plus an area silently returned distance-ordered rows.
 * Measured before the fix: seeker/50 km inverted created_at at index 42
 * (2026-07-14 followed by 2026-08-03) while the first rows looked correctly
 * dated, which is exactly why it hid.
 *
 * Omitting `order_by` keeps the historical inference, because callers other
 * than discover (`/network/item/fetch`, markers) depend on "coordinates mean
 * nearest-first" and must not change behaviour here.
 */
function buildDistanceOrderBy(
  filters: Pick<ItemFetchFilters, 'item_latitude' | 'item_longitude' | 'order_by'>
) {
  const hasCenter =
    filters.item_latitude !== undefined && filters.item_longitude !== undefined;
  // Explicit wins; absent `order_by` falls back to the historical inference.
  const byDistance =
    filters.order_by === 'distance' || (filters.order_by === undefined && hasCenter);

  // A distance order needs a centre to measure from. Asking for one without
  // coordinates is a caller bug, but degrading to recency beats emitting SQL
  // that cannot run.
  if (!byDistance || !hasCenter) {
    return sql`${items.created_at} DESC, ${items.item_id} ASC`;
  }

  return sql`
    (
      SELECT MIN(
        earth_distance(
          ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
          ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
        )
      )
      FROM jsonb_array_elements(${items.item_locations}) loc
    ) ASC NULLS LAST,
    ${items.created_at} DESC,
    ${items.item_id} ASC
  `;
}

const markerColumns = {
  item_id: items.item_id,
  item_domain: items.item_domain,
  item_instance_url: items.item_instance_url,
  item_locations: items.item_locations,
};

export async function fetchLocalItems(filters: ItemFetchFilters, log?: ItemFetchLog) {
  const whereClause = await buildWhereClause(filters, log);
  const total = await countLocalItems(filters, log);
  const result = await db
    .select(itemResponseColumns)
    .from(items)
    .where(whereClause)
    // Live profiles first, then the shared distance/created ordering within each
    // group — so a live profile floats to the top of "My Profiles" while
    // discovery (live_only) is unaffected (the first key is a no-op there).
    .orderBy(sql`(${items.lifecycle_status} = 'live') DESC, ${buildDistanceOrderBy(filters)}`)
    .limit(filters.limit)
    .offset(filters.offset);

  return {
    meta: {
      total,
      limit: filters.limit,
      offset: filters.offset,
    },
    items: result.map((item) => {
      const { item_private_state, ...responseItem } = item;
      if (!filters.includePrivateState) {
        return responseItem;
      }
      return {
        ...responseItem,
        item_state: decryptItemPrivate({
          item_state: item.item_state,
          item_private_state: item_private_state ?? '',
        }).mergedState,
      };
    }),
  };
}

/**
 * §4.3 slim projection for map markers: item_id/item_domain/item_instance_url/
 * item_locations only. Same WHERE + ORDER BY as fetchLocalItems (via
 * buildWhereClause / buildDistanceOrderBy) so filtering and nearest-first
 * ordering behave identically — just without the heavier item_state payload.
 */
export async function fetchLocalMarkers(filters: ItemFetchFilters, log?: ItemFetchLog) {
  const whereClause = await buildWhereClause(filters, log);
  const total = await countLocalItems(filters, log);
  const markers = await db
    .select(markerColumns)
    .from(items)
    .where(whereClause)
    .orderBy(buildDistanceOrderBy(filters))
    .limit(filters.limit)
    .offset(filters.offset);

  return {
    meta: {
      total,
      limit: filters.limit,
      offset: filters.offset,
    },
    markers,
  };
}
