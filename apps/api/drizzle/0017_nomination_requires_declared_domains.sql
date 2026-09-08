-- Nominating a default aggregator now REQUIRES the org to declare its domains.
--
-- Migration 0014 deliberately SKIPPED its declared-domain check when an org
-- declared nothing — "so this cannot lock out an existing deployment" — on the
-- reasoning that legacy mirrors predate `metadata.domains`. That was defensible
-- while nothing else read the column. It is not any more: this branch scopes
-- `POST /api/v1/admin/participant/decrypt` to the acting org's declared domains
-- and fails closed with `400 NO_DOMAINS_CONFIGURED` when there are none, exactly
-- as `aggregator/export.ts` already did.
--
-- The two guards therefore disagreed, and the disagreement built a dead end: a
-- legacy mirror could be nominated as a default aggregator, would then start
-- receiving participants, and could not decrypt a single one of them. An
-- operator following the documented nomination process would create that
-- silently, with a `RAISE WARNING` in the psql output as the only hint.
--
-- Two ways to make them agree. Refusing at nomination is the right one:
--
--   * The other option is decrypt DEGRADING to "no domain filter" for an org
--     that declares nothing. That is fail-open on the one path that returns
--     decrypted PII, for precisely the orgs whose scope is unknown. Wrong
--     direction.
--   * 0014's "cannot lock out an existing deployment" concern does not apply to
--     this check. Nominating a default is a deliberate, one-off operator
--     UPDATE, not something a running deployment does passively — no existing
--     traffic touches `default_for_bindings`. Refusing it costs the operator one
--     extra step (re-upsert the org with `domains`, which aggregator-dpg already
--     sends on both its call sites) and tells them why, instead of handing them
--     a default aggregator that cannot do its job.
--
-- So a nomination now fails with a message naming the fix. Everything else in
-- the function is unchanged: the advisory lock, the per-binding clash check, and
-- the defensive metadata parse all behave exactly as 0014 left them.
--
-- Custom migration: a trigger function is not expressible in the drizzle
-- schema, so per `apps/api/drizzle/README.md` this is hand-written.
CREATE OR REPLACE FUNCTION assert_default_binding_exclusive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  clash_id   text;
  clash_bind text;
  declared   jsonb;
BEGIN
  IF NEW.default_for_bindings IS NULL OR cardinality(NEW.default_for_bindings) = 0 THEN
    RETURN NEW;
  END IF;

  -- Serialise nominations so two concurrent writers cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtext('organization.default_for_bindings'));

  SELECT o.id, b
    INTO clash_id, clash_bind
    FROM organization o
    CROSS JOIN LATERAL unnest(o.default_for_bindings) AS b
   WHERE o.id <> NEW.id
     AND b = ANY (NEW.default_for_bindings)
   LIMIT 1;

  IF clash_id IS NOT NULL THEN
    RAISE EXCEPTION
      'binding % is already the default of org % — clear it there first',
      clash_bind, clash_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Parse defensively, matching `apps/api/src/utils/org_metadata.ts`: a null
  -- column, malformed JSON, a missing key or a non-array all degrade to "no
  -- declared domains". `metadata` is a plain text column, so a legacy row
  -- holding junk would otherwise fail the cast with `invalid input syntax for
  -- type json` — turning a clear refusal into a confusing one, on a statement
  -- support runs by hand.
  BEGIN
    declared := (NEW.metadata::jsonb) -> 'domains';
  EXCEPTION WHEN others THEN
    declared := NULL;
  END;

  -- No usable declared domains: REFUSE (0014 warned and continued). An org that
  -- does not say which domains it reports on cannot be given a population it is
  -- then unable to read.
  IF declared IS NULL
     OR jsonb_typeof(declared) <> 'array'
     OR jsonb_array_length(declared) = 0 THEN
    RAISE EXCEPTION
      'org % declares no metadata.domains, so it cannot be a default aggregator — re-upsert it via POST /api/v1/admin/aggregator/upsert with a non-empty domains array first',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The org must actually report on the domain it is being made default for.
  -- Doubles as a typo guard: a fat-fingered 'blue_dot/seekers' matches no
  -- declared domain and is rejected, where before it would have been accepted
  -- silently, tagged nobody, and still produced an audit row reading like a
  -- success.
  SELECT b
    INTO clash_bind
    FROM unnest(NEW.default_for_bindings) AS b
   WHERE split_part(b, '/', 2) NOT IN (
           SELECT jsonb_array_elements_text(declared))
   LIMIT 1;

  IF clash_bind IS NOT NULL THEN
    RAISE EXCEPTION
      'org % does not declare the domain in binding % (declares: %)',
      NEW.id, clash_bind,
      (SELECT string_agg(d, ',') FROM jsonb_array_elements_text(declared) AS d)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
