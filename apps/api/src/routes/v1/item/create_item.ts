import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { consent_record } from '@api/db/postgres/schema';
import { resolveConsentVersion } from '@/services/consent_version';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';
import { createItemInternal, ItemServiceError, resolveGoLiveGates } from '@/services/item_service';
import { tagUserWithDefaultAggregator } from '@/services/aggregator/default_aggregator';
import { resolveLocationsForCreate } from '@/services/geocoding/resolve_locations_for_create';
import { getWardAge } from '@/services/minor_guardian_repo';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { getNetworkConfigById } from '@/network_configs';

type CreateItemRequest = FastifyRequest<{
  Body: z.infer<typeof CreateItemBodySchema>;
}>;

/**
 * Thrown inside the create transaction when the consent row cannot be written,
 * so the item insert rolls back with it (fail-closed — no PII item without a
 * consent record).
 */
class ConsentWriteError extends Error {}

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: CreateItemBodySchema,
      response: {
        201: z.object({
          item_type: z.string(),
          item_id: z.string(),
        }),
      },
    },
    handler: create_item_handler,
  });
};

/**
 * Maps a create-item failure to its HTTP status + error body, logging where
 * appropriate. Keeps the handler's catch a single statement so the deeply
 * nested error-type/DB-code branching doesn't inflate the handler's complexity.
 *
 * @returns The reply status + JSON body for the failure.
 */
