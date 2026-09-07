# Signals-DPG (API + fetch layer): opt-in area, explicit sort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `Signals-DPG` · **Branch:** `feat/644-list-view-sort-filters` · **Worktree:** `../Signals-DPG.worktrees/644-list-view`
**Goal:** Make the list view's location filter opt-in and its ordering explicit, end to end from the UI fetch hook through the `/discover` BFF to the search envelope.

**Architecture:** Four layers, bottom-up. The Zod body/response schemas gain `sort` and an ordering centre. The search client maps them into the Beckn envelope. The `/discover` handler stops sending a spatial clause unless an area was explicitly requested, defaults and reports the sort, and teaches the native fallback the same orders. The UI fetch layer (`browse-discover.ts`, `use-infinite-browse-items.ts`) gains a `BrowseArea` union defaulting to `anywhere` and stops forwarding the viewer's location unconditionally.

**Tech Stack:** TypeScript, Fastify + `fastify-type-provider-zod`, Zod, Drizzle, TanStack Query `useInfiniteQuery`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-list-view-sort-domain-and-card-metric-design.md`
**Contract:** `docs/superpowers/plans/2026-09-03-list-view-wire-contract.md` — **FROZEN. Read §5–§7 before Task 1.**
**Sibling plans:** `2026-09-03-signals-search-sort-paging-text.md` (other repo, parallel session) · `2026-09-03-signals-dpg-list-view-ui.md` (this repo, after this plan)

**Part of:** #644. Same PR as the UI plan.

## Global Constraints

- **The wire contract is frozen.** Field names and semantics come from the contract doc. If you believe it is wrong, stop and report — do not change it locally. Signals-DPG's tests all mock signals-search, so a divergence produces a green build and a broken deploy.
- **`anywhere` is the default and sends NO `item_latitude` / `item_longitude` / `distance_meters`.** There is no `area_mode` field: absence *is* `anywhere`. This is the actual bug fix (#644) — do not reintroduce a default radius anywhere in the stack.
- **An ordering centre is not an area filter.** `ordering_latitude` / `ordering_longitude` must never produce a spatial clause and must never set `meta.distance_meters`.
- **`meta.sort_applied` is always present** on a 200, on both the signals-search and native-fallback paths.
- **Never send `distance_meters` unless the request carried an area filter.** Today's `signalsSearchConfig.distanceMeters` env fallback (`discover.ts:191`) applies **only** in `radius` mode.
- **signals-search cannot be run locally.** Every test mocks `@/services/signals_search_client` or its `fetch` (see that file's header comment). Do not write a test that expects a live instance.
- **Test commands:** `pnpm --filter api test`, `pnpm --filter ui test`, `pnpm typecheck` (both packages).
- **Low-RAM machine (8 GB):** append `-- --pool=forks --maxWorkers=2` to any Vitest run, and use `--concurrency=1` for turbo. An uncapped full suite can hang the system.
- **Base branch is `feature`.** Open the PR as a **draft**. Never commit or push to `feature` or `develop` directly.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/schemas/src/api/discover_schemas.ts` | `/discover` wire contract | `sort`, `ordering_*`, `meta.sort_applied`; narrow the meaning of the three area fields |
| `apps/api/src/services/signals_search_client.ts` | Beckn envelope construction | `sort` + `orderingCenter` in `intent`; spatial only when an area filter is present |
| `apps/api/src/routes/v1/network/item/discover.ts` | BFF orchestration | default + report sort; area-gated spatial; native fallback sorts |
| `apps/api/src/utils/item_fetch_runtime.ts` | Native SQL ordering | `item_id` tiebreaker in `buildDistanceOrderBy` |
| `apps/ui/src/lib/browse-discover.ts` | Search box + facets → params | `BrowseArea` union; `sort`; drop hardcoded `relevance: true` |
| `apps/ui/src/hooks/use-infinite-browse-items.ts` | Paged feed for one domain | area + sort in the query key and body |

Sort defaulting lives in `discover.ts` as an exported pure function, mirroring `resolveSort` in the signals-search plan, so it is unit-testable without a route.

---

## Task 1: `/discover` schema — `sort`, ordering centre, `sort_applied`

**Files:**
- Modify: `packages/schemas/src/api/discover_schemas.ts`
- Test: `packages/schemas/src/api/__tests__/discover_schemas.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const DiscoverSortSchema: z.ZodEnum<['relevance','newest','nearest']>;
  export type DiscoverSort = 'relevance' | 'newest' | 'nearest';
  // DiscoverItemsBodySchema gains: sort?, ordering_latitude?, ordering_longitude?
  // DiscoverResponseSchema.meta gains: sort_applied (required)
  ```
  Consumed by Tasks 2, 3 and the UI plan.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DiscoverItemsBodySchema, DiscoverResponseSchema } from '../discover_schemas';

const base = { item_network: 'purple_dot', item_domain: 'provider', item_type: 'profile_1.0' };

describe('DiscoverItemsBodySchema — sort (contract §5)', () => {
  it('accepts each sort value', () => {
    for (const sort of ['relevance', 'newest', 'nearest'] as const) {
      expect(DiscoverItemsBodySchema.safeParse({ ...base, sort }).success).toBe(true);
    }
  });

  it('rejects an unknown sort', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, sort: 'cheapest' }).success).toBe(false);
  });

  it('treats sort as optional — the server defaults it', () => {
    expect(DiscoverItemsBodySchema.safeParse(base).success).toBe(true);
  });
});

