import { items } from '@dpg/database';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import z from 'zod';

const ItemLocationPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
});
export const ItemLocationsArray = z.array(ItemLocationPoint);

export const ItemSelectSchema = createSelectSchema(items);
export const ItemResponseSchema = ItemSelectSchema.omit({
  item_private_state: true,
}).extend({
  // Kept optional deliberately: response paths that do not project this column
  // (e.g. browse/fetch without lifecycle filter) must not cause a serialization 500.
  lifecycle_status: z.enum(['draft', 'live', 'paused', 'retired']).optional(),
  item_locations: ItemLocationsArray,
});
export const ItemInsertSchema = createInsertSchema(items);
// ItemSnapshotSchema is the contract sent to the external match-score scorer.
// The scorer knows nothing about item_locations — it expects flat scalar coords
// (item_latitude / item_longitude). The UI derives these from item_locations[0]
// before calling the API (see apps/ui/src/lib/match-score-api.ts itemToSnapshot).
export const ItemSnapshotSchema = ItemResponseSchema.omit({
  created_by: true,
  created_at: true,
  updated_at: true,
  item_locations: true,
}).extend({
  item_latitude: z.number().min(-90).max(90).nullable().optional(),
  item_longitude: z.number().min(-180).max(180).nullable().optional(),
});

export const CreateItemBodySchema = ItemInsertSchema.omit({
  created_by: true,
  item_id: true,
  item_instance_url: true,
  item_schema_url: true,
  item_private_state: true,
  created_at: true,
  updated_at: true,
  lifecycle_status: true,
}).extend({
  // Optional override used by admin / service callers to author items on
  // behalf of another user. Non-admin callers cannot supply this — see
  // create_item.ts.
  created_by: z.string().min(1).optional(),
  item_locations: ItemLocationsArray.optional(),
  consent: z
    .object({
      category: z.literal('profile_creation'),
      version: z.number().int().min(1),
      brand: z.string().min(1).nullish(),
    })
    .optional(),
});

const FetchItemsSchemaBase = z.object({
  item_id: z.uuid().optional(),
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1).optional(),

  item_instance_url: z.url().nullable().optional(),

  item_schema_url: z.url().nullable().optional(),

  // Facet filter. Each entry's value may be a scalar or a `string[]` —
  // item_fetch_runtime's buildWhereClause normalizes a scalar `v` to `[v]`
  // and applies EVERY entry (scalar or array) the same guarded way:
  // `item_state ->> field = ANY(...)`, gated by the declared/non-private
  // facet guard (see `resolveAllowedFacetFields`; #394 dropped the additional
  // `filterable` marker that guard used to also require, and separately
  // closed a hole where a scalar value bypassed the guard entirely via an
  // unguarded `item_state @> jsonb` containment check — there is no such
  // unguarded branch any more). Left as `z.unknown()` rather than a narrower
  // union deliberately: this field is shared by every fetch/count/markers
  // schema below.
  item_state: z.record(z.string(), z.unknown()).optional(),
  item_latitude: z.coerce.number().optional(),
  item_longitude: z.coerce.number().optional(),
  radius_meters: z.coerce.number().positive().optional(),

  // Bounding-box viewport search (#203 Task 2). All four or none; mutually
  // exclusive with the radius-center params above (item_latitude/
  // item_longitude/radius_meters) — see withGeoSearchRefinement. The SQL that
  // consumes these lands in Task 3; this is schema + passthrough only.
  min_lat: z.coerce.number().min(-90).max(90).optional(),
  min_lng: z.coerce.number().min(-180).max(180).optional(),
  max_lat: z.coerce.number().min(-90).max(90).optional(),
  max_lng: z.coerce.number().min(-180).max(180).optional(),

  limit: z.coerce.number().int().min(1).max(1000).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  cache_ttl_seconds: z.coerce.number().int().positive().optional(),

  // Owner "My Profiles" reads exclude retired (permanently-removed) profiles by
  // default. The first-time-login redirect check opts INTO retired so a
  // retired-only user is recognized as "already set up" and stays on the map
  // rather than being sent to the create page (#376). Absent → retired excluded.
  include_retired: z.enum(['true', 'false']).transform((v) => v === 'true').optional().default(false),
});

type FetchItemsSchemaShape = z.infer<typeof FetchItemsSchemaBase>;

