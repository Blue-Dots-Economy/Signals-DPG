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
 *   callers (never for aggregators — see the gate for why). An aggregator
 *   therefore DOES read a minor, so the version comparison resolves the u18
 *   document set for one; see `consentVariantForAge`.
 * - `?network=` selects which network's documents define "current"; it defaults
 *   to the served network on a single-network instance, and a value this
 *   instance does not serve is refused (`NETWORK_NOT_SERVED`) rather than
 *   answered all-false.
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
  const { email: email_norm, phone: phone_norm } = normalizeLookupIdentifier(
    request.query,
  );

  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  const orgCheck = resolveReadableActingOrg(request.acting_org);
  if (!orgCheck.ok) {
    return reply.code(orgCheck.status).send({
      error: orgCheck.error,
      message: orgCheck.message,
    });
  }
  const acting_org = orgCheck.acting_org;

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

  // User exists — check ownership rules. An aggregator sees only the users it
  // onboarded; network_service and voice can always read.
  const disclose =
    acting_org.org_type !== 'aggregator' ||
    existing.onboardedByOrgId === acting_org.org_id;

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
  if (isMinorBlockedForCaller(age, acting_org.org_type)) {
    return reply.code(400).send({
      error: 'U18_NOT_ALLOWED',
      message:
        'under-18 users cannot be onboarded via this API; use the portal',
    });
  }

  // The network whose consent documents the accepted versions are compared
  // against. Resolved before the reads because a version comparison is
  // meaningless without it.
  const networkCheck = resolveComplianceNetwork(request.query.network);
  if (!networkCheck.ok) {
    return reply.code(400).send({
      error: networkCheck.error,
      message: networkCheck.message,
    });
  }
  const network = networkCheck.network;

  const itemsList = await readItemsForUser(existing.id);
  const consentedItemIds = await readProfileConsentedItemIds(
    itemsList.map((i) => i.item_id),
    network,
    age,
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

/**
 * Canonicalises the lookup identifier from the query string.
 *
 * Stored phone numbers are canonical E.164 ("+91..."). Callers may send the
 * number without the leading "+" (e.g. "919876543210"), so it is prepended
 * before the exact-match lookup; otherwise an existing user would silently
 * miss.
 *
 * @param query - The validated query string (email and/or phone_number).
 * @returns The normalised pair, each `null` when not supplied.
 */
function normalizeLookupIdentifier(query: GetParticipantQueryType): {
  email: string | null;
  phone: string | null;
} {
  const trimmedPhone = query.phone_number?.trim();
  let phone: string | null = null;
  if (trimmedPhone) {
    phone = trimmedPhone.startsWith('+') ? trimmedPhone : `+${trimmedPhone}`;
  }
  return { email: query.email?.trim().toLowerCase() ?? null, phone };
}

/** Acting orgs permitted to read this endpoint. */
const READABLE_ORG_TYPES = new Set(['aggregator', 'network_service', 'voice']);

type ReadableActingOrg = NonNullable<GetParticipantRequestType['acting_org']>;

/**
 * Validates the acting org and narrows it to non-null for the handler.
 *
 * `voice` is admitted alongside aggregator and network_service: voice-dpg is an
 * integrating DPG that authenticates the same way (client-credentials token,
 * service org whose slug matches its Keycloak client id), and the platform
 * layers below already accept it (`SERVICE_ORG_TYPES`, `ALLOWED_ORG_TYPES`) —
 * this list predates it.
 *
 * @param acting_org - The request's acting org, if the auth layer resolved one.
 * @returns The org on success, or the status/error/message to reply with.
 */
function resolveReadableActingOrg(
  acting_org: GetParticipantRequestType['acting_org'],
):
  | { ok: true; acting_org: ReadableActingOrg }
  | { ok: false; status: number; error: string; message: string } {
  if (!acting_org) {
    return {
      ok: false,
      status: 403,
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant',
    };
  }
  if (!READABLE_ORG_TYPES.has(acting_org.org_type)) {
    return {
      ok: false,
      status: 403,
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message:
        'only aggregator, network_service or voice acting orgs are allowed',
    };
  }
  return { ok: true, acting_org };
}

/**
 * Whether this caller must be refused because the participant is a minor.
 *
 * See the call site for why the rejection is scoped to voice/network_service
 * and why it runs only after the disclosure verdict.
 *
 * @param age - The participant's stored age, or null when none is on file.
 * @param orgType - The acting org's type.
 * @returns True when the read must answer `U18_NOT_ALLOWED`.
 */
function isMinorBlockedForCaller(age: number | null, orgType: string): boolean {
  if (orgType === 'aggregator') return false;
  return age != null && isMinor(age);
}

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
 * A requested network outside the served set is REFUSED rather than answered.
 * Answering it would be worse than an error: `resolveConsentVersion` finds no
 * config for an unknown network and returns `null` for every category, so a
 * typo (`blue-dot` for `blue_dot`) produced a confident `200` with every flag
 * `false` — indistinguishable from "genuinely not consented", which for a voice
 * channel means re-collecting consent the participant already gave. A consent
 * answer for a network this instance does not serve is not an answer.
 *
 * @param requested - The `?network=` query value, when supplied.
 * @returns The resolved network, or a failure naming which of the two problems
 *   it hit — an unserved value, or an ambiguity that must not be guessed.
 */
function resolveComplianceNetwork(
  requested: string | undefined,
):
  | { ok: true; network: string }
  | { ok: false; error: string; message: string } {
  const served = servedNetworks();
  // No served bindings at all (an unconfigured instance): there is nothing to
  // check membership against, so an explicitly named network is taken at its
  // word rather than refused. The typo guard below still applies to every
  // instance that actually declares SERVED_DOMAINS, which is all of them.
  if (served.length === 0) {
    return requested
      ? { ok: true, network: requested }
      : {
          ok: false,
          error: 'NETWORK_REQUIRED',
          message:
            'this instance declares no served domains; pass ?network= to select which consent documents to compare against',
        };
  }
  if (requested) {
    if (!served.includes(requested)) {
      return {
        ok: false,
        error: 'NETWORK_NOT_SERVED',
        message: `this instance does not serve network "${requested}"`,
      };
    }
    return { ok: true, network: requested };
  }
  if (served.length === 1) return { ok: true, network: served[0] };
  return {
    ok: false,
    error: 'NETWORK_REQUIRED',
    message:
      'this instance serves more than one network; pass ?network= to select which consent documents to compare against',
  };
}

/**
 * The document set a participant's rows were written against.
 *
 * The write side discriminates on it — `signup_guardian.ts` and
 * `u18_profile_consent.ts` write a ward's rows with `variant: 'u18'`, against
 * `u18_documents`, which carries its OWN `current_version` per category. A read
 * that always resolved the adult version would compare a u18 row against the
 * wrong counter the moment the two sets diverge, and report a guardian-completed
 * ward as un-consented to the aggregator that onboarded them (the caller class
 * deliberately exempt from the U18 rejection, so it does reach here).
 *
 * `age == null` resolves to `'adult'`, and either way the mismatch direction is
 * safe: comparing a row against the other set's counter yields `false`, which
 * re-prompts rather than claiming a consent that was never verified.
 *
 * @param age - The participant's stored age, or null when none is on file.
 * @returns The variant to resolve versions against.
 */
function consentVariantForAge(age: number | null): 'adult' | 'u18' {
  return age != null && isMinor(age) ? 'u18' : 'adult';
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
 * Each row is compared against the current version for its OWN stored `brand`,
 * not against the network default. `resolveConsentVersion` prefers a brand
 * override when one exists (as `mergeConsentConfig` does in the UI) and the
 * write side passes `brand` (`participant_consent.ts`), so resolving only the
 * default would break both ways once a brand's counter diverges: a brand that
 * bumps its terms would leave its whole cohort reported `true` against the
 * default's older number — a false positive, the worse direction for a consent
 * answer — while a default that bumps alone would re-prompt a brand cohort that
 * is already current. Reading the brand off the row needs no new request param
 * and cannot disagree with what was written.
 *
 * @param userId - The participant.
 * @param network - Network whose documents define "current".
 * @param age - The stored age; selects the document set and reports `has_age`.
 * @returns One entry per reported key, every key always present.
 */
async function readCompliance(
  userId: string,
  network: string,
  age: number | null,
): Promise<Array<{ key: ParticipantComplianceKey; value: boolean }>> {
  const variant = consentVariantForAge(age);

  // Network-scoped now, where it used to be deliberately network-agnostic:
  // the comparison is against THIS network's document, so a row accepted on
  // another network cannot satisfy it. No behavioural change on the
  // single-network deployments that exist today.
  const rows = await db
    .select({
      category: consent_record.consentCategory,
      version: consent_record.documentVersion,
      brand: consent_record.brand,
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

  // One resolve per (category, brand) actually present on a row. Config lookups
  // are cached, and a participant holds a handful of rows at most.
  const currentFor = new Map<string, number | null>();
  await Promise.all(
    rows.map(async (r) => {
      const key = `${r.category}\u0000${r.brand ?? ''}`;
      if (currentFor.has(key)) return;
      currentFor.set(key, null); // claim the slot before awaiting
      currentFor.set(
        key,
        await resolveConsentVersion({
          network,
          brand: r.brand ?? null,
          category: r.category as 'terms' | 'privacy',
          variant,
        }),
      );
    }),
  );

  // An unconfigured category resolves to `null`. Reported as `false`, and this
  // is a decision rather than a fallthrough: with no document there is nothing
  // that could have been accepted, and `false` sends the caller to a consent
  // flow rather than letting it proceed on an unverifiable claim.
  const acceptedAt = (category: 'terms' | 'privacy'): boolean =>
    rows.some((r) => {
      if (r.category !== category) return false;
      const current = currentFor.get(`${r.category}\u0000${r.brand ?? ''}`);
      return current != null && r.version === current;
    });

  return [
    { key: 'user_terms', value: acceptedAt('terms') },
    { key: 'user_privacy', value: acceptedAt('privacy') },
    { key: 'has_age', value: age != null },
  ];
}

/**
 * Item ids whose `profile_creation` consent is accepted at the current version.
 *
 * Same version blindness as `readCompliance` had, and the same fix — including
 * the network predicate and the per-row brand resolution, which this function
 * originally lacked even though `readCompliance`'s own comment explains why a
 * row accepted on another network must not satisfy the query. Drives
 * `ParticipantItemSnapshot.profile_consent_accepted`.
 *
 * @param itemIds - Candidate items.
 * @param network - Network whose document defines "current".
 * @param age - The stored age; selects the document set.
 * @returns The subset consented at the current version.
 */
async function readProfileConsentedItemIds(
  itemIds: string[],
  network: string,
  age: number | null,
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set<string>();
  const variant = consentVariantForAge(age);
  const rows = await db
    .select({
      itemId: consent_record.itemId,
      version: consent_record.documentVersion,
      brand: consent_record.brand,
    })
    .from(consent_record)
    .where(
      and(
        eq(consent_record.level, 'item'),
        eq(consent_record.consentCategory, 'profile_creation'),
        eq(consent_record.network, network),
        inArray(consent_record.itemId, itemIds),
      ),
    );

  const consented = new Set<string>();
  await Promise.all(
    rows.map(async (r) => {
      const current = await resolveConsentVersion({
        network,
        brand: r.brand ?? null,
        category: 'profile_creation',
        variant,
      });
      if (current != null && r.version === current && r.itemId) {
        consented.add(r.itemId);
      }
    }),
  );
  return consented;
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
