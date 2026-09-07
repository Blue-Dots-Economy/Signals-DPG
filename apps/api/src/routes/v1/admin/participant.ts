import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { resolveDefaultAggregator } from '@/services/aggregator/default_aggregator';
import { updateItemInternal, type DbOrTx } from '@/services/item_service';
import { apiConfig, authConfig } from '@/config';
import {
  publishItemEvent,
  publishItemEvents,
  type ItemEventKey,
} from '@/utils/publish_item_event';
import {
  UpsertParticipantRequest,
  UpsertParticipantResponse,
  type UpsertParticipantRequest as UpsertBody,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { resolve_upsert_action } from './_resolve_upsert_action.js';
import {
  recordParticipantConsent,
  promoteEligibleDraftsForUser,
} from '@/services/participant_consent';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired, isMinor } from '@/services/minor';
import { createParticipantKeycloakIdentity } from '@/services/auth/participant_identity';
import { insertLocalUser } from '@/services/auth/user_writer';

/**
 * POST /api/v1/admin/participant
 *
 * Tier-aware upsert. Dispatches on `resolve_upsert_action`'s verdict
 * (6 kinds) + a runtime ownership check for the update_item branch.
 *
 * When `item_state` is absent the route enters account_only mode:
 * - new user  → create user (no item), return user_existed:false
 * - existing user → return items, owned_elsewhere:false
 *
 * Aggregators that target a user they did not onboard receive
 * owned_elsewhere:true with an empty items list and no data disclosed.
 */
type UpsertRequest = FastifyRequest<{ Body: UpsertBody }>;

export const participant: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: UpsertParticipantRequest,
      response: { 200: UpsertParticipantResponse },
    },
    handler: participant_handler,
  });
};

// ---------------------------------------------------------------------------
// Shared onboarding-field payload builder (same columns in both branches).
// ---------------------------------------------------------------------------

type OnboardingFields = {
  phone_norm: string | null;
  age: number | undefined;
  /**
   * The aggregator that owns this participant, or null when nobody does yet.
   *
   * SS-3 (#640): this is NO LONGER simply the acting org. A `voice` or
   * `network_service` caller is not an aggregator — the voice agent is hosted
   * by the network, so a cold inbound caller genuinely has no aggregator — and
   * tagging them to the network's own org satisfies "every entrant has an
   * owner" on paper while leaving a verification queue nobody would open.
   * Those callers resolve the instance's DEFAULT aggregator instead, and get
   * null when none is configured. See `resolveOnboardingOwnerOrg`.
   */
  owner_org_id: string | null;
  /** True when `owner_org_id` came from the default rather than a real onboarding act. */
  onboarded_by_default: boolean;
  channel: UpsertBody['channel'];
  source_id: string | undefined;
  /**
   * The domain this participant is being onboarded into, when the caller named
   * one. Recorded on the user row so the single-domain lock has something to
   * lock against — this API never wrote `user.domains`, which left every
   * aggregator-onboarded participant permanently unlocked (and made
   * `GET /api/v1/user/domains` return `[]` for them in the UI).
   *
   * Undefined for an aggregator caller that omits `domain` on the account-only
   * path; the column then stays empty and the participant's first item create
   * records it (`assertSingleDomain`).
   */
  domain: string | undefined;
  now: Date;
};

/** A non-aggregator caller omitted `domain`, so no default can be resolved. */
export const DOMAIN_REQUIRED_FOR_DEFAULT = {
  error: 'DOMAIN_REQUIRED' as const,
  message:
    'domain is required when acting on behalf of a non-aggregator org: it selects which default aggregator owns the participant',
};

/**
 * Who owns a participant created through this route.
 *
 * An aggregator caller owns the participants it onboards, unchanged. Any other
 * caller (`voice`, `network_service`) is not an aggregator — the voice agent is
 * hosted by the network, so a cold inbound caller genuinely has no aggregator —
 * and falls back to the default nominated for the binding it is joining.
 *
 * `domain` is REQUIRED on that branch. The request schema marks it optional
 * with a documented default of `'seeker'`, which is fine for the item it
 * creates but not for this: defaults are per (network, domain), so a silent
 * `'seeker'` fallback would hand a provider participant — and the right to
 * decrypt their PII — to the seeker aggregator, with a 200 and no trace. The
 * voice registration bot always sends it.
 *
 * Works in `account_only` mode too: `domain` is a top-level body field,
 * independent of `item_state`, so a participant with no profile yet is still
 * tagged at account creation.
 *
 * @returns the resolved owner, or `null` when the caller omitted `domain`
 *   (the caller turns that into a 400).
 */
