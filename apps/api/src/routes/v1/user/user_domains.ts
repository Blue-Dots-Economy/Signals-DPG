import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { tagUserForDomain } from '@/services/aggregator/default_aggregator';
import {
  claimDomain,
  domainLockedMessage,
  readLockedDomains,
} from '@/services/items/single_domain_lock';

// `.max(1)`: the column is an array for a future multi-role case, but one
// account may declare exactly ONE domain. Two in a single call would mint the
// multi-domain account `assertSingleDomain` exists to prevent, in one request.
const SetDomainsBody = z.object({ domains: z.array(z.string().min(1)).min(1).max(1) });
const DomainsResponse = z.object({ domains: z.array(z.string()) });
type SetReq = FastifyRequest<{ Body: z.infer<typeof SetDomainsBody> }>;

/**
 * The domain role the current user may create profiles in. Persisted at
 * signup. The profile form uses it to narrow its domain picker.
 *
 * This IS an authorization boundary, unlike when it was written. `user.domains`
 * is what `assertSingleDomain` (`services/item_service.ts`) reads to keep an
 * account to a single domain, and that single-domain invariant is what allows a
 * DIFFERENT default aggregator per domain — `user.onboarded_by_org_id` grants
 * PII-decrypt rights and is per ACCOUNT, so an account spanning two domains
 * would let one domain's default decrypt the other's participant.
 *
 * So POST is write-once, matching the create path: set it when unset, accept a
 * no-op repeat, and refuse a different domain with the same `DOMAIN_LOCKED`
 * body `create_item` returns, via the shared primitives in
 * `services/items/single_domain_lock.ts`.
 *
 * Two bugs lived here, both letting a user grant themselves a second domain and
 * walk past the lock: it UNIONed the submitted domains onto the existing ones,
 * and then — once that was fixed with a local copy of the create path's claim —
 * that copy was missing the `NOT EXISTS items` guard, so an account with an
 * empty column but existing items was still handed a second domain. Hence one
 * shared implementation rather than a third copy.
 *
 * Deliberately no reset path: clearing a domain is a support operation
 * (`UPDATE "user" SET domains='{}' WHERE id=…`), the same shape as nominating a
 * default aggregator. Deleting your last profile does NOT release the lock.
 *
 * Null column → empty array.
 */
export const user_domains: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/domains',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], response: { 200: DomainsResponse } },
    handler: get_domains_handler,
  });

  fastify.route({
    url: '/domains',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], body: SetDomainsBody, response: { 200: DomainsResponse } },
    handler: set_domains_handler,
  });
};

const get_domains_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
  return reply.code(200).send({ domains: row?.domains ?? [] });
};

const set_domains_handler = async (request: SetReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  // Only real served domains may be stored — reject arbitrary strings, which
  // would otherwise poison the profile-form picker (empty → creation lockout).
  const served = new Set(apiConfig.served_domains.map((b) => b.domain));
  const invalid = request.body.domains.filter((d) => !served.has(d));
  if (invalid.length > 0) {
    return reply.code(400).send({ error: 'UNSERVED_DOMAIN', message: `Not served: ${invalid.join(', ')}` });
  }

  const requested = request.body.domains[0] as string;

  // Write-once, through the SAME primitives the create path uses
  // (`services/items/single_domain_lock.ts`). This handler used to carry its own
  // copy of the claim UPDATE, missing that module's `NOT EXISTS items` guard —
  // so an account with an empty column but existing items (every aggregator- and
  // voice-onboarded participant until migration 0015 runs, and every account the
  // documented `SET domains='{}'` support reset touches) could be granted a
  // second domain here and then create in it, because the create path saw a
  // non-empty column and trusted it.
  let effective = [requested];
  if (!(await claimDomain(db, userId, requested))) {
    const held = await readLockedDomains(db, userId);
    // Empty ⇒ the user row is gone. Nothing to lock, nothing to grant.
    if (held.length > 0 && !held.includes(requested)) {
      return reply.code(403).send({
        error: 'DOMAIN_LOCKED',
        message: domainLockedMessage(held[0] as string, requested, 'switch to'),
        locked_domain: held[0],
        requested_domain: requested,
      });
    }
    effective = held.length > 0 ? held : [requested];
  }

  // SS-3 (#640): the user's domain is now decided, so this is where the default
  // aggregator can own them. No-op when they already have an owner or no
  // default is nominated. Best-effort: a tagging failure must not fail the
  // domain write the client is waiting on.
  for (const domain of effective) {
    try {
      await tagUserForDomain(db, userId, domain);
    } catch (err) {
      request.log.error({ err, userId, domain }, 'default-aggregator tagging failed');
    }
  }
  return reply.code(200).send({ domains: effective });
};
