import { eq, sql, type SQL } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import type { DbOrTx } from '@/services/db_types';
import { resolveServedNetworkForDomain } from '@/utils/served_domain_guard';

/**
 * Default-aggregator resolution (#640, SS-3).
 *
 * A user arriving through an uncontrolled inbound path — portal self-signup, or
 * a cold call to the network-hosted voice agent — has no aggregator of their
 * own. `user.onboarded_by_org_id` is the tenancy key for participant reads,
 * action authorisation and **PII decryption**, so leaving it null means nobody
 * is responsible for verifying that person and nobody can decrypt them.
 *
 * The default aggregator is a real, already-approved aggregator org that the
 * network admin nominates by a direct backend/support request — a hand-written
 * UPDATE of `organization.default_for_bindings` (#640's answer; there is no API
 * for it, and the database enforces the rules: a CHECK for `type='aggregator'`,
 * a trigger for per-binding exclusivity, a trigger rejecting a binding whose
 * domain the org does not declare, and an audit trigger so the change is
 * traceable).
 *
 * It is deliberately never system-generated: an org minted by the system has no
 * enabled Keycloak user, so the "unverified queue" it owns would be a queue
 * nobody can open. Note the database can only prove `type = 'aggregator'` —
 * `organization` has no approval/status column, so "already-approved" is a
 * process guarantee the runbook has to carry, not an enforced one.
 *
 * ## Resolution is per binding, and several defaults may coexist
 *
 * `organization.default_for_bindings` is per (network, domain) — product asked
 * for a per-domain default (#640 Q3) — and lookups are per binding. So one
 * aggregator may hold `['blue_dot/seeker','blue_dot/provider']`, AND two
 * different aggregators may hold one binding each.
 *
 * The second shape used to be blocked by `organization_single_default_idx`,
 * because the tag (`user.onboarded_by_org_id`) is per ACCOUNT and write-once
 * while items are per DOMAIN: an account spanning two domains had one owner
 * covering both, so the other domain's default could decrypt a participant it
 * did not own. That index is gone (migration 0016), because the ambiguity is
 * now removed at the source — `assertSingleDomain` in
 * `services/item_service.ts` keeps every account to a single domain at the one
 * choke point every create path shares, and `POST /api/v1/user/domains` is
 * write-once so a user cannot grant themselves a second one.
 *
 * `participant_decrypt` additionally filters on the acting org's declared
 * domains, so a leak would need both invariants to fail rather than one.
 *
 * What remains enforced is per-binding exclusivity — no two orgs are the
 * default for the SAME binding — by the
 * `organization_default_binding_exclusive` trigger (migration 0014). Postgres
 * cannot unique-index an array element, which is why that one is a trigger.
 */

export interface DefaultAggregatorResolution {
  /** The default aggregator, or null when none is nominated. */
  org_id: string | null;
}

/** Canonical served-domain binding key, same shape as `binding.key` in `served_domain_guard.ts`. */
export const bindingKey = (network: string, domain: string): string => `${network}/${domain}`;

/**
 * THE lookup for a binding's default aggregator.
 *
 * `LIMIT 1` is safe because `organization_default_binding_exclusive` guarantees
 * at most one org holds any given binding.
 */
export const defaultAggregatorQuery = (binding: string): SQL =>
  sql`SELECT id FROM organization
       WHERE default_for_bindings && ARRAY[${binding}]::text[]
         AND type = 'aggregator'
       LIMIT 1`;

/**
 * The default aggregator for a served-domain binding.
 *
 * Not cached. It runs at most once per user, inside a transaction that is
 * already writing an item — and the value is changed by an operator, so a cache
 * would introduce a stale window with nothing to invalidate it.
 */
export async function resolveDefaultAggregator(
  exec: DbOrTx,
  network: string,
  domain: string,
): Promise<DefaultAggregatorResolution> {
  const result = (await exec.execute(
    defaultAggregatorQuery(bindingKey(network, domain)),
  )) as unknown as { rows?: Array<{ id: string }> };

  return { org_id: result.rows?.[0]?.id ?? null };
}