async function resolveOnboardingOwnerOrg(
  exec: DbOrTx,
  acting: { org_id: string; org_type: 'aggregator' | 'voice' | 'network_service' },
  network: string,
  domain: string | undefined,
  log: FastifyRequest['log'],
): Promise<{ owner_org_id: string | null; onboarded_by_default: boolean } | null> {
  if (acting.org_type === 'aggregator') {
    return { owner_org_id: acting.org_id, onboarded_by_default: false };
  }

  if (!domain) return null;

  const { org_id } = await resolveDefaultAggregator(exec, network, domain);
  if (!org_id) {
    log.info(
      { acting_org_id: acting.org_id, org_type: acting.org_type, network, domain },
      'participant: no default aggregator nominated for this binding — participant left untagged',
    );
    return { owner_org_id: null, onboarded_by_default: false };
  }
  return { owner_org_id: org_id, onboarded_by_default: true };
}

const buildOnboardingSet = (f: OnboardingFields) => ({
  phoneNumber: f.phone_norm,
  phoneNumberVerified: false,
  // Age snapshot (#331) — integrating DPGs derive it from the birth year and
  // send the number; no birth date is accepted. (Deprecated terms/privacy
  // booleans are intentionally NOT written — consent lives in the ledger, #309.)
  age: f.age ?? null,
  onboardedByOrgId: f.owner_org_id,
  onboardedByDefault: f.onboarded_by_default,
  onboardedVia: f.channel,
  onboardedSourceId: f.source_id ?? null,
  onboardedAt: f.now,
  updatedAt: f.now,
  // Only when the caller named a domain — never write an empty array, which
  // would read as "locked to nothing" rather than "not yet decided".
  ...(f.domain ? { domains: [f.domain] } : {}),
});

// ---------------------------------------------------------------------------
// signUpAndOnboardUser
//
// Creates the participant's local `user` row, applies the onboarding columns,
// runs whatever else the caller needs in the same transaction, and finally mints
// the Keycloak identity.
//
// Two ways the row gets created, chosen by AUTH_PROVIDER:
//
//   keycloak    `insertLocalUser` writes it directly, INSIDE the transaction that
//               also carries the onboarding columns and the caller's work. So a
//               failure anywhere rolls the whole thing back and there is no
//               orphan to clean up.
//   betterauth  `signUpEmail` writes it first and outside any transaction (that
//               is better-auth's own API), so the row is already committed when
//               the transaction starts — and an orphan IS possible, hence the
//               compensating delete below.
//
// Used by two branches: `account_only` (no item) and `create_new_user` (which
// also creates the profile item). Both supply `withinTx`; neither owns a
// transaction any more, because the user write has to be able to join it.
//
// Returns { ok: true, user_id } or a typed failure the caller turns into a reply.
// ---------------------------------------------------------------------------

type SignUpResult =
  | { ok: true; user_id: string }
  | { ok: false; statusCode: number; error: string; message: string };

