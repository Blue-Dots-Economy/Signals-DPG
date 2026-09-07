-- SS-3 (#640) — two triggers on organization.default_for_bindings.
--
-- The default aggregator is nominated by a "direct backend/support request"
-- (product's answer on #640): a hand-written UPDATE, no API. So both the
-- exclusivity rule and the audit trail have to live in the database — an
-- application route would never see the write.
--
-- Custom migration: triggers are not expressible in the drizzle schema, so per
-- apps/api/drizzle/README.md this is hand-written rather than generated.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Exclusivity: no two orgs may be the default for the SAME binding.
--
-- SECOND LAYER. `organization_single_default_idx` (migration 0013) is the
-- primary guard and currently permits only ONE default org instance-wide, so
-- a contested binding cannot arise while that index is in place — a second
-- nomination fails with 23505 before this trigger is reached.
--
-- This exists because that index is temporary. Per-domain defaults are the
-- intended end state, blocked today only by the tag being per ACCOUNT while
-- `participant_decrypt` scopes without a domain condition — so with two
-- per-domain defaults, a multi-domain user (reachable: admin api-key callers
-- bypass the single-role lock in create_item.ts) would let one default decrypt
-- the other's participant. Once the per-profile `profile_origin` work (#661)
-- removes that exposure, 0013's index comes off and THIS becomes the guard
-- that matters: several orgs holding one binding each, never two on the same
-- binding.
--
-- Postgres cannot unique-index an array *element*, and there is no gist opclass
-- for text[] overlap, so per-binding exclusivity has to be a trigger. The
-- advisory lock makes it safe against two concurrent nominations, which would
-- otherwise each see a clear field and both commit.
-- ─────────────────────────────────────────────────────────────────────────────
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

  -- The org must actually report on the domain it is being made default for.
  --
  -- Dropping the old admin endpoint took two validations with it that the
  -- database had not replaced: this one, and "is the binding served by this
  -- instance" (which the DB cannot know — SERVED_DOMAINS is env config). This
  -- restores the one that is checkable, and it doubles as a typo guard: a
  -- fat-fingered 'blue_dot/seekers' matches no declared domain and is
  -- rejected, where before it would have been accepted silently, tagged
  -- nobody, and still produced an audit row reading like a success.
  --
  -- Skipped when the org declares nothing (legacy mirrors predate
  -- metadata.domains), so this cannot lock out an existing deployment.
  -- Parse defensively, matching `apps/api/src/utils/org_metadata.ts`, which
  -- degrades a null column, malformed JSON, a missing key or a non-array to
  -- "no declared domains". `metadata` is a plain text column, so a legacy row
  -- holding junk would otherwise fail the cast with `invalid input syntax for
  -- type json`, and a scalar `domains` would fail with `cannot get array
  -- length of a scalar` — turning a clear refusal into a confusing one, on a
  -- statement support runs by hand.
  --
  -- Degrade rather than block, so bad metadata cannot wedge a nomination, but
  -- WARN so it is visible in the psql output rather than silently skipping a
  -- safety check.
  BEGIN
    declared := (NEW.metadata::jsonb) -> 'domains';
  EXCEPTION WHEN others THEN
    declared := NULL;
  END;

  IF declared IS NULL OR jsonb_typeof(declared) <> 'array' THEN
    IF NEW.metadata IS NOT NULL AND NEW.metadata <> '' THEN
      RAISE WARNING
        'org % has no usable metadata.domains — skipping the declared-domain check',
        NEW.id;
    END IF;
  ELSIF jsonb_array_length(declared) > 0 THEN
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
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS organization_default_binding_exclusive ON organization;
--> statement-breakpoint
CREATE TRIGGER organization_default_binding_exclusive
BEFORE INSERT OR UPDATE OF default_for_bindings ON organization
FOR EACH ROW
EXECUTE FUNCTION assert_default_binding_exclusive();
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Audit: one row per binding gained or lost.
--
--   to_org_id   NULL => the binding was REVOKED (nothing took over)
--   from_org_id NULL => genuinely the FIRST nomination for this binding
--
-- A hand-over is two rows (a revoke of A, then a grant to B, because
-- exclusivity forces clearing A first), and the grant carries
-- from_org_id = A — recovered from the audit trail itself, since `organization`
-- has already forgotten. So a transfer is self-describing and does not depend
-- on the operator running both statements in one transaction.
--
-- `changed_by` is the Postgres role that ran the statement — the only identity
-- a hand-written UPDATE has. It answers "which role", not "which person": if
-- support shares one application login, that is all the trail can say. Issue
-- individual DB logins if per-operator attribution is needed; that operational
-- control is what makes this audit worth having.
--
-- `changed_by` is the Postgres role that ran the statement, the only identity
-- available for a hand-written UPDATE. `organization` has no `updated_at`, and
-- this column decides which organisation may decrypt an inbound population's
-- PII, so a change with no trace would be unauditable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION log_default_aggregator_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  -- Named `bnd`, not `binding`: a plpgsql variable sharing a column name makes
  -- `WHERE a.binding = binding` ambiguous and the trigger fails at runtime.
  bnd   text;
  prior text;
BEGIN
  FOR bnd IN
    SELECT unnest(coalesce(NEW.default_for_bindings, '{}'::text[]))
    EXCEPT
    SELECT unnest(coalesce(OLD.default_for_bindings, '{}'::text[]))
  LOOP
    -- Who held this binding immediately before now.
    --
    -- Exclusivity forces clear-then-set, so by the time this grant fires the
    -- previous holder's row is already cleared and `organization` no longer
    -- knows. The audit table does: the last row for this binding names the
    -- last holder — `to_org_id` on a grant, or `from_org_id` on a revoke.
    --
    -- Without this every grant read `from_org_id = NULL`, making a hand-over
    -- indistinguishable from a first-ever nomination and pushing correlation
    -- onto the operator running both UPDATEs in one transaction. This table's
    -- whole job is answering "who changed PII-decrypt rights", so the rows
    -- need to be self-describing.
    SELECT coalesce(a.to_org_id, a.from_org_id)
      INTO prior
      FROM aggregator_default_audit a
     WHERE a.binding = bnd
     ORDER BY a.changed_at DESC, a.change_id DESC
     LIMIT 1;

    INSERT INTO aggregator_default_audit (binding, from_org_id, to_org_id, changed_by)
    VALUES (bnd, prior, NEW.id, session_user);
  END LOOP;

  FOR bnd IN
    SELECT unnest(coalesce(OLD.default_for_bindings, '{}'::text[]))
    EXCEPT
    SELECT unnest(coalesce(NEW.default_for_bindings, '{}'::text[]))
  LOOP
    INSERT INTO aggregator_default_audit (binding, from_org_id, to_org_id, changed_by)
    VALUES (bnd, OLD.id, NULL, session_user);
  END LOOP;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Scoped to the column, and only when it actually changed, so the
-- /aggregator/upsert mirror rewriting name/logo/metadata writes no audit rows.
DROP TRIGGER IF EXISTS organization_default_aggregator_audit ON organization;
--> statement-breakpoint
CREATE TRIGGER organization_default_aggregator_audit
AFTER UPDATE OF default_for_bindings ON organization
FOR EACH ROW
WHEN (
  coalesce(OLD.default_for_bindings, '{}'::text[])
    IS DISTINCT FROM coalesce(NEW.default_for_bindings, '{}'::text[])
)
EXECUTE FUNCTION log_default_aggregator_change();