function mapCreateItemError(
  err: unknown,
  log: CreateItemRequest['log'],
  body: unknown,
): { status: number; body: { error: string; message: string } } {
  if (err instanceof ConsentWriteError) {
    log.error({ err }, 'consent write failed; item creation rolled back (fail-closed)');
    return {
      status: 500,
      body: {
        error: 'CONSENT_WRITE_FAILED',
        message: 'Failed to record consent; the item was not created.',
      },
    };
  }
  if (err instanceof ItemServiceError) {
    // `details` carries the extra fields a published error shape promises —
    // DOMAIN_LOCKED's `locked_domain` / `requested_domain`. Spread FIRST, so a
    // future guard whose `details` happens to carry an `error` or `message` key
    // cannot override the error code. Spread straight from `details`: object
    // spread of `undefined` contributes nothing, so a `?? {}` fallback would
    // only add an empty object literal.
    return {
      status: err.statusCode,
      body: { ...err.details, error: err.errorCode, message: err.message },
    };
  }
  if (err instanceof DrizzleQueryError && err.cause instanceof DatabaseError) {
    // 23505 = unique_violation (fallback safety), 23503 = foreign_key_violation.
    if (err.cause.code === '23505') {
      return {
        status: 409,
        body: {
          error: 'ITEM_ALREADY_EXISTS',
          message: 'An item with the same type and id already exists',
        },
      };
    }
    if (err.cause.code === '23503') {
      return {
        status: 400,
        body: {
          error: 'INVALID_REFERENCE',
          message:
            'One or more referenced entities do not exist, including the authenticated user',
        },
      };
    }
  }
  log.error({ err, body }, 'Failed to create item');
  return { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', message: 'Failed to create item' } };
}

/**
 * Whether a consent-less self-create must be rejected: true iff the domain
 * gates go-live on `consent_required` AND a profile_creation consent version is
 * configured (nothing to accept ⇒ not demanded).
 */
async function selfCreateNeedsConsent(body: CreateItemRequest['body']): Promise<boolean> {
  const gates = await resolveGoLiveGates(body.item_network, body.item_domain);
  if (!gates.includes('consent_required')) return false;
  const requiredVersion = await resolveConsentVersion({
    network: body.item_network,
    category: 'profile_creation',
  });
  return requiredVersion !== null;
}

/**
 * Whether a create that carries consent may promote straight to `live`. A
 * consenting create promotes (#275) EXCEPT a gated minor: on a
 * guardian-gated domain only a proven adult self-promotes; a minor / unknown
 * age stays draft until guardian consent (fail-closed, mirrors the promote path).
 */
async function resolveSelfConsentPromotes(
  body: CreateItemRequest['body'],
  userId: string,
): Promise<boolean> {
  if (body.consent == null) return false;
  const networkConfig = await getNetworkConfigById(body.item_network);
  if (!guardianConsentRequired(networkConfig, body.item_domain)) return true;
  const age = await getWardAge(userId);
  return !(age === null || isMinor(age));
}

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply
) => {
  const callerId = request.user?.id;
  const callerRole = request.user?.role;
  const body = request.body;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  // The "admin acting on behalf of another user" flow is reserved for
  // server-to-server callers identified by an api-key. UI sessions — even
  // when the logged-in user happens to carry an admin role — should behave
  // like a normal user and own the items they create. Distinguishing on
  // the api-key header keeps that contract explicit and avoids confusing
  // signed-in admins with a CREATED_BY_REQUIRED error when they create
  // their own profile.
  const isApiKeyCaller = Boolean(request.headers['x-api-key']);
  const isAdminApiCaller = isApiKeyCaller && callerRole === 'admin';

  if (!isAdminApiCaller && body.created_by) {
    return reply.code(403).send({
      error: 'FORBIDDEN_CREATED_BY',
      message: 'created_by may only be set by an admin api-key caller',
    });
  }

  if (isAdminApiCaller && !body.created_by) {
    return reply.code(400).send({
      error: 'CREATED_BY_REQUIRED',
      message: 'created_by is required when an admin api-key creates an item',
    });
  }

  const userId = isAdminApiCaller ? (body.created_by as string) : callerId;

  // A direct/self create (session user or api-key-as-self) must carry consent
  // when the domain gates go-live on `consent_required` AND the network
  // configures a profile_creation statement — the login/gate safety net is
  // UI-only, so this is the server-side guarantee. The admin on-behalf (bulk)
  // path is exempt: those participants are gated at first login. A domain whose
  // `go_live_required` omits `consent_required` (e.g. a provider configured
  // `["schema_required"]`) goes live on completeness alone, so consent is not
  // demanded at create; and when no profile_creation consent is configured
  // there is nothing to accept.
  if (!isAdminApiCaller && !body.consent && (await selfCreateNeedsConsent(body))) {
    return reply.code(400).send({
      error: 'CONSENT_REQUIRED',
      message: 'profile_creation consent is required to create this item',
    });
  }

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  try {
    await ensureItemPartition(
      db,
      body.item_network,
      body.item_domain
    );
  } catch (err) {
    request.log.error(
      {
        err,
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
      },
      'Failed to ensure item partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for item type',
    });
  }

  // Backend geocoding: resolve coordinates from the schema's location field when
  // the client supplied none. Shared with the admin-participant onboarding path
  // (create_profile_item) so both store item_locations identically.
  const item_locations = await resolveLocationsForCreate({
    item_network: body.item_network,
    item_domain: body.item_domain,
    item_type: body.item_type,
    item_state: body.item_state ?? {},
    provided: body.item_locations,
    log: request.log,
  });

  // U18 fail-closed: a consenting create promotes to live (#275) EXCEPT a gated
  // minor, who stays draft until guardian consent (see resolveSelfConsentPromotes).
  const selfConsentPromotes = await resolveSelfConsentPromotes(body, userId);

  try {
    // Item + consent are written in one transaction so a consent-write failure
    // rolls the item back too (fail-closed — never a PII item without a consent
    // row). The item event/cache-invalidation happen only after commit.
    const created = await db.transaction(async (tx) => {
      // SS-3 (#640): give the owner an owning aggregator BEFORE the item is
      // classified.
      //
      // This is the seam between the two levels: the tag is per USER, the
      // draft/live decision is per ITEM. `createItemInternal` runs
      // `classify_item`, which reads the tag through `owner_required` — so the
      // write has to happen first or a brand-new signup's first profile is
      // classified unowned and lands in `draft`, only going live on some later
      // write. Same transaction, so it is atomic with the item.
      //
      // Unconditional, deliberately: gating this on "is this the user's first
      // create" stranded the population the feature exists for — people who
      // signed up before a default was nominated, and so were never tagged.
      //
      // Cheap on every create: one statement whose `IS NULL` guard
      // short-circuits the org lookup for an already-owned user, matching no
      // rows and scanning nothing.
      //
      // Uses the request's concrete network rather than deriving it from the
      // bare domain — that derivation returns null when two served networks
      // declare the same domain, which would leave the user untagged while the
      // gate (which does know the network) still demanded an owner.
      await tagUserWithDefaultAggregator(tx, userId, body.item_network, body.item_domain);

      const c = await createItemInternal(tx, {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_state: body.item_state ?? {},
        item_locations,
        created_by: userId,
        // A self-create that carries consent IS the profile_creation acceptance,
        // so classify with it now (#275 gated `live` on consent but never let
        // the create path see it → profiles were stuck `draft`). Keyed on
        // presence, not `body.consent.category`: the consent row + version are
        // server-resolved to `profile_creation` (the only create-time consent
        // category), so any consent block present is that acceptance. The row is
        // written just below in the same transaction; a consent-write failure
        // rolls the whole create back (fail-closed). Admin/bulk callers omit
        // this and stay draft, promoted later via /consent/profile-accept.
        // A gated minor is forced draft (see selfConsentPromotes above).
        consent_accepted: selfConsentPromotes,
      });

      if (body.consent) {
        // Version is derived server-side from the loaded consent config, never
        // trusted from the client (the ledger stores only category + version).
        const profileVersion = await resolveConsentVersion({
          network: body.item_network,
          brand: body.consent.brand,
          category: 'profile_creation',
        });
        if (profileVersion === null) {
          throw new ConsentWriteError(
            `profile_creation consent version not configured for ${body.item_network}`,
          );
        }
        try {
          await tx.insert(consent_record).values({
            level: 'item',
            consentCategory: 'profile_creation',
            userId: callerId,
            itemId: c.itemId,
            network: body.item_network,
            brand: body.consent.brand ?? null,
            documentVersion: profileVersion,
            source: 'profile',
            acceptedAt: new Date(),
          });
        } catch (err) {
          throw new ConsentWriteError(err instanceof Error ? err.message : 'consent write failed');
        }
      }

      return c;
    });

    await publishItemEvent(
      {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_id: created.itemId,
        op: 'upsert',
      },
      request.log,
    );

    await invalidateItemFetchCache(body.item_network, body.item_domain).catch((err) =>
      request.log.warn({ err }, 'cache invalidation after create failed'),
    );

    // Owner-facing create email (#531/#534). Fire-and-forget after commit —
    // never blocks or fails the create. Lazy-imported so the notification/config
    // chain stays out of this route's static module graph. An aggregator
    // acting-org routes to the initiation email instead of the self create email.
    // `userId` is the resolved OWNER on both paths — the session caller for a
    // self create, and `body.created_by` for an admin-api create (validated
    // above) — so it's the correct recipient regardless of who called.
    // `lifecycleStatus` distinguishes a `live` create ("you're live") from a
    // `draft` one ("complete your profile"): a create can commit draft
    // (incomplete / gated minor) while still returning 201.
    void import('@/notifications/notify_item_lifecycle')
      .then(({ dispatchItemLifecycleNotification }) =>
        dispatchItemLifecycleNotification(
          {
            op: 'create',
            ownerId: userId,
            itemId: created.itemId,
            domain: body.item_domain,
            network: body.item_network,
            actingOrgType: request.acting_org?.org_type ?? null,
            lifecycleStatus: created.lifecycleStatus,
          },
          request.log,
        ),
      )
      .catch((err) => request.log.warn({ err }, 'item-lifecycle notify (create) failed'));

    return reply.code(201).send({
      item_type: created.itemType,
      item_id: created.itemId,
    });
  } catch (err) {
    const mapped = mapCreateItemError(err, request.log, body);
    return reply.code(mapped.status).send(mapped.body);
  }
};