/** Shape both branches share for classifying a write failure. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  const pg_code = e?.code ?? e?.cause?.code;
  const message = String(e?.message ?? '');
  return (
    pg_code === '23505' ||
    message.includes('duplicate key value') ||
    message.includes('unique constraint')
  );
}

async function signUpAndOnboardUser(params: {
  /**
   * The participant's real email, or null for a phone-only participant.
   *
   * Deliberately not a synthesised address. `signUpEmail` requires one, so the
   * `<uuid>@no-email.local` placeholder is derived below and confined to that
   * branch — it used to be computed by the callers and then leaked into both the
   * `user` row and the Keycloak identity.
   */
  email_norm: string | null;
  name: string;
  fields: OnboardingFields;
  log: FastifyRequest['log'];
  /**
   * Caller-specific work — consent, and the profile item for `create_new_user`.
   * Runs inside the transaction that carries the onboarding columns. Must throw
   * on failure.
   */
  withinTx: (tx: DbOrTx, user_id: string) => Promise<void>;
}): Promise<SignUpResult> {
  const { email_norm, name, fields, log, withinTx } = params;
  const keycloak = authConfig.keycloak_enabled;

  // Under Keycloak signals owns the id, and it must be a bare UUID because it
  // becomes the Keycloak `sub` (enforced by insertLocalUser).
  let user_id: string = randomUUID();
  /** Only ever true on the better-auth path — see the header note. */
  let rowCommittedOutsideTx = false;

  if (!keycloak) {
    const signedUp = await signUpViaBetterAuth(email_norm, name, log);
    if (!signedUp.ok) return signedUp;
    user_id = signedUp.user_id;
    rowCommittedOutsideTx = true;
  }

  try {
    await db.transaction(async (tx) => {
      if (keycloak) {
        // The row and its onboarding columns in one insert — there is no
        // separate update to sequence, and nothing to orphan if the rest of the
        // transaction fails. Consent booleans are deliberately not written here;
        // consent lives in the ledger (#309), which `withinTx` records.
        const written = await insertLocalUser(
          {
            id: user_id,
            name,
            email: email_norm,
            // Onboarding by an aggregator proves nothing about the identifier;
            // the OTP login is what verifies it.
            emailVerified: false,
            phoneNumber: fields.phone_norm,
            phoneNumberVerified: false,
            extra: buildOnboardingSet(fields),
          },
          log,
          tx
        );

        if (!written.ok) {
          // Thrown so the transaction rolls back; classified by the catch below.
          throw Object.assign(new Error(written.message), {
            statusCode: written.code === 'IDENTITY_CONFLICT' ? 409 : 500,
            errorCode:
              written.code === 'IDENTITY_CONFLICT' ? 'USER_ALREADY_EXISTS' : 'ONBOARD_FAILED',
          });
        }
      } else {
        await tx.update(user).set(buildOnboardingSet(fields)).where(eq(user.id, user_id));
      }

      await withinTx(tx, user_id);
    });
  } catch (updateErr: unknown) {
    // Orphan cleanup, better-auth path only. Under Keycloak the row was written
    // inside the transaction that just rolled back, so deleting here would at
    // best be a no-op and at worst remove a *different* row that happened to
    // reuse the id.
    if (rowCommittedOutsideTx) {
      await deleteOrphanUser(user_id, log, {}, 'cleaned up orphan user after update/tx failed');
    }

    return classifyOnboardFailure(updateErr, log);
  }

  // The realm identity comes last, once the local row is complete: under
  // Keycloak the `user` row is only a mirror, and without a realm user the OTP
  // login fails with `user_not_found` — the participant would be onboarded and
  // permanently unable to sign in. Deliberately fails the whole request rather
  // than logging and continuing; the orphan is cleaned up the same way an
  // update failure is, so the caller can safely retry.
  const identity = await createParticipantKeycloakIdentity({
    userId: user_id,
    name,
    // The real email, or null. Passing the `@no-email.local` placeholder here is
    // what made the realm identity's username an address nobody can receive mail
    // at — their phone is then the only usable channel, and the fake address
    // matches no lookup on either side.
    email: email_norm,
    phoneNumber: fields.phone_norm,
    log,
  });

  if (!identity.ok) {
    await deleteOrphanUser(
      user_id,
      log,
      { identity_error: identity.code },
      'cleaned up orphan user after the Keycloak identity could not be created',
    );

    return {
      ok: false,
      statusCode: identity.code === 'IDENTITY_CONFLICT' ? 409 : 500,
      error: identity.code,
      message: identity.message,
    };
  }

  return { ok: true, user_id };
}

/** better-auth signup (writes the user row itself, outside any transaction). */
async function signUpViaBetterAuth(
  email_norm: string | null,
  name: string,
  log: FastifyRequest['log'],
): Promise<SignUpResult> {
  const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;
  try {
    const signed_up = await authInstance.api.signUpEmail({
      body: {
        email: email_for_signup,
        password: randomUUID(),
        name,
      },
    });
    return { ok: true, user_id: signed_up.user.id };
  } catch (signupErr: unknown) {
    if (isUniqueViolation(signupErr)) {
      log.warn({ err: signupErr }, 'signUp race; user exists now');
      return {
        ok: false,
        statusCode: 409,
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race) — retry the request',
      };
    }
    log.error({ err: signupErr }, 'signUp failed during onboarding');
    return {
      ok: false,
      statusCode: 500,
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    };
  }
}

/** Best-effort orphan removal; a failed delete is logged for manual cleanup. */
async function deleteOrphanUser(
  user_id: string,
  log: FastifyRequest['log'],
  warnFields: Record<string, unknown>,
  warnMessage: string,
): Promise<void> {
  try {
    await db.delete(user).where(eq(user.id, user_id));
    log.warn({ orphan_user_id: user_id, ...warnFields }, warnMessage);
  } catch (cleanupErr) {
    log.error(
      { cleanupErr, orphan_user_id: user_id },
      'failed to clean up orphan user — manual cleanup needed',
    );
  }
}