describe('DiscoverItemsBodySchema — ordering centre is separate from the area filter', () => {
  it('accepts an ordering centre with NO area filter (nearest + anywhere)', () => {
    const r = DiscoverItemsBodySchema.safeParse({
      ...base, sort: 'nearest', ordering_latitude: 12.97, ordering_longitude: 77.59,
    });
    expect(r.success).toBe(true);
  });

  it('requires ordering lat/lng together', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, ordering_latitude: 12.97 }).success).toBe(false);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, ordering_longitude: 77.59 }).success).toBe(false);
  });

  it('still requires item lat/lng together (existing rule intact)', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 12.97 }).success).toBe(false);
  });

  it('accepts both centres at once (area filter + ordering centre)', () => {
    const r = DiscoverItemsBodySchema.safeParse({
      ...base, sort: 'nearest',
      item_latitude: 12.97, item_longitude: 77.59, distance_meters: 25000,
      ordering_latitude: 12.97, ordering_longitude: 77.59,
    });
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range ordering coordinates', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, ordering_latitude: 99, ordering_longitude: 0 }).success).toBe(false);
  });
});

describe('DiscoverResponseSchema — sort_applied (contract §6)', () => {
  const meta = { total: 0, limit: 20, offset: 0, source: 'signals_search' as const, degraded: false };

  it('requires sort_applied', () => {
    expect(DiscoverResponseSchema.safeParse({ meta, items: [] }).success).toBe(false);
    expect(DiscoverResponseSchema.safeParse({ meta: { ...meta, sort_applied: 'newest' }, items: [] }).success).toBe(true);
  });

  it('keeps distance_meters optional — absent for a non-area search', () => {
    const r = DiscoverResponseSchema.safeParse({ meta: { ...meta, sort_applied: 'nearest' }, items: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.meta.distance_meters).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @dpg/schemas test -- --pool=forks --maxWorkers=2`
(If the schemas package has no test runner, put this file in `apps/api/src/routes/v1/network/item/__tests__/discover_schemas.test.ts` and run `pnpm --filter api test`.)
Expected: FAIL — `sort` stripped, ordering fields unknown, `sort_applied` not required.

- [ ] **Step 3: Implement**

In `packages/schemas/src/api/discover_schemas.ts`, add above `DiscoverItemsBodyBase`:

```ts
/**
 * Explicit list ordering (#644). Optional on the wire — the BFF defaults it
 * (`relevance` when an anchor is sent, else `newest`) and always reports what
 * it actually applied via `meta.sort_applied`, so the UI can never claim an
 * order it did not get.
 */
export const DiscoverSortSchema = z.enum(['relevance', 'newest', 'nearest']);
export type DiscoverSort = z.infer<typeof DiscoverSortSchema>;
```

Add to `DiscoverItemsBodyBase`:

```ts
  sort: DiscoverSortSchema.optional(),
  /**
   * Ordering centre for `sort: 'nearest'` — DISTINCT from the area filter
   * (`item_latitude`/`item_longitude`/`distance_meters`) above. Sending only
   * these two orders the whole network nearest-first WITHOUT bounding the
   * candidate set, which is the capability #644 needs: location may sort, but
   * must not truncate.
   */
  ordering_latitude: z.number().min(-90).max(90).optional(),
  ordering_longitude: z.number().min(-180).max(180).optional(),
```

Also narrow the doc comment on the three existing area fields:

```ts
  // AREA FILTER (opt-in, #644). Sent ONLY in `radius` area mode; the default
  // `anywhere` mode sends none of the three, so no spatial clause is built and
  // the list spans the whole network. There is no `area_mode` field — absence
  // IS `anywhere`.
  item_latitude: z.number().min(-90).max(90).optional(),
  item_longitude: z.number().min(-180).max(180).optional(),
  distance_meters: z.number().positive().optional(),
```

Extend the refine chain (keep the existing one, add a second):

```ts
export const DiscoverItemsBodySchema = DiscoverItemsBodyBase
  .refine(
    (data) => (data.item_latitude === undefined) === (data.item_longitude === undefined),
    { message: 'item_latitude and item_longitude must be provided together', path: ['item_longitude'] }
  )
  .refine(
    (data) => (data.ordering_latitude === undefined) === (data.ordering_longitude === undefined),
    { message: 'ordering_latitude and ordering_longitude must be provided together', path: ['ordering_longitude'] }
  );
```

In `DiscoverResponseSchema`'s `meta`, update `distance_meters`'s comment and add the new field:

```ts
    // Effective spatial radius actually applied. Present ONLY when the request
    // carried an AREA FILTER (item_latitude/item_longitude). An ordering centre
    // alone must NOT set this — it bounds nothing, so reporting a radius would
    // be a lie. Absent otherwise, and `resolveListNote` already degrades
    // correctly when it is.
    distance_meters: z.number().optional(),
    /** The order actually applied, after the BFF's defaulting and fallbacks. */
    sort_applied: DiscoverSortSchema,
```

- [ ] **Step 4: Run to confirm pass**

Run: the same command as Step 2. Expected: PASS.

- [ ] **Step 5: Regenerate the OpenAPI artifact**

The repo commits a generated `openapi.json` (see the merged PR "regenerate openapi.json"). Regenerate it, or CI will fail on drift:

```bash
pnpm --filter api build && pnpm --filter api exec node scripts/generate-openapi.mjs 2>/dev/null || true
git status --short   # commit any regenerated artifact
```
If no such script exists, check how `openapi.json` is produced and follow that path. **Do not hand-edit it.**

- [ ] **Step 6: Commit**

```bash
git add packages/schemas apps/api
git commit -m "feat(discover): add sort, an ordering centre distinct from the area filter, and meta.sort_applied"
```

---

## Task 2: Search client — `sort` and `orderingCenter` in the envelope

**Files:**
- Modify: `apps/api/src/services/signals_search_client.ts`
- Test: `apps/api/src/services/__tests__/signals_search_client.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `DiscoverSort` (Task 1).
- Produces:
  ```ts
  export interface SearchSignalsInput {
    // ...existing
    sort?: DiscoverSort;
    orderingLat?: number;
    orderingLng?: number;
  }
  // buildSignalsSearchRequest emits intent.sort and intent.orderingCenter
  ```
  Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildSignalsSearchRequest } from '../signals_search_client';

const base = { network: 'purple_dot', domain: 'provider', itemType: 'profile_1.0', limit: 20, offset: 0 };

describe('buildSignalsSearchRequest — sort + ordering centre (contract §1, §5.1)', () => {
  it('places sort INSIDE intent, so the upstream cache key covers it', () => {
    const req = buildSignalsSearchRequest({ ...base, sort: 'nearest' });
    expect(req.message.intent.sort).toBe('nearest');
    // Placement guard: NOT on message beside pagination.
    expect((req.message as Record<string, unknown>).sort).toBeUndefined();
  });

  it('omits sort entirely when not supplied (backward compatible)', () => {
    const req = buildSignalsSearchRequest(base);
    expect('sort' in req.message.intent).toBe(false);
  });

  it('emits orderingCenter as GeoJSON [lng, lat]', () => {
    const req = buildSignalsSearchRequest({ ...base, sort: 'nearest', orderingLat: 12.97, orderingLng: 77.59 });
    expect(req.message.intent.orderingCenter).toEqual({ type: 'Point', coordinates: [77.59, 12.97] });
  });

  it('builds NO spatial clause for an ordering centre alone — nearest must not filter', () => {
    const req = buildSignalsSearchRequest({ ...base, sort: 'nearest', orderingLat: 12.97, orderingLng: 77.59 });
    expect(req.message.intent.spatial).toBeUndefined();
  });

  it('still builds a spatial clause for an area filter', () => {
    const req = buildSignalsSearchRequest({ ...base, lat: 12.97, lng: 77.59, distanceMeters: 25000 });
    expect(req.message.intent.spatial).toEqual([
      { op: 's_dwithin', geometry: { type: 'Point', coordinates: [77.59, 12.97] }, distanceMeters: 25000 },
    ]);
  });

  it('carries both centres independently when both are supplied', () => {
    const req = buildSignalsSearchRequest({
      ...base, sort: 'nearest', lat: 1, lng: 2, distanceMeters: 500, orderingLat: 3, orderingLng: 4,
    });
    expect(req.message.intent.spatial?.[0].geometry.coordinates).toEqual([2, 1]);
    expect(req.message.intent.orderingCenter?.coordinates).toEqual([4, 3]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter api test signals_search_client -- --pool=forks --maxWorkers=2`
Expected: FAIL — unknown input keys; `intent.sort` / `intent.orderingCenter` undefined.

- [ ] **Step 3: Implement**

Add to `SearchSignalsInput`:

```ts
  /**
   * Explicit ordering, forwarded as `intent.sort`. Omitted entirely when
   * undefined so signals-search keeps its historical inferred behaviour.
   */
  sort?: DiscoverSort;
  /**
   * Ordering centre → `intent.orderingCenter`. Orders only; produces NO
   * spatial clause. Distinct from `lat`/`lng` above, which DO filter.
   */
  orderingLat?: number;
  orderingLng?: number;
```

Add to the request Zod schema, inside `message.intent`:

```ts
      textSearch: z.string().optional(),
      filters: z.array(SignalsSearchFilterClauseSchema).optional(),
      spatial: z.array(SignalsSearchSpatialClauseSchema).max(1).optional(),
      item: z.object({ id: z.string() }).optional(),
      sort: z.enum(['relevance', 'newest', 'nearest']).optional(),
      orderingCenter: z
        .object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) })
        .optional(),
```

Add a builder beside `buildSpatialClause`:

```ts
// Ordering centre → GeoJSON Point. Deliberately separate from
// buildSpatialClause: this one must NEVER become an s_dwithin clause, or
// `sort: 'nearest'` would silently truncate the candidate set (#644).
function buildOrderingCenter(input: SearchSignalsInput) {
  if (input.orderingLat === undefined || input.orderingLng === undefined) return undefined;
  return { type: 'Point' as const, coordinates: [input.orderingLng, input.orderingLat] as [number, number] };
}
```

In `buildSignalsSearchRequest`, add to the `intent` spread:

```ts
        ...(input.sort ? { sort: input.sort } : {}),
        ...(orderingCenter ? { orderingCenter } : {}),
```
with `const orderingCenter = buildOrderingCenter(input);` next to the existing `const spatial = ...`.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter api test signals_search_client -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services
git commit -m "feat(discover): forward sort and an order-only centre into the search envelope"
```

---

## Task 3: `/discover` handler — default, gate, report

The behavioural heart of the plan. This is where the 30 km bug actually dies.

**Files:**
- Modify: `apps/api/src/routes/v1/network/item/discover.ts`
- Test: `apps/api/src/routes/v1/network/item/__tests__/discover.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1, 2.
- Produces:
  ```ts
  export function resolveDiscoverSort(input: {
    requested?: DiscoverSort; hasAnchor: boolean; hasQ: boolean; hasOrderingCenter: boolean;
  }): DiscoverSort;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDiscoverSort } from '../discover';

const base = { hasAnchor: false, hasQ: false, hasOrderingCenter: false };

describe('resolveDiscoverSort (contract §5.2)', () => {
  it('defaults to relevance when an anchor is sent', () => {
    expect(resolveDiscoverSort({ ...base, hasAnchor: true })).toBe('relevance');
  });
  it('defaults to newest with no anchor', () => {
    expect(resolveDiscoverSort(base)).toBe('newest');
  });
  it('falls back to newest for relevance with neither anchor nor q', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'relevance' })).toBe('newest');
  });
  it('honours relevance when q is present without an anchor', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'relevance', hasQ: true })).toBe('relevance');
  });
  it('falls back to newest for nearest with no ordering centre', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'nearest' })).toBe('newest');
  });
  it('honours nearest with an ordering centre', () => {
    expect(resolveDiscoverSort({ ...base, requested: 'nearest', hasOrderingCenter: true })).toBe('nearest');
  });
});
```

Then the route-level cases. Follow the existing mocking style in `discover.test.ts` (it already mocks `@/services/signals_search_client`):

```ts
describe('/discover — area is opt-in (#644)', () => {
  it('sends NO spatial clause and NO distance_meters when no area is requested', async () => {
    const spy = vi.mocked(searchSignals).mockResolvedValue({ items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' } });
    const res = await app.inject({ method: 'POST', url: '/v1/network/item/discover', payload: { ...body } });
    expect(res.statusCode).toBe(200);

    const sent = spy.mock.calls[0][0];
    expect(sent.lat).toBeUndefined();
    expect(sent.lng).toBeUndefined();
    expect(sent.distanceMeters).toBeUndefined();      // env fallback must NOT apply
    expect(res.json().meta.distance_meters).toBeUndefined();
  });

  it('does NOT report distance_meters for an ordering centre alone', async () => {
    vi.mocked(searchSignals).mockResolvedValue({ items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'nearest' } });
    const res = await app.inject({ method: 'POST', url: '/v1/network/item/discover',
      payload: { ...body, sort: 'nearest', ordering_latitude: 12.97, ordering_longitude: 77.59 } });
    expect(res.json().meta.distance_meters).toBeUndefined();
    expect(res.json().meta.sort_applied).toBe('nearest');
  });

  it('DOES send and report a radius in radius mode', async () => {
    const spy = vi.mocked(searchSignals).mockResolvedValue({ items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'nearest' } });
    const res = await app.inject({ method: 'POST', url: '/v1/network/item/discover',
      payload: { ...body, item_latitude: 12.97, item_longitude: 77.59, distance_meters: 25000 } });
    expect(spy.mock.calls[0][0].distanceMeters).toBe(25000);
    expect(res.json().meta.distance_meters).toBe(25000);
  });

  it('passes signals-search meta.sort_applied straight through', async () => {
    vi.mocked(searchSignals).mockResolvedValue({ items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' } });
    const res = await app.inject({ method: 'POST', url: '/v1/network/item/discover',
      payload: { ...body, sort: 'relevance' } });   // no anchor → upstream reports newest
    expect(res.json().meta.sort_applied).toBe('newest');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter api test discover -- --pool=forks --maxWorkers=2`
Expected: FAIL — `resolveDiscoverSort` missing; `distanceMeters` is still sent from the env fallback; `sort_applied` absent.

- [ ] **Step 3: Implement the resolver**

Add to `discover.ts` above the handler:

```ts
/**
 * Default and validate the requested order (contract §5.2). Exported and pure
 * so the decision table is testable without a route. Mirrors `resolveSort` in
 * signals-search — kept as two small functions rather than a shared package
 * because the two repos deploy independently and must not couple on it.
 *
 * Never errors: an unsatisfiable sort degrades to `newest`, and the response
 * reports what was actually used.
 */
export function resolveDiscoverSort(input: {
  requested?: DiscoverSort;
  hasAnchor: boolean;
  hasQ: boolean;
  hasOrderingCenter: boolean;
}): DiscoverSort {
  if (input.requested === 'relevance') {
    return input.hasAnchor || input.hasQ ? 'relevance' : 'newest';
  }
  if (input.requested === 'nearest') {
    return input.hasOrderingCenter ? 'nearest' : 'newest';
  }
  if (input.requested === 'newest') return 'newest';
  return input.hasAnchor ? 'relevance' : 'newest';
}
```

- [ ] **Step 4: Gate the spatial clause and the radius on area mode**

Replace the `searchInput` / `effectiveDistanceMeters` block (`discover.ts:183-208`):

```ts
    // AREA FILTER, opt-in (#644). Present only when the client explicitly
    // asked for `radius` mode. In the default `anywhere` mode all three fields
    // are absent, so no spatial clause is built and — critically — the
    // SIGNALS_SEARCH_DISTANCE_METERS env fallback does NOT apply. Before this
    // change the UI always forwarded the viewer's location, which silently
    // bounded every signed-in list to ~30 km with no opt-out.
    const hasAreaFilter =
      body.item_latitude !== undefined && body.item_longitude !== undefined;

    // Effective radius: only meaningful when an area filter exists. Precedence
    // request override > configured env > the constant mirroring
    // signals-search's own default.
    const effectiveDistanceMeters = hasAreaFilter
      ? (body.distance_meters ??
         signalsSearchConfig.distanceMeters ??
         DEFAULT_SEARCH_DISTANCE_METERS)
      : undefined;

    // ORDERING centre — orders without filtering. Never sets a radius and
    // never sets meta.distance_meters.
    const hasOrderingCenter =
      body.ordering_latitude !== undefined && body.ordering_longitude !== undefined;

    const sortApplied = resolveDiscoverSort({
      requested: body.sort,
      hasAnchor: body.anchor_item_id !== undefined,
      hasQ: body.q !== undefined,
      hasOrderingCenter: hasOrderingCenter || hasAreaFilter,
    });

    const searchInput: SearchSignalsInput = {
      network: body.item_network,
      domain: body.item_domain,
      itemType: body.item_type,
      q: body.q,
      filters: allowedFilters,
      ...(hasAreaFilter
        ? {
            lat: body.item_latitude,
            lng: body.item_longitude,
            distanceMeters: effectiveDistanceMeters,
          }
        : {}),
      ...(hasOrderingCenter
        ? { orderingLat: body.ordering_latitude, orderingLng: body.ordering_longitude }
        : {}),
      sort: sortApplied,
      limit: body.limit,
      offset: body.offset,
      anchorItemId: body.anchor_item_id,
    };
```

- [ ] **Step 5: Report the applied sort on all four return paths**

There are **four** 200-responses in this handler: signals-search success, the anchor-retry success, the native fallback, and (verify) any other. Each `meta` gains `sort_applied`.

For the two signals-search paths, prefer the upstream's own value and fall back to ours:

```ts
          sort_applied: searchResult.meta.sort_applied ?? sortApplied,
```

For the native fallback (contract §7 — `relevance` is unavailable without ranking):

```ts
          sort_applied: sortApplied === 'relevance' ? 'newest' : sortApplied,
```

Also widen `SignalsSearchResponseSchema`'s `meta` in the client to accept the new upstream field:

```ts
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      // Optional here (not required) so this BFF keeps working against a
      // signals-search deployed BEFORE its sort PR — the two repos ship
      // independently and this one may reach production first.
      sort_applied: z.enum(['relevance', 'newest', 'nearest']).optional(),
    }),
```

> This optionality is deliberate and important: it is what lets the two PRs merge in either order without an outage.

- [ ] **Step 6: Teach the native fallback the sorts**

In the `fallBackToNative` call to `fetchItemsAcrossInstances`, replace the location fields:

```ts
        // Native ordering (contract §7). buildDistanceOrderBy keys off lat/lng
        // ONLY, and buildWhereClause adds a radius clause only when lat, lng
        // AND radius_meters are all present (item_fetch_runtime.ts:328-332).
        // So: `newest` sends no coordinates → created_at DESC. `nearest` sends
        // coordinates with NO radius → distance-ordered and unbounded.
        // `relevance` has no native equivalent and behaves as `newest`.
        ...(sortApplied === 'nearest'
          ? {
              item_latitude: body.ordering_latitude ?? body.item_latitude,
              item_longitude: body.ordering_longitude ?? body.item_longitude,
              radius_meters: effectiveDistanceMeters,   // undefined unless an area filter exists
            }
          : hasAreaFilter
            ? {
                item_latitude: body.item_latitude,
                item_longitude: body.item_longitude,
                radius_meters: effectiveDistanceMeters,
              }
            : {}),
```

- [ ] **Step 7: Run to confirm pass**

Run: `pnpm --filter api test discover -- --pool=forks --maxWorkers=2`
Expected: PASS. Existing `discover.test.ts` cases that assert `distanceMeters` was sent for a bare lat/lng request now legitimately change — update those assertions to reflect the new opt-in semantics, and **add a comment** on each saying the old expectation encoded the #644 bug.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/v1/network/item/discover.ts apps/api/src/services/signals_search_client.ts apps/api/src/routes/v1/network/item/__tests__
git commit -m "fix(discover): make the area filter opt-in, default and report the sort, teach the native fallback both orders"
```

---

## Task 4: `item_id` tiebreaker on the native path (P1, second half)

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts:463-480`
- Test: `apps/api/src/utils/__tests__/item_fetch_runtime.integration.test.ts` (extend)

**Interfaces:** no signature change.

- [ ] **Step 1: Write the failing test**

```ts
describe('buildDistanceOrderBy — deterministic paging over tied keys (P1)', () => {
  it('partitions tied rows across pages with no duplicates or omissions', async () => {
    // Six live rows sharing one created_at and no locations, so both order
    // branches hit the tie. Same defect as signals-search: each page is an
    // independent query, so a tie group can rearrange between them.
    const ids = await seedTiedItems(6, '2026-01-15T10:00:00Z');

    const p1 = await fetchLocalItems({ ...filters, limit: 3, offset: 0, lifecycle_filter: 'live_only' });
    const p2 = await fetchLocalItems({ ...filters, limit: 3, offset: 3, lifecycle_filter: 'live_only' });

    const union = [...p1.items, ...p2.items].map((i) => i.item_id);
    expect(new Set(union).size).toBe(6);
    expect([...union].sort()).toEqual([...ids].sort());
  });

  it('is stable across identical repeated queries', async () => {
    const a = await fetchLocalItems({ ...filters, limit: 3, offset: 0, lifecycle_filter: 'live_only' });
    const b = await fetchLocalItems({ ...filters, limit: 3, offset: 0, lifecycle_filter: 'live_only' });
    expect(a.items.map((i) => i.item_id)).toEqual(b.items.map((i) => i.item_id));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter api test:integration item_fetch_runtime -- --pool=forks --maxWorkers=2`
Expected: FAIL on the partition assertion. If it passes at six rows, raise to ~200 tied rows with `limit: 20` — the drift is provable from the SQL and appears reliably at that size.

- [ ] **Step 3: Implement**

```ts
/**
 * §4.1/§4.3 shared ORDER BY: nearest-first when a lat/lng center is present
 * (ties broken by created_at DESC; no-location rows sort last), otherwise
 * plain created_at DESC. Shared by fetchLocalItems and fetchLocalMarkers so
 * the ordering behavior can never drift between the two projections.
 *
 * Every branch ends with `item_id ASC` (#644 P1). Without a unique final key,
 * SQL leaves tied rows unordered and — because each page is an independent
 * query execution — a tie group can arrange differently between page N and
 * page N+1, so rows appear twice while others are never returned. Common here:
 * a bulk import writes many rows with the same created_at.
 */
function buildDistanceOrderBy(
  filters: Pick<ItemFetchFilters, 'item_latitude' | 'item_longitude'>
) {
  return filters.item_latitude !== undefined && filters.item_longitude !== undefined
    ? sql`
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
      `
    : sql`${items.created_at} DESC, ${items.item_id} ASC`;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter api test:integration item_fetch_runtime -- --pool=forks --maxWorkers=2`
Expected: PASS. Then run the full API suite — `fetchLocalMarkers` shares this helper, so marker-ordering tests are affected too:
`pnpm --filter api test -- --pool=forks --maxWorkers=2`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils
git commit -m "fix(api): append item_id tiebreaker to the native browse ordering so paging cannot duplicate or skip rows"
```

---

## Task 5: `browse-discover.ts` — `BrowseArea` and `sort`

**Files:**
- Modify: `apps/ui/src/lib/browse-discover.ts`
- Test: `apps/ui/src/lib/browse-discover.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type BrowseArea =
    | { mode: 'anywhere' }
    | { mode: 'radius'; center: { lat: number; lng: number }; meters: number };
  export type BrowseSort = 'relevance' | 'newest' | 'nearest';
  export const DEFAULT_BROWSE_AREA: BrowseArea;   // { mode: 'anywhere' }
  export interface DerivedBrowseParams {
    relevance: true; q?: string; filters: DiscoverFacetFilter[];
    area: BrowseArea; sort: BrowseSort;
  }
  export function deriveBrowseParams(input: {
    search: string; activeFieldFilters: Record<string, string[]>;
    area?: BrowseArea; sort?: BrowseSort;
  }): DerivedBrowseParams;
  ```
  Consumed by Task 6 and the UI plan.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { deriveBrowseParams, DEFAULT_BROWSE_AREA } from '../browse-discover';

describe('deriveBrowseParams — area defaults to anywhere (#644)', () => {
  it('defaults to anywhere when no area is given', () => {
    const p = deriveBrowseParams({ search: '', activeFieldFilters: {} });
    expect(p.area).toEqual({ mode: 'anywhere' });
    expect(DEFAULT_BROWSE_AREA).toEqual({ mode: 'anywhere' });
  });

  it('passes a radius area through unchanged', () => {
    const area = { mode: 'radius' as const, center: { lat: 12.97, lng: 77.59 }, meters: 25000 };
    expect(deriveBrowseParams({ search: '', activeFieldFilters: {}, area }).area).toEqual(area);
  });

  it('defaults sort to relevance (the hook has the anchor context to refine it)', () => {
    expect(deriveBrowseParams({ search: '', activeFieldFilters: {} }).sort).toBe('relevance');
  });

  it('passes an explicit sort through', () => {
    expect(deriveBrowseParams({ search: '', activeFieldFilters: {}, sort: 'newest' }).sort).toBe('newest');
  });

  it('still maps search text and facets as before', () => {
    const p = deriveBrowseParams({ search: '  solar  ', activeFieldFilters: { sector: ['energy'] } });
    expect(p.q).toBe('solar');
    expect(p.filters).toEqual([{ field: 'sector', values: ['energy'] }]);
  });

  it('omits q when the search box is blank', () => {
    expect(deriveBrowseParams({ search: '   ', activeFieldFilters: {} }).q).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test browse-discover -- --pool=forks --maxWorkers=2`
Expected: FAIL — `area` / `sort` undefined, `DEFAULT_BROWSE_AREA` not exported.

- [ ] **Step 3: Implement**

Replace the module's stale header comment (`browse-discover.ts:6-25`) — it currently documents the 30 km bound as intended-with-known-gap, which this change fixes:

```ts
// ─── Search box + facets → discover params ──────────────────────────────────
//
// Maps the LIST view's search box, facet selections, area choice and sort to
// the `useInfiniteBrowseItems` opts.
//
// #644: the list is NO LONGER location-bounded by default. Previously the page
// forwarded the resolved viewer location unconditionally, and signals-search
// treats a spatial clause as a HARD `s_dwithin` filter, so every signed-in
// viewer silently saw only items within ~30 km with no opt-out. Now:
//
//   - `area` defaults to `{ mode: 'anywhere' }` and sends NO coordinates, so
//     the list spans the whole network — its original requirement.
//   - `radius` is opt-in and explicit; the viewer's location is merely the
//     default CENTRE OFFERED, not an implicit filter.
//   - `sort: 'nearest'` orders by distance via a separate ORDERING CENTRE that
//     bounds nothing, so location may sort without truncating.
//
// `relevance: true` stays a field because `useInfiniteBrowseItems` /
// `isDiscoverActive` key off it as one of three ways to activate discover.
export type BrowseSort = 'relevance' | 'newest' | 'nearest';

export type BrowseArea =
  | { mode: 'anywhere' }
  | { mode: 'radius'; center: { lat: number; lng: number }; meters: number };

/** Exported so the page and its tests share one source of truth for the default. */
export const DEFAULT_BROWSE_AREA: BrowseArea = { mode: 'anywhere' };

export interface DeriveBrowseParamsInput {
  search: string;
  activeFieldFilters: Record<string, string[]>;
  area?: BrowseArea;
  sort?: BrowseSort;
}

export interface DerivedBrowseParams {
  relevance: true;
  q?: string;
  filters: DiscoverFacetFilter[];
  area: BrowseArea;
  sort: BrowseSort;
}

export function deriveBrowseParams(input: DeriveBrowseParamsInput): DerivedBrowseParams {
  const q = input.search.trim();
  const filters: DiscoverFacetFilter[] = Object.entries(input.activeFieldFilters).map(
    ([field, values]) => ({ field, values }),
  );
  return {
    relevance: true,
    ...(q ? { q } : {}),
    filters,
    area: input.area ?? DEFAULT_BROWSE_AREA,
    // `relevance` is the UI default; the BFF downgrades it to `newest` when
    // there is no anchor and no q, and reports what it applied.
    sort: input.sort ?? 'relevance',
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test browse-discover -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/browse-discover.ts apps/ui/src/lib/browse-discover.test.ts
git commit -m "feat(ui): area defaults to anywhere and sort becomes explicit in the browse params"
```

---

## Task 6: `use-infinite-browse-items` — area + sort in the key and body

**Files:**
- Modify: `apps/ui/src/hooks/use-infinite-browse-items.ts`
- Test: `apps/ui/src/hooks/use-infinite-browse-items.test.tsx` (extend)

**Interfaces:**
- Consumes: `BrowseArea`, `BrowseSort` (Task 5).
- Produces: `opts.area`, `opts.sort`; result gains `sortApplied: BrowseSort`.
  The `userLocation` positional argument becomes **ordering-centre-only**.

- [ ] **Step 1: Write the failing test**

```ts
describe('useInfiniteBrowseItems — location no longer filters (#644)', () => {
  it('sends NO coordinates when area is anywhere, even with a resolved location', async () => {
    const spy = vi.mocked(fetchDiscover).mockResolvedValue(emptyPage);
    renderHook(() => useInfiniteBrowseItems(network, domain, { lat: 12.97, lng: 77.59 }, {
      relevance: true, area: { mode: 'anywhere' }, sort: 'relevance',
    }), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const body = spy.mock.calls[0][0];
    expect(body.item_latitude).toBeUndefined();
    expect(body.item_longitude).toBeUndefined();
    expect(body.distance_meters).toBeUndefined();
  });

  it('sends the area filter in radius mode', async () => {
    const spy = vi.mocked(fetchDiscover).mockResolvedValue(emptyPage);
    renderHook(() => useInfiniteBrowseItems(network, domain, null, {
      relevance: true, sort: 'relevance',
      area: { mode: 'radius', center: { lat: 12.97, lng: 77.59 }, meters: 25000 },
    }), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const body = spy.mock.calls[0][0];
    expect(body.item_latitude).toBe(12.97);
    expect(body.item_longitude).toBe(77.59);
    expect(body.distance_meters).toBe(25000);
  });

  it('sends the viewer location as an ORDERING centre for nearest + anywhere', async () => {
    const spy = vi.mocked(fetchDiscover).mockResolvedValue(emptyPage);
    renderHook(() => useInfiniteBrowseItems(network, domain, { lat: 12.97, lng: 77.59 }, {
      relevance: true, area: { mode: 'anywhere' }, sort: 'nearest',
    }), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const body = spy.mock.calls[0][0];
    expect(body.ordering_latitude).toBe(12.97);
    expect(body.ordering_longitude).toBe(77.59);
    expect(body.item_latitude).toBeUndefined();   // orders, does not filter
  });

  it('changing sort resets paging (new query key)', async () => {
    const spy = vi.mocked(fetchDiscover).mockResolvedValue(emptyPage);
    const { rerender } = renderHook(
      ({ sort }) => useInfiniteBrowseItems(network, domain, null, { relevance: true, sort, area: { mode: 'anywhere' } }),
      { wrapper, initialProps: { sort: 'relevance' as const } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ sort: 'newest' as const });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0].offset).toBe(0);
  });

  it('changing area resets paging', async () => {
    const spy = vi.mocked(fetchDiscover).mockResolvedValue(emptyPage);
    const { rerender } = renderHook(
      ({ area }) => useInfiniteBrowseItems(network, domain, null, { relevance: true, sort: 'relevance', area }),
      { wrapper, initialProps: { area: { mode: 'anywhere' } as BrowseArea } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ area: { mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 } });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('surfaces meta.sort_applied', async () => {
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [], meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'newest' },
    });
    const { result } = renderHook(() => useInfiniteBrowseItems(network, domain, null, {
      relevance: true, sort: 'relevance', area: { mode: 'anywhere' },
    }), { wrapper });
    await waitFor(() => expect(result.current.sortApplied).toBe('newest'));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test use-infinite-browse-items -- --pool=forks --maxWorkers=2`
Expected: FAIL — coordinates still sent unconditionally (that is the bug); `ordering_*` unknown; `sortApplied` undefined.

- [ ] **Step 3: Implement**

Add to `UseInfiniteBrowseItemsOpts`:

```ts
  /**
   * Area filter. Defaults to `{ mode: 'anywhere' }` (#644) — the list is not
   * location-bounded unless the user explicitly asks. `anywhere` sends no
   * coordinates at all.
   */
  area?: BrowseArea;
  /** Explicit ordering. Part of the query key: changing it resets paging. */
  sort?: BrowseSort;
```

Add to `UseInfiniteBrowseItemsResult`:

```ts
  /**
   * The order the SERVER actually applied (`meta.sort_applied`), which can
   * differ from what was requested — e.g. `relevance` with no anchor and no
   * text degrades to `newest`. The UI must label from THIS, never from the
   * requested value, or it will claim an order it did not get.
   */
  sortApplied?: BrowseSort;
```

Add it to `BrowsePage['meta']` too, then:

```ts
  const area = opts?.area ?? DEFAULT_BROWSE_AREA;
  const sort = opts?.sort ?? 'relevance';

  // The AREA FILTER's centre — only in radius mode.
  const areaFilter = area.mode === 'radius'
    ? { item_latitude: area.center.lat, item_longitude: area.center.lng, distance_meters: area.meters }
    : undefined;

  // The ORDERING centre — only for `nearest`, and only when the area filter
  // has not already supplied one (signals-search reuses the filter's centre).
  // This is what keeps "location may sort" separate from "location filters".
  const orderingCenter = sort === 'nearest' && !areaFilter && userLocation
    ? { ordering_latitude: userLocation.lat, ordering_longitude: userLocation.lng }
    : undefined;
```

Replace `filterKey` — note `lat`/`lng` must leave the key, since a resolved location no longer affects a `relevance` or `newest` discover request and would otherwise cause needless refetches:

```ts
  const filterKey = {
    limit: PROFILE_PAGE_SIZE,
    mode: useDiscover ? ('discover' as const) : ('native' as const),
    q,
    filters,
    // Only the coordinates that actually reach the request belong in the key.
    ...(useDiscover
      ? { area, sort, anchorItemId: anchorItemId ?? null, ordering: orderingCenter ?? null }
      : { lat: userLocation?.lat ?? null, lng: userLocation?.lng ?? null }),
  };
```

Replace the discover request body's location spread (`:148-150`):

```ts
            ...(areaFilter ?? {}),
            ...(orderingCenter ?? {}),
            sort,
```

And carry the field through the page mapping and the return:

```ts
            sortApplied: res.meta.sort_applied,
```
```ts
    // Not sticky: it is a property of the current request, so the latest
    // loaded page's value is the correct one to surface (same reasoning as
    // distanceMeters).
    sortApplied: lastPage?.meta.sortApplied,
```

> The **native** branch keeps forwarding `userLocation` unchanged — plain proximity browse is a different feature and is not in #644's scope.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test use-infinite-browse-items -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Expect callers to break — that is correct**

`home-page.tsx` still passes the old opts shape. `pnpm typecheck` will fail there. **Leave it failing** — Task 7 of the UI plan rewrites those call sites. Note the failure in your commit message so the next executor is not surprised.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/hooks/use-infinite-browse-items.ts apps/ui/src/hooks/use-infinite-browse-items.test.tsx
git commit -m "feat(ui): area and sort drive the discover request; a resolved location no longer filters the list

home-page.tsx call sites are intentionally left un-migrated; the UI plan's
All-tab removal rewrites them."
```

---

## Task 7: Cross-repo contract fixture

**Files:**
- Test: `apps/api/src/services/__tests__/signals_search_client.test.ts` (extend)

- [ ] **Step 1: Write the fixture (contract §9)**

The same assertion the signals-search plan makes independently, so a divergence fails a test rather than a deploy:

```ts
describe('cross-repo contract fixture (wire-contract §9)', () => {
  it('anchor + text + nearest + orderingCenter produces exactly the contracted envelope', () => {
    const req = buildSignalsSearchRequest({
      network: 'purple_dot', domain: 'provider', itemType: 'profile_1.0',
      limit: 20, offset: 0,
      anchorItemId: '00000000-0000-4000-8000-0000000000aa',
      q: 'solar',
      sort: 'nearest',
      orderingLat: 12.97, orderingLng: 77.59,
    });

    expect(req.message.intent).toMatchObject({
      item: { id: '00000000-0000-4000-8000-0000000000aa' },
      textSearch: 'solar',
      sort: 'nearest',
      orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] },
    });
    // The load-bearing assertion: ordering by location must NOT filter.
    expect(req.message.intent.spatial).toBeUndefined();
    // And placement must keep the upstream cache key correct.
    expect((req.message as Record<string, unknown>).sort).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter api test signals_search_client -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 3: Full backend verification**

```bash
pnpm --filter api test -- --pool=forks --maxWorkers=2
pnpm --filter ui test -- --pool=forks --maxWorkers=2
```
Both green except the known `home-page.tsx` typecheck failure from Task 6 Step 5. **Do not** paper that over — it is resolved by the UI plan.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/__tests__
git commit -m "test(discover): cross-repo contract fixture for the sort and ordering-centre envelope"
```

---

## Self-Review

**Spec coverage** — the API/fetch half of spec §6:

| Spec item | Task |
| --- | --- |
| `sort` + area fields on the discover schema (§3.1, §3.2) | 1 |
| `sort` in the envelope; centre-without-radius (§3.2) | 2 |
| Spatial only when an area is requested (§3.1, D1/D2) | 3 |
| Area-driven `meta.distance_meters` (§3.1) | 3 |
| Report the applied sort (§3.2) | 3 |
| Native fallback learns both sorts (§3.7) | 3 |
| Native `item_id` tiebreaker (§3.4) | 4 |
| `BrowseArea`; drop always-send-location (§3.1) | 5 |
| Area + sort in the query key and body (§5 UI) | 6 |
| Cross-repo fixture (contract §9) | 7 |

Deliberately deferred to the UI plan: All-tab removal and `sortItemsByNearest` (P6), the sticky bar, the domain control, the chip bar, card metric, match-score scale + cache, the explanation panel, i18n. Deferred to signals-search: everything in that repo.

**Placeholder scan:** no TBD/TODO; every code step carries real code. Task 1 Step 5 contains a conditional command because the OpenAPI generation path is not verifiable from here — it names the constraint (do not hand-edit; find the generator) rather than inventing a script name.

**Type consistency:** `DiscoverSort` (schemas package) and `BrowseSort` (UI) are the same three-member union declared once per package boundary, matching how this monorepo already keeps UI types independent of `@dpg/schemas` internals. `BrowseArea` is declared once in `browse-discover.ts` and imported by the hook. `SearchSignalsInput` uses `lat`/`lng` for the filter and `orderingLat`/`orderingLng` for the order-only centre — deliberately different names so the two can never be confused at a call site. `resolveDiscoverSort`'s input keys (`requested`, `hasAnchor`, `hasQ`, `hasOrderingCenter`) are identical in Task 3's test and implementation; note they differ from signals-search's `resolveSort` keys (`hasText`, `hasCenter`, `hasSpatialFilter`) because the two layers know different things — that divergence is intentional, not a typo.
