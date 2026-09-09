import z, {
  getActionInteraction,
  PerformNetworkActionBodySchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import {
  ensureActionEventPartition,
  ensureActionPartition,
  item_actions,
} from '@dpg/database';
import { consent_record } from '@api/db/postgres/schema';
import {
  computeActionMatchScore,
  type ItemSnapshotLike,
} from '@/services/actions/compute_match_score';
import {
  assertPairCapAvailable,
  maxActionsPerPair,
  terminalStatuses,
  ActionPairCapError,
} from '@/services/action_pair_cap';
import { resolveConsentVersion } from '@/services/consent_version';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  buildActionEventPayload,
  fetchLocalItemSnapshot,
  insertActionEvent,
  isCurrentInstanceItem,
  mirrorActionEventToSourceInstance,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';
import { dispatchActionNotifications } from '@/notifications/notify_actions';
import { public_rate_limit } from '@/middleware/public_rate_limit';
import { peer_instance_guard_strict } from '@/middleware/peer_instance_guard';

type PerformNetworkActionRequest = FastifyRequest<{
  Body: z.infer<typeof PerformNetworkActionBodySchema>;
}>;

type ActionItemRef = z.infer<
  typeof PerformNetworkActionBodySchema
>['source_item'];

/**
 * Shape returned by `fetchLocalItemSnapshot` — carries item content
 * (`item_schema_url`, public `item_state`, decrypted+merged `private_state`,
 * `item_locations`) but not the network/domain/type/id/instance-url
 * identity, which lives on the request body's item ref instead. Builds the
 * full `ItemSnapshotLike` the match-score service requires by merging the
 * two. Uses the public `item_state` (never `private_state`) so decrypted PII
 * never flows into the match-score input, matching the discover match-score
 * flow.
 */
function toMatchScoreSnapshot(
  ref: ActionItemRef,
  snapshot: {
    item_schema_url: string;
    item_state: Record<string, unknown>;
    private_state: Record<string, unknown>;
    item_locations?: Array<{ lat: number; lng: number }> | null;
  } | null
): ItemSnapshotLike | null {
  if (!snapshot) return null;
  return {
    item_network: ref.item_network,
    item_domain: ref.item_domain,
    item_type: ref.item_type,
    item_id: ref.item_id,
    item_instance_url: ref.item_instance_url,
    item_schema_url: snapshot.item_schema_url,
    item_state: snapshot.item_state,
    item_locations: snapshot.item_locations,
  };
}

/**
 * Thrown inside the create transaction when the initiate-consent row cannot be
 * written, so the action insert rolls back with it (fail-closed — no
 * PII-revealing action without a consent record).
 */
class ConsentWriteError extends Error {}

const PerformNetworkActionResponseSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
  source_item_id: z.string(),
  target_item_id: z.string(),
});

export const perform_network_action: FastifyPluginAsyncZod = async function (
  fastify
) {
  fastify.route({
    url: '/action/perform',
    method: 'POST',
    // Peer-only (AUTH-VULN-05). This body ASSERTS identity — `source_item_owner`
    // and the `performed_by_*` audit fields decide who the action belongs to, and
    // the handler has no independent way to check them. While the route was
    // public, anyone who could reach the host could name any user (ids are
    // discoverable) and have an action recorded against them; a pentest confirmed
    // it, getting back a consent error specific to the impersonated user rather
    // than an auth error. The HMAC guard binds the request to a peer that holds
    // INSTANCE_SHARED_SECRET, so the identity fields are only as forgeable as
    // that secret. The STRICT guard is deliberate: unlike the *_local reads, this
    // route never had a legitimate unsigned caller to keep working during
    // rollout, so it does not honour PEER_AUTH_MODE=permissive — otherwise the
    // finding stays open in every deployment that has not flipped the flag.
    preHandler: [
      peer_instance_guard_strict,
      public_rate_limit('network_action_perform', 100),
    ],
    schema: {
      tags: ['network'],
      body: PerformNetworkActionBodySchema,
      response: {
        201: PerformNetworkActionResponseSchema,
      },
    },
    handler: perform_network_action_handler,
  });
};

