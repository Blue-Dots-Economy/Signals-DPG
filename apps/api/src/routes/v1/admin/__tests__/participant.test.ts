import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan C Task 3 — failing tests for POST /api/v1/admin/participant.
 *
 * Mounts the tier-aware upsert route in isolation (no auth_middleware,
 * no acting_org preHandler), stubs request.acting_org via a preHandler
 * hook, and asserts the dispatch matrix from resolve_upsert_action +
 * the runtime ownership check produces the right response shape and
 * the right side effects on the mocked DB / item helpers.
 */

// Flipped per test. Declared before the factory so the mock closes over it —
// `keycloak_enabled` decides whether the row is written directly or via
// better-auth's signUpEmail.
// `vi.hoisted` because `vi.mock` factories are hoisted above ordinary consts,
// and this one is dereferenced when the factory runs rather than lazily.
const mockAuthConfig = vi.hoisted(() => ({
  secret: 'test-secret',
  middleware_enabled: false,
  url: 'http://source.local/api/auth',
  create_test_otp: false,
  keycloak_enabled: false,
}));

// --- mock @/config so loadEnv() never runs ---
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'provider' },
    ],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: mockAuthConfig,
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

// --- neutralize the auth chain ---
vi.mock('@/routes/auth/create_auth', () => {
  return {
    authInstance: {
      api: {
        signUpEmail: vi.fn(async () => {
          if (dbState.signUpMode === 'unique_violation') {
            const err: Error & { code?: string } = new Error(
              'duplicate key value violates unique constraint',
            );
            err.code = '23505';
            throw err;
          }
          return { user: { id: dbState.signUpUserId } };
        }),
      },
    },
  };
});

