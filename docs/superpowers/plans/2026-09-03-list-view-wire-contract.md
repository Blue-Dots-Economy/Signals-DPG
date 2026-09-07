# FROZEN WIRE CONTRACT — list-view sort + area (#644)

**Status:** FROZEN 2026-09-03. Do not change unilaterally.
**Spec:** `docs/superpowers/specs/2026-09-03-list-view-sort-domain-and-card-metric-design.md`
**Consumed by:** `2026-09-03-signals-search-sort-paging-text.md` (repo: signals-search)
and `2026-09-03-signals-dpg-list-view.md` (repo: Signals-DPG)

---

## Why this document exists

The two repos are being implemented **in parallel, in separate sessions**.
Signals-DPG's tests never touch a real signals-search — every test mocks the
client module or its `fetch` (`apps/api/src/services/signals_search_client.ts:6-8`).
So both halves can compile, both test suites can pass, and integration can
still fail on the dev cluster if the two sessions invent different field names.

**This file is the only shared truth.** Both plans are written against it.

> **If you are implementing either side and believe this contract is wrong:
> STOP. Do not "fix" it locally.** Report the problem, get the contract
> amended here first, and let the other session pick up the amendment. A
> unilateral change produces a green build and a broken deploy.

---

## 1. signals-search `POST /v1/search` — request

Two **new optional** fields, both inside `message.intent`.

```ts
// signals-search/src/api/schemas.ts — IntentSchema
{
  // ...existing: textSearch, item, spatial, filters

  /**
   * NEW. Explicit ordering. When ABSENT, ordering falls back to today's
   * inferred behaviour (cosine if a query vector exists, else distance if a
   * spatial clause exists, else recency) — so existing callers are unaffected.
   */
  sort?: 'relevance' | 'newest' | 'nearest';

  /**
   * NEW. A centre used ONLY for ordering. It NEVER contributes a WHERE
   * predicate. This is the capability that makes "location may sort but must
   * not truncate" expressible; `spatial` continues to filter, unchanged.
   * GeoJSON order — [lng, lat].
   */
  orderingCenter?: { type: 'Point'; coordinates: [number, number] };
}
```

### 1.1 Placement is load-bearing

Both fields **MUST** live inside `intent`, not on `message` beside
`pagination`. `cacheKey(normalized)` (`search_route.ts:64-65`) hashes
`{networkId, domain, itemType, intent, pagination}`. Inside `intent`, the cache
key is correct for free. Beside `pagination`, **two different sorts share a
cache entry.** There is a required test for this (search plan Task 2).

### 1.2 Resolution rules — normative

Applied in this order. The result is reported back as `meta.sort_applied`.

| Requested `sort` | Precondition | If met | If NOT met |
| --- | --- | --- | --- |
| `relevance` | an anchor (`intent.item.id`) **or** `textSearch` is present | cosine order | **fall back to `newest`** |
| `newest` | none | `created_at` order | n/a |
| `nearest` | a centre resolves (see 1.3) | distance order, **no radius bound** | **fall back to `newest`** |
| *absent* | — | today's inferred behaviour | n/a |

**Fallbacks never error.** A caller asking for an order it cannot have gets
`newest` and is told so via `meta.sort_applied`.

### 1.3 Centre resolution for `sort: 'nearest'`

First match wins:

1. `intent.orderingCenter.coordinates`
2. `intent.spatial[0].geometry.coordinates` — **`op: 's_dwithin'` ONLY.** A
   `bbox` clause contributes NO ordering centre (see 1.5).
3. the anchor item's own stored location (already resolved as `anchorLat` /
   `anchorLng`, `search_route.ts:58-59`)
4. none of the above → fall back to `newest`

### 1.4 `spatial` — `s_dwithin` is unchanged

