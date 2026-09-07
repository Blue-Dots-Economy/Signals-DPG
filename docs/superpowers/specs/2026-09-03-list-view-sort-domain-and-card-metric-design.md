# List view: unbounded paging, explicit sort, one domain control, card metric follows the sort

**Date:** 2026-09-03
**Status:** design approved; UI design approved (§7); ready to plan
**Issues:** signals-dpg#644, #645, #646, signals-search#148
**Supersedes:** `2026-08-31-list-view-pagination-and-filter-surface-design.md` (same problem
space; that document's D6 and D8 are reversed here — see §2.1)
**Re-scopes:** #404 (folding facets into the search box)
**Builds on:** #203 (epic), #419 (list → `/discover` BFF), #394 (removed the "Near me" toggle)

---

## 1. Problem

Four defects share one cause: **the list view silently became a map.**

1. **The list is bounded to 30 km with no opt-out.** A signed-out visitor who
   declines geolocation sees the whole network. The moment a user signs in with
   a profile that has a location, the same view collapses to a 30 km radius.
   The original requirement was the opposite: page through **all** items in the
   network in a defined order. The map owns location-based discovery.
2. **Paging over tied rows duplicates and skips items.** No `ORDER BY` carries a
   unique final key, so `LIMIT/OFFSET` boundaries drift between queries.
3. **Nobody can tell what is filtering the list.** Domain scoping is split
   across three controls plus one invisible rule; there is no applied-filter
   read-out and no clear-all.
4. **The card's number and the list's order measure different things.** The
   badge is always a cosine similarity, but the order often is not — and the UI
   re-sorts the feed client-side, discarding the server's ranking entirely.

### 1.1 Root cause of the 30 km bound

signals-search applies the spatial clause as a hard `WHERE` predicate, not a
ranking signal:

```
-- signals-search/src/db/search_query.ts:66-72
conds.push(sql`ST_DWithin(s.geo, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :distanceMeters)`)
```

Radius resolution: request `distanceMeters` → `SEARCH_DEFAULT_DISTANCE_METERS`
→ **30 000 m** (`signals-search/src/config.ts:49`). `bluedots-automation` sets no
override, so 30 km is the live value.

Signals-DPG has no code path that omits the location. `relevance: true` is
hardcoded (`apps/ui/src/lib/browse-discover.ts:43`) and lat/lng is forwarded
whenever one resolves (`apps/ui/src/hooks/use-infinite-browse-items.ts:148-150`).
`useUserLocation` resolves the profile location first, else browser geolocation.

| Viewer | lat/lng sent | Candidate set |
| --- | --- | --- |
| Signed out, geolocation denied | no | whole network — correct |
| Signed out, geolocation granted | yes | 30 km |
| Signed in with a profile location | **always** | **30 km, no opt-out** |

**Pagination itself is not the defect.** `LIMIT/OFFSET` and a true `count(*)`
both work; the candidate set they page over is truncated.

### 1.2 Ordering and paging defects

- **P1 — no `ORDER BY` tiebreaker (live correctness bug).** All three ranking
  paths order without a unique final key (`search_query.ts:96-100`). SQL leaves
  the order of tied rows undefined, and page N and page N+1 are separate query
  executions, so the tie group can be arranged differently between them. Rows
  then appear on both pages while others are never returned at all. See §3.4
  for the worked failure and the fix.
- **P2 — rerank silently truncates paging.** `search_route.ts:110-111,125`
  over-fetches `topN` from offset 0, reorders, then slices. Any
  `offset >= topN` returns an **empty page** while `meta.total` still reports
  the full count. `RERANK_DEFAULT=false` / `RESULT_TOPN=50` today, so it is
  latent — and would cap paging at 50 items the moment reranking is enabled.
- **P3 — ordering is implicit and unchangeable.** `ORDER BY` is inferred from
  which inputs happen to be present: cosine if an anchor or text exists, else
  distance if spatial, else recency. The user can neither see nor choose it,
  and with an anchor present distance is only ever a *filter*, never a sort.
- **P4 — recency sorts on an ingestion artifact.** The recency path uses
  `item_search.indexed_at`, so a re-index or backfill reshuffles the entire
  user-facing feed.
- **P5 — federation gaps (restated, unchanged).** `/discover` is
  single-instance; on the native fallback path `q` does not forward to peers.
  `meta.total` there sums Redis-cached per-instance counts and can overstate,
  which `use-infinite-browse-items.ts:194-203` compensates for with a
  short-page check.
- **P6 — the UI discards the server's ranking (confirmed live).**
  `home-page.tsx:2396` re-sorts the fetched feed client-side by haversine
  distance (`sortItemsByNearest`, defined at `:141`), so the server's cosine
  order arrives correctly and is thrown away before render while each card
  still displays the server's cosine score. Reproduced on the deployed instance
  at `/home?view=list`: badges read **49%, 62%, 49%** top to bottom; adding
  `&domain=provider` takes the single-domain branch, which does not sort, and
  the order becomes **62, 49, 49**.

  The sort sits inside the `selectedDomain === null` branch (`:2359`) —
  i.e. the "All" tab — which is the default landing state for a signed-in
  seeker. **Removing the All tab (§2.1 D10) deletes this defect outright**; no
  merged union survives to re-sort.

  Aggravating details, recorded because they explain why the order looks
  non-monotonic even as a distance sort: `nearestDistanceMeters` returns
  `Infinity` for an item with no/empty `item_locations`
  (`lib/geo/distance.ts:53-55`), pushing location-less items to the end;
  stored coordinates carry PII jitter, so printed addresses are not a proxy for
  the sort key; and it re-sorts the *accumulated* pages on every fetch, so
  positions reshuffle during scroll.

  **Shared trigger.** `sortItemsByNearest` short-circuits on
  `if (!userLocation) return items` — the same condition that gates the 30 km
  bound. A resolved viewer location switches on both defects at once, which is
  why the signed-out list looked correct on both counts and the two symptoms
  always appeared together.

### 1.3 Typed search is inert for signed-in viewers (signals-search#148)

`search_route.ts:74` gates text embedding on `!message.intent.item?.id`, and
`search_query.ts` has **no text `WHERE` clause at all** — verified: the only
conditions are lifecycle, network/domain/type (`:61-64`), facet filters (`:65`)
and spatial (`:67`). There is exactly one query vector (`:29`), written either
from the anchor's stored embedding (`:57`) or from typed text (`:75`), never
both.

So when an anchor is present, `textSearch` is consumed by nothing. Signals-DPG
sends `q` and `anchor_item_id` together on every list query, and the anchor is
present for essentially all signed-in traffic. **Typing in the list search box
as a signed-in viewer with a profile returns an identical set in an identical
order**; the only observable effect is a changed cache key. It works only on the
*degraded* native fallback, which value-matches `q`.

`willRerank` also requires `textSearch` and would at least have reordered, but
`RERANK_DEFAULT=false` in `bluedots-automation`, so that path is dead in
production too.

### 1.4 Filter surface problems

Domain scoping is split across three controls plus one invisible rule:

1. **Sidebar Browse tab** — `selectedDomain` / `?domain=`, scopes list + map +
   header count.
2. **`MapFiltersPanel`'s domain chip multi-select** — `mapSelectedDomains`,
   applies **only** on the "All" tab, and **client-side only**: markers are
   fetched for every visible domain and then discarded after the fact
   (`home-page.tsx:1178-1185`).
3. **Invisible `computeVisibleDomains` scoping** — a signed-in viewer only ever
   sees domains their own domain can initiate toward (a seeker never sees other
   seekers), overridable via `?as=` but never explained in the UI.

On top of that: the top-bar search box is a fourth filter surface behaving
differently per view (semantic embedding match in the list, `/markers?q=` value
match on the map); the facet panel is named `MapFiltersPanel` but has served
both views since #394; and there is no applied-filters chip row and no
clear-all — `resolveListNote` prints one of five sentences about the anchor and
radius and says nothing about active facets or search text.

### 1.5 Card metric problems

Both the card badge and the detail modal show the same quantity — `1 -
cosine_distance` between two BGE-M3 embeddings — through **three** scales:

- `signals-search` `/v1/relevance` returns 0–100 (`src/api/relevance_route.ts:14`)
- the provider divides by 10 (`packages/match_score/src/providers/signals_search/client.ts:15`)
- the `/discover` seed multiplies by 10 (`apps/ui/src/hooks/use-match-score.ts:44`)

Two conversion points, three scales. `getScoreStyles`
(`match-score-badge.tsx:20-25`) already carries a bug-fix comment about a
mis-normalisation that classified nearly every score "Excellent".

**The score is pure cosine — the API composes filters, never scores.** Worth
stating explicitly because it is the crux of the confusion: `score` is
`(1 - (s.embedding <=> :vec))::float8` and nothing else contributes;
`distanceMeters` is a separate `ST_Distance` column, reported alongside and
never folded in; facets and `ST_DWithin` are `WHERE` predicates that decide
membership, not position. There is no weighted blend anywhere in the stack.

Two further defects: one badge carries two incomparable quantities
(profile↔item cosine with a profile, typed-text↔item cosine without), and the
Excellent/Good/Moderate/Low bands over 0.85/0.70/0.50 are uncalibrated —
BGE-M3 profile similarities cluster in a narrow range, so the band reads as
near-constant across a result set. The number has real **ordinal** value; the
absolute percentage and band label imply a calibration that does not exist.

Adding an explicit `sort` forces the decision: under `newest` or `nearest` an
item would be **ordered by one quantity and badged with another**, permanently
and visibly.

---

## 2. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | The list sends **no spatial clause by default** | Restores the original requirement; makes signed-in and signed-out behave identically. Smallest change that fixes the reported bug. |
| D2 | Location enters **only** via an explicit area filter | Serves the dense-map escape hatch (§2.2) without reintroducing an invisible default bound. |
| D3 | Distance is **not** blended into the default ranking | Moving `ST_DWithin` into `ORDER BY` as a boost needs relevance re-tuning and a cosine/distance blend decision. `nearest` as an explicit sort covers the need. |
| D4 | Ordering becomes an **explicit `sort` on the wire** | Fixes P3 at the contract level rather than papering over it in the UI. |
| D5 | Recency sorts on `items.created_at` — **not** `indexed_at`, **not** `updated_at` | `indexed_at` is an ingestion artifact (P4). `updated_at` lets any edit jump a listing to the top and is trivially gameable. Users mean "newest listing". |
| D6 | **Area modes are `anywhere` and `radius` only. `viewport` is dropped.** | Reverses the prior spec. signals-search supports one `s_dwithin` **Point** clause and no bbox operator, so a map viewport (a rectangle) would have to be approximated by its circumscribed circle — always larger than the rectangle, so the list would include items that were off the edges of the map the user was just looking at. `radius` already serves the real need. Recorded on #644 as explicitly skipped, with this reason. |
| D7 | Keep counterpart-only domain scoping; **make it visible** | No product ask to open peer-to-peer browse. Allowing it would drop the anchor (signals-search 403s non-interacting pairs), fall back to `newest`, and require hiding Connect on every card. **SUPERSEDED — see D7a.** |
| D7a | Reverses the "make it visible" half of D7: a domain the viewer cannot browse is **not rendered at all**, rather than listed and disabled with a reason. | Decided from QA on the 3-domain up-gzb network. Listing it put a permanently dead `Seeker` tab in the middle of the primary browse control for every signed-in seeker, which reads as a broken toggle rather than as an explanation — and the disabled tab was never where a user would look to learn who can interact with whom. The scoping itself is unchanged: `computeVisibleDomains` and the interaction matrix still govern what is fetchable, and `DomainControl` now simply renders what it is given. Consequence: with one browsable domain the control collapses to the "Showing <Domains>" heading, which is the D7 goal (state the scope) reached by stating it rather than by greying out the alternatives. |
| D8 | **The "All" tab is removed.** | Reverses the prior spec's client-merged union. See §2.1 — this deletes an unsolved design problem rather than solving it. |
| D9 | #404 is re-scoped to additive `field:value` typing | The panel stays. Token syntax is a convenience for typists, not a replacement surface on a low-literacy, mobile-first product. #404 must drop its "remove the standalone filter facet panel" item before it is planned. |
| D10 | Domain selection moves **out of the sidebar** to a selectable control above the map/list, alongside the applied-filter chips | Domain *is* a filter; it should look and live like one. Collapses three controls into one. |
| D11 | **List = single-select domain. Map = multi-select domain.** | The list is one `/discover` call, which takes exactly one `item_domain`. The map already issues one `/markers` call per domain, so multi-select is native there. |
| D12 | The map's domain multi-select drives **which domains are fetched**, not a post-fetch filter | `use-map-markers.ts:265-285` already fans out per domain via `useQueries`; today `home-page.tsx:1178-1185` throws away markers after fetching them. Feeding the selection into the fan-out removes wasted requests. |
| D13 | signals-search#148 is **fixed in this work**: text narrows (value-match `WHERE`), profile ranks (cosine) | Same two files this work already rewrites. Without it, #646's "matches your search" label is not a real distinction for signed-in viewers. |
| D14 | With an anchor present, the card label is **"matches your profile"** — even when text is also typed | After D13 the score is still 100% profile↔item cosine; text only narrows membership. Labelling it "matches your search" would be false. The typed text is surfaced as its own removable chip instead. |
| D15 | `VITE_FREETEXT_MATCH_SCORE_ENABLED` is **kept** | Reversing #646's C3. It is a legitimate per-deployment product choice — "does this instance show a score for free-text matches, or only for profile matches?" — not a workaround for an ambiguous badge. Labelling (D14) fixes the ambiguity; the flag keeps its real meaning. |
| D16 | Offset paging is retained; **keyset paging is a follow-up** | See §3.5. Accepted, measured risk. |
| D17 | `item_id` is appended as the final `ORDER BY` key on the **`newest` and `nearest`** paths in both repos — **not** on `relevance` | Fixes P1 in signals-search and the identical latent bug in the native fallback. Amended 2026-09-03 after measurement: on the cosine path the tiebreaker destroys the HNSW index (115× slower, O(corpus)) and buys little, because a cosine tie needs byte-identical embeddings and the traversal is deterministic anyway. See §3.4. |
| D18 | The card's primary metric **is** the ranking basis | So metric and order can never disagree. See §5. |
| D19 | With no `?domain=`, the list defaults to the viewer's **first interacting counterpart domain**, else the first visible domain | The All tab was the previous no-domain default; something must replace it. Invisible for a viewer with one visible domain. |
| D20 | The explanation panel ("why this result, in this position") is **in scope** | Requested. Subject to the honesty constraint in §5.4. |
| D21 | **A UI prototype was required before implementation**, for (a) the domain + filter bar and (b) the card with the swappable metric | Both were layout problems prose could not settle. **Resolved** — see §7 for the approved design. |
| D22 | The card metric is an **icon-only pill**; the ranking basis is stated **once** in the sticky bar, not on every card | The sort is a property of the *list*, not of each card, so repeating it 20 times is redundant. Icons are language-neutral, so nothing truncates in hi/kn and the footer stays as roomy as today. The full label lives in the tooltip and the explanation panel. |
| D23 | The domain + filter bar is **sticky** | This is what makes D22 safe: the basis label stays on screen however far the user scrolls, so a bare `62%` is never unexplained. |
| D24 | **Search and the facet panel stay in the app bar.** The sticky bar adds only `sort`, `area` and the chip read-out | App bar = **editors**; sticky bar = **state**. Nothing becomes a second editor for the same thing. The facet panel already mounts in the header (`home-page.tsx:2145` → `PageShell`) and does not move. |
| D25 | Removing the search chip **also clears the app-bar search box** | The chip is a read-out whose editor lives elsewhere; a chip that removed the constraint but left text in the box would be lying. |
| D26 | **No sort control on the map at all** — hidden, not disabled | Ordering is meaningless for a marker layer. A disabled control would invite the question rather than answer it. |
| D27 | Map → list **collapses a multi-domain selection to the first domain silently** | No notice. The domain control itself shows the result, which is the read-out's job. |

### 2.1 Why the "All" tab is removed (D8)

The prior spec kept an "All" view as a client-merged paged union of N
per-domain feeds, and left an **open design gap**: what orders that union?
None of the options were acceptable —

- **Cosine is not comparable across domains.** Feeds anchored on the same
  profile but scored against different domains' embeddings do not share a
  scale, so interleaving by raw score is meaningless.
- Concatenating per domain is coherent within each block but buries the second
  domain entirely.
- A true global ranking needs one server-side query across domains, which
  `/discover` cannot do — it takes exactly one `item_domain`.

Removing the tab deletes the question. It also removes the mixed-domain result
set that users found confusing in the first place, and it deletes P6 as a side
effect (there is no merged union left to re-sort).

It fits the existing architecture rather than fighting it:

- **The list is already per-domain.** `singleDomainList` runs with
  `enabled: selectedDomain !== null` (`home-page.tsx:1267`). Making
  `selectedDomain` never-null is the change.
- **The map is already per-domain.** `use-map-markers.ts` fans out one
  `/markers` query per domain via `useQueries`.

Code deleted with it (~70 references in a 2685-line file): `DomainPagedFetch`,
`allDomainPages`, `allDomainItemsFiltered`, `filteredAllDomainItems`,
`allDomainsTotalCount`, `anyAllDomainHasMore`, `selectByDomainScope`,
`allDomainsListDegraded`, `allDomainsListPartial`, `allDomainsLoading`,
`handleDomainItems`, `sortItemsByNearest`.

**Three user-visible consequences, all accepted:**

1. A default domain is required where "no domain" used to mean All — D19.
2. Existing `/home?view=list` links (which meant All) resolve to that default.
3. Switching **map → list** with several domains selected must collapse to one.
   Keep the first selected domain and show it in the chip bar, so the collapse
   is visible rather than silent. **List → map** keeps the single selection.

### 2.2 Why the list still needs an *optional* area filter

The map cannot be the only location-aware view. `apps/ui/src/lib/map-caps.ts`
caps markers at 1000 clustered / 500 individual (env-tunable) and shows an
"N+ in this area — zoom in" pill when `meta.total` exceeds the cap. In a dense
cell at maximum zoom there is no further zoom to escape to — the list is the
escape hatch. So it needs an **explicit, opt-in** area constraint, never a
default one.

---

## 3. Design — A: the fetch contract

### 3.1 Area becomes an explicit, opt-in parameter

`deriveBrowseParams` gains an `area` discriminated union:

```ts
type BrowseArea =
  | { mode: 'anywhere' }                                  // default
  | { mode: 'radius'; center: LatLng; meters: number };
```

- **`anywhere`** sends no `item_latitude` / `item_longitude` /
  `distance_meters`. The BFF then builds no spatial clause, and
  `meta.distance_meters` is absent — `resolveListNote` already degrades
  correctly when it is.
- **`radius`** sends centre + metres explicitly. The resolved viewer location
  (`useUserLocation`) is offered as the **default centre** when the user picks
  this mode, and remains editable.

`home-page` stops unconditionally forwarding `browseCoords`
(`home-page.tsx:1224`). A resolved viewer location is no longer, by itself, a
filter.

`meta.distance_meters` becomes **area-mode driven** rather than
"a location was sent" driven (`discover.ts:203-208`), so it can never report a
radius that was not applied.

### 3.2 Explicit sort

New `sort` field, forwarded from the UI through `/discover` into the search
envelope:

| `sort` | Requires | signals-search `ORDER BY` |
| --- | --- | --- |
| `relevance` | anchor or `textSearch` | `s.embedding <=> :vec ASC, s.item_id ASC` |
| `newest` | — | `i.created_at DESC, s.item_id ASC` (D5) |
| `nearest` | an ordering centre | `ST_Distance(...) ASC NULLS LAST, s.item_id ASC`, **no radius bound** |

**Default:** `relevance` when an anchor is sent, else `newest`.

A `relevance` request with neither anchor nor text **falls back to `newest`
rather than erroring**, and the response **reports the sort actually applied**,
so the UI can never claim an order it did not get.

**`nearest`'s ordering centre is independent of the area filter.** With
`area: 'anywhere'` and `sort: 'nearest'`, the viewer's resolved location is
sent as an **ordering centre only** — a request field distinct from the area's
filtering centre — so the candidate set stays network-wide while the order is
nearest-first. When an area *is* selected, its centre doubles as the ordering
centre. If no location resolves at all, `nearest` is offered **disabled with a
reason**, and a request for it falls back to `newest`, reported as applied.

**This is new capability in signals-search, not just a new field.** Today a
spatial clause always produces an `ST_DWithin` predicate, and `distanceMeters`
being optional merely falls through to the 30 km default — there is no way to
express "here is a centre, order by it, bound nothing". The wire shape must
make that expressible.

**`sort` must live inside `intent`.** `cacheKey(normalized)`
(`search_route.ts:64-65`) hashes `{networkId, domain, itemType, intent,
pagination}`. Placing `sort` inside `intent` makes the cache key correct for
free; placing it on `message` alongside `pagination` would make two different
sorts **share a cache entry**. Covered by a test.

### 3.3 Text narrows, profile ranks (signals-search#148, D13)

Apply `textSearch` as an **additional value-match `WHERE` predicate** ANDed
with the existing conditions, alongside the anchor query vector — rather than
as a competing query vector.

- `search_query.ts`: add a text predicate over the target domain/item_type's
  text fields. `item_search` does not store the serialized text, so the
  predicate runs against `i.item_state` via the existing `JOIN items i`.
- `search_route.ts`: stop gating text handling on `!message.intent.item?.id`.
  Anchor and text are no longer mutually exclusive.
- Ranking is unchanged: the anchor embedding still supplies the cosine order,
  so the relevance % still explains the position (composes with §5).

**Which fields does text match?** The two paths disagree today: the native
fallback uses declared non-private facet fields (`resolveTextSearchFields` →
`resolveAllowedFacetFields`); signals-search's semantic relevance uses
`vectorize: true` fields (`src/config/vectorize_fields.ts`, available as
`deps.registry.vectorizeFields(...)`). **Decision: use the `vectorize` set**, so
text-narrowing and cosine-ranking describe the same content. The healthy/
degraded divergence is documented as a known inconsistency for #360 to settle
properly.

**Rejected, recorded so they are not relitigated:** blending the two vectors
(normalise + weighted sum) makes narrowing fuzzy and unmeasurable today;
re-serialising anchor text + typed text into one embedding costs an embed call
per query and still cannot narrow; dropping the anchor when text is present
throws away profile relevance exactly when the user is being most specific.
Semantic blending is a reasonable follow-up once someone can measure it.

### 3.4 Deterministic paging (P1, D17)

Append `s.item_id` as the final key to **every** `ORDER BY` in
`search_query.ts`.

**Why it is needed.** SQL leaves the order of tied rows undefined, and the
database holds no state between page requests — page N and page N+1 are
independent query executions. Worked failure, six items where five share a
bulk-migrated `created_at`, page size 3, `ORDER BY i.created_at DESC`:

```
Page 1  (LIMIT 3 OFFSET 0) — tie group happens to order C,A,D,B,E
        full order: F C A D B E  →  user sees  F, C, A

Page 2  (LIMIT 3 OFFSET 3) — fresh execution, tie group orders B,E,C,A,D
        full order: F B E C A D  →  user sees  C, A, D

Net:    F, C, A, C, A, D   ← C and A duplicated; B and E NEVER shown
```

With `ORDER BY i.created_at DESC, s.item_id ASC` there is exactly one valid
ordering of the table, so every execution produces it and every offset lands on
the same boundary: `F, A, B` then `C, D, E`. No state required — determinism
replaces the need for it.

**Where ties actually arise:**

| Path | Tie source | Likelihood |
| --- | --- | --- |
| `newest` | bulk migration / import writing many rows in the same second | **Common** — the primary case |
| `nearest` | two items at identical coordinates (same building), or PII jitter collisions | Occasional |
| `relevance` | identical embeddings, i.e. two items whose vectorized text serializes identically (duplicate listings) | Rare but real |

So it goes on all three paths. `item_id` is the right key: unique per row, never
null, already in the composite PK and already in the `SELECT` list
(`search_query.ts:109`). Cost is negligible — a sort comparator only reads the
second key **inside a tie group**, so rows with distinct leading keys never
touch it.

**The same bug exists on the native fallback.** `buildDistanceOrderBy`
(`apps/api/src/utils/item_fetch_runtime.ts:463-480`) ends at
`items.created_at DESC` with no unique key — identical failure mode. It gets
the same tiebreaker, or the degraded path stays broken.

**MEASURED 2026-09-03 — the cosine path is exempt.** The verification this
section originally called for was run, and the result reverses the plan for one
of the three paths.

On 20 000 live rows with real 1024-dim vectors (pgvector `vector_cosine_ops`,
PG16), appending `, s.item_id ASC` to the cosine clause **destroys the HNSW
index**:

| ORDER BY | Plan | Time |
| --- | --- | --- |
| `embedding <=> :vec ASC` | `Index Scan using item_search_embedding_hnsw` | **2.8 ms** |
| `embedding <=> :vec ASC, s.item_id ASC` | Seq Scan ×2 + `top-N heapsort` | **316 ms** |

115× slower and a full scan of every live row, so O(corpus) — ~3 s at 200 k,
unusable at 1 M. Architectural, not a costing accident: with `seqscan`,
`hashjoin` and `mergejoin` forced off there is still no HNSW path; with
`enable_incremental_sort = on` no Incremental Sort node appears; and removing
the `JOIN items` changes nothing. pgvector's HNSW scan supplies a pathkey only
for the exact single-expression ordering, and being *approximate* it cannot
promise complete tie groups, so an incremental sort over it is not legal.

**The tiebreaker also buys almost nothing there.** A cosine tie requires
byte-identical embeddings, which requires identical vectorized content. The one
real tie group is rows with `embedding IS NULL` (legitimate — no vectorizable
content), which cluster at the tail. And the HNSW traversal is *deterministic*
for a fixed query vector, `ef_search` and index state, so even tied rows come
back in a stable order.

**Resolution:** the tiebreaker applies to `newest` and `nearest` (where it is
free — those paths already performed a sort) and **not** to `relevance`.

**Relevance paging IS deterministic and does partition cleanly** — measured, at
`ef_search = 500`: five pages at offsets 0/20/40/100/200 returned 100 rows,
100 distinct ids, zero overlap between any pair; and offset 100 returned a
byte-identical set twice in one session and once on a fresh connection. So P1's
guarantee is scoped only in the narrow sense that `relevance` relies on the
traversal's determinism rather than on a unique sort key.

### 3.4.1 A separate, higher-severity defect found while measuring this

`hnsw.ef_search` defaults to **40** and `hnsw.iterative_scan` defaults to
**off**. In that configuration the HNSW scan **silently truncates**. Measured,
`limit 20`, 20 500 live rows:

| offset | rows returned |
| --- | --- |
| 0 | 20 |
| 20 | 20 |
| 40 | 20 |
| 100 | **0** |
| 200 | **0** |

60 of 100 expected rows. `EXPLAIN` confirms the planner still chooses
`Index Scan using item_search_embedding_hnsw` at every offset, so nothing falls
back to a complete plan — the truncation is silent, and `meta.total` still
reports 20 500.

**This is live today on the default path**, and it is the same failure shape as
P2: an empty page under a full `meta.total`. It also defeats this document's
headline requirement, because `getNextPageParam`
(`use-infinite-browse-items.ts:249`) stops paging on any short page — so under
`relevance` the list would silently cap at roughly 60 items while displaying a
count in the thousands. Replacing a 30 km cap with a 60-item cap is not the fix
#644 asked for.

**The fix is configuration only.** pgvector 0.8.5 supports iterative scan:

```sql
SET hnsw.iterative_scan = strict_order;
```

With `ef_search` left at its 40 default, that returns full 20-row pages at
offsets 0, 40, 100, 200 **and 1000**, with the HNSW index still used. Offset
200 goes 135 ms → 206 ms — and the 135 ms was fast only because it was
returning nothing. Offset 0, the common case, shows no regression.

So this is a **fixable defect, not an inherent limitation.** See §3.5 for how
it changes the scope decision.

### 3.5 Paging depth: accepted risk (D16)

Removing the 30 km bound takes the list from a few dozen items to ~20 000, so
`OFFSET` is asked to walk much further than it ever has. **This is a new
exposure, not a pre-existing proven-safe path** — the 30 km cap means nobody has
paged past roughly a few hundred rows in the list view before.

`LIMIT 20 OFFSET 19000` makes Postgres produce and discard 19 000 rows.
Retained anyway, because real users scroll tens of items rather than thousands,
and offset stays fast for the first several hundred.

**Follow-up (own issue, not built here):** keyset paging —

```sql
WHERE (i.created_at, s.item_id) < (:last_created_at, :last_item_id)
ORDER BY i.created_at DESC, s.item_id ASC
LIMIT 20
```

O(1) at any depth. It changes the wire contract (a cursor replaces an offset),
and it **requires** the D17 tiebreaker to be expressible at all — without
`item_id` in the comparison you can only say "after this timestamp", which
skips the rest of the tie group. So D17 is both the correctness fix and the
prerequisite for the performance fix.

**Open scope decision — `hnsw.iterative_scan` (§3.4.1).** Without it, the
default `relevance` list silently caps at roughly 60 items, so #644's headline
requirement is not met on the path most users land on. Three options:

1. **Land the config fix in this epic** (recommended). It is a session-level
   `SET hnsw.iterative_scan = strict_order` on signals-search's search
   connection, plus a test that pages past `ef_search` and asserts a non-empty
   page. Small, and it is the difference between #644 working and not working
   by default.
2. **Default the list to `newest`** instead of `relevance`, which pages
   completely today, with `relevance` opt-in.
3. **Ship knowing the default view caps at ~60 items.**

Not decided here. Recorded so it is chosen rather than discovered.

### 3.6 Rerank paging guard (P2)

When `willRerank && pagination.offset + pagination.limit > topN`, skip
reranking for that request and page natively from the requested offset.
Ranking quality degrades gracefully at depth instead of returning an empty page
under a full `meta.total`.

### 3.7 Native fallback

Keeps its current role (search-service outage → `source: 'native_fallback'`,
`degraded: true`, existing "basic matches" messaging unchanged) and learns the
same sorts. This is close to free: `buildDistanceOrderBy` already emits
`created_at DESC` with no location and distance-then-`created_at` with one, so
`newest` is "do not send lat/lng" and `nearest` is "send lat/lng with no
`radius_meters`". Confirm `buildWhereClause` builds no radius clause when
`radius_meters` is absent while lat/lng are present.

Plus the D17 tiebreaker (§3.4).

### 3.8 Out of scope

Federated ranked discover; forwarding `q` to peers on the fallback path;
bbox/polygon spatial operators; `viewport` area mode (D6); any blended
cosine-plus-distance score (D3); keyset paging (§3.5).

---

## 4. Design — B: the filter surface

### 4.1 Applied-filters chip bar

A persistent row above the results, rendering one **removable** chip per active
constraint, plus a clear-all:

- domain (D10 — domain *is* a filter)
- each facet field/value group
- search text
- `sort`, when non-default
- `area`, when not `anywhere`

Shared by list and map, since both read the same state. **Chips are the
read-out; the panel remains the editor.** The bar is **sticky** (D23) and sits
below the app bar per §7.

The search-text chip's editor is the app-bar box, so removing that chip
**also clears the box** (D25); it is rendered visually distinct to signal
"remove here, edit above". Layout, states and mobile behaviour: §7.2.

### 4.2 One domain control (D10, D11, D12)

Collapse the sidebar Browse tab and the panel's domain multi-select into a
single first-class domain control living with the chips above the view.

- **List view: single-select.** One `/discover` call, one `item_domain`.
- **Map view: multi-select.** One `/markers` call per domain already.
- The selection drives the map's `useQueries` fan-out rather than filtering its
  results afterwards (D12).
- Map → list collapses a multi-selection to its first domain **silently**
  (D27) — no notice; the domain control itself is the read-out.

### 4.3 Make counterpart-only scoping visible (D7)

The domain control lists **every** domain in the network and marks
non-interacting ones unavailable with a one-line reason (e.g. "you can't
connect with other seekers"). `computeVisibleDomains` and the interaction
matrix are **untouched** — only explained.

### 4.4 Rename `MapFiltersPanel` → `BrowseFiltersPanel`

`apps/ui/src/components/map/map-filters-panel.tsx` →
`apps/ui/src/components/filters/browse-filters-panel.tsx`. It has served both
views since #394 and the name misleads every reader.

**Two consumers, not one:** `home-page.tsx:2123` (desktop) and `:2146`
(mobile), **plus `apps/ui/src/tourist/tourist-app.tsx:97`**. Around 30 further
references across four test files.

### 4.5 Sort selector

Sits in the sticky bar's second row, driving §3.2. `nearest` renders **disabled
with a reason** when no location resolves (§3.2).

**List view only — the control is absent on the map** (D26), not disabled:
ordering is meaningless for a marker layer, and a disabled control invites the
question rather than answering it. A `sort` chip therefore only ever appears on
the list.

### 4.6 Accessibility

Chips form a labelled group, each removable by keyboard, with `aria-pressed`
state and focus returned to the bar after removal. Existing
`pointer-coarse:min-h-11` touch targets preserved.

---

## 5. Design — C: the card metric follows the ranking basis

### 5.1 The metric is the ranking basis (D18)

The card's primary metric becomes whatever drove its position, so the metric
and the order can never disagree:

| `sort` | Card pill | Source |
| --- | --- | --- |
| `relevance` | `★ 62%` | `/discover` `score` |
| `nearest` | `◎ 4.2 km` | `distanceMeters`, already returned |
| `newest` | `◷ 5d ago` | `items.created_at` (D5) |

The metric is **never shown when it did not determine the order.** The map popup
card (`marker-popup-card.tsx`) is kept consistent — and since the map has no
sort control (D26), its pill follows whatever sort the list last set.

**The pill is icon-only (D22)** — the basis label is not repeated per card. It
lives in the sticky bar's `Sort` control (always on screen, D23), the pill
tooltip, and the explanation panel. Layout rationale: §7.4.

This falls out efficiently: a per-pair score is shown only under `relevance`,
where `/discover` already returns it for free. **No N×`/v1/relevance` calls** —
which matters, because that endpoint shipped 1:1 (`source`, `target`), not the
batched source×N of the original design.

**Design boundary — this is not a rejection of composite scoring.** D18 is
correct *because* only one quantity ever ranks at a time. If a true composite
relevance is ever built (cosine + proximity + facet-match bonus, weighted), it
supersedes D18 and finally justifies one unified relevance % across all sorts.
That is a separate design, out of scope, **not rejected**.

### 5.2 One scale end to end

Pick a single wire scale — **0–100**, matching `/v1/relevance` — and format at
the edge. Delete both conversion points: the provider's `÷10`
(`providers/signals_search/client.ts:15`) and `seedFromDiscoverScore`'s `×10`
(`use-match-score.ts:44`).

**Cache invalidation is mandatory.** `getMatchScoreBand` and
`formatScorePercentage` (`apps/ui/src/utils/match-score-cache.ts:95,136`) both
assume 0–10, and scores are persisted in localStorage under
`CACHE_KEY_PREFIX = 'dpg:matchScore:v1'` (`:3`) with a 24-hour TTL enforced on
read (`:31-34`).

What breaks without action: a user who viewed a score in the 24 hours before
the deploy has `6.2` in their browser (the old 0–10 value). The new formatter
reads it as 0–100 and renders **6%** for what is a 62% match. Silent, no error.

Two required changes:

1. **Bump the prefix to `'dpg:matchScore:v2'`.** Old entries become
   unreachable, so the new code recomputes instead of misreading. Converting
   the stored values instead is not possible — there is no scale marker in the
   payload, so a stored `6.2` is indistinguishable between the two scales. The
   version prefix *is* the marker.
2. **One-time sweep of the `dpg:matchScore:v1` prefix on startup.**
   `localStorage` has no expiry of its own — the TTL is enforced in code, on
   read, and nothing will read a `v1` key again. `clearMatchScoreCache()` only
   sweeps the *current* prefix (`:84`), so without an explicit sweep the old
   entries persist in every user's browser forever. Small, but
   `setCachedMatchScore` already fails silently when localStorage is full
   (`:56-58`), so leaking quota is not free.

### 5.3 Label the basis (D14, D15)

- **Anchor present** (with or without typed text) → "matches your profile".
  After §3.3 the score is still 100% profile↔item cosine; text only narrows
  membership, so any other label would be false. The typed text is surfaced as
  its own removable chip (§4.1) instead of being folded into the score's label.
- **No anchor, text present** → "matches your search". Here the text genuinely
  *is* the query vector.

`VITE_FREETEXT_MATCH_SCORE_ENABLED` and `isFreeTextMatchScoreEnabled` are
**kept** (D15), with their real meaning: whether this deployment shows a score
for free-text matches at all.

**Edge case:** free-text scores disabled + no profile + `sort: relevance` →
there is no number to show. The card renders **no metric**, as it does today.
Sorting still works.

### 5.4 Explanation panel — "why this result, in this position" (D20)

The panel may show:

- the sort in force and the metric it used
- the `vectorize: true` fields for that domain/item_type and their
  `vector_weight`
- the viewer's and the item's values for those fields, side by side, so overlap
  is visible
- **separately**, the constraints that shaped the *set* but not the order —
  active facets, area, domain

**HONESTY CONSTRAINT.** The cosine is computed over a *single pooled embedding*
of the serialized `vectorize` fields (`serializeItemText` repeats each line
`vector_weight` times), so it **cannot be decomposed into per-field
contributions**. Any "what you have in common" display must be computed from
attribute overlap and **labelled illustrative** — never presented as a
breakdown of the score.

### 5.5 Delete the dead surface

- Remove `band`, `confidence`, `reasoning`, `signals`, `prompt_version`,
  `model_provider`, `model` from
  `packages/match_score/src/match_score.types.ts` and
  `apps/ui/src/lib/match-score-api.ts` — dpg-scoring-era fields the
  `signals_search` provider never populates, giving the modal affordances that
  can never fill.
- Drop the uncalibrated Excellent/Good/Moderate/Low bands from
  `match-score-badge.tsx`.

### 5.6 Future scope (documented, NOT built here): user-tunable relevance

`vector_weight` is already a per-property knob
(`signals-search/src/config/vectorize_fields.ts`) applied as **literal line
repetition** at ingest (`src/ingest/serialize.ts`). So letting a user reweight
their own priorities means re-serializing **their own** profile with their
chosen weights and embedding it on the fly (one TEI call) to use as the query
vector — **the item side needs no re-indexing.**

Caveats to carry forward: the result-cache key must include the weights;
per-request embedding gives up the stored-anchor-embedding shortcut
(`search_route.ts` currently reads the anchor's embedding straight from
`item_search`); and it depends on **#360** to declare which fields are
user-tunable.

---

## 6. Files affected

**signals-search** (lands first — additive and backward-compatible: absent
`sort` keeps today's inferred behaviour)
- `src/api/schemas.ts` — `sort` inside `intent` (§3.2); ordering-centre-without-radius shape
- `src/api/search_route.ts` — sort plumbing; drop the `!item?.id` text gate (§3.3); rerank paging guard (§3.6)
- `src/db/search_query.ts` — `item_id` tiebreaker on every `ORDER BY`; explicit sort; `i.created_at` recency; text `WHERE` predicate; centre-for-ordering without a radius predicate

**Signals-DPG — API**
- `packages/schemas/src/api/discover_schemas.ts` — `sort`, area fields
- `apps/api/src/routes/v1/network/item/discover.ts` — `sort` passthrough; spatial only when an area is requested; area-driven `meta.distance_meters`; report the applied sort
- `apps/api/src/services/signals_search_client.ts` — `sort` in the envelope; centre-without-radius
- `apps/api/src/utils/item_fetch_runtime.ts` — `item_id` tiebreaker in `buildDistanceOrderBy` (§3.4)

**Signals-DPG — UI**
- `apps/ui/src/lib/browse-discover.ts` — `BrowseArea`; drop the hardcoded always-send-location behaviour
- `apps/ui/src/hooks/use-infinite-browse-items.ts` — area + sort in the query key and request body
- `apps/ui/src/hooks/use-map-markers.ts` — selection drives the fan-out (D12)
- `apps/ui/src/pages/home-page.tsx` — remove the All tab and its ~70 references (§2.1); stop forwarding `browseCoords`; wire the chip bar and sort selector
- `apps/ui/src/components/map/map-filters-panel.tsx` → `components/filters/browse-filters-panel.tsx` (§4.4, three consumers)
- New: applied-filters chip bar; domain control; sort selector; explanation panel
- `apps/ui/src/components/match-score/*` (badge, card, modal, container), `hooks/use-match-score.ts`, `lib/match-score-api.ts`, `utils/match-score-cache.ts` (cache version, §5.2), `components/cards/domain-card.tsx`, `components/map/marker-popup-card.tsx`
- `packages/match_score/src/match_score.types.ts`, `packages/match_score/src/providers/signals_search/client.ts`
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — chip, sort, area, domain-unavailable, metric-label and relative-age copy

**PRs.** Two, one per repo — a single PR cannot span repos. signals-search
first (additive, backward-compatible), then Signals-DPG. The signals-search PR
references and closes signals-search#148; the Signals-DPG PR references #644,
#645, #646 and records the `viewport` omission with its reason (D6).

---

## 7. UI design (D21 — resolved, approved 2026-09-03)

Prototyped and approved. Mockups are in `.superpowers/brainstorm/` (gitignored,
not durable) — this section is the durable record.

### 7.1 Division of labour

**App bar = editors. Sticky bar = state.** (D24)

| Surface | Holds | Changes |
| --- | --- | --- |
| **App bar** (existing) | search box, facet panel trigger, location toggle | **nothing moves** — the panel already mounts here via `PageShell` |
| **Sticky bar** (new) | domain control, `sort`, `area`, applied-filter chips, clear-all, result count | new surface |

Nothing becomes a second editor for the same constraint. `sort` and `area` are
new controls with no prior home, so they live in the sticky bar.

### 7.2 The sticky bar — two rows

**Row 1:** the domain control, result count right-aligned.
**Row 2:** `Sort ▾`, `Area ▾`, one chip per applied constraint, `Clear all`.
When nothing is applied, row 2 reads "No filters applied" rather than
collapsing (a stable height avoids the list shifting under the user's thumb).

- **Domain control:** single-select on list (D11), multi-select with tick marks
  on map. Non-interacting domains are listed and greyed with their reason
  inline — e.g. `Seeker · you can't connect with other seekers` — which is
  where D7/#645's "make the invisible rule visible" requirement lands.
- **Area:** `Anywhere` (default) or `Within N km`. Showing `Area: Anywhere`
  is what makes the §1.1 bug fix *legible* — the user can see that location is
  not filtering them.
- **Sort:** list only; **absent on the map** (D26).
- **Chips:** the search-text chip is a read-out whose editor is the app-bar
  box; removing it clears that box too (D25). Render it visually distinct
  (dashed border) to signal "remove here, edit above".

### 7.3 Sticky implementation — resolved better than specified

The constraint was real: `top-bar.tsx:78` is `sticky top-0 z-40 min-h-14` **and
`flex-wrap`**, so on narrow screens it wraps to two lines and its height is
**not fixed**. Any hardcoded `top-14` on the filter bar would gap or overlap.

This section originally prescribed nesting both bars in one sticky container.
Reading `page-shell.tsx` during implementation produced a better answer:
**`<main>` is the scroll container** (`overflow-y-auto` inside an `h-svh` flex
column) and the top bar is already its **sibling**, so a new `toolbarSlot`
rendered between them is **structurally pinned** — no `sticky`, no offset, and
the flex-wrap problem cannot arise at all. `footerSlot` already used exactly
this pattern at the bottom of the same column.

**As built:** `PageShell` gains `toolbarSlot`, rendered `flex-none` between
`<TopBar>` and `<main>`. `BrowseToolbar` carries no positioning classes, and a
test asserts it does not — a `sticky` class creeping back in would reintroduce
the offset problem.

### 7.4 The card metric (D22)

An **icon-only pill** in the existing footer slot — the slot keeps its current
size, and the basis label is *not* repeated per card:

| `sort` | Pill |
| --- | --- |
| `relevance` | `★ 62%` |
| `nearest` | `◎ 4.2 km` |
| `newest` | `◷ 5d ago` |

Today's pill already renders bare `62%` — `MatchScoreButton` passes
`showLabel={false}` (`match-score-button.tsx:41`) — so this is a change of
*content*, not of size. The band label being dropped (§5.5) is consistent with
that call site.

The basis ("matches your profile" / "matches your search", §5.3) appears in the
sticky bar's `Sort` control, the pill tooltip, and the explanation panel (§5.4).
D23's sticky bar is what makes this honest: the label is on screen at every
scroll position.

### 7.5 Mobile costs (accepted)

- ~74px of permanent vertical space for the two stuck rows.
- The unavailable-domain reason cannot fit inline; it becomes a tap/long-press
  tooltip.
- The domain row **scrolls horizontally** past ~4 domains rather than wrapping.
  **Checked and cleared:** no live network exceeds three domains today, so the
  segmented control is fine as specified. If a network ever declares a fourth
  browsable domain, revisit — the mobile fallback would be a dropdown.

### 7.6 Found during implementation, not specified here

- **The result count rendered twice.** `ContentHeader` already showed it, so
  adding it to the toolbar put two identical counts within ~40px. The header's
  copy was removed: the toolbar's survives scrolling and the header's does not.
- **`item_actions.match_score` must stay on its 0-10 scale.** §5.2's "one scale
  end to end" is about the DISPLAY path. That column is a different artifact —
  persisted `REAL`, documented 0-10, already holding rows on that scale, and
  sorted on in SQL (`fetch_actions.ts`). Writing 0-100 into it would leave the
  table holding both scales with nothing in a row to say which, so every
  pre-existing My Actions score would render 10x too small. One conversion at
  that storage boundary (`compute_match_score.ts`) keeps the column's meaning
  and needs no backfill.
- **The map's domain multi-select also fed the LIST's card filter**, so picking
  a domain other than the browsed one blanked the list entirely. Coherent while
  the All tab existed; a map concern emptying the list once it did not.
- **The list feed must wait for a VALID domain** before fetching. A stale or
  unbrowsable `?domain=` otherwise fires one wasted request and, for a
  non-interacting domain, draws a 403 on the anchor.
- **The default-domain effect must only rewrite `?domain=` when REPAIRING** an
  invalid param. Writing it on every resolve raced the network switcher in the
  same tick and clobbered `?network=`, and would pin a shared link to the
  sharer's default rather than letting each viewer resolve their own.

---

## 8. Testing

**Paging correctness**
- **P1 regression:** seed rows with identical sort keys, page with `limit`
  smaller than the tie group, assert the union of pages equals the full set
  with no duplicates and no omissions (fails before the tiebreaker). Applies to
  `newest` and `nearest` only (§3.4). **Use ~200 tied rows, not a handful:** at
  six rows Postgres picks a stable plan by luck and the test passes *before*
  the fix, which reads as a false pass. Verified — 200 rows sharing one
  timestamp, paged at `limit` 20, returned 197 distinct ids of 200 before the
  fix (3 duplicated, 3 never returned).
- Same regression against the **native fallback** ordering
- **Rerank guard:** with rerank enabled, `offset >= topN` returns real rows
  rather than an empty page
- **Query plan:** `EXPLAIN ANALYZE` confirms the HNSW index is still used on the
  cosine path — i.e. that the tiebreaker was NOT added there (§3.4). A plan
  showing `Seq Scan` + `top-N heapsort` instead of
  `Index Scan using item_search_embedding_hnsw` means the exemption regressed.

**Fetch contract**
- **Unbounded default:** a discover request with no area sends no spatial
  clause and returns rows beyond 30 km from the viewer's profile location
- **Signed-in / signed-out parity:** identical result sets for the same
  network/domain/sort with no area selected
- **Sort matrix:** each `sort` produces the expected `ORDER BY`; `relevance`
  with no anchor and no text reports `newest` as applied
- **`nearest` does not filter:** ordering by distance returns items outside the
  configured default radius
- Location-less items are not silently forced to the end of the list
- **Cache key:** two requests differing only in `sort` do not share a cache
  entry (§3.2)
- Removing the area chip re-queries **unbounded**

**Text narrows, profile ranks (§3.3)**
- Anchor + `textSearch` returns a strictly **narrower** set than anchor alone,
  in the same relative order (fails today — returns the identical set)
- Anchor + `textSearch` matching nothing returns an empty set, not the
  unfiltered anchor-ranked feed
- `textSearch` with no anchor is unchanged (still the query vector)
- Healthy and degraded paths return the same *set* for the same `q` (order may
  differ — the fallback does no ranking)
- Two requests differing only in `textSearch` do not share a cache entry

**Domain control / All-tab removal**
- The list always requests exactly one `item_domain`; no request path can send
  zero or many
- With no `?domain=`, the list resolves to the D19 default
- Map multi-select changes **which** `/markers` queries are issued (D12), not
  just which markers render
- Map → list with several domains selected collapses to the first, and the chip
  bar shows it
- **P6 regression:** with a viewer location resolved, the rendered card order
  equals the `/discover` response order (fails today)

**Filter surface**
- The chip bar renders exactly one chip per active constraint, and none when
  nothing is applied
- Removing a chip re-queries with that constraint dropped; clear-all resets
  every one
- A non-interacting domain is listed as unavailable with its reason and cannot
  be selected
- Chip state is identical between list and map for the same filters
- Keyboard-only: every chip reachable, removable, focus lands on the bar
  afterwards
- Removing the search chip clears the app-bar search box (D25) — not just the
  query
- The sort control is **absent** in map view, not rendered disabled (D26); no
  `sort` chip appears on the map
- The bar stays visible while the list is scrolled, and does not gap or overlap
  when the app bar wraps to two lines at narrow widths (§7.3)
- Row 2 keeps a stable height between "nothing applied" and "filters applied",
  so the list does not shift under the user (§7.2)

**Card metric**
- Each `sort` renders the matching metric and no other
- Switching sort re-renders the metric without a stale value from the previous
  sort
- Anchor + typed text renders the **profile** label, not the search label (D14)
- No profile + text renders the search label
- Free-text scores disabled + no profile + `relevance` renders no metric, and
  sorting still works (§5.3)
- The pill is icon-only and carries no basis label (D22); the basis appears in
  the sticky bar, the tooltip and the explanation panel
- Cached 0–10 scores from before §5.2 are invalidated, not rendered 10× wrong
- The `dpg:matchScore:v1` sweep removes old entries rather than orphaning them
  (§5.2)
- The explanation panel lists exactly the `vectorize: true` fields for the
  domain with their weights, and labels any overlap display illustrative (§5.4)
- No card renders a score sourced from a different anchor than the current
  active profile (the existing `useMatchScore` profile-switch reset must
  survive the refactor)

**Test-run constraint (this machine, 8 GB):** cap Vitest to
`--pool=forks --maxWorkers=2` and turbo to `--concurrency=1`. Uncapped full
suites hang the system.

---

## 9. Summary

**A — fetch contract.** The list pages through the whole network by default:
location becomes opt-in (`anywhere` | `radius`), ordering becomes explicit on
the wire (`relevance` | `newest` | `nearest`) with the applied sort reported
back, and three real defects are fixed — the `item_id` tiebreaker (duplicate
and skipped items across pages), the rerank truncation guard, and typed search
being inert for every signed-in viewer.

**B — filter surface.** The All tab is removed, which deletes the unsolvable
multi-domain ordering question along with the mixed-domain confusion that
prompted it. Domain moves out of the sidebar into one control above the view —
single-select on list, multi-select on map — beside a chip bar that shows every
applied constraint with a clear-all, and the counterpart-only rule is explained
rather than silently enforced.

**C — card metric.** The card shows the reason it is where it is: a labelled
relevance % under `relevance`, a distance under `nearest`, an age under
`newest`. One scale end to end, dead LLM-era fields deleted, and an explanation
panel that is honest about what a single pooled embedding can and cannot tell
you.

**UI.** Approved (§7): app bar keeps the editors, a new sticky bar carries the
state — domain, sort, area, chips — and the card pill becomes icon-only, since
the sticky bar states the ranking basis once instead of every card repeating
it.