// The realm-identity step. Mocked so no admin client is constructed, and so a
// failure can be simulated to prove the compensating delete still runs.
vi.mock('@/services/auth/participant_identity', () => ({
  createParticipantKeycloakIdentity: vi.fn(async (input: { email: string | null }) => {
    dbState.identityCalls.push({ email: input.email });
    return dbState.identityResult;
  }),
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

// --- mock @dpg/database: keep real exports for schemas/items, stub ensureItemPartition ---
vi.mock('@dpg/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/database')>();
  return {
    ...actual,
    ensureItemPartition: vi.fn(async () => {}),
  };
});

// --- mock publishItemEvent so Redis is never touched in unit tests ---
vi.mock('@/utils/publish_item_event', () => {
  const publishItemEvent = vi.fn(async () => {});
  return {
    publishItemEvent,
    // Keeps the real fan-out + de-dupe, delegating to the mocked single publish,
    // so every assertion on `publishItemEvent` still sees exactly the events the
    // route emitted — a no-op stub here would hide them all.
    publishItemEvents: vi.fn(
      async (
        keys: Array<Record<string, string>>,
        op: string,
        logger?: unknown,
      ) => {
        const seen = new Set<string>();
        for (const k of keys) {
          const id = `${k.item_network}/${k.item_domain}/${k.item_type}/${k.item_id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (publishItemEvent as any)({ ...k, op }, logger);
        }
      },
    ),
  };
});

// --- mock the consent service: it is unit-tested separately; here we only
//     assert the route calls it with the right args and stays green.
vi.mock('@/services/participant_consent', () => ({
  recordParticipantConsent: vi.fn(async () => ({ recorded: 0, promoted: false })),
  // Returns the keys of the drafts an age write promoted (#557) — the route has to
  // publish an item event for each so signals-search re-indexes them.
  promoteEligibleDraftsForUser: vi.fn(async () => [] as unknown[]),
}));

// --- mock @dpg/schemas: keep real exports + neutralize the merge helper for tests ---
vi.mock('@dpg/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/schemas')>();
  return {
    ...actual,
    mergeItemStateWithPrivate: (pub: Record<string, unknown>) => pub,
  };
});

// --- shared mock state ---
type ItemRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_private_state: string;
  item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  created_at: Date;
  updated_at: Date;
};

const dbState: {
  existingUserRows: Array<{
    id: string;
    email: string | null;
    phoneNumber: string | null;
    onboardedByOrgId: string | null;
  }>;
  itemsByUser: Map<string, ItemRow[]>;
  itemOwnerLookup: Map<string, string>; // item_id -> user_id
  updates: Array<{ id: string; set: Record<string, unknown> }>;
  inserts: Array<{ user_id: string; network: string; domain: string; item_type: string }>;
  signUpMode: 'ok' | 'unique_violation';
  signUpUserId: string;
  /**
   * When set (non-null), the mock returns this item_id for the
   * existing-owned-item lookup (SELECT item_id FROM items WHERE
   * created_by=... AND item_network=... ORDER BY updated_at DESC LIMIT 1).
   * Set per-test for the idempotent re-onboard scenario.
   */
  existingOwnedItemId: string | null;
  /** `user` rows written directly by insertLocalUser (the Keycloak branch). */
  userInserts: Array<Record<string, unknown>>;
  /** Args seen by createParticipantKeycloakIdentity. */
  identityCalls: Array<{ email: string | null }>;
  identityResult: { ok: boolean; code?: string; message?: string };
  /** When set, the direct user insert throws this. */
  userInsertError: unknown;
  /** user rows deleted (the orphan-cleanup path). */
  userDeletes: number;
  /**
   * Orgs claiming the binding in the SS-3 default-aggregator lookup (#640).
   * Empty = no default configured for this instance, which is the launch state
   * and what every pre-existing test in this file expects.
   */
  defaultAggregatorRows: Array<{ id: string }>;
} = {
  existingUserRows: [],
  itemsByUser: new Map(),
  itemOwnerLookup: new Map(),
  updates: [],
  inserts: [],
  signUpMode: 'ok',
  signUpUserId: 'usr_new_default',
  existingOwnedItemId: null,
  userInserts: [],
  identityCalls: [],
  identityResult: { ok: true },
  defaultAggregatorRows: [],
  userInsertError: null,
  userDeletes: 0,
};

// Discriminate db.select() projections by their key set, so the same
// db mock can serve user-lookups, ownership-lookups, items-list reads,
// and the idempotent existing-owned-item lookup.
type SelectMode = 'user' | 'items_list' | 'item_owner' | 'existing_item_lookup' | 'unknown';

const classifyProjection = (proj: Record<string, unknown> | undefined): SelectMode => {
  // `insertLocalUser` re-reads with a bare `select()` (no projection) after a
  // unique violation, so undefined is a real case, not a mistake.
  if (!proj) return 'unknown';
  const keys = Object.keys(proj);
  if (keys.includes('onboardedByOrgId')) return 'user';
  // The ownership pre-flight now also reads the item's key columns (#557), so it is
  // no longer a single-column projection.
  if (keys.includes('created_by') && !keys.includes('item_state')) return 'item_owner';
  if (keys.length === 1 && keys[0] === 'item_id') return 'existing_item_lookup';
  if (keys.includes('item_state') && keys.includes('item_private_state')) {
    return 'items_list';
  }
  return 'unknown';
};

// Last user_id captured from a select-where call so items_list reads can
// scope their results. We use the most-recent user_id queried; tests are
// single-flow so there's no contention.
let lastQueriedUserId: string | null = null;
// Last item_id captured from an item-owner lookup.
let lastQueriedItemId: string | null = null;

// Intercept eq()/and()/inArray() drizzle expressions: drizzle returns
// opaque SQL builders, so we can't introspect them directly. Instead the
// test's user_id is fed via a side channel — the existingUserRows[0].id —
// since each test only ever has one user in scope.
vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeSelectChain = (proj?: Record<string, unknown>) => {
    const mode = classifyProjection(proj);
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            if (mode === 'user') {
              return Promise.resolve(dbState.existingUserRows);
            }
            if (mode === 'item_owner') {
              const item_id = lastQueriedItemId;
              const owner = item_id
                ? dbState.itemOwnerLookup.get(item_id)
                : undefined;
              if (!owner) return Promise.resolve([]);
              // Key columns come from the item row when the test seeded one, so a
              // published event carries that item's real identity.
              const seeded = (dbState.itemsByUser.get(owner) ?? []).find(
                (r) => r.item_id === item_id,
              );
              return Promise.resolve([
                {
                  created_by: owner,
                  item_network: seeded?.item_network ?? 'blue_dot',
                  item_domain: seeded?.item_domain ?? 'seeker',
                  item_type: seeded?.item_type ?? 'profile_1.0',
                },
              ]);
            }
            return Promise.resolve([]);
          }),
          orderBy: vi.fn(() => {
            if (mode === 'items_list') {
              const user_id = lastQueriedUserId;
              const rows = user_id
                ? dbState.itemsByUser.get(user_id) ?? []
                : [];
              // Scope by served-domain networks (only blue_dot in tests).
              const allowedNetworks = new Set(['blue_dot']);
              const filtered = rows
                .filter((r) => allowedNetworks.has(r.item_network))
                // item_locations is projected by readItemsForUser; default to []
                // for mock rows that don't set it (matches the NOT NULL column).
                .map((r) => ({ item_locations: [], ...r }));
              return Promise.resolve(filtered);
            }
            if (mode === 'existing_item_lookup') {
              // Returns a chainable .limit() so the caller can do
              // .orderBy(...).limit(1). The result resolves to either
              // [{item_id}] or [] depending on dbState.existingOwnedItemId.
              return {
                limit: vi.fn(() => {
                  if (dbState.existingOwnedItemId) {
                    return Promise.resolve([{ item_id: dbState.existingOwnedItemId }]);
                  }
                  return Promise.resolve([]);
                }),
              };
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    };
  };

  const select = vi.fn((proj?: Record<string, unknown>) =>
    makeSelectChain(proj),
  );

  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        dbState.updates.push({
          id: dbState.signUpUserId,
          set: values,
        });
        return Promise.resolve();
      }),
    })),
  }));

  const deleteFn = vi.fn(() => ({
    where: vi.fn(() => {
      dbState.userDeletes += 1;
      return Promise.resolve();
    }),
  }));

  const insertFn = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      if (dbState.userInsertError) return Promise.reject(dbState.userInsertError);
      dbState.userInserts.push(values);
      return Promise.resolve();
    }),
  }));

  const transaction = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select,
        update,
        insert: insertFn,
      };
      return cb(tx);
    },
  );

  return {
    db: {
      select,
      update,
      insert: insertFn,
      transaction,
      delete: deleteFn,
      // Raw-SQL path. Used by the SS-3 default-aggregator lookup (#640);
      // `defaultAggregatorRows` decides whether a default is configured.
      execute: vi.fn(() => Promise.resolve({ rows: dbState.defaultAggregatorRows })),
    },
  };
});

// --- mock create_profile_item helper: simulates an item insert ---
vi.mock('@/lib/profile_item', () => {
  // Inline UUID generator so the factory is hoist-safe.
  let uuidCounter = 0;
  const fakeUuid = () => {
    uuidCounter += 1;
    const hex = uuidCounter.toString(16).padStart(8, '0');
    return `${hex}-1111-4111-8111-111111111111`;
  };
  return {
    create_profile_item: vi.fn(async (input: {
      user_id: string;
      network: string;
      domain: string;
      item_type: string;
      payload: Record<string, unknown>;
    }) => {
      const item_id = fakeUuid();
    const now = new Date();
    const row: ItemRow = {
      item_id,
      item_network: input.network,
      item_domain: input.domain,
      item_type: input.item_type,
      item_state: input.payload,
      item_private_state: '',
      created_at: now,
      updated_at: now,
    };
    const list = dbState.itemsByUser.get(input.user_id) ?? [];
    list.push(row);
    dbState.itemsByUser.set(input.user_id, list);
    dbState.itemOwnerLookup.set(item_id, input.user_id);
    dbState.inserts.push({
      user_id: input.user_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
    });
    return { item_id };
  }),
  };
});

// --- mock item_service.updateItemInternal: simulates item update ---
vi.mock('@/services/item_service', () => {
  class ItemServiceError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(statusCode: number, errorCode: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return {
    ItemServiceError,
    updateItemInternal: vi.fn(
      async (
        _tx: unknown,
        itemId: string,
        callerId: string,
        isAdmin: boolean,
        body: { item_state?: Record<string, unknown> },
      ) => {
        const owner = dbState.itemOwnerLookup.get(itemId);
        if (!owner || (!isAdmin && owner !== callerId)) {
          throw new ItemServiceError(
            404,
            'ITEM_NOT_FOUND_OR_FORBIDDEN',
            'Item not found or does not belong to the authenticated user',
          );
        }
        // Mutate the matched row in itemsByUser.
        const list = dbState.itemsByUser.get(owner) ?? [];
        const idx = list.findIndex((r) => r.item_id === itemId);
        if (idx >= 0 && body.item_state) {
          list[idx] = {
            ...list[idx],
            item_state: body.item_state,
            updated_at: new Date(),
          };
        }
        return { row: list[idx] };
      },
    ),
  };
});

// Imported after mocks.
import { participant } from '../participant.js';
import { publishItemEvent } from '@/utils/publish_item_event';
import { recordParticipantConsent } from '@/services/participant_consent';
import { authInstance } from '@/routes/auth/create_auth';

const VALID_EMAIL = 'demo@example.com';
const VALID_PHONE = '+919876543210';

const baseBody = (over: Record<string, unknown> = {}) => ({
  email: VALID_EMAIL,
  name: 'Demo',
  terms_accepted: true,
  privacy_accepted: true,
  channel: 'bulk',
  // SS-3 (#640): a non-aggregator caller must send `domain` — it selects which
  // default aggregator owns the participant, and the schema's `?? 'seeker'`
  // fallback would silently hand a provider signup to the seeker aggregator.
  domain: 'seeker',
  item_state: { whoIAm: { education: 'XII' } },
  ...over,
});

const buildApp = async (
  acting?: {
    org_id?: string;
    org_type?: 'aggregator' | 'voice' | 'network_service';
  } | null,
): Promise<FastifyInstance> => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (acting !== null) {
      (req as unknown as { acting_org: unknown }).acting_org = {
        org_id: acting?.org_id ?? 'org_agg_1',
        org_type: acting?.org_type ?? 'aggregator',
        service_user_id: 'svc_test',
      };
    }
  });
  await app.register(participant);
  return app;
};

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';

/** Shared by both top-level describes; they must reset identically. */
const resetDbState = () => {
    dbState.existingUserRows = [];
    dbState.itemsByUser = new Map();
    dbState.itemOwnerLookup = new Map();
    dbState.updates = [];
    dbState.inserts = [];
    dbState.signUpMode = 'ok';
    dbState.signUpUserId = 'usr_new_default';
    dbState.existingOwnedItemId = null;
    dbState.userInserts = [];
    dbState.identityCalls = [];
    dbState.identityResult = { ok: true };
    dbState.userInsertError = null;
    dbState.userDeletes = 0;
    dbState.defaultAggregatorRows = [];
    mockAuthConfig.keycloak_enabled = false;
    lastQueriedUserId = null;
    lastQueriedItemId = null;
    vi.mocked(publishItemEvent).mockClear();
    // Reset the consent-service mock and restore its default resolved value so
    // per-test mockResolvedValueOnce/mockRejectedValueOnce overrides don't bleed.
    vi.mocked(recordParticipantConsent).mockReset();
    vi.mocked(recordParticipantConsent).mockResolvedValue({
      recorded: 0,
      promoted: false,
    });
  vi.mocked(authInstance.api.signUpEmail).mockClear();
};

describe('POST /admin/participant', () => {
  beforeEach(resetDbState);

  it('403 INVALID_ACTING_ORG when acting_org is missing', async () => {
    const app = await buildApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for an org type outside the allowed set', async () => {
    // voice used to be the example; it is now an admitted integrating DPG, so
    // the rejection case needs a type that genuinely is not allowed.
    const app = await buildApp({
      org_type: 'employer' as unknown as 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });

  it('admits a voice acting org for participant upsert', async () => {
    const app = await buildApp({ org_id: 'org_voice_1', org_type: 'voice' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.json().error).not.toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });

  it('aggregator + new user + item_state → 200 user_existed:false, owned_elsewhere:false, items:[1], inserts:1', async () => {
    dbState.signUpUserId = 'usr_new_agg';
    lastQueriedUserId = 'usr_new_agg';
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe('usr_new_agg');
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('aggregator + new user + no item_state → 200 account_only: user_existed:false, owned_elsewhere:false, items:[]', async () => {
    dbState.signUpUserId = 'usr_new_agg_acct';
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
    // Assert that the onboarding-field update fired and set the expected fields.
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedVia: 'bulk',
      // This API never wrote `user.domains`, which left every participant it
      // onboarded permanently exempt from the single-domain lock (empty reads
      // as "not decided yet") and made GET /api/v1/user/domains return [] for
      // them in the UI. Recorded here, on the account-only path too, since the
      // caller states the domain.
      domains: ['seeker'],
    });
    expect(dbState.updates[0].set).not.toHaveProperty('termsAccepted');
    expect(dbState.updates[0].set).not.toHaveProperty('privacyAccepted');
  });

  it('omits domains entirely when an aggregator caller sends no domain', async () => {
    // An aggregator IS the owner, so `domain` is optional for it. Writing `[]`
    // would read as "locked to nothing" rather than "not yet decided" — the
    // participant's first item create records it instead.
    dbState.signUpUserId = 'usr_new_nodomain';
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        phone_number: VALID_PHONE,
        email: undefined,
        item_state: undefined,
        domain: undefined,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates[0].set).not.toHaveProperty('domains');
  });

  it('accepts a request with terms_accepted/privacy_accepted omitted (now optional) → 200', async () => {
    dbState.signUpUserId = 'usr_new_optional';
    lastQueriedUserId = 'usr_new_optional';
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: {
        email: 'optional@example.com',
        name: 'Opt',
        channel: 'bulk',
        item_state: { whoIAm: { education: 'XII' } },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('aggregator + existing OWN user + item_state → 200 user_existed:true, owned_elsewhere:false, inserts:1', async () => {
    const user_id = 'usr_own';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe(user_id);
    expect(body.onboarded_at).toBeNull();
    expect(dbState.inserts).toHaveLength(1);
  });

  it('aggregator + existing OWN user + no item_state → 200 account_only: items returned, no writes', async () => {
    const user_id = 'usr_own_no_state';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { foo: 'bar' },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe(user_id);
    expect(body.onboarded_at).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing OWN user + no item_state + compliance → records user-level consent, no itemId, consent_recorded from service', async () => {
    const user_id = 'usr_own_compliance';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    vi.mocked(recordParticipantConsent).mockResolvedValueOnce({
      recorded: 2,
      promoted: false,
    });
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(user_id);
    // The route surfaces whatever the service reported it recorded.
    expect(body.consent_recorded).toBe(2);

    expect(vi.mocked(recordParticipantConsent)).toHaveBeenCalled();
    const [, args] = vi.mocked(recordParticipantConsent).mock.calls[0];
    expect(args.userId).toBe(user_id);
    expect(args.compliance).toEqual([
      { key: 'user_terms', value: true },
      { key: 'user_privacy', value: true },
    ]);
    // Account-only user-level consent carries no itemId.
    expect(args.itemId).toBeUndefined();
    // No user/item writes happened on this path.
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing OWN user + compliance + consent recording throws → 500 CONSENT_WRITE_FAILED, no raw-error leak', async () => {
    const user_id = 'usr_own_consent_boom';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    vi.mocked(recordParticipantConsent).mockRejectedValueOnce(
      new Error('boom SENSITIVE bound-param text'),
    );
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      }),
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('CONSENT_WRITE_FAILED');
    // The raw error message (with bound params) must never reach the client.
    expect(body.message).not.toContain('boom');
    expect(body.message).not.toContain('SENSITIVE');
  });

  it('aggregator + existing OTHER-aggregator user → 200 owned_elsewhere:true, items:[], no writes', async () => {
    const user_id = 'usr_other_agg';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_2',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { foo: 'bar' },
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.owned_elsewhere).toBe(true);
    expect(body.items).toEqual([]);
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing self-registered user (onboardedByOrgId null) → 200 owned_elsewhere:true, items:[]', async () => {
    const user_id = 'usr_self';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: null,
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owned_elsewhere).toBe(true);
    expect(body.items).toEqual([]);
  });

  it('network_service + new user + item_state → 200 user_existed:false, owned_elsewhere:false, items:[1]', async () => {
    dbState.signUpUserId = 'usr_new_ns';
    lastQueriedUserId = 'usr_new_ns';
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe('usr_new_ns');
    expect(body.items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('network_service + new user + no item_state → 200 account_only: user_existed:false, owned_elsewhere:false, items:[]', async () => {
    dbState.signUpUserId = 'usr_new_ns_acct';
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
    // Assert that the onboarding-field update fired and set the expected fields.
    //
    // SS-3 (#640): `onboardedByOrgId` is deliberately NULL here, where it used
    // to be the acting org. A `network_service` caller is not an aggregator —
    // tagging its participants to the network's own org satisfied "every
    // entrant has an owner" on paper while leaving a verification queue nobody
    // would open. No default is nominated in this test (the launch state), so
    // the participant is left unowned.
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: null,
      onboardedByDefault: false,
      onboardedVia: 'bulk',
    });
    expect(dbState.updates[0].set).not.toHaveProperty('termsAccepted');
    expect(dbState.updates[0].set).not.toHaveProperty('privacyAccepted');
  });

  it('a non-aggregator caller tags to the default aggregator when one is configured (SS-3)', async () => {
    // Cold inbound voice: the caller is the network's own service org, so the
    // participant is tagged to the nominated default aggregator rather than to
    // the network org (whose verification queue nobody would open).
    dbState.signUpUserId = 'usr_voice_default';
    dbState.defaultAggregatorRows = [{ id: 'org_default_agg' }];
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      // A profile is created, so the domain is known and the per-(network,
      // domain) default can be resolved.
      payload: baseBody({
        phone_number: VALID_PHONE,
        email: undefined,
        domain: 'seeker',
        channel: 'voice',
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.userInserts.length + dbState.updates.length).toBeGreaterThan(0);
    const written = (dbState.updates[0]?.set ?? dbState.userInserts[0]) as Record<string, unknown>;
    expect(written).toMatchObject({
      onboardedByOrgId: 'org_default_agg',
      onboardedByDefault: true,
      onboardedVia: 'voice',
    });
  });

  it('tags in account_only mode too — domain rides the body, not the item (SS-3)', async () => {
    // `domain` is a top-level body field, independent of `item_state`, so an
    // account-only onboard (no profile yet) still resolves its binding's
    // default and is tagged at account creation rather than deferred.
    dbState.signUpUserId = 'usr_voice_account_only';
    dbState.defaultAggregatorRows = [{ id: 'org_default_agg' }];
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: 'org_default_agg',
      onboardedByDefault: true,
    });
    expect(res.json()).toMatchObject({
      onboarded_by_org_id: 'org_default_agg',
      onboarded_by_default: true,
    });
  });


  it('400s when a non-aggregator caller omits domain (SS-3)', async () => {
    // Defaults are per (network, domain). The schema documents `domain` as
    // defaulting to 'seeker', so without this a provider onboard that omitted
    // it would be handed to the SEEKER aggregator — wrong org gets decrypt
    // rights, with a 200 and no trace.
    dbState.signUpUserId = 'usr_no_domain';
    dbState.defaultAggregatorRows = [{ id: 'org_default_agg' }];
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, domain: undefined }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('DOMAIN_REQUIRED');
    expect(dbState.updates).toHaveLength(0);
  });

  it('an aggregator caller may still omit domain — it owns its own onboards (SS-3)', async () => {
    // The 400 is scoped to the branch that resolves a default; an aggregator
    // never does, so its existing contract is unchanged.
    dbState.signUpUserId = 'usr_agg_no_domain';
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, domain: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const written = (dbState.updates[0]?.set ?? dbState.userInserts[0]) as Record<string, unknown>;
    expect(written).toMatchObject({ onboardedByOrgId: 'org_agg_1', onboardedByDefault: false });
  });

  it('aggregator acting org still owns the participants it onboards (SS-3 unchanged path)', async () => {
    dbState.signUpUserId = 'usr_new_agg_acct';
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].set).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedByDefault: false,
      onboardedVia: 'bulk',
    });
  });

  it('network_service + existing user + valid item_id → 200 owned_elsewhere:false, item updated', async () => {
    const user_id = 'usr_ns_existing';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_A,
        item_state: { v: 2 },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owned_elsewhere).toBe(false);
    expect(vi.mocked(updateItemInternal)).toHaveBeenCalledTimes(1);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing OWN user + item_id + item_state → 200 update_item: updateItemInternal called, no insert', async () => {
    const user_id = 'usr_agg_own_update';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_A,
        item_state: { v: 2 },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe(user_id);
    expect(vi.mocked(updateItemInternal)).toHaveBeenCalledTimes(1);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('network_service + existing user + valid item_id + NO item_state → 200 update_item: records consent for that item, no item write, no publish', async () => {
    const user_id = 'usr_ns_consent_only';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      // item_id targets the owned profile; item_state omitted → consent/DOB-only
      // update that must not touch the item's fields (#309).
      payload: baseBody({
        item_id: VALID_UUID_A,
        item_state: undefined,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owned_elsewhere).toBe(false);
    expect(body.user_id).toBe(user_id);
    // No field update and no event publish when item_state is absent.
    expect(vi.mocked(updateItemInternal)).not.toHaveBeenCalled();
    expect(vi.mocked(publishItemEvent)).not.toHaveBeenCalled();
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
    // Consent is still recorded, scoped to the targeted item.
    expect(vi.mocked(recordParticipantConsent)).toHaveBeenCalled();
    const [, consentArgs] = vi.mocked(recordParticipantConsent).mock.calls[0];
    expect(consentArgs.itemId).toBe(VALID_UUID_A);
  });

  it('network_service + existing user + invalid item_id (other user) → 403 ITEM_NOT_OWNED_BY_USER', async () => {
    const user_id = 'usr_ns_existing';
    const other_user = 'usr_someone_else';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    // Item belongs to a DIFFERENT user.
    dbState.itemOwnerLookup.set(VALID_UUID_B, other_user);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_B;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_B,
        item_state: { v: 2 },
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');
    expect(vi.mocked(updateItemInternal)).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('network_service + existing user + item_state + no item_id → 200 owned_elsewhere:false, inserts:1', async () => {
    const user_id = 'usr_ns_insert';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owned_elsewhere).toBe(false);
    expect(dbState.inserts).toHaveLength(1);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('network_service + existing user + no item_state + no item_id → 200 account_only: items returned, no writes', async () => {
    const user_id = 'usr_ns_acct_only';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_state: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.owned_elsewhere).toBe(false);
    expect(body.onboarded_at).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('network_service + existing user + existing item (same network/domain/type) + no item_id → 200 creates another profile (always-create)', async () => {
    const user_id = 'usr_ns_reonboard';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    // Pre-existing item of (blue_dot, seeker, profile_1.0).
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_state: { v: 2 } }),
    });
    expect(res.statusCode).toBe(200);
    // Always-create (#349): a new profile is inserted, updateItemInternal not called.
    expect(vi.mocked(updateItemInternal)).toHaveBeenCalledTimes(0);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('aggregator + existing OWN user + existing item (same network/domain/type) + no item_id → 200 creates another profile (always-create)', async () => {
    const user_id = 'usr_agg_reonboard';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_state: { v: 2 } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().owned_elsewhere).toBe(false);
    // Always-create (#349): the owning aggregator adds another profile.
    expect(vi.mocked(updateItemInternal)).toHaveBeenCalledTimes(0);
    expect(dbState.inserts).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // publishItemEvent enqueue assertions (insert_item / update_item / create_new_user)
  // ---------------------------------------------------------------------------

  it('insert_item branch: publishItemEvent called with op:upsert and correct item identity', async () => {
    const user_id = 'usr_insert_enqueue';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0' }),
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(publishItemEvent)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(publishItemEvent).mock.calls[0];
    expect(event.op).toBe('upsert');
    expect(event.item_network).toBe('blue_dot');
    expect(event.item_domain).toBe('seeker');
    expect(event.item_type).toBe('profile_1.0');
    expect(typeof event.item_id).toBe('string');
    expect(event.item_id.length).toBeGreaterThan(0);
  });

  it('update_item branch: publishItemEvent called with op:upsert and row identity from updateItemInternal', async () => {
    const user_id = 'usr_update_enqueue';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_id: VALID_UUID_A, item_state: { v: 2 } }),
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(publishItemEvent)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(publishItemEvent).mock.calls[0];
    expect(event.op).toBe('upsert');
    expect(event.item_id).toBe(VALID_UUID_A);
    expect(event.item_network).toBe('blue_dot');
    expect(event.item_domain).toBe('seeker');
    expect(event.item_type).toBe('profile_1.0');
  });

  // #557: both of these branches publish the item the request named. An age write
  // can ALSO promote drafts the request never named (age is user-level), and those
  // need re-indexing too — previously they were silently left `draft` in the index.
  it('update_item branch: publishes the updated item AND the drafts the age write promoted', async () => {
    const user_id = 'usr_update_collateral';
    dbState.existingUserRows = [
      { id: user_id, email: VALID_EMAIL, phoneNumber: null, onboardedByOrgId: 'org_ns_1' },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { promoteEligibleDraftsForUser } = await import('@/services/participant_consent');
    vi.mocked(promoteEligibleDraftsForUser).mockResolvedValueOnce([
      { item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'itm_other_draft' },
    ]);
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ item_id: VALID_UUID_A, item_state: { v: 2 }, age: 25 }),
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(publishItemEvent).mock.calls.map(([e]) => e.item_id)).toEqual([
      VALID_UUID_A,
      'itm_other_draft',
    ]);
  });

  it('insert_item branch: publishes the inserted item AND the drafts the age write promoted', async () => {
    const user_id = 'usr_insert_collateral';
    dbState.existingUserRows = [
      { id: user_id, email: VALID_EMAIL, phoneNumber: null, onboardedByOrgId: 'org_ns_1' },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const { promoteEligibleDraftsForUser } = await import('@/services/participant_consent');
    vi.mocked(promoteEligibleDraftsForUser).mockResolvedValueOnce([
      { item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'itm_other_draft' },
    ]);
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0', age: 25 }),
    });

    expect(res.statusCode).toBe(200);
    const ids = vi.mocked(publishItemEvent).mock.calls.map(([e]) => e.item_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe('itm_other_draft');
  });

  it('create_new_user branch: publishItemEvent called with op:upsert after tx commits', async () => {
    dbState.signUpUserId = 'usr_new_enqueue';
    lastQueriedUserId = 'usr_new_enqueue';
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined, network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(false);
    expect(vi.mocked(publishItemEvent)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(publishItemEvent).mock.calls[0];
    expect(event.op).toBe('upsert');
    expect(event.item_network).toBe('blue_dot');
    expect(event.item_domain).toBe('seeker');
    expect(event.item_type).toBe('profile_1.0');
    expect(typeof event.item_id).toBe('string');
    expect(event.item_id.length).toBeGreaterThan(0);
  });

  // #557: `item_id` alone resolves to update_item "with or without item_state" —
  // a consent-only activation. recordParticipantConsent then promotes that item
  // draft → live inside the transaction, and its `promoted` flag is the ONLY signal
  // for it: no item_state means no updateItemInternal row, and the item is no longer
  // `draft` so promoteEligibleDraftsForUser cannot return it either. Without
  // consuming that flag the promotion publishes nothing and the profile stays
  // `draft` in item_search — the exact bug this PR fixes, via another door.
  it('update_item branch: a consent-only activation (no item_state) publishes the promoted item', async () => {
    const user_id = 'usr_consent_only_activation';
    dbState.existingUserRows = [
      { id: user_id, email: VALID_EMAIL, phoneNumber: null, onboardedByOrgId: 'org_ns_1' },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: '',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    vi.mocked(recordParticipantConsent).mockResolvedValueOnce({ recorded: 1, promoted: true });
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_A,
        item_state: undefined,
        compliance: [{ key: 'profile_creation', value: true }],
      }),
    });

    expect(res.statusCode).toBe(200);
    // No item write happened — the promotion is the only reason to publish.
    expect(vi.mocked(updateItemInternal)).not.toHaveBeenCalled();
    expect(vi.mocked(publishItemEvent)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(publishItemEvent).mock.calls[0];
    expect(event.op).toBe('upsert');
    expect(event.item_id).toBe(VALID_UUID_A);
    expect(event.item_network).toBe('blue_dot');
    expect(event.item_domain).toBe('seeker');
    expect(event.item_type).toBe('profile_1.0');
  });

  // #557: an age write can promote drafts this request never mentions (age is
  // user-level, so it can unblock several profiles at once). Those promotions
  // changed what search must return, and the account_only branch published nothing
  // at all — so the profiles stayed `draft` in item_search: invisible in every
  // ranked feed and every map viewport while `items` said live.
  it('account_only branch: publishes an upsert for each draft the age write promoted', async () => {
    const user_id = 'usr_age_promotes_drafts';
    dbState.existingUserRows = [
      { id: user_id, email: VALID_EMAIL, phoneNumber: null, onboardedByOrgId: 'org_agg_1' },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const { promoteEligibleDraftsForUser } = await import('@/services/participant_consent');
    vi.mocked(promoteEligibleDraftsForUser).mockResolvedValueOnce([
      { item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0', item_id: 'itm_a' },
      { item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_id: 'itm_b' },
    ]);
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        age: 25,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(publishItemEvent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(publishItemEvent).mock.calls.map(([e]) => [e.item_id, e.op])).toEqual([
      ['itm_a', 'upsert'],
      ['itm_b', 'upsert'],
    ]);
  });

  it('error branches: publishItemEvent NOT called when insert_item fails', async () => {
    const user_id = 'usr_insert_fail_no_enqueue';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const { create_profile_item } = await import('@/lib/profile_item');
    vi.mocked(create_profile_item).mockRejectedValueOnce(
      Object.assign(new Error('schema error'), { statusCode: 400, errorCode: 'INVALID_ITEM_STATE' }),
    );
    const app = await buildApp({ org_id: 'org_ns_1', org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(publishItemEvent)).not.toHaveBeenCalled();
  });

  it('400 when neither email nor phone_number is provided', async () => {
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ email: undefined }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('items response scoped to served-domain networks only', async () => {
    const user_id = 'usr_with_cross_network';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    // One item in served network, one in a foreign network.
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        item_id: VALID_UUID_B,
        item_network: 'yellow_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: '',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    // existingOwnedItemId = null (default) → resolver chooses insert_item.
    // Scope filter returns only blue_dot items; yellow_dot is excluded.
    // This test validates the network-scoping logic regardless of insert/update.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // All returned items must be blue_dot
    for (const item of body.items) {
      expect(item.item_network).toBe('blue_dot');
    }
  });

  it('rejects any compliance entry with value:false → 400 CONSENT_DECLINED', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [{ key: 'user_terms', value: false }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONSENT_DECLINED');
  });

  it('rejects a broken user-consent pair → 400 USER_LEVEL_INCOMPLETE', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_state: undefined,
        compliance: [{ key: 'user_terms', value: true }], // no user_privacy
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('USER_LEVEL_INCOMPLETE');
  });

  it('age:15 (minor) → 400 U18_NOT_ALLOWED, no operation performed (#331/#359)', async () => {
    // The U18 check runs on the effective age (body.age ?? existing.age)
    // before any DB write, so a minor is rejected with no user/item create,
    // no update, and no consent recorded — regardless of domain/channel.
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        age: 15,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('U18_NOT_ALLOWED');

    expect(vi.mocked(recordParticipantConsent)).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });
});

/**
 * The direct-write branch (Phase 2 of the Keycloak migration).
 *
 * Under `AUTH_PROVIDER=keycloak` the `user` row is written by `insertLocalUser`
 * inside the onboarding transaction, instead of by better-auth's `signUpEmail`
 * followed by a separate update. What these pin down is that the branch produces
 * the same row without better-auth's artifacts, and that the failure handling
 * survives the restructure.
 */
describe('POST /admin/participant — direct write under AUTH_PROVIDER=keycloak', () => {
  beforeEach(() => {
    resetDbState();
    mockAuthConfig.keycloak_enabled = true;
  });

  const newUserBody = (over: Record<string, unknown> = {}) =>
    baseBody({ item_state: undefined, ...over });

  it('writes the row itself and never calls better-auth', async () => {
    // The regression that matters most: a change that quietly kept using
    // signUpEmail would otherwise still pass every other assertion here.
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(authInstance.api.signUpEmail)).not.toHaveBeenCalled();
    expect(dbState.userInserts).toHaveLength(1);
  });

  it('carries the onboarding columns in the insert, with no separate update', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    const [row] = dbState.userInserts;
    expect(row).toMatchObject({
      onboardedByOrgId: 'org_agg_1',
      onboardedVia: 'bulk',
      phoneNumber: VALID_PHONE,
    });
    // Insert + update collapsed into one write.
    expect(dbState.updates).toHaveLength(0);
  });

  it('leaves the consent booleans unwritten — consent lives in the ledger', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(dbState.userInserts[0]).not.toHaveProperty('termsAccepted');
    expect(dbState.userInserts[0]).not.toHaveProperty('privacyAccepted');
  });

  it('gives a phone-only participant a NULL email, not a placeholder', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(dbState.userInserts[0].email).toBeNull();
  });

  it('does not hand the Keycloak identity a placeholder address either', async () => {
    // This is what made 24 of 25 realm users key on <uuid>@no-email.local.
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(dbState.identityCalls).toHaveLength(1);
    expect(dbState.identityCalls[0].email).toBeNull();
  });

  it('passes a real email straight through to both the row and the identity', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ email: VALID_EMAIL, phone_number: undefined }),
    });

    expect(dbState.userInserts[0].email).toBe(VALID_EMAIL);
    expect(dbState.identityCalls[0].email).toBe(VALID_EMAIL);
  });

  it('uses a bare UUID as the id, since it becomes the Keycloak subject', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(dbState.userInserts[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('rolls back instead of orphan-deleting when the insert fails', async () => {
    // The row never committed, so issuing a delete would at best be a no-op and
    // at worst remove a different row that reused the id.
    dbState.userInsertError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    });
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('USER_ALREADY_EXISTS');
    expect(dbState.userDeletes).toBe(0);
  });

  it('still deletes the row when the Keycloak identity cannot be created', async () => {
    // That step is a remote call and cannot be in the transaction, so the
    // compensating delete is still required — a participant with no realm
    // identity could never sign in.
    dbState.identityResult = {
      ok: false,
      code: 'IDENTITY_CONFLICT',
      message: 'Another account already owns this email or phone number',
    };
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: newUserBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('IDENTITY_CONFLICT');
    expect(dbState.userDeletes).toBe(1);
  });

  it('creates the profile item in the same transaction as the user row', async () => {
    const app = await buildApp({ org_id: 'org_agg_1', org_type: 'aggregator' });

    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined }),
    });

    expect(res.statusCode).toBe(200);
    expect(dbState.userInserts).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });
});
