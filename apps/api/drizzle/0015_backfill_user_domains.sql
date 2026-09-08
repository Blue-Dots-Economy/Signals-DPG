-- Backfill `user.domains` from the items each user actually owns.
--
-- `POST /api/v1/admin/participant` never wrote the column, so every
-- aggregator- and voice-onboarded participant has `{}` no matter how many
-- profiles they hold. Two things read it, and this fixes both:
--
--   * `GET /api/v1/user/domains`, which the profile form's domain picker reads.
--     Today it returns `[]` for that whole population.
--   * the single-domain lock (`assertSingleDomain` in
--     `services/item_service.ts`), which treats an empty column as "not decided
--     yet — allow any served domain".
--
-- NOTE this migration is a correctness aid, NOT a prerequisite for the lock.
-- The deploy migration is a Helm `post-install,post-upgrade` hook
-- (docs/operations/migrations.md), so new pods serve traffic BEFORE it commits
-- — a lock that depended on it would be wrong for that whole window, and would
-- record the WRONG domain for anyone who created in it, which this statement's
-- "only fill empty columns" guard then could not repair. So the claim in
-- `assertSingleDomain` is additionally guarded on the user owning no items, and
-- falls back to reading the domains off `items` when the column is empty.
-- `items` is the real source of truth; this column is a cache of it.
--
-- Only fills rows that are empty. A user whose domain was recorded at signup
-- (`applySignupExtras`) or on a first create is already authoritative and is
-- left alone — this must never re-point an existing lock.
--
-- Custom migration: data, not schema. Nothing here is expressible in
-- `db/postgres/schema/*.ts`, so per `apps/api/drizzle/README.md` it is
-- hand-written rather than generated.
--
-- UNBATCHED, deliberately. Backfills elsewhere in this ecosystem are batched,
-- so the inconsistency needs a reason rather than an omission: drizzle runs each
-- migration in one transaction, so this holds row locks on the matched `user`
-- rows for the duration of the scan below. Two things make that acceptable here
-- and neither is "it's probably small enough":
--
--   * It is no longer on the correctness path. `assertSingleDomain` reads the
--     domains off `items` when the column is empty, so the lock is right whether
--     or not this has run (see the NOTE above). A slow backfill delays the
--     profile-form picker showing the right domain; it cannot mislabel anyone.
--   * It only ever locks rows it changes — `AND (u.domains IS NULL OR
--     cardinality(u.domains) = 0)`. A concurrent `assertSingleDomain` claim on
--     one of those rows blocks, then re-reads the backfilled value and behaves
--     correctly; it does not fail.
--
-- Batch it if `items` grows to where a single GROUP BY over every partition is a
-- multi-minute statement. Today it is one pass over a table whose row count is
-- in the thousands.
--
-- Deliberately NOT filtered to one network. `user.domains` stores a bare domain
-- with no network qualifier, and an instance may serve several networks, so the
-- authoritative answer is "every domain this user has items in" regardless of
-- network. `items` is LIST-partitioned on `item_network`, so this reads every
-- partition once — acceptable for a one-shot migration, and the grouping is on
-- the `items_created_by_idx` leading column.
--
-- Multi-domain users: a user with items in two domains gets BOTH recorded.
-- `assertSingleDomain` allows any domain already in the array, so such a user
-- keeps working exactly as today and is not retroactively broken by a rule that
-- did not exist when their profiles were created. They are also the population
-- that made a global single-default necessary in the first place, so find them
-- before nominating a second default aggregator:
--
--   SELECT id, domains FROM "user" WHERE cardinality(domains) > 1;
--
-- Going forward the lock prevents new ones.
UPDATE "user" u
   SET domains = sub.domains,
       updated_at = now()
  FROM (
    SELECT created_by, array_agg(DISTINCT item_domain) AS domains
      FROM items
     GROUP BY created_by
  ) sub
 WHERE u.id = sub.created_by
   AND (u.domains IS NULL OR cardinality(u.domains) = 0);