The `op: 's_dwithin'` clause keeps its exact current meaning: an `ST_DWithin`
**filter**, with `distanceMeters` defaulting to
`SEARCH_DEFAULT_DISTANCE_METERS` (30 000) when omitted. Do not alter it, and do
not make `sort: 'nearest'` imply it.

### 1.5 `spatial` gains a second op: `bbox` (unfreezes 1.4 for this addition)

Added so the list can offer an EXACT "search this area" from the map viewport.
Spec D6 had dropped that mode because the only spatial op was a Point +
radius, and approximating a rectangle by its circumscribed circle is always
larger than the rectangle — the list would include items that were off the
edges of the map the user was looking at.

```
intent.spatial = [{ op: 'bbox', minLat, minLng, maxLat, maxLng }]
intent.spatial = [{ op: 's_dwithin', geometry, distanceMeters }]   // unchanged
```

- **A second `op` on the existing array, NOT a top-level `intent.bbox`.** The
  array already carries `.max(1)`, so a bbox AND a radius is two clauses and is
  rejected structurally — there is no code path where one silently wins. Both
  repos already model this exact shape (`SignalsSearchSpatialClauseSchema` with
  `op: z.literal(...)` and `.max(1)`), so it lands as a discriminated union on
  `op` with no restructuring on either side.
- **camelCase**, matching signals-search's wire convention (`textSearch`,
  `distanceMeters`, `orderingCenter`); DPG's `min_lat`/`min_lng`/`max_lat`/
  `max_lng` map straight across.
- **Named fields, not a GeoJSON `[west,south,east,north]` tuple.**
  `orderingCenter` already carries one `[lng,lat]` transposition hazard; a
  second was not worth the brevity.
- **All four bounds required.** A partial box is rejected, never defaulted —
  defaulting a side searches somewhere the caller did not ask about.
  Transposed bounds are rejected rather than silently swapped, and
  `minLng > maxLng` is rejected with an explicit "antimeridian not supported"
  message rather than returning an empty set that reads as "nothing here".
- **The anchorless-spatial refine is scoped to `s_dwithin`.** A bbox carries
  its own bounds, so it must not demand an anchor.

**Geodesic edges — why the predicate is two clauses.** A `geography` polygon's
edges are geodesics: the arc joining two corners at the same latitude bows
poleward, so the shape sits slightly north of the intended rectangle. Measured
on a 0.1° x 0.2° box at 12.9°N, a pin exactly on the southern edge fell ~2 m
OUTSIDE and was dropped, while a pin just north of the top edge was wrongly
included. Two metres is trivial next to the circumscribed circle, but it is the
SAME CLASS of error D6 rejected — the list disagreeing with the map — so it is
fixed rather than documented:

```sql
s.geo && ST_MakeEnvelope(...)::geography                 -- index prefilter
AND ST_Intersects(s.geo::geometry, ST_MakeEnvelope(...))  -- exact, planar
```

The planar test gives true rectangle semantics. The `&&` is load-bearing, not
decoration: the geometry cast alone defeats the GiST index. The prefilter's
geodetic box strictly contains the planar rectangle, so it can never exclude a
row the exact test would keep. Measured on 20 000 geo rows:

| predicate | plan | time |
| --- | --- | --- |
| as shipped | Index Scan using `item_search_geo_gist` | **0.261 ms** |
| planar alone, no prefilter | double Seq Scan | 240.8 ms |
| existing `ST_DWithin` | Bitmap Index Scan, same index | 38.6 ms |

So bbox is index-backed on the same path as the radius filter, and cheaper. It
touches only the `WHERE`; `ORDER BY` is untouched and HNSW is not involved in a
geo query at all.

**Consequence for Signals-DPG.** `bbox` filters, `orderingCenter` orders — the
two never derive from each other. So `sort: 'nearest'` scoped to a viewport
requires DPG to send `orderingCenter` (the viewport centre) ALONGSIDE the bbox;
a bbox alone degrades to `newest` per 1.3 rule 4. This is deliberate: making
the viewport midpoint a rule-2 centre would let "search this area" silently
change the user's chosen sort, re-coupling the filtering centre and the
ordering centre that #644 separated on purpose.