// `z.ZodType` rather than the deprecated `z.ZodTypeAny` (zod 4).
function withGeoSearchRefinement<T extends z.ZodType>(schema: T) {
  return schema.refine(
    (rawData) => {
      const data = rawData as Partial<FetchItemsSchemaShape>;
      const hasLat = data.item_latitude !== undefined;
      const hasLng = data.item_longitude !== undefined;
      const hasRadius = data.radius_meters !== undefined;
      const hasRadiusCenter = hasLat && hasLng;

      // lat/lng must be supplied as a pair.
      if (hasLat !== hasLng) return false;
      // radius filtering requires a center (lat+lng); radius alone is invalid.
      if (hasRadius && !hasRadiusCenter) return false;

      const bboxValues = [
        data.min_lat,
        data.min_lng,
        data.max_lat,
        data.max_lng,
      ];
      const bboxProvidedCount = bboxValues.filter(
        (value) => value !== undefined
      ).length;
      const hasBbox = bboxProvidedCount === 4;
      const hasPartialBbox = bboxProvidedCount > 0 && bboxProvidedCount < 4;

      // bbox is all-four-or-none.
      if (hasPartialBbox) return false;
      // a radius center and a bbox are mutually exclusive viewport searches.
      if (hasRadiusCenter && hasBbox) return false;

      // lat+lng alone is valid (order-only); lat+lng+radius is valid (filter+order);
      // a full bbox alone is valid (filter).
      return true;
    },
    {
      message:
        'item_latitude and item_longitude must be provided together; radius_meters requires both; min_lat/min_lng/max_lat/max_lng must all be provided together and cannot be combined with a radius center',
      path: ['radius_meters'],
    }
  );
}

export const FetchItemsQuerySchema = withGeoSearchRefinement(FetchItemsSchemaBase);

export const FetchItemsCountBodySchema = withGeoSearchRefinement(
  FetchItemsSchemaBase.omit({
    limit: true,
    offset: true,
    cache_ttl_seconds: true,
  })
);

export const FetchItemsBodySchema = withGeoSearchRefinement(FetchItemsSchemaBase.extend({
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0),
  cache_ttl_seconds: z.number().int().positive().optional(),
  /**
   * Which order the caller wants — forwarded peer-to-peer (#644).
   *
   * Load-bearing for TWO reasons. First, `buildDistanceOrderBy` keys off this
   * rather than inferring from the presence of coordinates, so without it a
   * peer serving `sort: 'newest'` alongside a radius returns
   * DISTANCE-ordered rows — and because each peer over-fetches only its top N,
   * genuinely-newest items can be missing from the page rather than merely
   * misordered.
   *
   * Second, `fetchRemotePage` signs the serialized `ItemFetchFilters` and the
   * receiver re-hashes what this schema parsed. A field the schema does not
   * name is stripped before that re-hash, so an unlisted `order_by` breaks
   * peer auth outright.
   *
   * Absent means "infer", preserving the behaviour of every caller that
   * predates the explicit sort.
   */
  order_by: z.enum(['distance', 'created_at']).optional(),
}));

const MarkersSchemaBase = FetchItemsSchemaBase.extend({
  // Coords are cheap — allow a much higher cap than the 1000 full-fetch cap.
  limit: z.coerce.number().int().min(1).max(25000).default(200),

  // Free-text value-match search (#394 map native text search). Matched
  // server-side against the PUBLIC (non-private) item_state field values
  // only — see `resolveAllowedFacetFields` (facet_guard.ts) and
  // `buildWhereClause`'s `text_search` branch (item_fetch_runtime.ts) — and
  // is AND-ed with whatever bbox/radius viewport the rest of this request
  // already carries, so it's inherently scoped to the visible map area. Kept
  // on this schema (not the shared FetchItemsSchemaBase) because the map
  // stays native; list/discover text search goes through signals-search
  // instead. On `MarkersBodySchema` (forwarded peer-to-peer), only the raw
  // `q` travels — never a resolved field allowlist — each instance resolves
  // its own non-private fields from its own network config.
  q: z.string().trim().min(1).optional(),
});

export const MarkersQuerySchema = withGeoSearchRefinement(MarkersSchemaBase);
export const MarkersBodySchema = withGeoSearchRefinement(
  MarkersSchemaBase.extend({
    limit: z.number().int().min(1).max(25000),
    offset: z.number().int().min(0),
    cache_ttl_seconds: z.number().int().positive().optional(),
  })
);

export const MarkerResponseSchema = z.object({
  item_id: z.uuid(),
  item_domain: z.string(),
  item_instance_url: z.url().nullable(),
  item_locations: ItemLocationsArray,
});

export const UpdateItemParamsSchema = z.object({
  itemId: z.uuid(),
});

export const UpdateItemBodySchema = ItemInsertSchema.omit({
  created_by: true,
  item_network: true,
  item_domain: true,
  item_type: true,
  item_id: true,
  item_private_state: true,
  created_at: true,
  updated_at: true,
  lifecycle_status: true,
})
  .extend({
    item_locations: ItemLocationsArray.optional(),
  })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });
