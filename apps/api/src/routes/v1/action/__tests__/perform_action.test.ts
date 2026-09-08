import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan A Task 6 — bulk POST /api/v1/action/perform.
 * Each test sends an array body and asserts the { results, summary } envelope.
 */

// --- mock @/config so the env-validating loadEnv() never runs in tests ---
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    bulk_max_items: 100,
    schema_registry_url: '',
  },
  // The proxy now signs its outbound peer call (AUTH-VULN-05), so the mocked
  // config must carry the signing material or buildPeerHeaders throws.
  peerConfig: {
    shared_secret: 'c'.repeat(48),
    auth_mode: 'permissive',
    token_window_seconds: 300,
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  matchScoreConfig: { provider: 'noop', signals_search: {} },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {},
  databases: {},
  matchScore: {},
  notification: {},
  networkRuntime: {},
  schemaRegistry: {},
}));

// --- mock @/routes/auth/create_auth so the auth_middleware import chain
//     doesn't try to resolve @dpg/auth at module load time ---
vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: {
      getSession: vi.fn(async () => null),
    },
    handler: vi.fn(),
  },
}));

// --- mock the auth middleware itself so the auth path is a no-op in tests ---
vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

// --- mock @api/db/postgres/drizzle_config: db.select for onboarded_by lookup ---
const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
} = {
  userRows: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  // The route does TWO selects via db.select():
  //   (a) `resolve_acting_actor` looks up user.onboarded_by_org_id (only
  //       when acting_org is aggregator) — returns dbState.userRows.
  //   (b) `fetchLocalItemSnapshot` is itself mocked below, so the second
  //       select is never actually invoked through this mock. We still
  //       toggle to keep the mock shape generic, but the only call we
  //       care about returns userRows.
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(dbState.userRows)),
          })),
        })),
      })),
    },
  };
});

// --- mock fetch() so the proxy hop returns a deterministic response ---
const fetchCalls: Array<{ url: string; body: any }> = [];
const fetchResponse: { status: number; body: Record<string, unknown> } = {
  status: 201,
  body: {
    action_id: '00000000-0000-0000-0000-000000000001',
    action_type: 'apply',
    action_status: 'created',
    update_count: 0,
    source_item_id: '11111111-1111-4111-8111-111111111111',
    target_item_id: '22222222-2222-4222-8222-222222222222',
  },
};
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL, init: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify(fetchResponse.body), {
      status: fetchResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }),
);

// --- mock helpers from action_event_runtime: only fetchLocalItemSnapshot is on the perform path ---
const { fetchLocalItemSnapshotMock } = vi.hoisted(() => ({
  fetchLocalItemSnapshotMock: vi.fn(async () => ({
    created_by: 'usr_agg_owned',
    item_id: 'src_item_1',
    item_locations: [],
    private_state: {},
    lifecycle_status: 'live',
  })),
}));

vi.mock('@/utils/action_event_runtime', async () => {
  const actual =
    await vi.importActual<typeof import('@/utils/action_event_runtime')>(
      '@/utils/action_event_runtime',
    );
  return {
    ...actual,
    fetchLocalItemSnapshot: fetchLocalItemSnapshotMock,
  };
});

// --- mock served domain guard so the test isn't sensitive to env config ---
vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => true,
  replyForUnservedDomain: vi.fn(),
}));

// --- mock network config + interaction lookup ---
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    domains: [{ id: 'provider' }],
    instances: [
      { domain_id: 'provider', instance_url: 'http://target.local' },
    ],
  })),
}));

// --- mock the U18 guardian gate: this suite is all adult/ungated traffic, so
// it always resolves `not_required` (matching the real gate's behavior for
// these fixtures — 'seeker' never appears as a `guardian_consent_required`
// domain above). Mocked at this seam (not the deeper otp/redis primitives) so
// this unit test doesn't need a real Redis client, mirroring how the other
// deps on this route are already mocked above.
vi.mock('@/services/guardian_action_gate', () => ({
  guardianActionGate: vi.fn(async () => ({ status: 'not_required' })),
  // Bulk pre-pass (#393): default resolves an empty map (no gated subset). The
  // external-channel test asserts it is never called (pre-pass skipped when
  // request.acting_org is set, #450).
  guardianBulkActionGate: vi.fn(async () => new Map()),
  // Defaults to null (adult/ungated proceed); U18 tests override it per-case
  // with a real BulkItemFailure so runBulk records the per-item error.
  guardianGateFailure: vi.fn(() => null),
}));

vi.mock('@dpg/schemas', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({
      requirement_schema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      reveals_pii_on_status: [],
    })),
    validateAgainstJsonSchema: vi.fn(),
    mergeItemStateWithPrivate: vi.fn((a: any) => a),
    projectPrivateStateForSchema: vi.fn(() => ({})),
  };
});

// Imported after mocks.
import { perform_action } from '../perform_action.js';
import { BulkItemFailure } from '@/utils/bulk_runner';
import {
  guardianActionGate,
  guardianBulkActionGate,
  guardianGateFailure,
} from '@/services/guardian_action_gate';

// Valid v4 UUIDs (the "4" in the third group and "8/9/a/b" in the fourth
// satisfy z.uuid() across zod variants that gate on the variant nibble).
const SRC_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const TGT_ITEM_ID = '22222222-2222-4222-8222-222222222222';

const VALID_BODY = {
  action_type: 'apply',
  source_item: {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: SRC_ITEM_ID,
  },
  target_item: {
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'job_posting_1.0',
    item_id: TGT_ITEM_ID,
    item_instance_url: 'http://target.local',
  },
  requirements_snapshot: {},
};

const buildApp = (
  acting_org?: any,
  request_user: { id: string } = { id: 'usr_agg_owned' },
): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as any).user = request_user;
    if (acting_org) (req as any).acting_org = acting_org;
  });
  app.register(perform_action);
  return app;
};

describe('POST /api/v1/action/perform — on-behalf-of (bulk)', () => {
  beforeEach(() => {
    dbState.userRows = [];
    fetchCalls.length = 0;
    // Reset snapshot mock to the default valid snapshot
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_agg_owned',
      item_id: 'src_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
    });
    // Reset fetchResponse to default success
    fetchResponse.status = 201;
    fetchResponse.body = {
      action_id: '00000000-0000-0000-0000-000000000001',
      action_type: 'apply',
      action_status: 'created',
      update_count: 0,
      source_item_id: '11111111-1111-4111-8111-111111111111',
      target_item_id: '22222222-2222-4222-8222-222222222222',
    };
  });

  it('self-acted: no acting_org, no body field → 201, summary.succeeded=1, forwards effective_user_id as source_item_owner, audit null', async () => {
    // The snapshot's created_by is "usr_agg_owned" — match request.user
    // so the SOURCE_ITEM_NOT_OWNED_BY_ACTOR guard does not trip.
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      index: 0,
      status: 'success',
      action_id: '00000000-0000-0000-0000-000000000001',
      action_type: 'apply',
      action_status: 'created',
      update_count: 0,
      source_item_id: SRC_ITEM_ID,
      target_item_id: TGT_ITEM_ID,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_agg_owned',
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('422 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp(undefined, { id: 'usr_self' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_target' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'CANNOT_OVERRIDE_SELF' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 MISSING_ACTING_AS_USER_ID when aggregator acting_org but no body field', async () => {
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'MISSING_ACTING_AS_USER_ID' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 ACTING_ORG_TYPE_NOT_ALLOWED for an org type outside the allowed set', async () => {
    // voice used to be the example here; it is now an admitted integrating
    // DPG, so this needs a type that genuinely is not allowed.
    const app = buildApp({
      org_id: 'org_employer_1',
      org_type: 'employer' as unknown as 'aggregator',
      service_user_id: 'svc_emp_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_target' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('accepts a voice acting_org acting on behalf of a user', async () => {
    dbState.userRows = [{ id: 'usr_target', onboardedByOrgId: 'org_agg_2' }];
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc_voice_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_target' }],
    });
    // Not rejected on org type — voice reaches the action itself. The target
    // is onboarded by a different org on purpose: voice is network-wide, so
    // the aggregator's ownership rule must not apply to it.
    expect(res.json().results[0]).not.toMatchObject({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
    });
    expect(res.json().results[0]).not.toMatchObject({
      error: 'NOT_AUTHORIZED_FOR_TARGET',
    });
  });

  it('422 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another aggregator', async () => {
    dbState.userRows = [
      { id: 'usr_other', onboardedByOrgId: 'org_agg_2' },
    ];
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_other' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'NOT_AUTHORIZED_FOR_TARGET' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('aggregator happy path: 201, forwards acting_as_user_id as source_item_owner + populates audit', async () => {
    dbState.userRows = [
      { id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' },
    ];
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc_agg_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({ status: 'success' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_agg_owned',
      performed_by_org_id: 'org_agg_1',
      performed_by_service_user_id: 'svc_agg_1',
    });
  });

  it('422 SOURCE_ITEM_NOT_OWNED_BY_ACTOR when snapshot.created_by != effective_user_id', async () => {
    dbState.userRows = [
      { id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' },
    ];
    // Override the snapshot mock to return a DIFFERENT owner than acting_as_user_id.
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_someone_else',
      item_id: 'src_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
    });
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc_agg_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'SOURCE_ITEM_NOT_OWNED_BY_ACTOR' });
    expect(fetchCalls).toHaveLength(0); // proxy hop must be skipped
  });

  it('422 SOURCE_ITEM_NOT_FOUND when snapshot returns null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchLocalItemSnapshotMock.mockResolvedValue(null as any);
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'SOURCE_ITEM_NOT_FOUND' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 PROFILE_NOT_LIVE when source snapshot has a non-live lifecycle_status', async () => {
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_agg_owned',
      item_id: 'src_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'paused',
    });
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'PROFILE_NOT_LIVE' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 INVALID_TARGET_INSTANCE when target instance URL is not in the network config', async () => {
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform/bulk',
      payload: [{ ...VALID_BODY, target_item: { ...VALID_BODY.target_item, item_instance_url: 'http://not-allowed.local' } }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'INVALID_TARGET_INSTANCE' });
    expect(fetchCalls).toHaveLength(0);
  });

  describe('initiator consent gate', () => {
    it('422 CONSENT_REQUIRED when interaction declares reveals_pii_on_status but body has no consent', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        reveals_pii_on_status: ['accepted'],
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [VALID_BODY], // no consent field
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'CONSENT_REQUIRED' });
      expect(fetchCalls).toHaveLength(0);
    });

    it('201, forwards consent block to /network/action/perform when supplied', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        reveals_pii_on_status: ['accepted'],
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [
          {
            ...VALID_BODY,
            consent: { acknowledged: true, version: 1 },
          },
        ],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.consent).toEqual({
        acknowledged: true,
        version: 1,
      });
    });

    it('does NOT gate when interaction has empty reveals_pii_on_status (back-compat)', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        reveals_pii_on_status: [],
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [VALID_BODY], // no consent field
      });
      expect(res.statusCode).toBe(201);
      expect(fetchCalls).toHaveLength(1);
    });
  });

  describe('network_service tier', () => {
    it('network_service on-behalf-of: 201 when acting for any user in the network', async () => {
      dbState.userRows = [
        { id: 'usr_voice_owned', onboardedByOrgId: 'org_agg_b' },
      ];
      fetchLocalItemSnapshotMock.mockResolvedValue({
        created_by: 'usr_voice_owned',
        item_id: 'src_item_1',
        item_locations: [],
        private_state: {},
        lifecycle_status: 'live',
      });
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toMatchObject({
        source_item_owner: 'usr_voice_owned',
        performed_by_org_id: 'org_signals',
        performed_by_service_user_id: 'svc_ns',
      });
    });

    it('network_service on-behalf-of: 201 for self-registered user (onboarded_by null)', async () => {
      dbState.userRows = [
        { id: 'usr_self_reg', onboardedByOrgId: null },
      ];
      fetchLocalItemSnapshotMock.mockResolvedValue({
        created_by: 'usr_self_reg',
        item_id: 'src_item_1',
        item_locations: [],
        private_state: {},
        lifecycle_status: 'live',
      });
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_self_reg' }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls[0].body).toMatchObject({
        source_item_owner: 'usr_self_reg',
        performed_by_org_id: 'org_signals',
      });
    });

    it('network_service on-behalf-of: 422 USER_NOT_FOUND when pointing at non-existent user', async () => {
      dbState.userRows = []; // empty — no row returned
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_missing' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'USER_NOT_FOUND' });
      expect(fetchCalls).toHaveLength(0);
    });
  });

  // U18 action channel block (#395): the gate is mocked at its seam (as
  // everywhere in this suite), so these assert the wiring — perform passes the
  // correct `channel` and the gate's external_minor_blocked outcome flows
  // through guardianGateFailure into a per-item error with no relay fetch.
  describe('U18 action channel block (#395)', () => {
    it('on-behalf + minor on a gated domain → per-item MINOR_ACTION_CHANNEL_BLOCKED, no relay fetch', async () => {
      dbState.userRows = [{ id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' }];
      vi.mocked(guardianActionGate).mockResolvedValueOnce({
        status: 'external_minor_blocked',
        reason: 'minor',
      });
      vi.mocked(guardianGateFailure).mockReturnValueOnce(
        new BulkItemFailure(
          'MINOR_ACTION_CHANNEL_BLOCKED',
          "This participant is a minor; actions for minors must be completed in the app and can't be performed via this channel.",
        ),
      );
      const app = buildApp({
        org_id: 'org_agg_1',
        org_type: 'aggregator',
        service_user_id: 'svc_agg_1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        status: 'error',
        error: 'MINOR_ACTION_CHANNEL_BLOCKED',
      });
      expect(fetchCalls).toHaveLength(0);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'external', wardUserId: 'usr_agg_owned' }),
      );
    });

    it('on-behalf + adult → gate resolves not_required, action proceeds (201)', async () => {
      dbState.userRows = [{ id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' }];
      const app = buildApp({
        org_id: 'org_agg_1',
        org_type: 'aggregator',
        service_user_id: 'svc_agg_1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().results[0]).toMatchObject({ status: 'success' });
      expect(fetchCalls).toHaveLength(1);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'external' }),
      );
    });

    it('self-session + minor → guardian-OTP flow unchanged (channel self, GUARDIAN_OTP_REQUIRED, no relay fetch)', async () => {
      vi.mocked(guardianActionGate).mockResolvedValueOnce({ status: 'challenge_issued' });
      vi.mocked(guardianGateFailure).mockReturnValueOnce(
        new BulkItemFailure(
          'GUARDIAN_OTP_REQUIRED',
          'Guardian OTP sent; resubmit with guardian_otp to confirm this action.',
        ),
      );
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [VALID_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({
        status: 'error',
        error: 'GUARDIAN_OTP_REQUIRED',
      });
      expect(fetchCalls).toHaveLength(0);
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'self' }),
      );
    });

    it('external channel + minor ≥2-item bulk → each item MINOR_ACTION_CHANNEL_BLOCKED, batch gate skipped, no OTP (#450/#393)', async () => {
      dbState.userRows = [{ id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' }];
      // Two items → the per-action gate runs twice (batch pre-pass is skipped on
      // the external channel), each returning external_minor_blocked.
      const blocked = new BulkItemFailure(
        'MINOR_ACTION_CHANNEL_BLOCKED',
        "This participant is a minor; actions for minors must be completed in the app and can't be performed via this channel.",
      );
      vi.mocked(guardianActionGate)
        .mockResolvedValueOnce({ status: 'external_minor_blocked', reason: 'minor' })
        .mockResolvedValueOnce({ status: 'external_minor_blocked', reason: 'minor' });
      vi.mocked(guardianGateFailure).mockReturnValueOnce(blocked).mockReturnValueOnce(blocked);
      const app = buildApp({
        org_id: 'org_agg_1',
        org_type: 'aggregator',
        service_user_id: 'svc_agg_1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [
          { ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' },
          { ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' },
        ],
      });
      expect(res.statusCode).toBe(422);
      const results = res.json().results;
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toMatchObject({ status: 'error', error: 'MINOR_ACTION_CHANNEL_BLOCKED' });
      }
      // #450: the one-OTP batch path must NOT run on an external channel — the
      // per-action gate does the blocking, with channel 'external'.
      expect(vi.mocked(guardianBulkActionGate)).not.toHaveBeenCalled();
      expect(vi.mocked(guardianActionGate)).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'external', wardUserId: 'usr_agg_owned' }),
      );
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe('mixed batch', () => {
    it('207 when one connect succeeds and one has an unknown target instance', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [
          VALID_BODY,
          { ...VALID_BODY, target_item: { ...VALID_BODY.target_item, item_instance_url: 'http://not-allowed.local' } },
        ],
      });
      expect(res.statusCode).toBe(207);
      const body = res.json();
      expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
      expect(body.results[0]).toMatchObject({ index: 0, status: 'success' });
      expect(body.results[1]).toMatchObject({ index: 1, status: 'error', error: 'INVALID_TARGET_INSTANCE' });
    });
  });

  describe('request-level bulk guards', () => {
    it('400 BULK_EMPTY_ARRAY for an empty array', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_EMPTY_ARRAY' });
    });

    it('400 BULK_LIMIT_EXCEEDED when over the configured max', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      // Generate 101 items (bulk_max_items is mocked to 100)
      const items = Array.from({ length: 101 }, () => VALID_BODY);
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: items,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_LIMIT_EXCEEDED' });
    });
  });

  describe('remote error handling', () => {
    it('422 DUPLICATE_ACTION when target instance responds non-OK with a structured error body', async () => {
      fetchResponse.status = 409;
      fetchResponse.body = { error: 'DUPLICATE_ACTION', message: 'already exists' };
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [VALID_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'DUPLICATE_ACTION' });
    });

    it('422 INVALID_PAYLOAD when item is missing required source_item/target_item', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [{ action_type: 'connect' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'INVALID_PAYLOAD' });
      expect(fetchCalls).toHaveLength(0);
    });

    it('201 when requirements_snapshot is omitted → defaults to {} and forwards it', async () => {
      // A no-requirements action (e.g. blue_dot seeker→provider) carries an
      // empty snapshot; external callers that cannot serialise an empty object
      // omit the field. It must be accepted and forwarded as {}.
      const { requirements_snapshot: _omitted, ...bodyWithoutSnapshot } = VALID_BODY;
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [bodyWithoutSnapshot],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().results[0]).toMatchObject({ status: 'success' });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.requirements_snapshot).toEqual({});
    });

    it('422 TARGET_INSTANCE_UNAVAILABLE when target instance returns a non-JSON body (Fix 1)', async () => {
      const originalFetch = vi.mocked(global.fetch);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init: RequestInit) => {
          fetchCalls.push({ url: String(url), body: JSON.parse(init.body as string) });
          return {
            ok: true,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
          } as unknown as Response;
        }),
      );
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform/bulk',
        payload: [VALID_BODY],
      });
      // Restore normal fetch mock
      vi.stubGlobal('fetch', originalFetch);
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'TARGET_INSTANCE_UNAVAILABLE' });
    });
  });
});

describe('POST /api/v1/action/perform — single object', () => {
  beforeEach(() => {
    dbState.userRows = [];
    fetchCalls.length = 0;
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_agg_owned',
      item_id: 'src_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
    });
    fetchResponse.status = 201;
    fetchResponse.body = {
      action_id: '00000000-0000-0000-0000-000000000001',
      action_type: 'apply',
      action_status: 'created',
      update_count: 0,
      source_item_id: '11111111-1111-4111-8111-111111111111',
      target_item_id: '22222222-2222-4222-8222-222222222222',
    };
  });

  it('201 with a single-object body → { results:[one], summary:{ total:1 } }', async () => {
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary.total).toBe(1);
    expect(body.results).toHaveLength(1);
  });

  it('400 FST_ERR_VALIDATION when the single object body is missing required fields', async () => {
    // NOTE: /perform validates the body against PerformActionBodySchema at
    // the Fastify route-schema level (unlike /perform/bulk, whose body is
    // z.array(z.unknown()) and defers per-item shape validation into
    // runPerformActions, which reports INVALID_PAYLOAD as a 422 inside the
    // {results, summary} envelope). A route-schema failure short-circuits
    // before the handler runs, so Fastify's default validation error
    // applies here — a plain 400, not the bulk envelope's 422.
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { action_type: 'connect' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FST_ERR_VALIDATION' });
  });

  it('422 INVALID_TARGET_INSTANCE via single-object /perform when target instance URL is not in the network config', async () => {
    // Mirrors the bulk "422 INVALID_TARGET_INSTANCE" case above: a
    // syntactically-valid body (passes PerformActionBodySchema) whose
    // target_item.item_instance_url fails the business-rule check inside
    // runPerformActions, surfaced through the single-object /perform path
    // as the same { results, summary } envelope the bulk route returns.
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: {
        ...VALID_BODY,
        target_item: { ...VALID_BODY.target_item, item_instance_url: 'http://not-allowed.local' },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.summary.total).toBe(1);
    expect(body.results[0]).toMatchObject({ status: 'error', error: 'INVALID_TARGET_INSTANCE' });
    expect(fetchCalls).toHaveLength(0);
  });
});