---

## 2. signals-search `POST /v1/search` — response

One **new field**, always present.

```ts
// signals-search/src/api/schemas.ts — SearchResponseSchema
message: {
  items: ItemResult[],
  meta: {
    total: number,
    limit: number,
    offset: number,
    /**
     * NEW, ALWAYS PRESENT. The sort that was actually applied, after the
     * §1.2 fallbacks. Present even when the request sent no `sort`, in which
     * case it names whichever inferred path ran. The UI must never claim an
     * order it did not get.
     */
    sort_applied: 'relevance' | 'newest' | 'nearest',
  }
}
```

Additive, so old callers ignore it.

### 2.1 Known imprecision on the inferred path

When no `sort` is sent, ordering stays on the historical inferred branch —
which for recency is `s.indexed_at DESC`, **not** `i.created_at DESC` (§3 keeps
it that way for backward compatibility). `sort_applied` then reports
`'newest'`, which is the only recency label the enum carries, even though the
column differs.

Accepted, not a bug to fix: Signals-DPG always sends an explicit `sort` (its
BFF defaults it via `resolveDiscoverSort` and forwards it unconditionally), so
the inferred path is reachable only by legacy callers and Raya's
`/v1/search/flat`, and no user-facing label is derived from it there. A fourth
enum value would pollute the contract for a path that is on its way out.

### 2.2 `orderingCenter` must not leak into the distance projection

`orderingCenter` may be passed into the SQL layer **only when the applied sort
is `nearest`**. Resolving it eagerly (e.g. falling back to the anchor's stored
location for every anchored search) makes the distance expression non-NULL, so
**every anchor search would start emitting `distanceMeters` on every item** —
a silent change to the response shape Signals-DPG already consumes, and it
breaks the existing "no geo → no distance" assertion in
`search_route.test.ts`.

When a spatial **filter** is present the distance projection still comes from
its centre, exactly as today. Only the ordering centre is gated.

---

## 3. signals-search `ORDER BY` — exact SQL

**AMENDED 2026-09-03** — the `relevance` clause does NOT take the tiebreaker.
See §3.1 for the measurement that forced this.

```sql
-- relevance — SINGLE KEY, no tiebreaker (see §3.1)
ORDER BY s.embedding <=> :vec ASC

-- newest   (items.created_at, NOT item_search.indexed_at — spec D5)
ORDER BY i.created_at DESC, s.item_id ASC

-- nearest  (no radius predicate is added by this sort)
ORDER BY ST_Distance(
           s.geo,
           ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
         ) ASC NULLS LAST, s.item_id ASC
```

The **inferred** (no-`sort`) paths take the tiebreaker on distance and
`s.indexed_at DESC`, and — for the same reason as above — **not** on the
inferred cosine path.

### 3.1 Why `relevance` is exempt (measured, not assumed)

Appending `, s.item_id ASC` to the cosine clause **destroys the HNSW index**.
Measured on 20 000 live rows, real 1024-dim vectors, pgvector
`vector_cosine_ops`, PG16:

| ORDER BY | Plan | Time |
| --- | --- | --- |
| `embedding <=> :vec ASC` | `Index Scan using item_search_embedding_hnsw` | **2.8 ms** |
| `embedding <=> :vec ASC, s.item_id ASC` | Seq Scan ×2 + `top-N heapsort` | **316 ms** |

115× slower, and it is a full scan of every live row — so O(corpus): ~3 s at
200 k rows, unusable at 1 M.

Confirmed architectural, not a costing accident:

- forcing off `seqscan`/`hashjoin`/`mergejoin` still yields **no HNSW path**
  (it falls back to `item_search_pkey` + full sort)
- `enable_incremental_sort = on` produces **no Incremental Sort node**
- same result with the `JOIN items` removed entirely, so the join is not the
  cause