/** Turns a transaction/update failure into the route's typed failure shape. */
function classifyOnboardFailure(
  updateErr: unknown,
  log: FastifyRequest['log'],
): Extract<SignUpResult, { ok: false }> {
  const e = updateErr as {
    code?: string;
    message?: string;
    cause?: { code?: string };
    statusCode?: number;
    errorCode?: string;
  } | null;

  // Propagate typed service errors (e.g. from create_profile_item, or the
  // insert failure re-thrown above).
  if (e?.statusCode && e?.errorCode) {
    return {
      ok: false,
      statusCode: e.statusCode,
      error: e.errorCode,
      message: e.message ?? 'request rejected',
    };
  }

  if (isUniqueViolation(updateErr)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'USER_ALREADY_EXISTS',
      message: 'email or phone already in use (race)',
    };
  }

  log.error({ err: updateErr }, 'participant onboard failed');
  return {
    ok: false,
    statusCode: 500,
    error: 'ONBOARD_FAILED',
    message: 'could not onboard participant',
  };
}

/** The matched `user` row, as selected by {@link findExistingUser}. */
type ExistingUser = {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  onboardedByOrgId: string | null;
  age: number | null;
};

/**
 * Everything the verdict branches below share. The handler resolves this once,
 * then dispatches; each branch is a self-contained function so the endpoint reads
 * as "validate → resolve → dispatch" instead of one 500-line body.
 */
type ParticipantCtx = {
  request: UpsertRequest;
  reply: FastifyReply;
  body: UpsertBody;
  email_norm: string | null;
  phone_norm: string | null;
};

/** A rejected request: exactly the reply the caller must send. */
type ParticipantFailure = { status: number; error: string; message: string };

const failureReply = (reply: FastifyReply, f: ParticipantFailure) =>
  reply.code(f.status).send({ error: f.error, message: f.message });

/** `user_terms` / `user_privacy` acceptance, read off the compliance array. */
function userLevelPair(body: UpsertBody) {
  const compliance = body.compliance ?? [];
  const terms = compliance.some((c) => c.key === 'user_terms' && c.value === true);
  const privacy = compliance.some((c) => c.key === 'user_privacy' && c.value === true);
  return { terms, privacy };
}

/** Identifier presence + consent-payload validation (#309). Null = acceptable. */
function validateParticipantPayload(
  body: UpsertBody,
  email_norm: string | null,
  phone_norm: string | null,
): ParticipantFailure | null {
  // Defensive — schema refine should have caught this.
  if (!email_norm && !phone_norm) {
    return {
      status: 400,
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    };
  }
  // Accept-only: any entry sent as false rejects the whole request.
  if ((body.compliance ?? []).some((c) => c.value === false)) {
    return {
      status: 400,
      error: 'CONSENT_DECLINED',
      message: 'consent cannot be declined — omit a key to skip it',
    };
  }
  // user_terms + user_privacy are a both-or-none pair.
  const { terms, privacy } = userLevelPair(body);
  if (terms !== privacy) {
    return {
      status: 400,
      error: 'USER_LEVEL_INCOMPLETE',
      message: 'user_terms and user_privacy must be sent together',
    };
  }
  return null;
}

