# signals-search: explicit sort, deterministic paging, text narrowing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `signals-search` (NOT Signals-DPG — that is a sibling plan)
**Goal:** Add an explicit `sort` to `/v1/search`, make paging deterministic, let a location order without filtering, and make typed search work when an anchor is present.

**Architecture:** Three files change. `schemas.ts` gains two optional `intent` fields and one response field. `search_route.ts` resolves the requested sort against its preconditions and reports what it actually applied. `search_query.ts` gains an `item_id` tiebreaker on every `ORDER BY`, an explicit-sort branch, and a text `WHERE` predicate. Every change is additive — an absent `sort` preserves today's inferred behaviour exactly, so this can ship and sit in production before Signals-DPG uses it.

**Tech Stack:** TypeScript, Fastify, Zod (`fastify-type-provider-zod`), `postgres.js` tagged templates, pgvector + PostGIS, Vitest with `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-09-03-list-view-sort-domain-and-card-metric-design.md` (in the Signals-DPG repo, branch `feat/644-list-view-sort-filters`)

**Contract:** `docs/superpowers/plans/2026-09-03-list-view-wire-contract.md` (same branch) — **FROZEN. Read it before Task 1.**

**Closes:** signals-search#148. Enables Blue-Dots-Economy/signals-dpg#644.

## Global Constraints

- **The wire contract is frozen.** Field names, placement and resolution rules come from the contract doc, not from your judgement. If you think it is wrong, stop and report — do not change it locally. A unilateral change yields a green build and a broken deploy.
- **`sort` and `orderingCenter` MUST live inside `message.intent`**, never on `message` beside `pagination`. `cacheKey` hashes the whole `intent`; wrong placement makes two different sorts share a cache entry.
- **Every `ORDER BY` in `search_query.ts` ends with `s.item_id ASC`** — all three explicit sorts *and* all three inferred paths.
- **Recency means `i.created_at DESC`**, never `s.indexed_at`.
- **Backward compatibility is mandatory.** Absent `sort` ⇒ byte-identical behaviour to today. There are existing tests; they must keep passing unmodified.
- **`sort: 'nearest'` must add NO `ST_DWithin` predicate.** Ordering by location must never truncate the candidate set. This is the entire point of #644.
- **Fallbacks never error.** An unsatisfiable `sort` degrades to `newest` and says so in `meta.sort_applied`.
- **Test commands:** `pnpm test` (all), `pnpm test <file>` (one), `pnpm typecheck`. Integration tests boot a real Postgres via testcontainers — first run pulls an image.
- **Low-RAM machine (8 GB):** run `pnpm test -- --pool=forks --maxWorkers=2`. An uncapped full suite can hang the system.
- **Do not open a PR against `main` or `develop`.** Base is `feature`. Open it as a **draft**.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/api/schemas.ts` | Zod wire contract | Add `sort` + `orderingCenter` to `IntentSchema`; add `sort_applied` to `SearchResponseSchema` |
| `src/api/search_route.ts` | Request orchestration | Resolve requested sort → applied sort; resolve the ordering centre; drop the anchor gate on text; rerank paging guard |
| `src/db/search_query.ts` | SQL construction | `item_id` tiebreaker everywhere; explicit-sort `ORDER BY`; text `WHERE` predicate; distance expression from an ordering centre |
| `src/api/schemas.test.ts` | Contract unit tests | New cases |
| `src/db/search_query.test.ts` | SQL unit/integration tests | New cases |
| `src/api/search_route_sort.test.ts` | **New** — sort resolution + reporting | New file |
| `src/api/search_route_text_narrow.test.ts` | **New** — #148 regression | New file |
| `src/api/search_route_paging.test.ts` | **New** — P1 tiebreaker + P2 rerank guard | New file |

Sort resolution lives in `search_route.ts` as an exported pure function so it is unit-testable without a database. SQL stays entirely in `search_query.ts`.

---

## Task 1: Sort resolution as a pure function

Do this first: it is the decision table every later task depends on, and it needs no database.

**Files:**
- Modify: `src/api/search_route.ts` (add an exported function; no call-site change yet)
- Test: `src/api/search_route_sort.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SortMode = 'relevance' | 'newest' | 'nearest';
  export function resolveSort(input: {
    requested?: SortMode;
    hasAnchor: boolean;
    hasText: boolean;
    hasCenter: boolean;
    hasSpatialFilter: boolean;
  }): SortMode;
  ```
  Used by Task 4 (route wiring) and Task 5 (SQL).

- [ ] **Step 1: Write the failing test**

Create `src/api/search_route_sort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSort } from './search_route.js';

const base = { hasAnchor: false, hasText: false, hasCenter: false, hasSpatialFilter: false };

describe('resolveSort — explicit requests', () => {
  it('honours relevance when an anchor is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasAnchor: true })).toBe('relevance');
  });

  it('honours relevance when only text is present', () => {
    expect(resolveSort({ ...base, requested: 'relevance', hasText: true })).toBe('relevance');
  });

  it('falls back to newest for relevance with neither anchor nor text', () => {
    expect(resolveSort({ ...base, requested: 'relevance' })).toBe('newest');
  });

  it('honours nearest when a centre resolves', () => {
    expect(resolveSort({ ...base, requested: 'nearest', hasCenter: true })).toBe('nearest');
  });

  it('falls back to newest for nearest with no centre', () => {
    expect(resolveSort({ ...base, requested: 'nearest' })).toBe('newest');
  });

  it('always honours newest', () => {
    expect(resolveSort({ ...base, requested: 'newest' })).toBe('newest');
  });
});