Root cause: pgvector's HNSW scan supplies a pathkey only for the exact
single-expression ordering. A second sort key invalidates that pathkey, and
because the scan is *approximate* it cannot promise it emits complete tie
groups — so Postgres cannot legally build an incremental sort over it.

**And the tiebreaker buys almost nothing there anyway.** A cosine tie requires
byte-identical embeddings; the one real tie group is rows with
`embedding IS NULL`, which cluster at the tail. The traversal is also
**deterministic** for a fixed query vector, `ef_search` and index state, so
even tied rows come back in a stable order.

Measured: at `ef_search = 500`, five pages at offsets 0/20/40/100/200 returned
100 rows, 100 distinct ids, zero overlap between any pair — a clean partition;
and offset 100 returned a byte-identical set twice in one session and once on a
fresh connection. **Relevance paging is deterministic**; do not describe it as
inherently approximate.

### 3.2 Separate live defect: HNSW truncates silently at the default ef_search

Found while measuring the above. `hnsw.ef_search` defaults to 40 and
`hnsw.iterative_scan` to off; in that configuration the scan returns **0 rows**
past roughly `offset 60` (measured at `limit 20` over 20 500 rows: 20/20/20/0/0
at offsets 0/20/40/100/200) while `meta.total` still reports the full count.
`EXPLAIN` shows the HNSW index chosen at every offset, so nothing falls back —
the truncation is silent. Same failure shape as P2.

Fix is configuration only (pgvector 0.8.5):
`SET hnsw.iterative_scan = strict_order` returns full pages to offset 1000 with
`ef_search` left at 40.

**Not part of this contract** — no wire change — but it gates whether #644's
"page through all items" actually holds on the default `relevance` path. Scope
decision recorded in spec §3.5.

---

## 4. signals-search text predicate (#148) — exact behaviour

**AMENDED 2026-09-07** — two corrections to the original shape, both from
review. The predicate is now **tokenized**, and it applies **only when an
anchor is present**. See 4.1 for why.

`textSearch` becomes an **additional `WHERE` predicate**, ANDed with existing
conditions, applied **only when `intent.item.id` is also present.**

