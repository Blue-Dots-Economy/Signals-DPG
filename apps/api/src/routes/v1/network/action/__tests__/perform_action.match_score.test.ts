import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * #439 Task 3 — CREATE seam (POST /api/v1/network/action/perform) computes
 * and stores `item_actions.match_score` once, async, fire-and-forget.
 *
 * Verifies:
 *   (a) the handler still returns 201 with the created row (score compute
 *       must never block or fail the response), and
 *   (b) after the fire-and-forget promise settles, `db.update` was called
 *       with the mocked computed score for the created action_id.
 */

// Shared with vi.mock factories (hoisted above top-level consts).
const {
  BASE_URL,
  updateSetSpy,
  updateWhereSpy,
  computeActionMatchScoreSpy,
} = vi.hoisted(() => ({
  BASE_URL: 'http://source.local',
  updateSetSpy: vi.fn(),
  updateWhereSpy: vi.fn(async () => undefined),
  computeActionMatchScoreSpy: vi.fn(async (): Promise<number | null> => 6.1),
}));

// The route is peer-guarded (AUTH-VULN-05). These cases cover the notify /
// match-score seams, not auth, so let every request through — the guard's own
// wiring is asserted in the network route-registration test.
vi.mock('@/middleware/peer_instance_guard', () => ({
  peer_instance_guard: async () => {},
  // The route uses the STRICT variant, which never honours permissive — stub it
  // too, or every case here 401s before reaching the handler under test.
  peer_instance_guard_strict: async () => {},
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
}));

// Notification dispatch is not the focus here — keep it a no-op.
vi.mock('@/notifications/notify_actions', () => ({
  dispatchActionNotifications: vi.fn(async () => undefined),
}));

vi.mock('@/services/actions/compute_match_score', () => ({
  computeActionMatchScore: computeActionMatchScoreSpy,
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
    // Owner differs by item so the self-action guard (source owner === target
    // owner) does not trip: the source (seeker) and target (provider) are held
    // by different users, as in a real cross-domain action.
    fetchLocalItemSnapshot: vi.fn(async (_db: unknown, item: { item_id: string }) => ({
      created_by:
        item.item_id === '11111111-1111-4111-8111-111111111111' ? 'usr_seeker' : 'usr_provider',
      item_id: item.item_id,
      item_instance_url: BASE_URL,
      item_schema_url: 'https://schemas.test/job_posting_1.0.json',
      item_locations: [],
      lifecycle_status: 'live',
      private_state: { title: 'Role' },
    })),
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: vi.fn(async () => ({
      event_id: 'evt_1',
      action_id: 'act_1',
      action_type: 'connect',
      action_status: 'created',
      update_count: 0,
    })),
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
    // Fire-and-forget score persist: db.update(item_actions).set({...}).where(...)
    update: vi.fn(() => ({
      set: (arg: unknown) => {
        updateSetSpy(arg);
        return { where: updateWhereSpy };
      },
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

describe('POST /api/v1/network/action/perform — match_score compute (#439)', () => {
  beforeEach(() => {
    updateSetSpy.mockClear();
    updateWhereSpy.mockClear();
    computeActionMatchScoreSpy.mockClear();
  });

  it('returns 201 with the created row, then persists the computed match_score without blocking the response', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/action/perform',
      payload: VALID_BODY,
    });

    // (a) 201 path is unaffected by the score compute.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ action_id: 'act_1', action_status: 'created' });

    // The fire-and-forget update had not necessarily run synchronously with
    // the response — assert it lands once the microtask queue flushes.
    await vi.waitFor(() => expect(updateSetSpy).toHaveBeenCalled());

    expect(computeActionMatchScoreSpy).toHaveBeenCalledTimes(1);
    expect(updateSetSpy).toHaveBeenCalledWith({ match_score: 6.1 });
    expect(updateWhereSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a self-action (source item === target item) with 400 SELF_ACTION_NOT_ALLOWED', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/action/perform',
      // Acting on your own profile — source and target are the same item. The
      // UI filters own pins from the map/list, but the API is the control.
      payload: {
        ...VALID_BODY,
        source_item: {
          ...VALID_BODY.source_item,
          item_id: '22222222-2222-4222-8222-222222222222',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'SELF_ACTION_NOT_ALLOWED' });
  });

  it('rejects a self-action across two different items of the same owner (owner-equality branch)', async () => {
    // Different item ids, but both resolve to the same DB owner: the snapshot
    // mock returns `usr_provider` for any id other than the seeker source, so a
    // third source id shares the target's owner. Exercises the owner branch
    // (not the same-item shortcut) — the two-profiles-of-one-user case.
    const res = await buildApp().inject({
      method: 'POST',
      url: '/action/perform',
      payload: {
        ...VALID_BODY,
        source_item: {
          ...VALID_BODY.source_item,
          item_id: '33333333-3333-4333-8333-333333333333',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'SELF_ACTION_NOT_ALLOWED' });
  });

  it('does not update the row when the computed score is null', async () => {
    computeActionMatchScoreSpy.mockResolvedValueOnce(null);

    const res = await buildApp().inject({
      method: 'POST',
      url: '/action/perform',
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);

    // Give the fire-and-forget promise a chance to settle before asserting
    // the negative — there's no positive signal to waitFor here.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateSetSpy).not.toHaveBeenCalled();
  });
});
