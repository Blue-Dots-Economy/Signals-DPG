import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization, member } from '../../db/postgres/schema/auth.js';
import { authConfig } from '@/config';
import { ACTING_ORG_WILDCARD } from '@/utils/keycloak_token';

const ALLOWED_ORG_TYPES = ['aggregator', 'voice', 'network_service'] as const;
type AllowedOrgType = (typeof ALLOWED_ORG_TYPES)[number];

const get_header_value = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * ACTING-ORG SCOPE MODEL — how `x-acting-org-id` is authorised, and where.
 *
 * An on-behalf-of request carries three things: a service credential (who the
 * caller is), `x-acting-org-id` (the org it is acting as), and the target user.
 * Authorisation of that combination is split across two layers, in two places.
 *
 *   1. caller -> acting org. This middleware. It validates that the org exists,
 *      that its type may be asserted as an acting org, and that the caller is a
 *      registered service principal. It does NOT bind the org to the caller:
 *      any service credential may name any org of an allowed type.
 *
 *   2. acting org -> target user. Enforced downstream, per route:
 *      `routes/v1/action/_resolve_acting_actor.ts` (step 5) and the admin read
 *      paths (e.g. `admin/participant_decrypt.ts`, scoping on
 *      `user.onboardedByOrgId`). An `aggregator` acting org reaches only users
 *      it onboarded. `network_service` and `voice` are network-wide by design —
 *      see the rationale comment in `_resolve_acting_actor.ts`.
 *
 * So the reach of a request is determined by the TYPE of the org asserted, and
 * that reach is checked; the choice of which org to assert is not.
 *
 * What that means in practice depends entirely on the set of service principals
 * that exist. Today `SERVICES` in `scripts/seed_service_users.ts` holds a single
 * entry, seeded with org `type: 'network_service'` — network-wide scope. Raya /
 * voice is network-wide by the same design. Every principal able to reach this
 * middleware therefore already carries the broadest scope the model defines.
 *
 * If a service principal is ever provisioned that should reach only PART of the
 * network — a regional aggregator, a partner integration — layer 1 has to carry
 * the restriction, because layer 2 cannot express it. The mechanism exists and
 * is deployed but inert: set `ACTING_ORG_SOURCE=claim_preferred` (see
 * `@/config`) and populate the `signals_acting_orgs` claim for that principal.
 * The grant check below already reads it; `["*"]` means "any org"; the Keycloak
 * mappers are live. Enable it in the same change that adds the principal.
 */

/**
 * Fastify preHandler that resolves the acting org for a request.
 *
 * Reads the `x-acting-org-id` header and the apikey-bound user (set upstream
 * by the apikey auth path), validates that the org exists and is one of the
 * types allowed to be asserted as an acting org (`aggregator` | `voice` |
 * `network_service`), and that the service user is a registered member of
 * some org in Signals. On success, attaches `request.acting_org` and resolves.
 *
 * Each error branch responds via the reply and returns early; the request
 * lifecycle is terminated by Fastify when the reply is sent.
 *
 * The signature is declared as a plain async function (rather than typed via
 * Fastify's `preHandlerAsyncHookHandler`) so unit tests can invoke it without
 * binding a FastifyInstance `this`. The runtime shape still satisfies the
 * Fastify preHandler contract.
 */
export const acting_org_preHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  /**
   * Acting-org authorisation (§5.1 of the Keycloak migration design).
   *
   * The header is unchanged in every mode and is still what SELECTS the org.
   * What `ACTING_ORG_SOURCE` controls is whether the selection has to fall
   * inside a grant the token carries (`signals_acting_orgs`), which is the
   * difference between the caller authorising itself and the API verifying it.
   *
   * `undefined` grant means the token carried no claim at all — distinct from an
   * empty grant, which authorises nothing.
   */
  const grant = request.acting_org_grant;
  const grant_is_wildcard = grant?.includes(ACTING_ORG_WILDCARD) === true;

  if (authConfig.acting_org_claim_required && grant === undefined) {
    reply.code(403).send({
      error: 'ACTING_ORG_CLAIM_MISSING',
      message:
        'this token carries no acting-org grant; ACTING_ORG_SOURCE=claim_required',
    });
    return;
  }

  let acting_org_id = get_header_value(
    request.headers['x-acting-org-id'] as string | string[] | undefined,
  );

  // A grant naming exactly one org is unambiguous, so the header is optional.
  // This is what lets human callers stop sending it entirely.
  if (!acting_org_id && authConfig.acting_org_claim_enforced && grant?.length === 1 && !grant_is_wildcard) {
    acting_org_id = grant[0];
  }

  if (!acting_org_id) {
    reply.code(400).send({
      error: 'MISSING_ACTING_ORG',
      message: 'x-acting-org-id header is required',
    });
    return;
  }

  // The check this whole change exists for: an asserted org outside the grant is
  // refused, where previously any existing org id was honoured.
  if (
    authConfig.acting_org_claim_enforced &&
    grant !== undefined &&
    !grant_is_wildcard &&
    !grant.includes(acting_org_id)
  ) {
    request.log.warn(
      { asserted_org_id: acting_org_id, grant },
      'acting-org assertion refused: outside the token grant',
    );
    reply.code(403).send({
      error: 'ACTING_ORG_NOT_GRANTED',
      message: `this token may not act for org ${acting_org_id}`,
    });
    return;
  }

  const service_user_id = (request.user as { id?: string } | undefined)?.id;
  if (!service_user_id) {
    reply.code(401).send({
      error: 'UNAUTHENTICATED',
      message: 'service apikey is required',
    });
    return;
  }

  const org_rows = await db
    .select({ id: organization.id, type: organization.type })
    .from(organization)
    .where(eq(organization.id, acting_org_id))
    .limit(1);
  const org_row = org_rows[0];

  if (!org_row) {
    reply.code(404).send({
      error: 'ACTING_ORG_NOT_FOUND',
      message: `org ${acting_org_id} does not exist`,
    });
    return;
  }

  const org_type_raw = org_row.type;
  if (
    org_type_raw === null ||
    org_type_raw === undefined ||
    !(ALLOWED_ORG_TYPES as readonly string[]).includes(org_type_raw)
  ) {
    reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: `org type ${org_type_raw} cannot be asserted as acting org`,
    });
    return;
  }

  // Org-agnostic by design: this gate separates privilege TIERS (service
  // principal vs end user), not tenants. No production path writes `member`
  // rows except `scripts/seed_service_users.ts`, so a participant session has
  // none and is refused here before it can assert any acting org. Tenant reach
  // is decided downstream by the acting org's type — see the scope model above.
  const member_rows = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, service_user_id))
    .limit(1);

  if (member_rows.length === 0) {
    reply.code(403).send({
      error: 'SERVICE_USER_NOT_REGISTERED',
      message: 'service user is not a member of any org',
    });
    return;
  }

  request.acting_org = {
    org_id: org_row.id,
    org_type: org_type_raw as AllowedOrgType,
    service_user_id,
  };
};