/**
 * Fill `user.onboarded_by_org_id` from the default aggregator, but only if it
 * is still unset.
 *
 * `IS NULL` in the WHERE makes the write **write-once at the database level**:
 * a later profile create or edit can never re-point an existing tag, so moving
 * someone between aggregators stays an explicit, audited operation rather than
 * something that can happen by accident.
 *
 * `onboarded_by_default` is what marks these users as *defaulted* rather than
 * genuinely onboarded. It is a server-only column on purpose — `onboarded_via`
 * is written from the request's `channel` field, so a caller could set it, and
 * this flag is the key the re-assignment job scopes on.
 *
 * `onboarded_at` is filled with `coalesce` so a participant who was onboarded
 * months ago (voice/account-only creates already write a real `onboarded_at`
 * with a null org) does not have their genuine join date overwritten with the
 * tagging time — `item_metrics.age_days` and `profile_status` are derived from
 * it, and a dormant participant must not resurface as brand new.
 *
 * @returns whether this call actually wrote the tag.
 */
export async function tagUserWithDefaultAggregator(
  exec: DbOrTx,
  userId: string,
  network: string,
  domain: string,
): Promise<{ tagged: boolean }> {
  const binding = bindingKey(network, domain);

  // One statement, and the guard short-circuits the lookup. For a user who
  // already has an owner the WHERE fails, so the subqueries never execute —
  // no `organization` scan. That is what makes this cheap enough to run on
  // every profile create rather than only on a user's first one.
  //
  // The EXISTS matters: without it, a create on an instance with no default
  // nominated would write NULL over NULL and burn a row version.
  const updated = (await exec.execute(sql`
    UPDATE "user"
       SET onboarded_by_org_id = (
             SELECT id FROM organization
              WHERE default_for_bindings && ARRAY[${binding}]::text[]
                AND type = 'aggregator'
              LIMIT 1),
           onboarded_by_default = true,
           onboarded_via = coalesce(onboarded_via, 'self'),
           onboarded_at  = coalesce(onboarded_at, now()),
           updated_at    = now()
     WHERE id = ${userId}
       AND onboarded_by_org_id IS NULL
       AND EXISTS (
             SELECT 1 FROM organization
              WHERE default_for_bindings && ARRAY[${binding}]::text[]
                AND type = 'aggregator')
    RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };

  return { tagged: (updated.rows ?? []).length > 0 };
}

export interface OwnerGateContext {
  has_owner: boolean;
  /** Whether a default aggregator is nominated for this binding. */
  default_configured: boolean;
}

/**
 * The two signals the `owner_required` go-live gate needs: whether the profile
 * owner has an owning aggregator, and whether a default is nominated for this
 * binding at all.
 */
export async function resolveOwnerGateContext(
  exec: DbOrTx,
  ownerUserId: string,
  network: string,
  domain: string,
): Promise<OwnerGateContext> {
  const [owner] = await exec
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, ownerUserId))
    .limit(1);

  const resolution = await resolveDefaultAggregator(exec, network, domain);

  return {
    // A missing user row counts as "no owner" — fail closed. It should not
    // happen (items FK to `user`), and treating it as owned would be the
    // wrong direction on a gate that exists to guarantee an owner.
    has_owner: Boolean(owner?.onboardedByOrgId),
    default_configured: Boolean(resolution.org_id),
  };
}

/**
 * Tag a user from the default aggregator for the domain they just joined.
 *
 * THE user-level entry point (#640). Called wherever `user.domains` is first
 * established — the three places that decide which domain a user belongs to:
 *
 *   1. `applySignupExtras` (provisioning) — portal signup, from the stash
 *   2. `POST /api/v1/user/domains`        — explicit pick (write-once)
 *
 * A third caller used to live in `create_item`'s first-create bootstrap; that
 * bootstrap moved into `assertSingleDomain`, and `create_item` now calls
 * `tagUserWithDefaultAggregator` directly with the request's concrete network.
 *
 * Tagging belongs here rather than on every item write: ownership is a property
 * of the ACCOUNT, decided once when its domain is decided. Running it per item
 * write meant re-resolving the default on edits by users who were already
 * owned, which is work whose result is always discarded.
 *
 * Derives the network from the instance's served bindings, since `user.domains`
 * stores a bare domain. A domain that is unserved or ambiguous leaves the user
 * untagged (see `resolveServedNetworkForDomain`).
 *
 * @returns whether the tag was written.
 */
export async function tagUserForDomain(
  exec: DbOrTx,
  userId: string,
  domain: string,
): Promise<boolean> {
  const network = resolveServedNetworkForDomain(domain);
  if (!network) return false;

  const { tagged } = await tagUserWithDefaultAggregator(exec, userId, network, domain);
  return tagged;
}