- The gate at `search_route.ts` no longer keys off the anchor for the QUERY
  VECTOR (`!queryVector && textSearch` — an anchor's embedding still wins), but
  the narrowing predicate itself is passed to `searchItems` **only** when an
  anchor supplied that vector.
- When an anchor IS present: the anchor's embedding remains the query vector;
  text only narrows.
- When NO anchor is present: text becomes the query vector and **RANKS ONLY —
  it does not narrow.** This is the pre-#148 behaviour on that path, restored
  deliberately (see 4.1).
- Fields matched: the `vectorize: true` set,
  `deps.registry.vectorizeFields(networkId, domain, itemType)` — the same
  content that defines semantic relevance (spec §3.3). A `private` field can
  never be in that set: `vectorizeFields` throws on one.
- `item_search` does not store serialized text, so the predicate runs against
  `i.item_state` via the existing `JOIN items i`.

Shape — **AND across whitespace-separated terms, each an OR across fields**:

```sql
-- q = 'solar training'
(   (COALESCE(i.item_state->>'field_a','') ILIKE '%solar%'
  OR COALESCE(i.item_state->>'field_b','') ILIKE '%solar%')
AND (COALESCE(i.item_state->>'field_a','') ILIKE '%training%'
  OR COALESCE(i.item_state->>'field_b','') ILIKE '%training%') )
```

Every term must appear in SOME vectorized field; the terms need not share a
field, nor appear in the stored order. Repeated whitespace is collapsed, and a
whitespace-only query yields no predicate at all.

`%`, `_` and `\` in a term are **escaped** so they match themselves. The value
was always bound (no injection risk), but unescaped, `"50%"` barely narrowed
anything and a lone `"_"` matched every row.

**Known looseness, accepted:** for an array-valued field, `->>'f'` yields the
serialized JSON array as text (`["solar","wind"]`), so `ILIKE` matches against
that text form. Acceptable for a narrowing predicate; documented, not fixed
here.

### 4.1 Why tokenized, and why anchor-only (measured, not assumed)

**The whole-query form fell off a cliff at two words.** The original shape used
`q` as a single contiguous `%q%`. With `service_details: 'solar installation'`
and `services_offered: ['Solar','Training']`, the query `'solar training'`
matched **nothing** — no single field holds that contiguous string. So did
`'installation of solar'` and `'renewable energy'`. Any realistic multi-word
search returned an empty list. The original §4 specified this SQL exactly, so
the implementation was faithful; the cliff simply was not in the "known
looseness" note and was never a conscious trade-off.

**Narrowing on the anchorless path deleted semantic recall.** On that path `q`
is *simultaneously* the query vector. A literal predicate therefore meant
cosine could only ever reorder rows that already contained the typed string —
the opposite of what an embedding search is for, on the main browse path (a
signed-out or unanchored viewer sends `q` with no anchor). #148's actual bug
was text being **discarded** when an anchor existed; it never asked for
filtering where text already ranks. So the predicate is scoped to the
anchor-present case and the anchorless path returns to ranking only.

Consequence, stated plainly: with no anchor, `meta.total` is the whole
candidate set and cosine decides the order — a text search **ranks** rather
than **filters** there. That is the pre-#644 contract for that path.

Tests that would have caught both, now present in
`search_route_text_narrow.test.ts`: a two-word query whose terms span two
fields, a term-order-reversed query, a multi-word query that must still exclude
an item missing one term, and a semantically-related-but-literally-absent query
on the anchorless path.

---

## 5. Signals-DPG `POST /v1/network/item/discover` — request

```ts
// packages/schemas/src/api/discover_schemas.ts — DiscoverItemsBodyBase
{
  // ...existing: item_network, item_domain, item_type, q, filters,
  //              anchor_item_id, limit, offset

  /** NEW. Absent => server default per §5.2. */
  sort?: 'relevance' | 'newest' | 'nearest',

  // EXISTING FIELDS, MEANING NARROWED — these three now express the AREA
  // FILTER *only*, and the UI sends them ONLY in `radius` area mode.
  // `anywhere` (the default) sends none of them. There is no `area_mode`
  // field: absence IS `anywhere`.
  item_latitude?: number,
  item_longitude?: number,
  distance_meters?: number,

  /**
   * NEW. The ordering centre for `sort: 'nearest'`. Distinct from the area
   * filter above, so the candidate set stays network-wide while the order is
   * nearest-first. Must be sent together (existing paired-field refine
   * pattern applies).
   */
  ordering_latitude?: number,
  ordering_longitude?: number,
}
```

### 5.1 Mapping to the search envelope

| `/discover` field | → `intent` field |
| --- | --- |
| `sort` | `intent.sort` |
| `item_latitude` / `item_longitude` / `distance_meters` | `intent.spatial[0]` (filter) |
| `ordering_latitude` / `ordering_longitude` | `intent.orderingCenter` |

### 5.2 Default `sort` (server-side)

`relevance` when `anchor_item_id` is present, else `newest`. Never error.

---

## 6. Signals-DPG `/discover` — response

```ts
meta: {
  total, limit, offset, source, degraded,

  /**
   * CHANGED: now present only when an AREA FILTER was actually applied
   * (i.e. item_latitude/item_longitude were sent). Previously keyed off
   * "a location was sent", which conflated filtering with ordering.
   * An `ordering_*` centre alone MUST NOT set this.
   */
  distance_meters?: number,

  /** NEW, always present. Passed through from signals-search
   *  meta.sort_applied; on the native fallback, whatever the fallback did. */
  sort_applied: 'relevance' | 'newest' | 'nearest',
}
```

---

## 7. Native fallback (Signals-DPG only)

No wire change. Behaviour, per spec §3.7:

| `sort` | Native call |
| --- | --- |
| `newest` | send **no** lat/lng → `buildDistanceOrderBy` yields `created_at DESC` |
| `nearest` | send lat/lng, **no** `radius_meters` → distance-ordered, unbounded |
| `relevance` | unavailable without ranking → behave as `newest`, report `sort_applied: 'newest'` |

Plus the `item_id` tiebreaker in `buildDistanceOrderBy`
(`apps/api/src/utils/item_fetch_runtime.ts:463-480`).

---

## 8. Match-score scale (Signals-DPG only, no cross-repo impact)

Single wire scale **0–100** end to end, matching what `/v1/relevance` already
emits. Both conversion points deleted:
`packages/match_score/src/providers/signals_search/client.ts:15` (`÷10`) and
`use-match-score.ts:44` (`×10`). signals-search needs **no change** for this —
it already emits 0–100.

---

## 9. Contract test both sides must satisfy

Each repo asserts the same fixture independently, so a divergence fails a test
rather than a deploy.

```
Request  intent = { item: { id: <anchor> },
                    textSearch: 'solar',
                    sort: 'nearest',
                    orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } }
         pagination = { limit: 20, offset: 0 }