export const perform_network_action_handler = async (
  request: PerformNetworkActionRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (
    !isServedDomainBinding(
      body.target_item.item_network,
      body.target_item.item_domain
    )
  ) {
    return await replyForUnservedDomain(
      reply,
      body.target_item.item_network,
      body.target_item.item_domain
    );
  }

  if (!isCurrentInstanceItem(body.target_item)) {
    return reply.code(400).send({
      error: 'INVALID_TARGET_INSTANCE',
      message: 'Actions must be created on the target item instance',
    });
  }

  let interaction: ReturnType<typeof getActionInteraction>;
  let networkConfig: Awaited<ReturnType<typeof getNetworkConfigById>>;
  try {
    networkConfig = await getNetworkConfigById(
      body.target_item.item_network
    );
    interaction = getActionInteraction(networkConfig, {
      actionType: body.action_type,
      fromNetwork: body.source_item.item_network,
      fromDomain: body.source_item.item_domain,
      fromItemType: body.source_item.item_type,
      toNetwork: body.target_item.item_network,
      toDomain: body.target_item.item_domain,
      toItemType: body.target_item.item_type,
    });

    validateAgainstJsonSchema(
      interaction.requirement_schema,
      body.requirements_snapshot,
      'action requirements',
      { allowAdditionalProperties: apiConfig.allow_extra_schema_data }
    );
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_REQUEST',
      message: err instanceof Error ? err.message : 'Invalid action request',
    });
  }

  // Initiate-consent gate, enforced HERE (the write endpoint) — not only on the
  // /action/perform proxy — because this is where the row is created and the PII
  // action event is emitted. The proxy forwards `consent` for reveals_pii
  // actions, so legitimate (proxied and inter-instance) calls pass; a direct
  // call that bypasses the proxy without consent is rejected rather than
  // creating a PII-revealing action with no consent recorded.
  if (interaction.reveals_pii_on_status.length > 0 && !body.consent?.acknowledged) {
    return reply.code(400).send({
      error: 'CONSENT_REQUIRED',
      message: 'Initiator consent acknowledgment required for this action.',
    });
  }

  const targetItemSnapshot = await fetchLocalItemSnapshot(db, body.target_item);
  if (!targetItemSnapshot) {
    return reply.code(404).send({
      error: 'TARGET_ITEM_NOT_FOUND',
      message: 'Target item does not exist on this instance',
    });
  }

  if (targetItemSnapshot.lifecycle_status !== 'live') {
    return reply.code(409).send({ error: 'PROFILE_NOT_LIVE', message: 'target_item is not live; cannot perform actions' });
  }

  let sourceItemSnapshot = null;
  if (isCurrentInstanceItem(body.source_item)) {
    sourceItemSnapshot = await fetchLocalItemSnapshot(db, body.source_item);

    if (!sourceItemSnapshot) {
      return reply.code(404).send({
        error: 'SOURCE_ITEM_NOT_FOUND',
        message: 'Source item does not exist on this instance',
      });
    }

    if (sourceItemSnapshot.lifecycle_status !== 'live') {
      return reply.code(409).send({ error: 'PROFILE_NOT_LIVE', message: 'source_item is not live; cannot perform actions' });
    }
  }

  // Self-action guard: you cannot perform an action on your own profile. The UI
  // filters the viewer's own pins from the map/list, but the API is the control
  // — a crafted request (or a UI gap) must still be rejected here. Same item is
  // unambiguously self. The owner-equality branch compares only the DB-resolved
  // source owner (`sourceItemSnapshot.created_by`) — never `body.source_item_owner`,
  // which is caller-asserted and could be forged to dodge the check. That means a
  // REMOTE source (no local snapshot) relies on the item-id check alone; a remote
  // instance vouches for its own users' ownership, and its two-profiles-of-one-user
  // case is enforced at that instance's own perform endpoint.
  const isSelfAction =
    body.source_item.item_id === body.target_item.item_id ||
    (sourceItemSnapshot !== null &&
      sourceItemSnapshot.created_by === targetItemSnapshot.created_by);
  if (isSelfAction) {
    return reply.code(400).send({
      error: 'SELF_ACTION_NOT_ALLOWED',
      message: 'You cannot perform this action on your own profile.',
    });
  }

  try {
    await ensureActionPartition(
      db,
      body.target_item.item_network,
      body.action_type
    );
    await ensureActionEventPartition(
      db,
      body.target_item.item_network,
      body.action_type
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_type: body.action_type,
      },
      'Failed to ensure action/event partitions'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for action or event type',
    });
  }

  const actionStatus = 'created';
  const updateCount = 0;
  const eventPayload = buildActionEventPayload({
    event_schema: interaction.event_schema,
    action_status: actionStatus,
    context: {
      action_type: body.action_type,
      source_item: body.source_item,
      target_item: body.target_item,
      requirements_snapshot: body.requirements_snapshot,
    },
    consent: body.consent,
  });

  try {
    validateActionEventPayload(interaction.event_schema, eventPayload);
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_EVENT',
      message: err instanceof Error ? err.message : 'Invalid action event',
    });
  }

  // Action + initiate-consent are written in one transaction so a consent-write
  // failure rolls the action back too (fail-closed — never a PII-revealing
  // action without a consent row). The action event is emitted only after commit.
  // Pair cap (#370/#422): at most `max_actions_per_pair` (default 1) OPEN
  // actions between these two items, bidirectional + type-agnostic. Enforced
  // HERE (the single write endpoint every perform — self, proxied, or
  // inter-instance — funnels through) inside the insert txn with a pair-scoped
  // advisory lock, so concurrent submits can't both land.
  let capExceeded = false;
  const created = await db
    .transaction(async (tx) => {
      await assertPairCapAvailable(tx, {
        network: body.target_item.item_network,
        sourceItemId: body.source_item.item_id,
        targetItemId: body.target_item.item_id,
        cap: maxActionsPerPair(networkConfig),
        terminal: terminalStatuses(networkConfig),
      });
      const [row] = await tx
        .insert(item_actions)
        .values({
          action_type: body.action_type,
          partition_network: body.target_item.item_network,
          action_status: actionStatus,
          update_count: updateCount,
          source_item_network: body.source_item.item_network,
          source_item_domain: body.source_item.item_domain,
          source_item_type: body.source_item.item_type,
          source_item_id: body.source_item.item_id,
          source_item_instance_url: body.source_item.item_instance_url,
          source_item_owner: body.source_item_owner,
          target_item_network: body.target_item.item_network,
          target_item_domain: body.target_item.item_domain,
          target_item_type: body.target_item.item_type,
          target_item_id: body.target_item.item_id,
          target_item_instance_url: body.target_item.item_instance_url,
          target_item_owner: targetItemSnapshot.created_by,
          requirements_snapshot: body.requirements_snapshot,
          remarks: null,
          performed_by_org_id: body.performed_by_org_id ?? null,
          performed_by_service_user_id: body.performed_by_service_user_id ?? null,
        })
        .returning({
          action_id: item_actions.action_id,
          action_type: item_actions.action_type,
          action_status: item_actions.action_status,
          update_count: item_actions.update_count,
          source_item_id: item_actions.source_item_id,
          target_item_id: item_actions.target_item_id,
        });

      if (body.consent) {
        // Version derived server-side from the loaded consent config, never
        // trusted from the client.
        const initiateVersion = await resolveConsentVersion({
          network: body.source_item.item_network,
          brand: body.consent.brand,
          category: 'action',
          actionType: body.action_type,
          stage: 'initiate',
        });
        if (initiateVersion === null) {
          throw new ConsentWriteError(
            `initiate consent version not configured for ${body.action_type}`,
          );
        }
        try {
          await tx.insert(consent_record).values({
            level: 'item',
            consentCategory: 'action',
            actionType: body.action_type,
            actionStage: 'initiate',
            userId: body.source_item_owner,
            itemId: body.source_item.item_id,
            actionId: row.action_id,
            network: body.source_item.item_network,
            brand: body.consent.brand ?? null,
            documentVersion: initiateVersion,
            source: 'action',
            acceptedAt: new Date(),
          });
        } catch (err) {
          throw new ConsentWriteError(
            err instanceof Error ? err.message : 'consent write failed',
          );
        }
      }

      return row;
    })
    .catch((err: unknown) => {
      if (err instanceof ActionPairCapError) {
        capExceeded = true;
        return null;
      }
      if (err instanceof ConsentWriteError) return null;
      throw err;
    });

  if (capExceeded) {
    return reply.code(409).send({
      error: 'ACTION_LIMIT_REACHED',
      message: 'An active request already exists between these two profiles.',
    });
  }

  if (created === null) {
    request.log.error(
      { action_type: body.action_type },
      'initiate consent write failed; action rolled back (fail-closed)',
    );
    return reply.code(500).send({
      error: 'CONSENT_WRITE_FAILED',
      message: 'Failed to record consent; the action was not created.',
    });
  }

  const storedEvent = {
    origin_instance_domain: getCurrentApiBaseUrl(),
    action_type: created.action_type,
    action_id: created.action_id,
    action_status: created.action_status,
    update_count: created.update_count,
    source_item: body.source_item,
    target_item: body.target_item,
    source_item_owner: body.source_item_owner,
    target_item_owner: targetItemSnapshot.created_by,
    source_item_locations: sourceItemSnapshot?.item_locations ?? [],
    target_item_locations: targetItemSnapshot.item_locations ?? [],
    event_payload: eventPayload,
  };

  const createdEvent = await insertActionEvent(db, storedEvent);
  void mirrorActionEventToSourceInstance(storedEvent, request.log);

  // Fire-and-forget action emails for every owner side hosted locally. Guarded
  // on the non-null event insert so retries/duplicates don't re-notify.
  if (createdEvent) {
    void dispatchActionNotifications(
      {
        lifecycle: 'created',
        actionType: created.action_type,
        actionId: created.action_id,
        status: created.action_status,
        updateCount: created.update_count,
        currentInstanceUrl: getCurrentApiBaseUrl(),
        source: {
          ownerUserId: body.source_item_owner ?? null,
          itemId: body.source_item.item_id,
          domain: body.source_item.item_domain,
          network: body.source_item.item_network,
          instanceUrl: body.source_item.item_instance_url,
        },
        target: {
          ownerUserId: targetItemSnapshot.created_by ?? null,
          itemId: body.target_item.item_id,
          domain: body.target_item.item_domain,
          network: body.target_item.item_network,
          instanceUrl: body.target_item.item_instance_url,
        },
      },
      request.log,
    ).catch((err) =>
      request.log.error({ err }, 'action notification dispatch failed'),
    );
  }

  // Match score (#439): computed ONCE at create, for all interaction types,
  // and stored on the row. Fire-and-forget so connect latency is unaffected;
  // null when the source snapshot is unavailable (cross-instance) or the
  // relevance service errors. Never recomputed on status change.
  void computeActionMatchScore(
    toMatchScoreSnapshot(body.source_item, sourceItemSnapshot),
    toMatchScoreSnapshot(body.target_item, targetItemSnapshot),
    request.log,
  )
    .then(async (score) => {
      if (score === null) return;
      await db
        .update(item_actions)
        .set({ match_score: score })
        .where(
          and(
            eq(item_actions.partition_network, body.target_item.item_network),
            eq(item_actions.action_type, created.action_type),
            eq(item_actions.action_id, created.action_id),
          ),
        );
    })
    .catch((err) =>
      request.log.error({ err, action_id: created.action_id }, 'match-score row update failed'),
    );

  return reply.code(201).send(created);
};