describe('resolveSort — inferred (no sort requested), preserving today’s behaviour', () => {
  it('infers relevance from an anchor', () => {
    expect(resolveSort({ ...base, hasAnchor: true })).toBe('relevance');
  });

  it('infers relevance from text', () => {
    expect(resolveSort({ ...base, hasText: true })).toBe('relevance');
  });

  it('infers nearest from a spatial filter when there is no query vector', () => {
    expect(resolveSort({ ...base, hasSpatialFilter: true, hasCenter: true })).toBe('nearest');
  });

  it('prefers the query vector over a spatial filter, as today', () => {
    expect(resolveSort({ ...base, hasAnchor: true, hasSpatialFilter: true, hasCenter: true })).toBe('relevance');
  });

  it('infers newest with no signals at all', () => {
    expect(resolveSort(base)).toBe('newest');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test src/api/search_route_sort.test.ts`
Expected: FAIL — `resolveSort is not a function` / no matching export.

- [ ] **Step 3: Implement the minimal function**

Add to `src/api/search_route.ts`, above `runSearch`:

```ts
export type SortMode = 'relevance' | 'newest' | 'nearest';

/**
 * Resolve the ORDER the request will actually get. Pure and exported so the
 * decision table is testable without a database or a live route.
 *
 * Contract (docs .../2026-09-03-list-view-wire-contract.md §1.2): an
 * unsatisfiable `sort` NEVER errors — it degrades to `newest`, and the caller
 * is told via `meta.sort_applied`. With no `sort` requested we reproduce
 * today's inferred precedence exactly (cosine > distance > recency) so
 * existing callers see no change.
 */
export function resolveSort(input: {
  requested?: SortMode;
  hasAnchor: boolean;
  hasText: boolean;
  hasCenter: boolean;
  hasSpatialFilter: boolean;
}): SortMode {
  const canRelevance = input.hasAnchor || input.hasText;

  if (input.requested === 'relevance') return canRelevance ? 'relevance' : 'newest';
  if (input.requested === 'nearest') return input.hasCenter ? 'nearest' : 'newest';
  if (input.requested === 'newest') return 'newest';

  // No explicit sort: today's inferred behaviour, preserved exactly.
  if (canRelevance) return 'relevance';
  if (input.hasSpatialFilter && input.hasCenter) return 'nearest';
  return 'newest';
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm test src/api/search_route_sort.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/api/search_route.ts src/api/search_route_sort.test.ts
git commit -m "feat(search): resolveSort decision table for explicit and inferred ordering"
```

---

## Task 2: Wire contract in Zod — `sort`, `orderingCenter`, `sort_applied`

**Files:**
- Modify: `src/api/schemas.ts` (`IntentSchema`, `SearchResponseSchema`)
- Test: `src/api/schemas.test.ts` (extend)

**Interfaces:**
- Consumes: `SortMode` from Task 1.
- Produces: `intent.sort`, `intent.orderingCenter`, `meta.sort_applied` — consumed by Tasks 3–5 and by the Signals-DPG plan.

- [ ] **Step 1: Write the failing tests**

Append to `src/api/schemas.test.ts`:

```ts
import { SearchRequestSchema, SearchResponseSchema } from './schemas.js';

describe('IntentSchema — sort (contract §1)', () => {
  const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
  const parse = (intent: unknown) =>
    SearchRequestSchema.safeParse({ context: ctx, message: { intent, pagination: { limit: 20, offset: 0 } } });

  it('accepts each sort value', () => {
    for (const sort of ['relevance', 'newest', 'nearest'] as const) {
      expect(parse({ sort }).success).toBe(true);
    }
  });

  it('rejects an unknown sort value', () => {
    expect(parse({ sort: 'cheapest' }).success).toBe(false);
  });

  it('treats sort as optional (backward compatible)', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts orderingCenter as a GeoJSON Point', () => {
    const r = parse({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } });
    expect(r.success).toBe(true);
  });

  it('rejects orderingCenter with a wrong coordinate arity', () => {
    expect(parse({ orderingCenter: { type: 'Point', coordinates: [77.59] } }).success).toBe(false);
  });

  it('does NOT require an anchor for orderingCenter (unlike anchorless spatial)', () => {
    expect(parse({ orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } }).success).toBe(true);
  });

  it('keeps sort and orderingCenter INSIDE intent, so the cache key covers them', () => {
    // Placement guard: cacheKey hashes {networkId, domain, itemType, intent,
    // pagination}. If these fields ever move to `message`, two different sorts
    // share a cache entry. Asserting the parsed shape locks the placement.
    const r = parse({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [1, 2] } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.message.intent.sort).toBe('nearest');
      expect(r.data.message.intent.orderingCenter).toEqual({ type: 'Point', coordinates: [1, 2] });
    }
  });
});

describe('SearchResponseSchema — sort_applied (contract §2)', () => {
  it('requires sort_applied on meta', () => {
    const ctx = { version: '1.0.0', messageId: 'm1', networkId: 'n', domain: 'd', itemType: 't' };
    const without = { context: ctx, message: { items: [], meta: { total: 0, limit: 20, offset: 0 } } };
    expect(SearchResponseSchema.safeParse(without).success).toBe(false);

    const withIt = { context: ctx, message: { items: [], meta: { total: 0, limit: 20, offset: 0, sort_applied: 'newest' } } };
    expect(SearchResponseSchema.safeParse(withIt).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/api/schemas.test.ts`
Expected: FAIL — `sort`/`orderingCenter` stripped by Zod (so the placement assertions get `undefined`), and the `sort_applied`-absent case wrongly succeeds.

- [ ] **Step 3: Implement**

In `src/api/schemas.ts`, add above `IntentSchema`:

```ts
// Explicit ordering (#644). ABSENT is meaningful: it preserves the historical
// inferred behaviour (cosine > distance > recency), so existing callers are
// unaffected. See resolveSort in search_route.ts.
export const SortModeSchema = z.enum(['relevance', 'newest', 'nearest']);

// A centre used ONLY for ordering — it never produces a WHERE predicate.
// Deliberately NOT subject to the anchorless-spatial refine below: an ordering
// centre needs no anchor, because it filters nothing.
const OrderingCenterSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]), // GeoJSON order: [lng, lat]
});
```

Inside `IntentSchema`'s object (before the `.superRefine`), add:

```ts
  sort: SortModeSchema.optional(),
  orderingCenter: OrderingCenterSchema.optional(),
```

In `SearchResponseSchema`, change the `meta` object to:

```ts
    meta: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      // Always present: the order actually applied after the §1.2 fallbacks,
      // so a client can never claim an order it did not get.
      sort_applied: SortModeSchema,
    }),
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/api/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm nothing else broke**

