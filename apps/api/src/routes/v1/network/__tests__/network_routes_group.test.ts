import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// Covers two network-group route modules with one shared dependency graph:
//   - action/perform_action.ts  (exports its handler)
//   - item/fetch_item.ts        (plugin only -> handlers captured on register)
// Everything the two modules import is mocked, so no Postgres/Redis is needed.
const {
  dbState,
  inserts,
  txCalls,
  isServedDomainBinding,
  replyForUnservedDomain,
  getNetworkConfigById,
  fetchItemsAcrossInstances,
  countLocalItems,
  fetchLocalItems,
  peer_instance_guard,
  getActionInteraction,
  validateAgainstJsonSchema,
  ensureActionPartition,
  ensureActionEventPartition,
  assertPairCapAvailable,
  maxActionsPerPair,
  terminalStatuses,
  ActionPairCapError,
  resolveConsentVersion,
  fetchLocalItemSnapshot,
  isCurrentInstanceItem,
  buildActionEventPayload,
  validateActionEventPayload,
  insertActionEvent,
  mirrorActionEventToSourceInstance,
  dispatchActionNotifications,
  pass,
} = vi.hoisted(() => {
  class ActionPairCapError extends Error {}
  return {
    // Passthrough factory for vi.mock: keeps the wrapper's rest signature
    // assignable no matter what arity the underlying vi.fn declares.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pass: (fn: (...a: any[]) => unknown) => (...a: any[]) => fn(...a),
    // Resettable failure flags — never monkey-patch a shared queue, an
    // override there leaks into every later test in the file.
    dbState: {
      consentInsertFailWith: null as Error | null,
      actionInsertFailWith: null as Error | null,
      actionRow: {} as Record<string, unknown>,
    },
    inserts: [] as { table: string; values: Record<string, unknown> }[],
    txCalls: [] as unknown[],
    isServedDomainBinding: vi.fn(
      (_network: string, _domain: string) => true as boolean,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    replyForUnservedDomain: vi.fn(async (reply: any, n: string, d: string) =>
      reply.code(403).send({
        error: 'UNSERVED_DOMAIN_BINDING',
        message: `This API instance does not serve "${n}/${d}".`,
      }),
    ),
    getNetworkConfigById: vi.fn(async (_id: string) => ({
      id: 'blue_dot',
      domains: [{ id: 'student' }, { id: 'mentor' }],
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchItemsAcrossInstances: vi.fn(async (_input: any) => ({
      meta: {
        total: 0,
        limit: 10,
        offset: 0,
        partial: false,
        unavailable_instances: [] as string[],
      },
      items: [] as unknown[],
    })),
    countLocalItems: vi.fn(async (_filters: Record<string, unknown>) => 0),
    fetchLocalItems: vi.fn(async (_filters: Record<string, unknown>) => ({
      meta: { total: 0, limit: 10, offset: 0 },
      items: [] as unknown[],
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peer_instance_guard: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getActionInteraction: vi.fn((_cfg: any, _sel: any) => ({
      requirement_schema: { type: 'object' },
      event_schema: { type: 'object' },
      reveals_pii_on_status: [] as string[],
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validateAgainstJsonSchema: vi.fn((..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureActionPartition: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureActionEventPartition: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertPairCapAvailable: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    maxActionsPerPair: vi.fn((_cfg: any) => 1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    terminalStatuses: vi.fn((_cfg: any) => ['rejected', 'withdrawn']),
    ActionPairCapError,
    resolveConsentVersion: vi.fn(
      async (_input: Record<string, unknown>) => 3 as number | null,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchLocalItemSnapshot: vi.fn(async (_db: any, _ref: any) => null as
      | Record<string, unknown>
      | null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isCurrentInstanceItem: vi.fn((_item: any) => true as boolean),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildActionEventPayload: vi.fn((_input: any) => ({ built: true })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validateActionEventPayload: vi.fn((..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insertActionEvent: vi.fn(async (_db: any, _event: any) => ({
      event_id: 'e1',
    }) as Record<string, unknown> | null),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mirrorActionEventToSourceInstance: vi.fn(async (..._a: any[]) => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispatchActionNotifications: vi.fn(async (..._a: any[]) => {}),
  };
});

function insertResult(table: string) {
  if (table === 'consent_record' && dbState.consentInsertFailWith) {
    return Promise.reject(dbState.consentInsertFailWith);
  }
  if (table === 'item_actions' && dbState.actionInsertFailWith) {
    return Promise.reject(dbState.actionInsertFailWith);
  }
  return Promise.resolve(table === 'item_actions' ? [dbState.actionRow] : []);
}

function fakeTx() {
  return {
    insert: (table: { __name: string }) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: table.__name, values });
        // A thenable so both `await ...values(v)` (consent) and
        // `await ...values(v).returning({...})` (action) work. BOTH callbacks
        // must be forwarded — dropping `rej` hangs a rejected insert.
        return {
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            insertResult(table.__name).then(res, rej),
          returning: () => insertResult(table.__name),
        };
      },
    }),
  };
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: async (cb: (tx: any) => unknown) => {
      const tx = fakeTx();
      txCalls.push(tx);
      return cb(tx);
    },
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { __name: 'consent_record' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/database', () => ({
  item_actions: {
    __name: 'item_actions',
    action_id: 'ia.action_id',
    action_type: 'ia.action_type',
    action_status: 'ia.action_status',
    update_count: 'ia.update_count',
    source_item_id: 'ia.source_item_id',
    target_item_id: 'ia.target_item_id',
  },
  ensureActionPartition: pass(ensureActionPartition),
  ensureActionEventPartition: pass(ensureActionEventPartition),
}));

vi.mock('@dpg/schemas', () => {
  const leaf: Record<string, unknown> = {};
  leaf.array = () => leaf;
  leaf.int = () => leaf;
  leaf.nonnegative = () => leaf;
  return {
    default: {
      object: (shape: unknown) => ({ shape, array: () => leaf }),
      string: () => leaf,
      number: () => leaf,
      boolean: () => leaf,
    },
    PerformNetworkActionBodySchema: {},
    FetchItemsBodySchema: {},
    FetchItemsCountBodySchema: {},
    FetchItemsQuerySchema: {},
    ItemResponseSchema: { array: () => leaf },
    getActionInteraction: pass(getActionInteraction),
    validateAgainstJsonSchema: pass(validateAgainstJsonSchema),
  };
});

vi.mock('@/config', () => ({
  apiConfig: { allow_extra_schema_data: false },
  getCurrentApiBaseUrl: () => 'https://this-instance.example',
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: pass(getNetworkConfigById),
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: pass(isServedDomainBinding),
  replyForUnservedDomain: pass(replyForUnservedDomain),
}));

vi.mock('@/utils/inter_instance_fetch', () => ({
  fetchItemsAcrossInstances: pass(fetchItemsAcrossInstances),
}));

vi.mock('@/utils/item_fetch_runtime', () => ({
  countLocalItems: pass(countLocalItems),
  fetchLocalItems: pass(fetchLocalItems),
}));

vi.mock('@/middleware/peer_instance_guard', () => ({
  peer_instance_guard: pass(peer_instance_guard),
}));

vi.mock('@/services/action_pair_cap', () => ({
  assertPairCapAvailable: pass(assertPairCapAvailable),
  maxActionsPerPair: pass(maxActionsPerPair),
  terminalStatuses: pass(terminalStatuses),
  ActionPairCapError,
}));

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: pass(resolveConsentVersion),
}));

vi.mock('@/utils/action_event_runtime', () => ({
  fetchLocalItemSnapshot: pass(fetchLocalItemSnapshot),
  isCurrentInstanceItem: pass(isCurrentInstanceItem),
  buildActionEventPayload: pass(buildActionEventPayload),
  validateActionEventPayload: pass(validateActionEventPayload),
  insertActionEvent: pass(insertActionEvent),
  mirrorActionEventToSourceInstance: pass(mirrorActionEventToSourceInstance),
}));

vi.mock('@/notifications/notify_actions', () => ({
  dispatchActionNotifications: pass(dispatchActionNotifications),
}));

import { perform_network_action_handler } from '../action/perform_action';
import { fetch_item } from '../item/fetch_item';

// --- fakes -----------------------------------------------------------------
interface FakeReply {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
  header(k: string, v: string): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    header(k, v) {
      this.headers[k] = v;
      return this;
    },
  };
}

interface FakeRoute {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preHandler?: (...a: any[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
}

const routes: FakeRoute[] = [];

async function loadFetchItemRoutes() {
  routes.length = 0;
  const fakeFastify = {
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await fetch_item(fakeFastify as any, {} as any);
}

function routeFor(url: string): FakeRoute {
  const found = routes.find((r) => r.url === url);
  if (!found) throw new Error(`no route registered for ${url}`);
  return found;
}

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(handler: any, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const sourceItem = {
  item_id: 'src-1',
  item_network: 'blue_dot',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_instance_url: 'https://this-instance.example/api/v1',
};

const targetItem = {
  item_id: 'tgt-1',
  item_network: 'blue_dot',
  item_domain: 'mentor',
  item_type: 'profile_1.0',
  item_instance_url: 'https://this-instance.example/api/v1',
};

function actionBody(overrides: Record<string, unknown> = {}) {
  return {
    action_type: 'connect',
    source_item: sourceItem,
    target_item: targetItem,
    source_item_owner: 'user-src',
    requirements_snapshot: { note: 'hi' },
    ...overrides,
  };
}

const liveTarget = {
  lifecycle_status: 'live',
  created_by: 'user-tgt',
  item_locations: [{ lat: 1, lon: 2 }],
};

const liveSource = {
  lifecycle_status: 'live',
  created_by: 'user-src',
  item_locations: [{ lat: 3, lon: 4 }],
};

beforeEach(async () => {
  inserts.length = 0;
  txCalls.length = 0;
  dbState.consentInsertFailWith = null;
  dbState.actionInsertFailWith = null;
  dbState.actionRow = {
    action_id: 'act-1',
    action_type: 'connect',
    action_status: 'created',
    update_count: 0,
    source_item_id: 'src-1',
    target_item_id: 'tgt-1',
  };
  // resetAllMocks (not clearAllMocks) — vitest 4 restores the implementation
  // originally passed to vi.fn(), so a per-test mockResolvedValue override
  // cannot leak into the next test.
  vi.resetAllMocks();
  fetchLocalItemSnapshot.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_db: any, ref: any) =>
      ref?.item_id === 'tgt-1' ? liveTarget : liveSource,
  );
  await loadFetchItemRoutes();
});

// ---------------------------------------------------------------------------
describe('perform_network_action_handler — guards', () => {
  it('403 UNSERVED_DOMAIN_BINDING when the target binding is not served', async () => {
    isServedDomainBinding.mockReturnValue(false);

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe(
      'UNSERVED_DOMAIN_BINDING',
    );
    // the guard is checked on the TARGET binding, not the source
    expect(isServedDomainBinding).toHaveBeenCalledWith('blue_dot', 'mentor');
    expect(fetchLocalItemSnapshot).not.toHaveBeenCalled();
  });

  it('400 INVALID_TARGET_INSTANCE when the target lives on another instance', async () => {
    isCurrentInstanceItem.mockReturnValue(false);

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe(
      'INVALID_TARGET_INSTANCE',
    );
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });

  it('400 INVALID_ACTION_REQUEST forwarding the interaction lookup message', async () => {
    getActionInteraction.mockImplementation(() => {
      throw new Error('no such interaction');
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'INVALID_ACTION_REQUEST',
      message: 'no such interaction',
    });
  });

  it('400 INVALID_ACTION_REQUEST when the requirements snapshot fails schema validation', async () => {
    validateAgainstJsonSchema.mockImplementation(() => {
      throw new Error('requirements invalid');
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe(
      'INVALID_ACTION_REQUEST',
    );
    expect(validateAgainstJsonSchema).toHaveBeenCalledWith(
      { type: 'object' },
      { note: 'hi' },
      'action requirements',
      { allowAdditionalProperties: false },
    );
  });

  it('400 CONSENT_REQUIRED (fail-closed) for a reveals-PII action with no consent block', async () => {
    getActionInteraction.mockReturnValue({
      requirement_schema: { type: 'object' },
      event_schema: { type: 'object' },
      reveals_pii_on_status: ['accepted'],
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('CONSENT_REQUIRED');
    expect(fetchLocalItemSnapshot).not.toHaveBeenCalled();
  });

  it('400 CONSENT_REQUIRED when consent is present but not acknowledged', async () => {
    getActionInteraction.mockReturnValue({
      requirement_schema: { type: 'object' },
      event_schema: { type: 'object' },
      reveals_pii_on_status: ['accepted'],
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody({ consent: { acknowledged: false, brand: 'bd' } }),
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('CONSENT_REQUIRED');
  });

  it('proceeds for a reveals-PII action when consent is acknowledged', async () => {
    getActionInteraction.mockReturnValue({
      requirement_schema: { type: 'object' },
      event_schema: { type: 'object' },
      reveals_pii_on_status: ['accepted'],
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody({ consent: { acknowledged: true, brand: 'bd' } }),
    });

    expect(reply.statusCode).toBe(201);
  });

  it('404 TARGET_ITEM_NOT_FOUND when the target snapshot is missing', async () => {
    fetchLocalItemSnapshot.mockResolvedValue(null);

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(404);
    expect((reply.body as { error: string }).error).toBe(
      'TARGET_ITEM_NOT_FOUND',
    );
  });

  it('409 PROFILE_NOT_LIVE when the target item is not live', async () => {
    fetchLocalItemSnapshot.mockResolvedValue({
      ...liveTarget,
      lifecycle_status: 'paused',
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'PROFILE_NOT_LIVE',
      message: 'target_item is not live; cannot perform actions',
    });
  });

  it('404 SOURCE_ITEM_NOT_FOUND when a local source item is missing', async () => {
    fetchLocalItemSnapshot.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_db: any, ref: any) =>
        ref?.item_id === 'tgt-1' ? liveTarget : null,
    );

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(404);
    expect((reply.body as { error: string }).error).toBe(
      'SOURCE_ITEM_NOT_FOUND',
    );
  });

  it('409 PROFILE_NOT_LIVE (source side) when a local source item is a draft', async () => {
    fetchLocalItemSnapshot.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (_db: any, ref: any) =>
        ref?.item_id === 'tgt-1'
          ? liveTarget
          : { ...liveSource, lifecycle_status: 'draft' },
    );

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(409);
    expect((reply.body as { message: string }).message).toBe(
      'source_item is not live; cannot perform actions',
    );
  });

  it('skips the source-item lookup entirely when the source is remote', async () => {
    // target -> current instance, source -> some other instance
    isCurrentInstanceItem.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: any) => item.item_id === 'tgt-1',
    );

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(201);
    expect(fetchLocalItemSnapshot).toHaveBeenCalledTimes(1);
    // no local source snapshot => no source locations on the stored event
    const stored = insertActionEvent.mock.calls[0][1] as {
      source_item_locations: unknown[];
    };
    expect(stored.source_item_locations).toEqual([]);
  });

  it('500 PARTITION_SETUP_FAILED when partition creation fails', async () => {
    ensureActionEventPartition.mockRejectedValue(new Error('no ddl'));

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'PARTITION_SETUP_FAILED',
    );
    expect(log.error).toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('400 INVALID_ACTION_EVENT when the built event fails event-schema validation', async () => {
    validateActionEventPayload.mockImplementation(() => {
      throw new Error('event invalid');
    });

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'INVALID_ACTION_EVENT',
      message: 'event invalid',
    });
    expect(txCalls).toHaveLength(0);
  });
});

describe('perform_network_action_handler — write path', () => {
  it('201 inserts the action, event, mirror and notifications', async () => {
    const reply = await call(perform_network_action_handler, {
      body: actionBody({
        performed_by_org_id: 'org-9',
        performed_by_service_user_id: 'svc-9',
      }),
    });

    expect(reply.statusCode).toBe(201);
    expect(reply.body).toEqual(dbState.actionRow);

    const actionInsert = inserts.find((i) => i.table === 'item_actions');
    expect(actionInsert?.values).toMatchObject({
      action_type: 'connect',
      partition_network: 'blue_dot',
      action_status: 'created',
      update_count: 0,
      source_item_id: 'src-1',
      target_item_id: 'tgt-1',
      // target owner comes from the snapshot, never from the request body
      target_item_owner: 'user-tgt',
      source_item_owner: 'user-src',
      remarks: null,
      performed_by_org_id: 'org-9',
      performed_by_service_user_id: 'svc-9',
    });

    // pair cap is enforced inside the txn with the network-config cap
    expect(assertPairCapAvailable).toHaveBeenCalledWith(txCalls[0], {
      network: 'blue_dot',
      sourceItemId: 'src-1',
      targetItemId: 'tgt-1',
      cap: 1,
      terminal: ['rejected', 'withdrawn'],
    });

    const stored = insertActionEvent.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      origin_instance_domain: 'https://this-instance.example',
      action_id: 'act-1',
      action_status: 'created',
      target_item_owner: 'user-tgt',
      source_item_locations: liveSource.item_locations,
      target_item_locations: liveTarget.item_locations,
      event_payload: { built: true },
    });
    expect(mirrorActionEventToSourceInstance).toHaveBeenCalledWith(
      stored,
      log,
    );
    expect(dispatchActionNotifications).toHaveBeenCalledTimes(1);
    const notif = dispatchActionNotifications.mock.calls[0][0] as {
      lifecycle: string;
      source: { ownerUserId: string | null };
      target: { ownerUserId: string | null };
    };
    expect(notif.lifecycle).toBe('created');
    expect(notif.source.ownerUserId).toBe('user-src');
    expect(notif.target.ownerUserId).toBe('user-tgt');
  });

  it('defaults the performed_by columns to null when absent', async () => {
    await call(perform_network_action_handler, { body: actionBody() });

    const actionInsert = inserts.find((i) => i.table === 'item_actions');
    expect(actionInsert?.values.performed_by_org_id).toBeNull();
    expect(actionInsert?.values.performed_by_service_user_id).toBeNull();
  });

  it('writes no consent row and resolves no version when no consent block is sent', async () => {
    await call(perform_network_action_handler, { body: actionBody() });

    expect(resolveConsentVersion).not.toHaveBeenCalled();
    expect(inserts.map((i) => i.table)).toEqual(['item_actions']);
  });

  it('records the initiate consent row with the SERVER-derived version', async () => {
    resolveConsentVersion.mockResolvedValue(7);

    const reply = await call(perform_network_action_handler, {
      // a client-supplied version must be ignored
      body: actionBody({
        consent: { acknowledged: true, brand: 'bd', documentVersion: 999 },
      }),
    });

    expect(reply.statusCode).toBe(201);
    expect(resolveConsentVersion).toHaveBeenCalledWith({
      network: 'blue_dot',
      brand: 'bd',
      category: 'action',
      actionType: 'connect',
      stage: 'initiate',
    });

    const consentInsert = inserts.find((i) => i.table === 'consent_record');
    expect(consentInsert?.values).toMatchObject({
      level: 'item',
      consentCategory: 'action',
      actionType: 'connect',
      actionStage: 'initiate',
      userId: 'user-src',
      itemId: 'src-1',
      actionId: 'act-1',
      network: 'blue_dot',
      brand: 'bd',
      documentVersion: 7,
      source: 'action',
    });
    // consent block is threaded into the event payload builder too
    expect(
      (buildActionEventPayload.mock.calls[0][0] as { consent: unknown }).consent,
    ).toEqual({ acknowledged: true, brand: 'bd', documentVersion: 999 });
  });

  it('nulls the consent brand when the client omits it', async () => {
    await call(perform_network_action_handler, {
      body: actionBody({ consent: { acknowledged: true } }),
    });

    const consentInsert = inserts.find((i) => i.table === 'consent_record');
    expect(consentInsert?.values.brand).toBeNull();
  });

  it('500 CONSENT_WRITE_FAILED when no initiate version is configured', async () => {
    resolveConsentVersion.mockResolvedValue(null);

    const reply = await call(perform_network_action_handler, {
      body: actionBody({ consent: { acknowledged: true } }),
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'CONSENT_WRITE_FAILED',
    );
    expect(log.error).toHaveBeenCalled();
    // fail-closed: no event emitted for the rolled-back action
    expect(insertActionEvent).not.toHaveBeenCalled();
    expect(dispatchActionNotifications).not.toHaveBeenCalled();
  });

  it('500 CONSENT_WRITE_FAILED when the consent insert itself throws', async () => {
    dbState.consentInsertFailWith = new Error('unique violation');

    const reply = await call(perform_network_action_handler, {
      body: actionBody({ consent: { acknowledged: true } }),
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'CONSENT_WRITE_FAILED',
    );
    expect(insertActionEvent).not.toHaveBeenCalled();
  });

  it('409 ACTION_LIMIT_REACHED when the pair cap is already used up', async () => {
    assertPairCapAvailable.mockRejectedValue(
      new ActionPairCapError('cap reached'),
    );

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(409);
    expect(reply.body).toEqual({
      error: 'ACTION_LIMIT_REACHED',
      message: 'An active request already exists between these two profiles.',
    });
    expect(inserts).toHaveLength(0);
    expect(insertActionEvent).not.toHaveBeenCalled();
  });

  it('skips notifications when the event insert is a no-op (duplicate)', async () => {
    insertActionEvent.mockResolvedValue(null);

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(201);
    expect(mirrorActionEventToSourceInstance).toHaveBeenCalledTimes(1);
    expect(dispatchActionNotifications).not.toHaveBeenCalled();
  });

  it('still returns 201 when the fire-and-forget notification dispatch rejects', async () => {
    dispatchActionNotifications.mockRejectedValue(new Error('smtp down'));

    const reply = await call(perform_network_action_handler, {
      body: actionBody(),
    });

    expect(reply.statusCode).toBe(201);
    await tick();
    expect(log.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'action notification dispatch failed',
    );
  });

  it('rejects (rather than replying 500) when the action insert itself fails', async () => {
    // Documented deviation from "routes never throw": only ActionPairCapError
    // and ConsentWriteError are swallowed by the .catch after the txn, so any
    // other DB error propagates out of the handler to Fastify's error handler.
    dbState.actionInsertFailWith = new Error('deadlock detected');

    await expect(
      perform_network_action_handler(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { log, body: actionBody() } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReply() as any,
      ),
    ).rejects.toThrow('deadlock detected');
  });
});

// ---------------------------------------------------------------------------
describe('fetch_item plugin registration', () => {
  it('registers the aggregate read plus the two peer-only local reads', async () => {
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /item/fetch',
      'POST /item/count_local',
      'POST /item/fetch_local',
    ]);
  });

  it('guards only the *_local routes with peer_instance_guard (no user auth)', async () => {
    // /item/fetch stays unauthenticated — it carries a per-IP rate-limit
    // preHandler (it is public and fans out to every peer), but never the peer
    // guard and never user auth. Asserting "not the peer guard" rather than
    // "no preHandler at all" keeps the real invariant: adding a throttle to a
    // public route must not be mistaken for adding auth to it.
    const fetchPreHandler = routeFor('/item/fetch').preHandler;
    expect(typeof fetchPreHandler).toBe('function');
    expect(fetchPreHandler).not.toBe(peer_instance_guard);

    for (const url of ['/item/count_local', '/item/fetch_local']) {
      const preHandler = routeFor(url).preHandler;
      expect(typeof preHandler).toBe('function');
      await preHandler?.({ url }, makeReply());
    }
    // the HMAC peer guard runs for both local routes, and nothing else does
    expect(peer_instance_guard).toHaveBeenCalledTimes(2);
  });
});

describe('GET /network/item/fetch (inter-instance aggregate)', () => {
  const query = {
    item_network: 'blue_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    limit: 10,
    offset: 0,
    cache_ttl_seconds: 30,
  };

  it('403 when the domain is not part of the network config', async () => {
    const reply = await call(routeFor('/item/fetch').handler, {
      query: { ...query, item_domain: 'nope' },
    });

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe(
      'UNSERVED_DOMAIN_BINDING',
    );
    expect(fetchItemsAcrossInstances).not.toHaveBeenCalled();
  });

  it('200 forwards live-only filters and the requested cache TTL', async () => {
    fetchItemsAcrossInstances.mockResolvedValue({
      meta: {
        total: 1,
        limit: 10,
        offset: 0,
        partial: false,
        unavailable_instances: [],
      },
      items: [{ item_id: 'i1' }],
    });

    const reply = await call(routeFor('/item/fetch').handler, { query });

    expect(reply.statusCode).toBe(200);
    expect((reply.body as { items: unknown[] }).items).toEqual([
      { item_id: 'i1' },
    ]);
    const input = fetchItemsAcrossInstances.mock.calls[0][0] as {
      filters: Record<string, unknown>;
      requestedCacheTtlSeconds: number;
    };
    expect(input.filters.lifecycle_filter).toBe('live_only');
    expect(input.filters.item_domain).toBe('student');
    expect(input.requestedCacheTtlSeconds).toBe(30);
  });

  it('exposes the partial-aggregate flag as the x-network-partial header', async () => {
    fetchItemsAcrossInstances.mockResolvedValue({
      meta: {
        total: 1,
        limit: 10,
        offset: 0,
        partial: true,
        unavailable_instances: ['https://peer.example'],
      },
      items: [],
    });

    const reply = await call(routeFor('/item/fetch').handler, { query });

    expect(reply.headers['x-network-partial']).toBe('true');
    expect(
      (reply.body as { meta: { unavailable_instances: string[] } }).meta
        .unavailable_instances,
    ).toEqual(['https://peer.example']);
  });

  it('500 INTERNAL_SERVER_ERROR when the scatter/gather fetch throws', async () => {
    fetchItemsAcrossInstances.mockRejectedValue(new Error('peers exploded'));

    const reply = await call(routeFor('/item/fetch').handler, { query });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'INTERNAL_SERVER_ERROR',
    );
    expect(log.error).toHaveBeenCalled();
  });

  it('500 INTERNAL_SERVER_ERROR when the network config cannot be loaded', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('no such network'));

    const reply = await call(routeFor('/item/fetch').handler, { query });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe(
      'INTERNAL_SERVER_ERROR',
    );
  });
});

describe('POST /network/item/count_local (peer-only)', () => {
  const body = { item_network: 'blue_dot', item_domain: 'student' };

  it('403 when this instance does not serve the requested binding', async () => {
    isServedDomainBinding.mockReturnValue(false);

    const reply = await call(routeFor('/item/count_local').handler, { body });

    expect(reply.statusCode).toBe(403);
    expect(countLocalItems).not.toHaveBeenCalled();
  });

  it('200 returns the live-only local count', async () => {
    countLocalItems.mockResolvedValue(42);

    const reply = await call(routeFor('/item/count_local').handler, { body });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ count: 42 });
    expect(countLocalItems).toHaveBeenCalledWith({
      ...body,
      lifecycle_filter: 'live_only',
    });
  });
});

describe('POST /network/item/fetch_local (peer-only)', () => {
  const body = {
    item_network: 'blue_dot',
    item_domain: 'student',
    limit: 5,
    offset: 0,
  };

  it('403 when this instance does not serve the requested binding', async () => {
    isServedDomainBinding.mockReturnValue(false);

    const reply = await call(routeFor('/item/fetch_local').handler, { body });

    expect(reply.statusCode).toBe(403);
    expect(fetchLocalItems).not.toHaveBeenCalled();
  });

  it('200 returns the local page with a live-only filter forced on', async () => {
    fetchLocalItems.mockResolvedValue({
      meta: { total: 1, limit: 5, offset: 0 },
      items: [{ item_id: 'i1' }],
    });

    const reply = await call(routeFor('/item/fetch_local').handler, { body });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      meta: { total: 1, limit: 5, offset: 0 },
      items: [{ item_id: 'i1' }],
    });
    expect(fetchLocalItems).toHaveBeenCalledWith({
      ...body,
      lifecycle_filter: 'live_only',
    });
  });
});
