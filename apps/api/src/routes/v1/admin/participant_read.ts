import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { consent_record } from '@api/db/postgres/schema';
import z, {
  GetParticipantRequest as GetParticipantRequestSchema,
  GetParticipantResponse,
  type GetParticipantRequest as GetParticipantQueryType,
  type ParticipantComplianceKey,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';
import { isMinor } from '@/services/minor';

/**
 * GET /api/v1/admin/participant
 *
 * Read-only lookup endpoint for both network_service and aggregator acting orgs.
 * Accepts email or phone_number (mutually optional at request level, one required
 * via schema refine). Returns user_id and items if found, filtered by org ownership.
 *
 * For network_service: returns user_id + all items if user exists.
 * For aggregator: returns user_id + items only if user was onboarded by this aggregator,
 *                otherwise returns items: [].
 * For either tier: returns { user_id: null } if user not found.
 *
 * Consent reporting (#692):
 * - `compliance` is a `[{key, value}]` array using the same key vocabulary the
 *   POST body accepts. It replaced `user_consent: {terms_accepted, …}`, which
 *   named one concept two ways and answered in a different shape than it was
 *   written in.
 * - Every `value` is VERSION-SCOPED: `true` only when a row exists at the
 *   document version this instance currently serves. Previously any accepted
 *   version counted, so a participant on a superseded document read as
 *   consented forever and the channel had no way to tell.
 * - A minor is rejected with 400 `U18_NOT_ALLOWED` for voice/network_service
 *   callers (never for aggregators — see the gate for why).
 * - `?network=` selects which network's documents define "current"; it defaults
 *   to the served network on a single-network instance.
 *
 * Error responses are intentionally not declared in the route schema, matching
 * the sibling POST /admin/participant, which likewise returns 400s (including
 * its own U18_NOT_ALLOWED) with only its 200 declared.
 */

type GetParticipantRequestType = FastifyRequest<{ Querystring: GetParticipantQueryType }>;

export const participant_read: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'GET',
    schema: {
      tags: ['admin'],
      querystring: GetParticipantRequestSchema,
      response: { 200: GetParticipantResponse },
    },
    handler: participant_read_handler,
  });
};

export const participant_read_handler = async (
  request: GetParticipantRequestType,
  reply: FastifyReply,
) => {
  const body = request.query;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  // Stored phone numbers are canonical E.164 ("+91..."). Callers may send the
  // number without the leading "+" (e.g. "919876543210"), so prepend it before
  // the exact-match lookup; otherwise an existing user would silently miss.
  const phone_trimmed = body.phone_number?.trim();
  const phone_norm = phone_trimmed
    ? phone_trimmed.startsWith('+')
      ? phone_trimmed
      : `+${phone_trimmed}`
    : null;

  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant',
    });
  }

  // `voice` is admitted alongside aggregator and network_service: voice-dpg is
  // an integrating DPG that authenticates the same way (client-credentials
  // token, service org whose slug matches its Keycloak client id), and the
  // platform layers below already accept it (`SERVICE_ORG_TYPES`,
  // `ALLOWED_ORG_TYPES`) — this list predates it.
  if (
    request.acting_org.org_type !== 'aggregator' &&
    request.acting_org.org_type !== 'network_service' &&
    request.acting_org.org_type !== 'voice'
  ) {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message:
        'only aggregator, network_service or voice acting orgs are allowed',
    });
  }

  // Look up existing user
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const existingRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  const existing = existingRows[0] ?? null;

  // User not found
  if (!existing) {
    return reply.code(200).send({
      user_id: null,
      compliance: EMPTY_COMPLIANCE,
      items: [],
    });
  }

  // User exists — check ownership rules
  const acting_org_id = request.acting_org.org_id;
  let itemsList: Awaited<ReturnType<typeof readItemsForUser>> = [];
  let disclose = false;

  if (request.acting_org.org_type === 'aggregator') {
    disclose = existing.onboardedByOrgId === acting_org_id;
  } else {
    disclose = true; // network_service can always read
  }

  if (!disclose) {
    // Aggregator that did not onboard this user — no consent disclosure.
    return reply.code(200).send({
      user_id: existing.id,
      compliance: EMPTY_COMPLIANCE,
      items: [],
    });
  }

  const [ageRow] = await db
    .select({ age: user.age })
    .from(user)
    .where(eq(user.id, existing.id))
    .limit(1);
  const age = ageRow?.age ?? null;

  // U18 (#692, mirroring the POST's #309/#331 gate): a minor is not readable by
  // the channels that cannot legitimately act on one. The voice channel would
  // otherwise be told "consent incomplete" and then be unable to complete it —
  // the POST answers `U18_NOT_ALLOWED` for every caller — so it is told plainly
  // to route the user to the portal instead.
  //
  // Scoped to voice / network_service on purpose. `aggregator` callers keep the
  // 200: their only use of this endpoint is `probeUser`, a read-only
  // "resume or start fresh" identity check that reads just `user_id`/`items`
  // and never consent, and it treats a 400 as a hard ValidationError. Rejecting
  // them would break registration for an already-onboarded minor.
  //
  // Placed AFTER the disclose verdict, exactly as the POST places its age gates
  // after the ownership verdict: `U18_NOT_ALLOWED` reveals minor status, so it
  // must never answer a caller that is not entitled to see this user at all.
  if (
    age != null &&
    isMinor(age) &&
    request.acting_org.org_type !== 'aggregator'
  ) {
    return reply.code(400).send({
      error: 'U18_NOT_ALLOWED',
      message:
        'under-18 users cannot be onboarded via this API; use the portal',
    });
  }

  // The network whose consent documents the accepted versions are compared
  // against. Resolved before the reads because a version comparison is
  // meaningless without it.
  const network = resolveComplianceNetwork(request.query.network);
  if (network === null) {
    return reply.code(400).send({
      error: 'NETWORK_REQUIRED',
      message:
        'this instance serves more than one network; pass ?network= to select which consent documents to compare against',
    });
  }

  itemsList = await readItemsForUser(existing.id);
  const consentedItemIds = await readProfileConsentedItemIds(
    itemsList.map((i) => i.item_id),
    network,
  );
  const itemsWithConsent = itemsList.map((i) => ({
    ...i,
    profile_consent_accepted: consentedItemIds.has(i.item_id),
  }));
  const compliance = await readCompliance(existing.id, network, age);

  return reply.code(200).send({
    user_id: existing.id,
    compliance,
    items: itemsWithConsent,
  });
};