Run: `pnpm test -- --pool=forks --maxWorkers=2`
Expected: existing suites still pass **except** ones asserting a response `meta` shape — those now need `sort_applied`. Fix any such assertions by adding the field; do **not** relax the schema.

Also run: `pnpm test src/api/openapi.test.ts` — if it snapshots the spec, regenerate/update the snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/api/schemas.ts src/api/schemas.test.ts
git commit -m "feat(search): add intent.sort, intent.orderingCenter and meta.sort_applied to the wire contract"
```

---

## Task 3: `item_id` tiebreaker on every ORDER BY (P1)

The highest-value fix in the plan. Do it before the sort branches so the branches inherit it.

**Files:**
- Modify: `src/db/search_query.ts:96-100`
- Test: `src/api/search_route_paging.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — a behavioural guarantee later tasks rely on.

- [ ] **Step 1: Write the failing test**

Create `src/api/search_route_paging.test.ts`. Model the boot/fixture block on `src/api/search_route_rerank.test.ts` (same testcontainers + `items` table + apikey setup).

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { startPostgres, sqlClient } from '../../test/support/pg.js';
import { runMigrations } from '../db/migrate.js';
import { ItemSearchRepo } from '../db/item_search_repo.js';
import { loadNetworkRegistry } from '../config/network_registry.js';
import { buildServer } from './server.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Sql } from 'postgres';
import type { FastifyInstance } from 'fastify';

// P1 regression (spec §3.4). SQL leaves tied rows unordered, and each page is
// an independent query, so a tie group can arrange differently between pages —
// duplicating some rows and never returning others. Six items share ONE
// created_at and one indexed_at, so every ordering path hits the tie.

let pg: StartedPostgreSqlContainer; let sql: Sql; let app: FastifyInstance;
const N = 1024;
const RAW = 'sk_paging_tiebreaker_test_key_abcdefgh';
const net = 'purple_dot';
const IDS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'cccccccc-0000-4000-8000-000000000003',
  'dddddddd-0000-4000-8000-000000000004',
  'eeeeeeee-0000-4000-8000-000000000005',
  'ffffffff-0000-4000-8000-000000000006',
];
const TIED_AT = '2026-01-15T10:00:00.000Z';

function vec(seed: number) { const v = Array.from({ length: N }, () => 0); v[seed % N] = 1; return v; }

beforeAll(async () => {
  pg = await startPostgres(); const url = pg.getConnectionUri();
  await runMigrations(url); sql = sqlClient(url);
  await sql`CREATE TABLE items (item_network text,item_domain text,item_type text,item_id uuid,item_state jsonb NOT NULL DEFAULT '{}',item_locations jsonb NOT NULL DEFAULT '[]',lifecycle_status text NOT NULL DEFAULT 'live',item_instance_url text,item_schema_url text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,PRIMARY KEY (item_network,item_domain,item_type,item_id))`;
  await sql`CREATE TABLE "apikey" (id text PRIMARY KEY, key text NOT NULL, user_id text, enabled boolean NOT NULL DEFAULT true, expires_at timestamp, remaining integer)`;
  await sql`INSERT INTO "apikey" (id,key,user_id,enabled) VALUES ('k1', ${createHash('sha256').update(RAW).digest('base64url')}, 'usr_1', true)`;

  const repo = new ItemSearchRepo(sql, N);
  for (let i = 0; i < IDS.length; i++) {
    // Identical created_at across all six — the bulk-migration tie.
    await sql`INSERT INTO items (item_network,item_domain,item_type,item_id,created_at)
              VALUES (${net},'provider','profile_1.0',${IDS[i]},${TIED_AT}::timestamptz)`;
    await repo.upsert({ item_network: net, item_domain: 'provider', item_type: 'profile_1.0', item_id: IDS[i], embedding: vec(i), locations: [], lifecycleStatus: 'live', modelVersion: 'm', contentHash: `p${i}` });
  }
  // Force indexed_at to tie as well, so the inferred recency path also ties.
  await sql`UPDATE item_search SET indexed_at = ${TIED_AT}::timestamptz WHERE item_network = ${net}`;

  const registry = await loadNetworkRegistry('test/fixtures/networks');
  app = await buildServer({ sql, registry } as never);
  await app.ready();
});

afterAll(async () => { await app?.close(); await sql?.end(); await pg?.stop(); });

