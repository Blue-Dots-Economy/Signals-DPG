import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

/**
 * Append-only audit of default-aggregator changes (#640, SS-3). Written by the
 * `organization_default_aggregator_audit` trigger (migration 0014), one row per
 * binding gained or lost. No updates, no deletes wired up — same shape as
 * `pii_reveal_audit`.
 *
 * A trigger rather than application code because the default is nominated by a
 * hand-written UPDATE (a support request), which no route would ever see.
 *
 * Known limit: a hand-over lands as TWO rows, because exclusivity forces
 * clearing org A before setting org B — a revoke (`to_org_id` null) and a grant
 * (`from_org_id` null). The grant row of a hand-over is therefore shaped
 * exactly like a first-ever nomination. Run the two UPDATEs in ONE transaction
 * so the pair shares a `changed_at`, which is what lets an operator correlate
 * them; a transaction id column would make it explicit and is the obvious
 * follow-up if this trail is ever read programmatically.
 *
 * Why this table exists at all: `organization` has no `updated_at`, and the
 * default is stored as a plain column, so without this there would be **no
 * trace of when a default changed** — and the default decides which
 * organisation may decrypt an entire inbound population's PII. The later
 * re-assignment job needs to know when the hand-over happened; it cannot be
 * reconstructed after the fact.
 *
 * `changed_by` is the Postgres role that ran the statement. If support connects
 * through one shared role, every change reads identically — the row says WHEN
 * and WHAT, not which human. Add a session-level audit context if per-operator
 * attribution is needed.
 *
 * No FK on `changed_by`: the role may be dropped later and the audit row must
 * survive it. `from_org_id` / `to_org_id` are likewise
 * unconstrained so an org row can be deleted without erasing history.
 */
export const aggregator_default_audit = pgTable(
  'aggregator_default_audit',
  {
    changeId: uuid('change_id').primaryKey().defaultRandom(),
    /** Canonical served-domain binding, e.g. 'blue_dot/seeker'. */
    binding: text('binding').notNull(),
    /** Null on the first assignment for this binding. */
    fromOrgId: text('from_org_id'),
    /**
     * Null when the binding was REVOKED — the org stood down and nothing took
     * over. Nullable on purpose: `bindings: []` is the documented way to stand
     * an aggregator down, and a NOT NULL column could not represent it, so the
     * single most consequential operation the endpoint supports would have gone
     * unaudited.
     */
    toOrgId: text('to_org_id'),
    /** The Postgres role that ran the statement. */
    changedBy: text('changed_by').notNull(),
    changedAt: timestamp('changed_at').notNull().defaultNow(),
  },
  (table) => [
    index('aggregator_default_audit_binding_idx').on(table.binding, table.changedAt),
    index('aggregator_default_audit_to_org_idx').on(table.toOrgId, table.changedAt),
  ]
);