// --- helpers ---

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

async function readItemsForUser(user_id: string) {
  const networks = servedNetworks();
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      lifecycle_status: items.lifecycle_status,
      item_state: items.item_state,
      item_locations: items.item_locations,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
    })
    .from(items)
    .where(
      networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(items.created_at);

  return rows.map((r) => {
    const { item_private_state: _drop, ...rest } = r;
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return {
      ...rest,
      item_state: mergedState,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });
}

/**
 * The network to compare accepted consent versions against.
 *
 * `consent_config` is per-network, so there is no single `current_version`
 * without picking one. An explicit `?network=` wins; otherwise the instance's
 * served bindings decide, which resolves every single-network deployment (all
 * of them today) without the caller changing anything.
 *
 * @param requested - The `?network=` query value, when supplied.
 * @returns The network id, or `null` when the instance serves several and the
 *   caller named none — an ambiguity that must not be guessed.
 */
function resolveComplianceNetwork(requested: string | undefined): string | null {
  if (requested) return requested;
  const served = new Set(apiConfig.served_domains.map((b) => b.network));
  return served.size === 1 ? [...served][0] : null;
}

/**
 * Whether a consent row exists at the version this instance currently serves.
 *
 * The whole point of #692. These reads used to test only "a row of this
 * category exists", so a participant who accepted an older document was
 * reported as consented forever: prod migrated users carry `document_version 1`
 * while the live document is version 2, and the voice channel was told their
 * consent was complete while the portal correctly re-prompted them. Because the
 * response carries no version, the channel could not detect this itself, so
 * those accounts stayed pinned to the superseded document indefinitely.
 *
 * Compared against the ADULT document set, matching `use-consent-gate.ts` in
 * the UI — which reads `config.documents[c].current_version` for every user.
 * Keeping the two identical is the point; a minor never reaches here anyway
 * (rejected above for the channels this serves).
 *
 * @param userId - The participant.
 * @param network - Network whose documents define "current".
 * @param age - The stored age, for `has_age`.
 * @returns One entry per reported key, every key always present.
 */
async function readCompliance(
  userId: string,
  network: string,
  age: number | null,
): Promise<Array<{ key: ParticipantComplianceKey; value: boolean }>> {
  const [termsVersion, privacyVersion] = await Promise.all([
    resolveConsentVersion({ network, category: 'terms' }),
    resolveConsentVersion({ network, category: 'privacy' }),
  ]);

  // Network-scoped now, where it used to be deliberately network-agnostic:
  // the comparison is against THIS network's document, so a row accepted on
  // another network cannot satisfy it. No behavioural change on the
  // single-network deployments that exist today.
  const rows = await db
    .select({
      category: consent_record.consentCategory,
      version: consent_record.documentVersion,
    })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.userId, userId),
        eq(consent_record.level, 'user'),
        eq(consent_record.network, network),
        inArray(consent_record.consentCategory, ['terms', 'privacy']),
      ),
    );

  // An unconfigured category resolves to `null`. Reported as `false`, and this
  // is a decision rather than a fallthrough: with no document there is nothing
  // that could have been accepted, and `false` sends the caller to a consent
  // flow rather than letting it proceed on an unverifiable claim.
  const acceptedAt = (
    category: 'terms' | 'privacy',
    current: number | null,
  ): boolean =>
    current !== null &&
    rows.some((r) => r.category === category && r.version === current);

  return [
    { key: 'user_terms', value: acceptedAt('terms', termsVersion) },
    { key: 'user_privacy', value: acceptedAt('privacy', privacyVersion) },
    { key: 'has_age', value: age != null },
  ];
}

/**
 * Item ids whose `profile_creation` consent is accepted at the current version.
 *
 * Same version blindness as `readCompliance` had, and the same fix. Drives
 * `ParticipantItemSnapshot.profile_consent_accepted`.
 *
 * @param itemIds - Candidate items.
 * @param network - Network whose document defines "current".
 * @returns The subset consented at the current version.
 */
async function readProfileConsentedItemIds(
  itemIds: string[],
  network: string,
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set<string>();
  const currentVersion = await resolveConsentVersion({
    network,
    category: 'profile_creation',
  });
  if (currentVersion === null) return new Set<string>();
  const rows = await db
    .select({ itemId: consent_record.itemId })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        eq(consent_record.documentVersion, currentVersion),
        inArray(consent_record.itemId, itemIds),
      ),
    );
  return new Set(rows.map((r) => r.itemId as string));
}

/**
 * Reported when there is nothing to disclose — user not found, or an aggregator
 * that did not onboard them. Every key is present and `false` so a caller never
 * has to tell "denied" from "key missing"; the two non-disclosing branches are
 * deliberately indistinguishable from "nothing accepted".
 */
const EMPTY_COMPLIANCE: Array<{ key: ParticipantComplianceKey; value: boolean }> = [
  { key: 'user_terms', value: false },
  { key: 'user_privacy', value: false },
  { key: 'has_age', value: false },
];

export default participant_read;
