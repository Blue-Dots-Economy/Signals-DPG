import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * §11 integration test — CREATE seam (POST /api/v1/network/action/perform).
 *
 * Proves the notification dispatch can't break the action:
 *   (a) the action returns 201 even when `nc.notify` rejects, and
 *   (b) `insertActionEvent` is called exactly once (no double insert from
 *       the dispatch path).
 *
 * The dispatch is real (not mocked) so the seam wiring is exercised end to end;
 * only the outbound notification client throws.
 */

// Shared with vi.mock factories (hoisted above top-level consts).
const { BASE_URL, notifySpy, insertActionEventSpy } = vi.hoisted(() => ({
  BASE_URL: 'http://source.local',
  notifySpy: vi.fn(async () => {
    throw new Error('NS down');
  }),
  insertActionEventSpy: vi.fn(async () => ({
    event_id: 'evt_1',
    action_id: 'act_1',
    action_type: 'connect',
    action_status: 'created',
    update_count: 0,
  })),
}));

// Notifications are CONFIGURED here (unlike the other seam tests) so dispatch
// actually runs and reaches the (throwing) notify client.
// The route is peer-guarded (AUTH-VULN-05). These cases cover the notify /
// match-score seams, not auth, so let every request through — the guard's own
// wiring is asserted in the network route-registration test.
vi.mock('@/middleware/peer_instance_guard', () => ({
  peer_instance_guard: async () => {},
}));

vi.mock('@/config', () => ({
  apiConfig: {
    domain: BASE_URL,
    port: 3000,
    served_domains: [],
    allow_extra_schema_data: true,
    bulk_max_items: 100,
    schema_registry_url: '',
  },
  getCurrentApiBaseUrl: () => BASE_URL,
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  notification: {
    NOTIFICATION_FROM_EMAIL: 'from@test.local',
    NOTIFICATION_REPLY_TO: 'reply@test.local',
    FRONTEND_BASE_URL: 'http://fe.test',
  },
  uiHostBindings: { byDomain: {}, warnings: [] },
}));

// Throwing notification client — the whole point of the test.
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => ({ notify: notifySpy }),
}));

// Recipient resolution stubbed so dispatch reaches notify (not skipped).
vi.mock('@/notifications/resolve_owner', () => ({
  resolveOwnerEmail: vi.fn(async () => 'recipient@test.local'),
  resolveProviderServiceName: vi.fn(async () => 'Acme Services'),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'blue_dot',
    display_name: 'Blue Dot',
    domains: [{ id: 'provider' }, { id: 'seeker' }],
  })),
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: vi.fn(() => true),
  replyForUnservedDomain: vi.fn(),
}));

vi.mock('@/utils/action_event_runtime', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/action_event_runtime')
  >('@/utils/action_event_runtime');
  return {
    ...actual,
    isCurrentInstanceItem: vi.fn(() => true),
    // Distinct owners per item so the self-action guard doesn't trip (source
    // seeker vs target provider — a real cross-owner action).
    fetchLocalItemSnapshot: vi.fn(async (_db: unknown, item: { item_id: string }) => ({
      created_by:
        item.item_id === '11111111-1111-4111-8111-111111111111' ? 'usr_seeker' : 'usr_provider',
      item_id: item.item_id,
      item_locations: [],
      lifecycle_status: 'live',
    })),
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: insertActionEventSpy,
    mirrorActionEventToSourceInstance: vi.fn(() => undefined),
  };
});

vi.mock('@dpg/database', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return {
    ...actual,
    ensureActionPartition: vi.fn(async () => undefined),
    ensureActionEventPartition: vi.fn(async () => undefined),
  };
});

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: vi.fn(async () => 1),
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const dbMock: Record<string, unknown> = {
    // Pair-cap pre-pass (#370): advisory lock (execute) + open-action recount
    // (select→from→where). 0 open → under the default cap of 1 → proceeds.
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ open: 0 }]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [
          {
            action_id: 'act_1',
            action_type: 'connect',
            action_status: 'created',
            update_count: 0,
            source_item_id: '11111111-1111-4111-8111-111111111111',
            target_item_id: '22222222-2222-4222-8222-222222222222',
          },
        ]),
      })),
    })),
  };
  // The handler wraps the action + initiate-consent inserts in a transaction;
  // run the callback with the same mock as `tx`.
  dbMock.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  return { db: dbMock };
});

vi.mock('@dpg/schemas', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({
      requirement_schema: {},
      event_schema: {},
      reveals_pii_on_status: [],
    })),
    validateAgainstJsonSchema: vi.fn(),
  };
});

// Imported after mocks.
import { perform_network_action } from '../perform_action.js';

const VALID_BODY = {
  action_type: 'connect',
  source_item: {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: '11111111-1111-4111-8111-111111111111',
    item_instance_url: BASE_URL,
  },
  target_item: {
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'job_posting_1.0',
    item_id: '22222222-2222-4222-8222-222222222222',
    item_instance_url: BASE_URL,
  },
  source_item_owner: 'usr_seeker',
  requirements_snapshot: {},
};

const buildApp = (): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(perform_network_action);
  return app;
};

describe('POST /api/v1/network/action/perform — notification fire-and-forget', () => {
  beforeEach(() => {
    notifySpy.mockClear();
    insertActionEventSpy.mockClear();
  });

  it('returns 201 even when nc.notify rejects, and inserts the event exactly once', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/action/perform',
      payload: VALID_BODY,
    });

    // (a) The action succeeds despite the notification client throwing.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ action_id: 'act_1', action_status: 'created' });

    // (b) Exactly one insertActionEvent — dispatch must not insert again.
    expect(insertActionEventSpy).toHaveBeenCalledTimes(1);

    // The dispatch ran and reached the (throwing) notify; the rejection is
    // swallowed by the per-plan catch and never surfaces to the route.
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled());
  });
});