/** Resolve the participant by either identifier. */
async function findExistingUser(
  email_norm: string | null,
  phone_norm: string | null,
): Promise<ExistingUser | null> {
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
      age: user.age,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The two age gates, which run ONLY after the ownership verdict and only on
 * branches that actually act on the user (owned aggregator / network_service /
 * new-user onboarding). Evaluating them earlier — on the globally-matched user,
 * before the `aggregator_owned_elsewhere` gate — would let a non-owning
 * aggregator probe another tenant's user: `U18_NOT_ALLOWED` leaks minor-status and
 * `AGE_REQUIRED` leaks "no age on file". Called here they still precede every DB
 * write (all writes live in the branches), so a minor is still a true no-op for
 * legitimate onboarding.
 */
async function checkAgeGates(
  ctx: ParticipantCtx,
  effectiveAge: number | null,
): Promise<ParticipantFailure | null> {
  const { body, request } = ctx;

  // U18 (#309/#331): a minor is NEVER onboarded via this server-to-server API.
  // Reject with an error and perform NO operation — no create/update, no consent.
  // Minors complete onboarding through the portal (guardian OTP flow).
  if (effectiveAge != null && isMinor(effectiveAge)) {
    return {
      status: 400,
      error: 'U18_NOT_ALLOWED',
      message: 'under-18 users cannot be onboarded via this API; use the portal',
    };
  }

  // On guardian-gated domains, recording user consent requires a known age so we
  // can confirm the user is an adult before recording consent / promoting. An age
  // already on the user's record satisfies it; only a brand-new / age-less user
  // must supply one. Runs after the lookup so a returning adult re-sending the
  // consent pair isn't wrongly rejected.
  const { terms, privacy } = userLevelPair(body);
  if (terms && privacy && effectiveAge == null) {
    const gate_network = body.network ?? 'blue_dot';
    const gate_domain = body.domain ?? 'seeker';
    let gated = false;
    try {
      gated = guardianConsentRequired(await getNetworkConfigById(gate_network), gate_domain);
    } catch (err) {
      request.log.warn({ err, network: gate_network }, 'network config load failed during age gate check');
    }
    if (gated) {
      return {
        status: 400,
        error: 'AGE_REQUIRED',
        message: 'age is required with consent on this domain',
      };
    }
  }

  return null;
}

/**
 * Failure mapping shared by the `update_item` and `insert_item` branches. A typed
 * service error (statusCode + errorCode) is a client error, logged at warn and
 * surfaced with its curated message; anything else is logged at error and answered
 * generically, because a raw DB error's text carries the failed SQL + bound params
 * — i.e. the participant's `item_state` (name/phone/email). Never return it.
 */
function replyItemWriteFailure(
  ctx: ParticipantCtx,
  err: unknown,
  opts: {
    logContext?: Record<string, unknown>;
    logMessage: string;
    fallbackError: string;
    fallbackMessage: string;
  },
) {
  const e = err as { statusCode?: number; errorCode?: string };
  const isClientError =
    typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500;
  const logger = isClientError ? ctx.request.log.warn : ctx.request.log.error;
  logger.call(ctx.request.log, { err, ...opts.logContext }, opts.logMessage);
  return ctx.reply.code(e.statusCode ?? 500).send({
    error: e.errorCode ?? opts.fallbackError,
    message: e.errorCode ? (err as Error).message : opts.fallbackMessage,
  });
}

/** Partition setup, shared by the two item-creating branches. Null = ready. */
async function ensurePartitionOrFail(
  ctx: ParticipantCtx,
  network: string,
  domain: string,
): Promise<ParticipantFailure | null> {
  try {
    await ensureItemPartition(db, network, domain);
    return null;
  } catch (err) {
    ctx.request.log.error(
      { err, network, domain },
      'failed to ensure item partition',
    );
    return {
      status: 500,
      error: 'PARTITION_SETUP_FAILED',
      message: 'failed to prepare storage for item type',
    };
  }
}

/** The 200 shape every existing-user branch returns. */
async function existingUserOk(
  reply: FastifyReply,
  user_id: string,
  consent_recorded: number,
) {
  const itemsList = await readItemsForUser(user_id);
  return reply.code(200).send({
    user_id,
    user_existed: true,
    owned_elsewhere: false,
    onboarded_at: null,
    items: itemsList,
    consent_recorded,
  });
}

/**
 * Aggregator-onboarding initiation email (#531/#534), NEW users only. Both
 * onboarding channels (bulk + link) land on this route, so this is the single
 * place the "you've been onboarded — activate your account" email is sent, in
 * place of the self create/welcome emails. Welcome is not a concern here: an
 * onboarded user's local row already exists (insertLocalUser), so
 * provisioning.createMirror is skipped on first login and never sends Welcome.
 * `actingOrgType: 'aggregator'` is hard-coded deliberately: every service-org
 * onboarder (aggregator, network_service, voice) lands here, and all get the
 * initiation email — the self create/Welcome path is suppressed for all of
 * them, so collapsing them to the aggregator copy prevents a missed onboarding
 * email. (A network_service/voice onboard is thus described as an aggregator in
 * the copy — accepted.)
 * Fire-and-forget, lazy-imported to keep the notification chain off this
 * route's static graph.
 */
function notifyAggregatorInit(
  ctx: ParticipantCtx,
  userId: string,
  network: string,
  domain: string,
): void {
  const orgId = ctx.request.acting_org?.org_id ?? null;
  void (async () => {
    const [{ dispatchItemLifecycleNotification }, { resolveOrgName }] = await Promise.all([
      import('@/notifications/notify_item_lifecycle'),
      import('@/notifications/resolve_owner'),
    ]);
    // Name the onboarding org in the email; fall back (dispatcher → network
    // brand) when it can't be resolved.
    const aggregatorOrgName = orgId ? await resolveOrgName(orgId) : null;
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: userId, domain, network, actingOrgType: 'aggregator', aggregatorOrgName },
      ctx.request.log,
    );
  })().catch((err) => ctx.request.log.warn({ err }, 'aggregator-init notify failed'));
}