async function page(offset: number, sort?: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `m${offset}-${sort}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent: { ...(sort ? { sort } : {}) }, pagination: { limit: 3, offset } },
    },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { message: { items: { item_id: string }[] } }).message.items.map((i) => i.item_id);
}

describe('P1 — paging over tied sort keys', () => {
  it('newest: pages partition the set with no duplicates and no omissions', async () => {
    const p1 = await page(0, 'newest');
    const p2 = await page(3, 'newest');
    const union = [...p1, ...p2];
    expect(new Set(union).size).toBe(6);          // no duplicates
    expect([...union].sort()).toEqual([...IDS].sort()); // no omissions
  });

  it('newest: repeated identical requests return an identical order', async () => {
    expect(await page(0, 'newest')).toEqual(await page(0, 'newest'));
  });

  it('inferred (no sort) path is also deterministic', async () => {
    const p1 = await page(0);
    const p2 = await page(3);
    expect(new Set([...p1, ...p2]).size).toBe(6);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm test src/api/search_route_paging.test.ts -- --pool=forks --maxWorkers=2`
Expected: FAIL on the partition assertion (set size < 6, duplicates present).

> **If it passes before the fix:** Postgres happened to pick a stable plan for six rows. Do NOT conclude the bug is absent — it is provable from the SQL. Raise the row count to ~200 tied rows with `limit: 20` and re-run; the drift appears reliably at that size.

- [ ] **Step 3: Implement the tiebreaker**

Replace the `orderBy` block at `src/db/search_query.ts:95-100`:

```ts
  // ORDER BY: prefer cosine similarity when a vector is present; else distance;
  // else recency. EVERY branch ends with `s.item_id ASC`.
  //
  // Why the tiebreaker is mandatory (spec §3.4): SQL leaves tied rows
  // unordered, and each page is an independent query execution, so a tie group
  // can arrange differently between page N and page N+1 — rows appear twice
  // while others are never returned. item_id is unique per row, already in the
  // composite PK and already selected, and a sort comparator only reads it
  // INSIDE a tie group, so distinct leading keys never pay for it.
  const tiebreak = sql`s.item_id ASC`;
  const orderBy = vecLiteral
    ? sql`s.embedding <=> ${vecLiteral}::vector ASC, ${tiebreak}`
    : p.spatial
      ? sql`${distExpr} ASC NULLS LAST, ${tiebreak}`
      : sql`s.indexed_at DESC, ${tiebreak}`;
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/api/search_route_paging.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS (the `sort: 'newest'` cases still route through the inferred recency path — Task 5 changes that; determinism already holds).

- [ ] **Step 5: Verify the HNSW plan did not regress**

**Do not skip — this is the one genuine performance risk (spec §3.4).** Adding a second `ORDER BY` key can stop the planner using the HNSW index (`item_search_embedding_hnsw`), which would turn relevance search into a full sort.

Against a database with a realistic row count:

```sql
EXPLAIN ANALYZE
SELECT s.item_id
FROM item_search s JOIN items i USING (item_network, item_domain, item_type, item_id)
WHERE i.lifecycle_status = 'live'
ORDER BY s.embedding <=> '[...]'::vector ASC, s.item_id ASC
LIMIT 20;
```

Expected: an `Index Scan using item_search_embedding_hnsw`, optionally under an
`Incremental Sort`. **Record the plan in the PR description.**

If you instead see a full `Sort` over all matching rows: STOP and report. The
documented fallback is to keep the tiebreaker on the recency and distance paths
(ties common, no ANN index involved) and handle cosine ties separately —
but that is a contract-affecting decision, not yours to make alone.

- [ ] **Step 6: Commit**

```bash
git add src/db/search_query.ts src/api/search_route_paging.test.ts
git commit -m "fix(search): append item_id tiebreaker to every ORDER BY so paging cannot duplicate or skip rows"
```

---

## Task 4: Explicit sort in SQL + ordering centre that does not filter

**Files:**
- Modify: `src/db/search_query.ts` (`SearchParams`, distance expression, `ORDER BY`)
- Test: `src/db/search_query.test.ts` (extend)

**Interfaces:**
- Consumes: `SortMode` (Task 1), `item_id` tiebreaker (Task 3).
- Produces:
  ```ts
  export type SearchParams = {
    // ...existing
    sort: SortMode;                                  // now REQUIRED — caller resolves it
    orderingCenter?: { lat: number; lng: number };   // orders only, never filters
  };
  ```
  Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Append to `src/db/search_query.test.ts` (follow the file's existing setup):

```ts
describe('searchItems — explicit sort (contract §3)', () => {
  it('newest orders by items.created_at DESC, not item_search.indexed_at', async () => {
    // Two rows whose created_at and indexed_at orders are OPPOSITE, so the
    // two candidate columns cannot both satisfy the assertion. Guards D5/P4.
    const older = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const newer = 'bbbbbbbb-0000-4000-8000-00000000000b';
    await sql`UPDATE items SET created_at = '2026-01-01T00:00:00Z' WHERE item_id = ${older}`;
    await sql`UPDATE items SET created_at = '2026-06-01T00:00:00Z' WHERE item_id = ${newer}`;
    await sql`UPDATE item_search SET indexed_at = '2026-06-01T00:00:00Z' WHERE item_id = ${older}`;
    await sql`UPDATE item_search SET indexed_at = '2026-01-01T00:00:00Z' WHERE item_id = ${newer}`;

    const { rows } = await searchItems(sql, {
      item_network: net, item_domain: 'provider', item_type: 'profile_1.0',
      filters: [], limit: 10, offset: 0, sort: 'newest',
    });
    const seen = rows.map((r) => r.item_id);
    expect(seen.indexOf(newer)).toBeLessThan(seen.indexOf(older));
  });

  it('nearest orders by distance and adds NO radius filter', async () => {
    // A far row must still be RETURNED. Ordering by location must not truncate.
    const { rows, total } = await searchItems(sql, {
      item_network: net, item_domain: 'provider', item_type: 'profile_1.0',
      filters: [], limit: 10, offset: 0,
      sort: 'nearest',
      orderingCenter: { lat: 12.97, lng: 77.59 }, // Bengaluru
    });
    // A row seeded ~2000 km away is present, i.e. far outside the 30 km default.
    expect(rows.some((r) => (r.distanceMeters ?? 0) > 1_000_000)).toBe(true);
    expect(total).toBe(rows.length);
    const ds = rows.map((r) => r.distanceMeters ?? Number.POSITIVE_INFINITY);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds); // ascending
  });

  it('nearest puts location-less rows last, not first', async () => {
    const { rows } = await searchItems(sql, {
      item_network: net, item_domain: 'provider', item_type: 'profile_1.0',
      filters: [], limit: 20, offset: 0,
      sort: 'nearest', orderingCenter: { lat: 12.97, lng: 77.59 },
    });
    const firstNull = rows.findIndex((r) => r.distanceMeters == null);
    if (firstNull !== -1) {
      expect(rows.slice(firstNull).every((r) => r.distanceMeters == null)).toBe(true);
    }
  });

  it('a spatial FILTER still truncates, unchanged', async () => {
    const { rows } = await searchItems(sql, {
      item_network: net, item_domain: 'provider', item_type: 'profile_1.0',
      filters: [], limit: 20, offset: 0, sort: 'nearest',
      spatial: { lat: 12.97, lng: 77.59, distanceMeters: 30_000 },
    });
    expect(rows.every((r) => (r.distanceMeters ?? 0) <= 30_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/db/search_query.test.ts -- --pool=forks --maxWorkers=2`
Expected: FAIL — `sort` is not a known property; `newest` currently sorts by `indexed_at`.

- [ ] **Step 3: Implement**

In `src/db/search_query.ts`, extend the type:

```ts
export type SortMode = 'relevance' | 'newest' | 'nearest';

export type SearchParams = {
  item_network: string;
  item_domain: string;
  item_type: string;
  queryVector?: number[];
  /** ST_DWithin FILTER — decides membership. Unchanged. */
  spatial?: { lat: number; lng: number; distanceMeters: number };
  /**
   * Centre used ONLY to ORDER. Never contributes a WHERE predicate, so
   * `sort: 'nearest'` returns the whole candidate set nearest-first instead of
   * truncating it (#644). When `spatial` is also set, the caller may pass its
   * centre here too.
   */
  orderingCenter?: { lat: number; lng: number };
  /** Resolved by the caller via resolveSort — never inferred here. */
  sort: SortMode;
  filters: FilterClause[];
  limit: number;
  offset: number;
};
```

Replace the distance-expression block (`:86-93`) so it prefers the ordering centre:

```ts
  // Distance expression, reused in SELECT and ORDER BY (a bare alias can't be
  // referenced from the same SELECT's ORDER BY). The ORDERING centre wins over
  // the FILTER centre: `nearest` may be requested with no spatial filter at all.
  const distCenter = p.orderingCenter ?? (p.spatial ? { lat: p.spatial.lat, lng: p.spatial.lng } : undefined);
  const distExpr = distCenter
    ? sql`ST_Distance(
        s.geo,
        ST_SetSRID(ST_MakePoint(${distCenter.lng}, ${distCenter.lat}), 4326)::geography
      )::float8`
    : sql`NULL::float8`;
```

Replace the `orderBy` block from Task 3 with the explicit switch:

```ts
  // Explicit ORDER BY, driven by the caller-resolved sort. Every branch ends
  // with `s.item_id ASC` (see Task 3 / spec §3.4).
  //
  // `relevance` degrades to recency when no vector was supplied: resolveSort
  // should already have prevented that, so this is defence in depth, not a
  // second decision point.
  const tiebreak = sql`s.item_id ASC`;
  let orderBy: PendingQuery<Row[]>;
  switch (p.sort) {
    case 'relevance':
      orderBy = vecLiteral
        ? sql`s.embedding <=> ${vecLiteral}::vector ASC, ${tiebreak}`
        : sql`i.created_at DESC, ${tiebreak}`;
      break;
    case 'nearest':
      orderBy = distCenter
        ? sql`${distExpr} ASC NULLS LAST, ${tiebreak}`
        : sql`i.created_at DESC, ${tiebreak}`;
      break;
    case 'newest':
    default:
      // items.created_at, NOT item_search.indexed_at: a re-index or backfill
      // must not reshuffle the user-facing feed (spec D5 / P4).
      orderBy = sql`i.created_at DESC, ${tiebreak}`;
      break;
  }
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/db/search_query.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS. Seed the fixture rows the tests need (a ~2000 km-away row, a location-less row) if they are not already present.

- [ ] **Step 5: Commit**

```bash
git add src/db/search_query.ts src/db/search_query.test.ts
git commit -m "feat(search): explicit sort in SQL, with an ordering centre that never filters"
```

---

## Task 5: Route wiring — resolve, pass, report

**Files:**
- Modify: `src/api/search_route.ts` (`runSearch`)
- Test: `src/api/search_route_sort.test.ts` (extend with route-level cases)

**Interfaces:**
- Consumes: `resolveSort` (Task 1), schema fields (Task 2), `SearchParams.sort` / `.orderingCenter` (Task 4).
- Produces: `meta.sort_applied` on every 200 response.

- [ ] **Step 1: Write the failing test**

Append route-level cases to `src/api/search_route_sort.test.ts` (reuse the boot block from Task 3's file; extract it to `test/support/` if you prefer — but do not duplicate a third time):

```ts
describe('route — meta.sort_applied (contract §2)', () => {
  it('reports newest when relevance was requested with no anchor and no text', async () => {
    const body = await search({ sort: 'relevance' });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('reports nearest when a centre was supplied', async () => {
    const body = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } });
    expect(body.message.meta.sort_applied).toBe('nearest');
  });

  it('reports newest when nearest was requested with no centre', async () => {
    const body = await search({ sort: 'nearest' });
    expect(body.message.meta.sort_applied).toBe('newest');
  });

  it('reports a sort even when none was requested', async () => {
    const body = await search({});
    expect(['relevance', 'newest', 'nearest']).toContain(body.message.meta.sort_applied);
  });

  it('does not share a cache entry between two sorts (placement guard)', async () => {
    // Same everything except `sort`. If sort had been placed outside `intent`,
    // the second call would be served the first call's cached order.
    const a = await search({ sort: 'newest' });
    const b = await search({ sort: 'nearest', orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] } });
    expect(a.message.meta.sort_applied).toBe('newest');
    expect(b.message.meta.sort_applied).toBe('nearest');
  });
});
```

Helper (place beside the boot block):

```ts
async function search(intent: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: '/v1/search',
    headers: { 'x-api-key': RAW },
    payload: {
      context: { version: '1.0.0', messageId: `m-${JSON.stringify(intent)}`, networkId: net, domain: 'provider', itemType: 'profile_1.0' },
      message: { intent, pagination: { limit: 5, offset: 0 } },
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { message: { meta: { sort_applied: string }; items: unknown[] } };
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/api/search_route_sort.test.ts -- --pool=forks --maxWorkers=2`
Expected: FAIL — `sort_applied` undefined.

- [ ] **Step 3: Implement**

In `runSearch`, after the existing `spatialParam` resolution block (`~:101`), add:

```ts
  // Contract §1.3 — centre resolution for `nearest`, first match wins:
  // explicit orderingCenter > the spatial filter's own centre > the anchor's
  // stored location. Independent of the area filter by design: with no spatial
  // clause the candidate set stays network-wide while the order is
  // nearest-first (#644).
  const oc = message.intent.orderingCenter;
  const orderingCenter =
    oc ? { lat: oc.coordinates[1], lng: oc.coordinates[0] }
      : spatialParam ? { lat: spatialParam.lat, lng: spatialParam.lng }
      : anchorLat != null && anchorLng != null ? { lat: anchorLat, lng: anchorLng }
      : undefined;

  const sortApplied = resolveSort({
    requested: message.intent.sort,
    hasAnchor: !!message.intent.item?.id,
    hasText: !!message.intent.textSearch,
    hasCenter: !!orderingCenter,
    hasSpatialFilter: !!spatialParam,
  });
```

Pass both into `searchItems` (`~:105-112`):

```ts
  const { rows, total } = await searchItems(deps.sql, {
    item_network: networkId, item_domain: domain, item_type: itemType,
    queryVector,
    spatial: spatialParam,
    orderingCenter,
    sort: sortApplied,
    filters: (message.intent.filters ?? []) as FilterClause[],
    limit: willRerank ? topN : pagination.limit,
    offset: willRerank ? 0 : pagination.offset,
  });
```

And report it (`~:139`):

```ts
      meta: { total, limit: pagination.limit, offset: pagination.offset, sort_applied: sortApplied },
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/api/search_route_sort.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `pnpm test -- --pool=forks --maxWorkers=2` and `pnpm typecheck`
Expected: green. Existing tests asserting `meta` shape need `sort_applied` added.

- [ ] **Step 6: Commit**

```bash
git add src/api/search_route.ts src/api/search_route_sort.test.ts
git commit -m "feat(search): resolve and report the applied sort on /v1/search"
```

---

## Task 6: Text narrows, profile ranks (#148)

**Files:**
- Modify: `src/db/search_query.ts` (new text predicate), `src/api/search_route.ts:74` (drop the anchor gate)
- Test: `src/api/search_route_text_narrow.test.ts` (create)

**Interfaces:**
- Consumes: `SearchParams` (Task 4).
- Produces:
  ```ts
  // added to SearchParams
  textSearch?: string;
  textSearchFields?: string[];   // the vectorize:true field names
  ```

- [ ] **Step 1: Write the failing test**

Create `src/api/search_route_text_narrow.test.ts` (same boot block; seed provider rows whose `item_state` contains distinguishable text, e.g. one with `{"skills":"solar installation"}` and one with `{"skills":"borewell drilling"}`, plus a seeker anchor):

```ts
describe('#148 — typed search must narrow even when an anchor is present', () => {
  it('anchor + text returns a STRICTLY NARROWER set than anchor alone', async () => {
    const withoutText = await search({ item: { id: ANCHOR } });
    const withText = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    expect(withoutText.message.items.length).toBeGreaterThan(withText.message.items.length);
  });

  it('anchor + text keeps the anchor as the ranking basis', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    // A cosine score is present, i.e. the anchor's embedding still drove order.
    expect(body.message.items.every((i: { score?: number }) => i.score != null)).toBe(true);
    expect(body.message.meta.sort_applied).toBe('relevance');
  });

  it('anchor + text matching nothing returns an EMPTY set, not the unfiltered feed', async () => {
    const body = await search({ item: { id: ANCHOR }, textSearch: 'zzzznomatch' });
    expect(body.message.items).toHaveLength(0);
    expect(body.message.meta.total).toBe(0);
  });

  it('text with NO anchor is unchanged — still the query vector, and now also narrows', async () => {
    const body = await search({ textSearch: 'solar' });
    expect(body.message.items.length).toBeGreaterThan(0);
    expect(body.message.items.every((i: { score?: number }) => i.score != null)).toBe(true);
  });

  it('two requests differing only in textSearch do not share a cache entry', async () => {
    const a = await search({ item: { id: ANCHOR }, textSearch: 'solar' });
    const b = await search({ item: { id: ANCHOR }, textSearch: 'borewell' });
    expect(a.message.items.map((i: { item_id: string }) => i.item_id))
      .not.toEqual(b.message.items.map((i: { item_id: string }) => i.item_id));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/api/search_route_text_narrow.test.ts -- --pool=forks --maxWorkers=2`
Expected: FAIL — the first test finds the two sets IDENTICAL. That is the live bug.

- [ ] **Step 3: Implement the predicate**

Add to `SearchParams` in `src/db/search_query.ts`:

```ts
  /**
   * #148: applied as an additional value-match WHERE predicate, ANDed with
   * everything else — NOT as a competing query vector. So text narrows while
   * the anchor's embedding still ranks. Matched against the `vectorize: true`
   * fields, so narrowing and cosine-ranking describe the same content.
   */
  textSearch?: string;
  textSearchFields?: string[];
```

Add a builder above `searchItems`:

```ts
// OR across the vectorize fields, ANDed into the WHERE. Runs against
// i.item_state — item_search does not store the serialized text, and the
// `JOIN items i` is already present.
//
// Known looseness (accepted, contract §4): for an array-valued field,
// `->>'f'` yields the serialized JSON array as text (e.g. ["solar","wind"]),
// so ILIKE matches that text form.
function textFragment(sql: Sql, q: string, fields: string[]): PendingQuery<Row[]> | undefined {
  if (fields.length === 0) return undefined;
  const like = `%${q}%`;
  const parts = fields.map((f) => sql`COALESCE(i.item_state->>${f}, '') ILIKE ${like}`);
  return parts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc} OR ${p}`), parts[0]);
}
```

Inside `searchItems`, after the facet-filter loop (`:65`):

```ts
  if (p.textSearch && p.textSearchFields?.length) {
    const frag = textFragment(sql, p.textSearch, p.textSearchFields);
    if (frag) conds.push(sql`(${frag})`);
  }
```

- [ ] **Step 4: Drop the anchor gate and pass the fields**

In `src/api/search_route.ts`, change line 74 from
`if (!message.intent.item?.id && message.intent.textSearch) {`
to:

```ts
  // #148: text and an anchor are NO LONGER mutually exclusive. With an anchor
  // present its stored embedding remains the query vector (so relevance still
  // explains the order) and the text is applied as a narrowing WHERE predicate
  // in search_query.ts. Without an anchor, text becomes the query vector as
  // before. Embedding still runs only on a cache MISS.
  if (!queryVector && message.intent.textSearch) {
```

Then pass the fields into `searchItems`:

```ts
    ...(message.intent.textSearch
      ? {
          textSearch: message.intent.textSearch,
          textSearchFields: deps.registry.vectorizeFields(networkId, domain, itemType),
        }
      : {}),
```

> Note: `vectorizeFields` is already used for reranking at `search_route.ts:117`, so the call shape is established.

- [ ] **Step 5: Run to confirm pass**

Run: `pnpm test src/api/search_route_text_narrow.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/search_query.ts src/api/search_route.ts src/api/search_route_text_narrow.test.ts
git commit -m "fix(search): apply textSearch as a narrowing predicate so typed search works with an anchor (#148)"
```

---

## Task 7: Rerank paging guard (P2)

**Files:**
- Modify: `src/api/search_route.ts:103-126`
- Test: `src/api/search_route_paging.test.ts` (extend)

**Interfaces:**
- Consumes: everything above. Produces: no new surface.

- [ ] **Step 1: Write the failing test**

Append to `src/api/search_route_paging.test.ts`. Boot a second app instance with rerank enabled (`RERANK_DEFAULT=true`, a `RERANK_BASE_URL`, `RESULT_TOPN=4`), stubbing the reranker as the existing rerank test does:

```ts
describe('P2 — rerank must not truncate paging', () => {
  it('offset beyond topN returns real rows, not an empty page', async () => {
    // RESULT_TOPN=4, so offset 4 previously fell outside the over-fetched
    // window and returned [] while meta.total still reported the full count.
    const res = await rerankApp.inject({
      method: 'POST', url: '/v1/search',
      headers: { 'x-api-key': RAW },
      payload: {
        context: { version: '1.0.0', messageId: 'p2', networkId: net, domain: 'provider', itemType: 'profile_1.0' },
        message: { intent: { textSearch: 'solar' }, pagination: { limit: 2, offset: 4 } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { message: { items: unknown[]; meta: { total: number } } };
    expect(body.message.meta.total).toBeGreaterThan(4);
    expect(body.message.items.length).toBeGreaterThan(0); // was 0 before the guard
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test src/api/search_route_paging.test.ts -- --pool=forks --maxWorkers=2`
Expected: FAIL — `items.length` is 0.

- [ ] **Step 3: Implement the guard**

Replace `willRerank` at `:103`:

```ts
  // Rerank over-fetches `topN` from offset 0 and slices back, so a request
  // whose window falls outside that band would return an EMPTY page under a
  // full meta.total. Degrade ranking quality at depth instead: skip reranking
  // for that request and page natively from the requested offset (spec §3.6).
  const rerankEligible = deps.rerank.defaultOn && !!deps.rerank.baseUrl && !!message.intent.textSearch;
  const topN = Math.max(pagination.limit, deps.rerank.topN);
  const willRerank = rerankEligible && pagination.offset + pagination.limit <= topN;
```

Leave the `if (willRerank) { ... }` body unchanged — the same predicate now
gates the over-fetch and the slice-back, which is the invariant the existing
`search_route_rerank.test.ts` was written to protect.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm test src/api/search_route_paging.test.ts src/api/search_route_rerank.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS — both. The pre-existing rerank test must **not** be modified.

- [ ] **Step 5: Commit**

```bash
git add src/api/search_route.ts src/api/search_route_paging.test.ts
git commit -m "fix(search): skip reranking past the over-fetch window instead of returning an empty page"
```

---

## Task 8: Contract fixture, docs, draft PR

**Files:**
- Test: `src/api/search_route_sort.test.ts` (add the shared fixture)
- Modify: `src/api/search_route.ts` (route `description` string, `:169-171`)

- [ ] **Step 1: Add the cross-repo contract fixture**

Contract §9 — the same assertion Signals-DPG makes independently, so a divergence fails a test rather than a deploy:

```ts
describe('cross-repo contract fixture (wire-contract §9)', () => {
  it('anchor + text + nearest + orderingCenter behaves exactly as contracted', async () => {
    const body = await search({
      item: { id: ANCHOR },
      textSearch: 'solar',
      sort: 'nearest',
      orderingCenter: { type: 'Point', coordinates: [77.59, 12.97] },
    });
    // ordering by location must NOT truncate: a far row survives
    expect(body.message.items.some((i: { distanceMeters?: number }) => (i.distanceMeters ?? 0) > 1_000_000)).toBe(true);
    // and the reported sort is what we asked for
    expect(body.message.meta.sort_applied).toBe('nearest');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test src/api/search_route_sort.test.ts -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 3: Update the route description**

At `src/api/search_route.ts:169-171`, replace the ranking sentence:

```ts
      description:
        'Beckn-aligned envelope. Provide any combination of textSearch, an anchor item.id, ' +
        'spatial, orderingCenter, sort, and filters. Ordering: pass `intent.sort` ' +
        '(relevance | newest | nearest); when omitted, ordering is inferred as ' +
        'cosine → distance → recency for backward compatibility. `intent.spatial` ' +
        'FILTERS (s_dwithin); `intent.orderingCenter` only ORDERS and never filters. ' +
        '`meta.sort_applied` always reports the order actually used. textSearch ' +
        'narrows results even when an anchor supplies the ranking vector.',
```

- [ ] **Step 4: Full verification before the PR**

```bash
pnpm typecheck
pnpm test -- --pool=forks --maxWorkers=2
```
Both must be green. Paste the real output into the PR description — do not assert success without it.

- [ ] **Step 5: Commit and open a DRAFT PR into `feature`**

```bash
git add -A
git commit -m "test(search): cross-repo contract fixture; document the sort contract on the route"
git push -u origin <your-branch>
gh pr create --draft --base feature \
  --title "feat(search): explicit sort, deterministic paging, text narrowing (#148)" \
  --body "..."   # see the required contents below
```

PR body must state **what changed** (never "review fixes"), and include:
- The `EXPLAIN ANALYZE` plan from Task 3 Step 5, proving HNSW survived.
- `Closes #148`.
- `Part of Blue-Dots-Economy/signals-dpg#644` — and a note that the sibling Signals-DPG PR must not merge before this one, since it depends on `intent.sort`.
- An explicit statement that the change is backward compatible: absent `sort` preserves the previous inferred ordering.
- Real `pnpm test` / `pnpm typecheck` output.

---

## Self-Review

**Spec coverage** — every signals-search item in spec §6:

| Spec item | Task |
| --- | --- |
| `sort` in the envelope (§3.2) | 2, 5 |
| Ordering centre without a radius (§3.2) | 2, 4, 5 |
| `item_id` tiebreaker on every ORDER BY (§3.4, P1) | 3 |
| `i.created_at` recency, not `indexed_at` (D5, P4) | 4 |
| Text `WHERE` predicate over `vectorize` fields (§3.3, #148) | 6 |
| Rerank paging guard (§3.6, P2) | 7 |
| Report the applied sort (§3.2) | 5 |
| Cache key covers `sort` (§3.2) | 2, 5 |
| HNSW plan check (§3.4) | 3 Step 5 |
| Cross-repo contract fixture (contract §9) | 8 |

Not in this plan, by design: everything in Signals-DPG (BFF, UI, match-score, native fallback tiebreaker) — sibling plan.

**Placeholder scan:** no TBD/TODO; every code step carries real code; the only `# see below` is a PR body whose required contents are then enumerated.

**Type consistency:** `SortMode` is declared in Task 1 (`search_route.ts`) and re-declared in Task 4 (`search_query.ts`) so the DB layer does not import from the API layer — matching the existing direction of dependency in this repo, where `search_route.ts` imports from `search_query.ts` and never the reverse. `resolveSort`'s input keys (`requested`, `hasAnchor`, `hasText`, `hasCenter`, `hasSpatialFilter`) are identical in Tasks 1 and 5. `orderingCenter` is `{lat,lng}` inside `SearchParams` and GeoJSON `[lng,lat]` on the wire — converted once, in Task 5.
