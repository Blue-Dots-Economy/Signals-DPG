import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import z, {
  PerformActionBodySchema,
  PerformNetworkActionBodySchema,
  StoreEventBodySchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { action_events, items } from '@dpg/database';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { decryptItemPrivate } from './item_decrypt';

type ActionItemRef = z.infer<typeof PerformNetworkActionBodySchema>['source_item'];
type PerformActionTargetItemRef = z.infer<
  typeof PerformActionBodySchema
>['target_item'];
export type StoredActionEvent = z.infer<typeof StoreEventBodySchema>;

export type ActionEventPayloadContext = {
  action_type: string;
  source_item: ActionItemRef;
  target_item: ActionItemRef;
  requirements_snapshot: Record<string, unknown>;
};

const actionEventSystemPayloadKeys = ['status', 'remark', 'consent'] as const;

export function normalizeInstanceUrl(url: string) {
  const parsedUrl = new URL(url);

  if (
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '::1'
  ) {
    parsedUrl.hostname = 'localhost';
  }

  if (
    (parsedUrl.protocol === 'http:' && parsedUrl.port === '80') ||
    (parsedUrl.protocol === 'https:' && parsedUrl.port === '443')
  ) {
    parsedUrl.port = '';
  }

  return parsedUrl.toString().replace(/\/$/, '');
}

function decodeSnapshot<
  T extends { item_state: unknown; item_private_state: string },
>(row: T) {
  const { mergedState } = decryptItemPrivate({
    item_state: row.item_state as Record<string, unknown>,
    item_private_state: row.item_private_state,
  });
  const {
    item_state: publicItemState,
    item_private_state: _drop2,
    ...rest
  } = row;
  return {
    ...rest,
    item_state: publicItemState as Record<string, unknown>,
    private_state: mergedState,
  };
}

export async function fetchLocalItemSnapshot(
  db: NodePgDatabase<any>,
  item: ActionItemRef
) {
  const baseConditions = and(
    eq(items.item_network, item.item_network),
    eq(items.item_domain, item.item_domain),
    eq(items.item_type, item.item_type),
    eq(items.item_id, item.item_id)
  );

  const [exactResult] = await db
    .select({
      item_id: items.item_id,
      item_instance_url: items.item_instance_url,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      created_by: items.created_by,
      item_locations: items.item_locations,
      lifecycle_status: items.lifecycle_status,
    })
    .from(items)
    .where(and(baseConditions, eq(items.item_instance_url, item.item_instance_url)))
    .limit(1);

  if (exactResult) {
    return decodeSnapshot(exactResult);
  }

  const normalizedItemInstanceUrl = normalizeInstanceUrl(item.item_instance_url);
  const normalizedCurrentInstanceUrl = normalizeInstanceUrl(getCurrentApiBaseUrl());
  if (normalizedItemInstanceUrl !== normalizedCurrentInstanceUrl) {
    return null;
  }

  const [localAliasResult] = await db
    .select({
      item_id: items.item_id,
      item_instance_url: items.item_instance_url,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      created_by: items.created_by,
      item_locations: items.item_locations,
      lifecycle_status: items.lifecycle_status,
    })
    .from(items)
    .where(baseConditions)
    .limit(1);

  if (
    localAliasResult &&
    normalizeInstanceUrl(localAliasResult.item_instance_url) ===
      normalizedCurrentInstanceUrl
  ) {
    return decodeSnapshot(localAliasResult);
  }

  return null;
}

export async function insertActionEvent(
  db: NodePgDatabase<any>,
  event: StoredActionEvent
) {
  const [created] = await db
    .insert(action_events)
    .values({
      action_type: event.action_type,
      partition_network: getActionEventPartitionNetwork(event),
      origin_instance_domain: event.origin_instance_domain,
      action_id: event.action_id,
      action_status: event.action_status,
      update_count: event.update_count,
      source_item_network: event.source_item.item_network,
      source_item_domain: event.source_item.item_domain,
      source_item_type: event.source_item.item_type,
      source_item_id: event.source_item.item_id,
      source_item_instance_url: event.source_item.item_instance_url,
      source_item_owner: event.source_item_owner,
      source_item_locations: event.source_item_locations ?? [],
      target_item_network: event.target_item.item_network,
      target_item_domain: event.target_item.item_domain,
      target_item_type: event.target_item.item_type,
      target_item_id: event.target_item.item_id,
      target_item_instance_url: event.target_item.item_instance_url,
      target_item_owner: event.target_item_owner,
      target_item_locations: event.target_item_locations ?? [],
      event_payload: event.event_payload,
      remarks: event.remarks ?? null,
    })
    .onConflictDoNothing({
      target: [
        action_events.partition_network,
        action_events.action_type,
        action_events.origin_instance_domain,
        action_events.action_id,
        action_events.update_count,
      ],
    })
    .returning({
      event_id: action_events.event_id,
      action_id: action_events.action_id,
      action_type: action_events.action_type,
      action_status: action_events.action_status,
      update_count: action_events.update_count,
    });

  return created ?? null;
}

function getActionEventPartitionNetwork(event: StoredActionEvent) {
  if (isCurrentInstanceItem(event.target_item)) {
    return event.target_item.item_network;
  }

  return event.source_item.item_network;
}

export function isCurrentInstanceItem(item: ActionItemRef) {
  return (
    normalizeInstanceUrl(item.item_instance_url) ===
    normalizeInstanceUrl(getCurrentApiBaseUrl())
  );
}

export function buildNetworkActionTargetItem(
  item: PerformActionTargetItemRef
): ActionItemRef {
  return {
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_id: item.item_id,
    item_instance_url: item.item_instance_url,
  };
}

export function buildActionEventPayload(input: {
  event_schema?: Record<string, unknown>;
  action_status: string;
  remarks?: string | null;
  context: ActionEventPayloadContext;
  consent?: { acknowledged: true; version: number };
}): Record<string, unknown> {
  const base = {
    ...projectEventPayloadFromSchema(input.event_schema, input.context),
    status: input.action_status,
    remark: input.remarks ?? defaultActionEventRemark(input.action_status),
  };
  if (!input.consent) return base;
  return {
    ...base,
    consent: {
      acknowledged: input.consent.acknowledged,
      version: input.consent.version,
      consented_at: new Date().toISOString(),
    },
  };
}

export function validateActionEventPayload(
  eventSchema: Record<string, unknown> | undefined,
  eventPayload: Record<string, unknown>
) {
  if (!eventSchema || Object.keys(eventSchema).length === 0) {
    return;
  }

  validateAgainstJsonSchema(eventSchema, eventPayload, 'event payload', {
    allowAdditionalProperties: apiConfig.allow_extra_schema_data,
    ignoredKeys: actionEventSystemPayloadKeys,
  });
}

function projectEventPayloadFromSchema(
  eventSchema: Record<string, unknown> | undefined,
  context: ActionEventPayloadContext
) {
  if (!eventSchema || Object.keys(eventSchema).length === 0) {
    return {};
  }

  const properties = isPlainObject(eventSchema.properties)
    ? eventSchema.properties
    : {};
  const payload: Record<string, unknown> = {};
  const contextRecord = context as unknown as Record<string, unknown>;

  for (const key of Object.keys(properties)) {
    if (isActionEventSystemPayloadKey(key)) {
      continue;
    }

    if (Object.hasOwn(contextRecord, key)) {
      payload[key] = contextRecord[key];
      continue;
    }

    if (Object.hasOwn(context.requirements_snapshot, key)) {
      payload[key] = context.requirements_snapshot[key];
    }
  }

  return payload;
}

function isActionEventSystemPayloadKey(
  key: string
): key is typeof actionEventSystemPayloadKeys[number] {
  return actionEventSystemPayloadKeys.includes(
    key as typeof actionEventSystemPayloadKeys[number]
  );
}

function defaultActionEventRemark(actionStatus: string) {
  return `Action status set to ${actionStatus}`;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * SSRF guard for the outbound event mirror. The mirror POSTs a full action-event
 * blob (containing PII) to `source_item.item_instance_url`, and that URL is
 * ultimately caller-asserted (via the unauthenticated /network/action/perform
 * body, then persisted and replayed from the DB on status updates). Without this
 * check any attacker can point it at an internal address (e.g. cloud IMDS) or an
 * exfiltration endpoint.
 *
 * The allowlist is the source network's own registered `instances` — an instance
 * whose `domain_id` matches the source item's domain and whose `instance_url`
 * shares the source URL's origin. We validate against `networkConfig.instances`
 * directly (NOT the served-domains-filtered CORS origin list): the mirror target
 * is a *remote* peer, so filtering by locally-served domains would wrongly refuse
 * legitimate peers. Compared by origin (scheme+host+port) so a path/query on
 * either side can't smuggle a mismatch.
 */
async function isRegisteredSourceInstance(
  event: StoredActionEvent
): Promise<boolean> {
  // The caller (mirrorActionEventToSourceInstance) has already parsed this URL
  // via normalizeInstanceUrl before reaching here, so `new URL` cannot throw.
  const sourceOrigin = new URL(event.source_item.item_instance_url).origin;

  const networkConfig = await getNetworkConfigById(
    event.source_item.item_network
  );

  return (networkConfig.instances ?? []).some((instance) => {
    if (instance.domain_id !== event.source_item.item_domain) return false;
    try {
      return new URL(instance.instance_url).origin === sourceOrigin;
    } catch {
      return false;
    }
  });
}

export async function mirrorActionEventToSourceInstance(
  event: StoredActionEvent,
  log: FastifyBaseLogger
) {
  if (
    normalizeInstanceUrl(event.source_item.item_instance_url) ===
    normalizeInstanceUrl(getCurrentApiBaseUrl())
  ) {
    return;
  }

  try {
    if (!(await isRegisteredSourceInstance(event))) {
      log.error(
        {
          action_id: event.action_id,
          source_instance_url: event.source_item.item_instance_url,
          source_item_network: event.source_item.item_network,
        },
        'Refusing to mirror action event: source instance URL is not a registered instance for its network (possible SSRF)'
      );
      return;
    }
  } catch (err) {
    log.error(
      {
        err,
        action_id: event.action_id,
        source_instance_url: event.source_item.item_instance_url,
      },
      'Failed to validate source instance URL before mirroring; refusing to mirror'
    );
    return;
  }

  try {
    const response = await fetch(
      new URL('/api/v1/event/store', event.source_item.item_instance_url),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
        // The origin allowlist above is checked once, against the URL we are
        // about to call. Following a redirect would move the PII payload to an
        // origin that was never checked, so a registered peer that 3xx's could
        // still relay this body anywhere — refuse instead.
        redirect: 'error',
        // Without a deadline an unresponsive peer holds this request (and its
        // socket) open indefinitely; the mirror is fire-and-forget, so a slow
        // peer must not accumulate. Same knob every other outbound peer call
        // uses (inter_instance_fetch.ts) — one timeout to tune, not two.
        signal: AbortSignal.timeout(apiConfig.peer_fetch_timeout_ms),
      }
    );

    if (!response.ok) {
      log.error(
        {
          action_id: event.action_id,
          source_instance_url: event.source_item.item_instance_url,
          status_code: response.status,
          status_text: response.statusText,
        },
        'Failed to mirror action event to source instance'
      );
    }
  } catch (err) {
    log.error(
      {
        err,
        action_id: event.action_id,
        source_instance_url: event.source_item.item_instance_url,
      },
      'Failed to mirror action event to source instance'
    );
  }
}