/** `account_only`, new user: create the account, skip item creation. */
async function handleAccountOnlyNewUser(ctx: ParticipantCtx) {
  const { request, reply, body, email_norm, phone_norm } = ctx;
  let consent_recorded = 0;
  const network = body.network ?? 'blue_dot';
  const now = new Date();

  // `body.domain`, not a `?? 'seeker'` fallback — see resolveOnboardingOwnerOrg.
  const owner = await resolveOnboardingOwnerOrg(
    db,
    request.acting_org!,
    network,
    body.domain,
    request.log,
  );
  if (!owner) return reply.code(400).send(DOMAIN_REQUIRED_FOR_DEFAULT);

  const fields: OnboardingFields = {
    phone_norm,
    age: body.age,
    owner_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
    channel: body.channel,
    source_id: body.source_id,
    domain: body.domain,
    now,
  };

  const result = await signUpAndOnboardUser({
    email_norm,
    name: body.name,
    fields,
    log: request.log,
    withinTx: async (tx, user_id) => {
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: user_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: now,
      });
      consent_recorded = consent.recorded;
    },
  });

  if (!result.ok) {
    return reply.code(result.statusCode).send({
      error: result.error,
      message: result.message,
    });
  }

  notifyAggregatorInit(ctx, result.user_id, network, body.domain ?? 'seeker');

  return reply.code(200).send({
    user_id: result.user_id,
    user_existed: false,
    owned_elsewhere: false,
    onboarded_at: now.toISOString(),
    items: [],
    consent_recorded,
    onboarded_by_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
  });
}

/**
 * `account_only`, existing user: persist age / record user-level consent, then
 * publish the drafts the new age unblocks.
 */