Expect   - NO ST_DWithin predicate in the SQL (nearest must not filter)
         - ORDER BY ends in `s.item_id ASC` (this fixture uses sort:'nearest';
           a `relevance` ORDER BY must NOT carry the tiebreaker — see §3.1)
         - text applied as a WHERE predicate, anchor still the query vector
         - meta.sort_applied === 'nearest'
```

---

## 10. Change log

| Date | Change |
| --- | --- |
| 2026-09-03 | Frozen. Initial version. |
| 2026-09-03 | Clarifications only, no shape change: §2.1 (the inferred path reports `'newest'` while ordering by `indexed_at`) and §2.2 (`orderingCenter` reaches the SQL layer only under `sort: 'nearest'`, or every anchor search starts emitting `distanceMeters`). Both surfaced while implementing; neither alters a field or a rule. |
| 2026-09-03 | **AMENDMENT (§3, §9): the `relevance` ORDER BY drops the `s.item_id` tiebreaker.** Measured: it destroys the HNSW index (2.8 ms → 316 ms, full seq scan, O(corpus)) because pgvector supplies a pathkey only for the exact single-expression ordering, and an approximate scan cannot support an incremental sort. It also buys almost nothing: a cosine tie needs byte-identical embeddings, and the traversal is deterministic anyway. `newest`/`nearest` keep the tiebreaker at zero cost. |
| 2026-09-03 | Correction to the above: an earlier draft claimed relevance paging was inherently approximate (differing candidate sets per page). Measurement disproved it — paging is deterministic and partitions cleanly. §3.1 corrected; §3.2 added for the real defect (silent HNSW truncation at the default `ef_search`). |
| 2026-09-03 | Note on §5: the radius Signals-DPG SENDS is `distance_meters ?? env` and is legitimately **absent** when neither is set — signals-search then applies `SEARCH_DEFAULT_DISTANCE_METERS`. `meta.distance_meters` folds in DPG's mirror of that default for **reporting only**; it is never put on the wire. |
| 2026-09-07 | **AMENDMENT (§4): the text predicate is TOKENIZED and applies only when an anchor is present.** Review found the whole-query `%q%` form matched nothing for any multi-word query (`'solar training'` against `service_details: 'solar installation'` + `services_offered: ['Solar','Training']` returned zero), and that narrowing the anchorless path — where `q` is itself the query vector — deleted semantic recall. Terms are now ANDed, each ORed across fields, with `%`/`_`/`\` escaped; the anchorless path ranks without filtering, as before #148. See §4.1. |
