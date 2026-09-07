import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/services/db_types';

/**
 * The single-domain lock's two primitives, in one leaf module.
 *
 * ## Why this file exists
 *
 * An account holds profiles in exactly ONE domain, for life.
 * `user.onboarded_by_org_id` — the tenancy key deciding which aggregator org
 * may decrypt a participant's PII — is per ACCOUNT and write-once, while items
 * are per DOMAIN. An account spanning two domains therefore has one owner
 * covering both, which lets one domain's default aggregator decrypt the other
 * domain's participant. That invariant is what allows a DIFFERENT default
 * aggregator per domain to exist at all.
 *
 * Two places decide an account's domain, and both must apply the same rule:
 *
 *   - `assertSingleDomain` (`services/item_service.ts`) — on every item create
 *   - `POST /api/v1/user/domains` (`routes/v1/user/user_domains.ts`) — the
 *     explicit pick made at signup
 *
 * They were written as two copies of the same SQL, and the copies drifted: the
 * route's claim was missing the `NOT EXISTS items` guard below, so two ordinary
 * HTTP calls granted a second domain to any account whose column was empty
 * while it already owned items — and that is the state of every aggregator- and
 * voice-onboarded participant until migration 0015 runs. The drift was
 * self-reinforcing: once the route wrote a domain, the column was no longer
 * empty, so `assertSingleDomain` never reached its `items` fallback and simply
 * trusted the value the route had laundered in.
 *
 * Hence one implementation, imported by both. A future third caller gets the
 * rule for free rather than a third chance to diverge.
 *
 * ## Known limit: the key is the bare domain, not (network, domain)
 *
 * `user.domains` stores a bare domain while `organization.default_for_bindings`
 * is per `<network>/<domain>`. On an instance serving two networks that declare
 * the same domain (`served_domain_guard.ts` documents `blue_dot` and
 * `purple_dot` both declaring `seeker`), those are ONE lock slot but TWO
 * tenancies, so the lock does not stop an account holding both. Accepted
 * deliberately: no deployment serves such a pair today. Resolving it means
 * either storing `network/domain` here, or scoping the aggregator read paths to
 * the networks of an org's own bindings instead of every served network — the
 * latter belongs with the per-profile ownership work in #661.
 *
 * @see `assertSingleDomain` for the create-path guard built on these.
 */

/**
 * Record `domain` as the account's domain, but only if it has none yet.
 *
 * Two guards, and both matter:
 *
 * `cardinality(domains) = 0` makes this write-once at the database level, so no
 * later call can re-point an existing lock — moving someone between domains
 * stays an explicit support operation. It is also what makes concurrency safe
 * without an advisory lock: a second caller picking a different domain blocks on
 * the row lock, re-evaluates its WHERE against the committed value, matches
 * nothing, and falls through to {@link readLockedDomains}.
 *
 * `NOT EXISTS items` is what makes the lock correct on a database that has never
 * been backfilled. The deploy migration is a Helm `post-install,post-upgrade`
 * hook (`docs/operations/migrations.md`), so pods serve traffic BEFORE
 * migration 0015 fills the column — and `POST /admin/participant` never wrote it
 * at all, so a legacy participant can hold a seeker profile with an empty
 * column. Without this guard a provider request in that window would claim
 * `provider`, leaving the account holding two domains while reading as locked to
 * the wrong one: a state 0015 cannot repair, because it only fills EMPTY
 * columns, and which its own `cardinality(domains) > 1` audit query cannot even
 * find. The same applies every time the documented support reset
 * (`UPDATE "user" SET domains='{}'`) is used on an account that owns items.
 *
 * @returns whether this call recorded the domain. `false` means the account
 *   already has one, or owns items, or does not exist — call
 *   {@link readLockedDomains} to find out which.
 */
export async function claimDomain(
  exec: DbOrTx,
  userId: string,
  domain: string,
): Promise<boolean> {
  const claimed = (await exec.execute(sql`
    UPDATE "user"
       SET domains = ARRAY[${domain}]::text[],
           updated_at = now()
     WHERE id = ${userId}
       AND (domains IS NULL OR cardinality(domains) = 0)
       AND NOT EXISTS (SELECT 1 FROM items WHERE created_by = ${userId})
    RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };

  return (claimed.rows ?? []).length > 0;
}

/**
 * The domains an account is locked to.
 *
 * `user.domains` first, then the domains of the items it actually owns. The
 * column is a cache; `items` is the source of truth, and unlike the column no
 * write path can have failed to record it. Reading the fallback only when the
 * column is empty keeps the extra query off the common path — and after
 * migration 0015 an empty column means a brand-new account, which owns no items,
 * so the query finds nothing and costs a couple of index probes.
 * (`items` is LIST-partitioned on `item_network`, one partition per network,
 * each carrying `items_created_by_idx`.)
 *
 * Callers must treat an empty result as "this account does not exist" rather
 * than "allow anything": {@link claimDomain} already declines for an account
 * that owns items, so by the time this returns empty there is nothing to lock.
 *
 * @returns every domain the account may create in. More than one entry only for
 *   a legacy account that already held items in two domains before the lock
 *   existed — migration 0015 records both, and callers honour both, so the rule
 *   stops NEW multi-domain accounts rather than retroactively breaking old ones.
 */
export async function readLockedDomains(exec: DbOrTx, userId: string): Promise<string[]> {
  const fromColumn = (await exec.execute(sql`
    SELECT domains FROM "user" WHERE id = ${userId} LIMIT 1
  `)) as unknown as { rows?: Array<{ domains: string[] | null }> };

  const declared = fromColumn.rows?.[0]?.domains ?? [];
  if (declared.length > 0) return declared;

  const fromItems = (await exec.execute(sql`
    SELECT DISTINCT item_domain FROM items WHERE created_by = ${userId}
  `)) as unknown as { rows?: Array<{ item_domain: string }> };

  return (fromItems.rows ?? []).map((r) => r.item_domain);
}

/** The `DOMAIN_LOCKED` copy, so the create path and the route cannot drift. */
export const domainLockedMessage = (locked: string, requested: string, verb: string): string =>
  `You are registered as "${locked}" and cannot ${verb} "${requested}".`;