async function handleAccountOnlyExistingUser(ctx: ParticipantCtx, existing: ExistingUser) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  // Drafts promoted as a side effect of the age write — an age is user-level, so it
  // can unblock several of the user's profiles at once (#557).
  let promotedDrafts: ItemEventKey[] = [];

  const hasCompliance = Boolean(body.compliance && body.compliance.length > 0);
  if (hasCompliance || body.age != null) {
    const network = body.network ?? 'blue_dot';
    try {
      await db.transaction(async (tx) => {
        if (body.age != null) {
          await tx
            .update(user)
            .set({ age: body.age, updatedAt: new Date() })
            .where(eq(user.id, existing.id));
        }
        if (hasCompliance) {
          const consent = await recordParticipantConsent(tx, {
            compliance: body.compliance,
            userId: existing.id,
            network,
            brand: null,
            channel: body.channel,
            acceptedAt: new Date(),
          });
          consent_recorded = consent.recorded;
        }
        if (body.age != null) {
          promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
        }
      });
    } catch (err) {
      // Never surface the raw error message: a DB error's text can include the
      // failed SQL + bound params. Log the full error, return a curated code.
      request.log.error(
        { err },
        'participant existing-user consent/age update failed',
      );
      return reply.code(500).send({
        error: 'CONSENT_WRITE_FAILED',
        message: 'failed to record consent',
      });
    }
  }

  // This branch touches no item of its own, so the promoted drafts are the only
  // events it has to publish. After the transaction, never inside it: an event
  // published pre-commit lets the worker index the row before the promotion is
  // visible (#557).
  await publishItemEvents(promotedDrafts, 'upsert', request.log);

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `update_item`: update the named item, record consent, publish. */
async function handleUpdateItem(
  ctx: ParticipantCtx,
  existing: ExistingUser,
  item_id: string,
) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  let promotedDrafts: ItemEventKey[] = [];

  // Runtime ownership check — pre-flight ahead of updateItemInternal so
  // mismatches produce 403 ITEM_NOT_OWNED_BY_USER rather than 404. Reads the item's
  // key columns in the same query: this branch can publish an event for the named
  // item even when no item_state was sent, and the key must come from the row —
  // body.network / body.domain / body.item_type are optional and need not describe
  // this item.
  const [ownerRow] = await db
    .select({
      created_by: items.created_by,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
    })
    .from(items)
    .where(eq(items.item_id, item_id))
    .limit(1);
  if (ownerRow?.created_by !== existing.id) {
    return reply.code(403).send({
      error: 'ITEM_NOT_OWNED_BY_USER',
      message: 'item_id does not belong to the resolved user',
    });
  }
  const namedItem: ItemEventKey = {
    item_network: ownerRow.item_network,
    item_domain: ownerRow.item_domain,
    item_type: ownerRow.item_type,
    item_id,
  };

  const hasItemState = Boolean(
    body.item_state && Object.keys(body.item_state).length > 0,
  );
  // Either of these means the named item changed and search must hear about it.
  let itemWritten = false;
  let itemPromoted = false;
  try {
    await db.transaction(async (tx) => {
      if (hasItemState) {
        await updateItemInternal(
          tx,
          item_id,
          existing.id,
          true, // isAdmin — ownership already verified above
          { item_state: body.item_state ?? {} },
        );
        itemWritten = true;
      }
      if (body.age != null) {
        await tx
          .update(user)
          .set({ age: body.age, updatedAt: new Date() })
          .where(eq(user.id, existing.id));
      }
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: existing.id,
        itemId: item_id,
        network: body.network ?? 'blue_dot',
        brand: null,
        channel: body.channel,
        acceptedAt: new Date(),
      });
      consent_recorded = consent.recorded;
      // `item_id` resolves to update_item with OR without item_state (#309): a
      // consent-only activation sends no fields, and recordParticipantConsent
      // promotes the named item draft → live itself. Its `promoted` flag is the only
      // signal for that — there is no updateItemInternal row, and the item is no
      // longer `draft`, so promoteEligibleDraftsForUser below cannot return it
      // either. Dropping it here would leave the profile `draft` in item_search:
      // #557 through another door.
      itemPromoted = consent.promoted;
      if (body.age != null) {
        promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
      }
    });
  } catch (err) {
    return replyItemWriteFailure(ctx, err, {
      logContext: { item_id },
      logMessage: 'updateItemInternal failed',
      fallbackError: 'UPDATE_FAILED',
      fallbackMessage: 'item update failed',
    });
  }

  // The named item when it was written or promoted, plus any OTHER draft the age
  // write promoted (#557). De-duplicated, since the two sets can overlap.
  await publishItemEvents(
    itemWritten || itemPromoted ? [namedItem, ...promotedDrafts] : promotedDrafts,
    'upsert',
    request.log,
  );

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `insert_item`: add another profile to an existing user. */
async function handleInsertItem(ctx: ParticipantCtx, existing: ExistingUser) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  let promotedDrafts: ItemEventKey[] = [];
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  const partitionFailure = await ensurePartitionOrFail(ctx, network, domain);
  if (partitionFailure) return failureReply(reply, partitionFailure);

  let insertedItemId: string | undefined;
  try {
    // Must run inside a transaction: createItemInternal's profile-cap guard
    // takes a transaction-scoped advisory lock (pg_advisory_xact_lock) and
    // then counts+inserts — on the plain pooled `db` (autocommit) that lock
    // would release immediately, leaving the check→insert non-atomic and the
    // cap racy. The same transaction also makes the consent write + promotion
    // atomic with the item insert. Mirrors create_new_user + /item/create.
    await db.transaction(async (tx) => {
      // Persist age (#331) BEFORE recording consent so promoteItemOnProfileConsent
      // sees the adult age and can flip the new profile live. Adding a profile to
      // an existing user is this branch; without this write, an age supplied here
      // is dropped and the profile is stuck draft under the guardian gate (#309).
      if (body.age != null) {
        await tx
          .update(user)
          .set({ age: body.age, updatedAt: new Date() })
          .where(eq(user.id, existing.id));
      }
      const { item_id } = await create_profile_item({
        tx,
        user_id: existing.id,
        network,
        domain,
        item_type,
        payload: body.item_state ?? {},
      });
      insertedItemId = item_id;
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: existing.id,
        itemId: item_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: new Date(),
      });
      consent_recorded = consent.recorded;
      // A newly-known age can also unblock the user's other consented drafts
      // (age is user-level) — sweep them, mirroring the update_item branch.
      if (body.age != null) {
        promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
      }
    });
  } catch (err) {
    return replyItemWriteFailure(ctx, err, {
      logMessage: 'insert_item failed',
      fallbackError: 'INSERT_ITEM_FAILED',
      fallbackMessage: 'item insert failed',
    });
  }

  // The inserted item, plus any other draft the age write promoted (#557).
  await publishItemEvents(
    [
      { item_network: network, item_domain: domain, item_type, item_id: insertedItemId! },
      ...promotedDrafts,
    ],
    'upsert',
    request.log,
  );

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `create_new_user`: onboard the account and its first profile together. */
async function handleCreateNewUser(ctx: ParticipantCtx) {
  const { request, reply, body, email_norm, phone_norm } = ctx;
  let consent_recorded = 0;
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  const partitionFailure = await ensurePartitionOrFail(ctx, network, domain);
  if (partitionFailure) return failureReply(reply, partitionFailure);

  const now = new Date();

  const owner = await resolveOnboardingOwnerOrg(
    db,
    request.acting_org!,
    network,
    body.domain,
    request.log,
  );
  if (!owner) return reply.code(400).send(DOMAIN_REQUIRED_FOR_DEFAULT);

  const fields: OnboardingFields = {
    phone_norm,
    age: body.age,
    owner_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
    channel: body.channel,
    source_id: body.source_id,
    domain: body.domain,
    now,
  };

  let onboarded_item_id: string | undefined;
  const result = await signUpAndOnboardUser({
    email_norm,
    name: body.name,
    fields,
    log: request.log,
    withinTx: async (tx, user_id) => {
      const { item_id } = await create_profile_item({
        tx,
        user_id,
        network,
        domain,
        item_type,
        payload: body.item_state ?? {},
      });
      onboarded_item_id = item_id;

      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: user_id,
        itemId: item_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: now,
      });
      consent_recorded = consent.recorded;
    },
  });

  if (!result.ok) {
    return reply.code(result.statusCode).send({
      error: result.error,
      message: result.message,
    });
  }

  if (onboarded_item_id) {
    await publishItemEvent(
      { item_network: network, item_domain: domain, item_type, item_id: onboarded_item_id, op: 'upsert' },
      request.log,
    );
  }

  notifyAggregatorInit(ctx, result.user_id, network, domain);

  const itemsList = await readItemsForUser(result.user_id);
  return reply.code(200).send({
    user_id: result.user_id,
    user_existed: false,
    owned_elsewhere: false,
    onboarded_at: now.toISOString(),
    items: itemsList,
    consent_recorded,
    onboarded_by_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
  });
}

/**
 * Validate → resolve the participant → dispatch on the ownership verdict. Each
 * verdict's work lives in its own function above; keep this body a dispatcher so
 * the ordering that matters (payload validation, then ownership, then the age
 * gates, then any DB write) stays readable in one screen.
 */
export const participant_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  const body = request.body;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  // --- Consent-payload validation (#309) ---
  const payloadFailure = validateParticipantPayload(body, email_norm, phone_norm);
  if (payloadFailure) return failureReply(reply, payloadFailure);

  const ctx: ParticipantCtx = { request, reply, body, email_norm, phone_norm };

  // 1. Look up existing user.
  const existing = await findExistingUser(email_norm, phone_norm);

  // 2. Compute aggregator ownership and dispatch on the helper's verdict.
  const aggregator_owns_user = Boolean(
    request.acting_org?.org_type === 'aggregator' &&
    existing?.onboardedByOrgId === request.acting_org?.org_id,
  );

  // 3. Dispatch. A create is always an insert (#349): item_state with no
  //    item_id creates a NEW profile every call; item_id updates that specific
  //    item. The per-user profile cap is enforced downstream in
  //    createItemInternal (createProfileItem), so all creation paths share it.
  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists: Boolean(existing),
    item_id_in_body: body.item_id,
    has_item_state: Boolean(
      body.item_state && Object.keys(body.item_state).length > 0,
    ),
    aggregator_owns_user,
  });

  if (verdict.kind === 'rejected') {
    return reply.code(verdict.status).send({
      error: verdict.error,
      message:
        verdict.error === 'INVALID_ACTING_ORG'
          ? 'acting_org is required for /admin/participant'
          : 'only aggregator, network_service or voice acting orgs are allowed',
    });
  }

  if (verdict.kind === 'aggregator_owned_elsewhere') {
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: true,
      onboarded_at: null,
      items: [],
    });
  }

  // Effective age (#331): what this call supplies, else what's already on file.
  const ageFailure = await checkAgeGates(ctx, body.age ?? existing?.age ?? null);
  if (ageFailure) return failureReply(reply, ageFailure);

  if (verdict.kind === 'account_only') {
    return existing
      ? handleAccountOnlyExistingUser(ctx, existing)
      : handleAccountOnlyNewUser(ctx);
  }

  if (verdict.kind === 'update_item') {
    return handleUpdateItem(ctx, existing!, verdict.item_id);
  }

  if (verdict.kind === 'insert_item') {
    return handleInsertItem(ctx, existing!);
  }

  return handleCreateNewUser(ctx);
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

export default participant;
