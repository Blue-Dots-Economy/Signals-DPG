import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Dependency-mocked unit tests for the two read-side admin participant
 * handlers:
 *   - GET  /api/v1/admin/participant          (participant_read.ts)
 *   - POST /api/v1/admin/participant/decrypt  (participant_decrypt.ts)
 *
 * The sibling `participant_read.test.ts` / `participant_decrypt.test.ts` mount
 * the real routes to exercise *schema validation* and the acting-org rejection
 * matrix with a `vi.fn()` db. This file goes the other way: it invokes the
 * exported handlers directly against a fake drizzle chain so the DB-backed
 * bodies (ownership gating, item/consent projection, decrypt-failure
 * isolation, audit log) are actually executed — that logic is otherwise only
 * covered by the `*.integration.test.ts` files, which the default run excludes.
 *
 * Ownership (see .claude/rules/auth-model.md) is keyed on the item creator's
 * `user.onboarded_by_org_id`, never on the lazily-materialized `item_metrics`
 * cache, so the assertions below inspect the generated WHERE tree directly.
 */

// --- mocks (hoisted) -------------------------------------------------------

const { rowQueue, queries, dbState, configState, decryptImpl, networkCfgState } =
  vi.hoisted(() => ({
    // One shared FIFO of result sets; each drizzle chain shifts the next entry.
    rowQueue: [] as unknown[][],
    // Every `.where(...)` call, in order, so tests can assert the predicate.
    queries: [] as { table: string; where: unknown; joined: string[] }[],
    // Resettable failure switch — never monkey-patch the shared row queue, an
    // override there would leak into every later test in the file.
    dbState: { failWith: null as Error | null },
    configState: {
      served_domains: [] as { network: string; domain: string }[],
    },
    decryptImpl: vi.fn((_row: { item_state: Record<string, unknown> }) => ({
      mergedState: {} as Record<string, unknown>,
    })),
    // #237: per-network config fixture, consumed by getNetworkConfigById only
    // when a test's body carries `contact` — every other test in this file
    // leaves it null and never triggers the lookup.
    networkCfgState: { cfg: null as Record<string, unknown> | null },
  }));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

// A thenable: some call sites await `.where(...)` directly, others chain
// `.limit()` / `.orderBy()`. BOTH then-callbacks must be forwarded — dropping
// `rej` makes a rejected query hang the await until the test timeout.
function thenable() {
  return {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      nextRows().then(res, rej),
    limit: () => nextRows(),
    orderBy: () => thenable(),
  };
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => {
      const joined: string[] = [];
      const builder = {
        from: (table: unknown) => {
          const scoped = {
            innerJoin: (t: unknown) => {
              joined.push(String(t));
              return scoped;
            },
            where: (w: unknown) => {
              queries.push({ table: String(table), where: w, joined });
              return thenable();
            },
          };
          return scoped;
        },
      };
      return builder;
    },
  },
}));

// Real drizzle helpers need real column objects; swap them for transparent
// tagged records so the emitted predicate tree is inspectable.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  eq: (a: unknown, b: unknown) => ({ op: 'eq', a, b }),
  inArray: (a: unknown, b: unknown) => ({ op: 'inArray', a, b }),
}));

vi.mock('@dpg/database', () => ({
  items: {
    toString: () => 'items',
    item_id: 'items.item_id',
    item_network: 'items.item_network',
    item_domain: 'items.item_domain',
    item_type: 'items.item_type',
    lifecycle_status: 'items.lifecycle_status',
    item_state: 'items.item_state',
    item_locations: 'items.item_locations',
    item_private_state: 'items.item_private_state',
    created_by: 'items.created_by',
    created_at: 'items.created_at',
    updated_at: 'items.updated_at',
  },
}));

// The user table is mocked under BOTH specifiers it is imported by: the `@api`
// alias and the relative `.js` path that participant_read/participant_decrypt
// actually use. The stub is inlined in each factory rather than shared via a
// top-level const, because vi.mock factories are hoisted above top-level
// declarations ("Cannot access 'x' before initialization"); only a `vi.hoisted`
// binding would be safe to reference.
vi.mock('@api/db/postgres/schema/auth', () => ({
  user: {
    toString: () => 'user',
    id: 'user.id',
    email: 'user.email',
    phoneNumber: 'user.phoneNumber',
    age: 'user.age',
    onboardedByOrgId: 'user.onboardedByOrgId',
  },
}));
vi.mock('../../../../../db/postgres/schema/auth.js', () => ({
  user: {
    toString: () => 'user',
    id: 'user.id',
    email: 'user.email',
    phoneNumber: 'user.phoneNumber',
    age: 'user.age',
    onboardedByOrgId: 'user.onboardedByOrgId',
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: {
    toString: () => 'consent_record',
    userId: 'cr.userId',
    level: 'cr.level',
    consentCategory: 'cr.consentCategory',
    itemId: 'cr.itemId',
  },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/schemas', () => ({
  default: {},
  GetParticipantRequest: {},
  GetParticipantResponse: {},
  DecryptParticipantRequest: {},
  DecryptParticipantResponse: {},
}));

vi.mock('@/config', () => ({ apiConfig: configState }));

vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: (row: { item_state: Record<string, unknown> }) =>
    decryptImpl(row),
}));

// #237: participant_decrypt now imports getNetworkConfigById to resolve the
// per-domain contact-field context, but only calls it when body.contact is
// present — mocked here so the pre-existing (contact-omitted) tests in this
// file never need a real network config.
// participant_decrypt now scopes an aggregator to the domains its org declares
// (defence in depth for per-domain default aggregators). Mocked here rather
// than adding `organization` to the schema mock, so tests can drive the
// declared set directly and this stays a unit test.
const declaredDomains = { value: ['seeker'] as string[] };
vi.mock('@/utils/org_metadata', () => ({
  readConfiguredDomains: async () => declaredDomains.value,
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => {
    if (!networkCfgState.cfg) {
      throw new Error(
        'participant_group.test.ts: no network_configs fixture set (only needed when body.contact is present)',
      );
    }
    return networkCfgState.cfg;
  }),
}));

import { participant_read_handler } from '../participant_read';
import { participant_decrypt_handler } from '../participant_decrypt';

// --- helpers ---------------------------------------------------------------

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(handler: any, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callRaw(handler: any, req: Record<string, unknown>): Promise<unknown> {
  return handler({ log, ...req }, makeReply());
}

interface Cond {
  op?: string;
  a?: unknown;
  b?: unknown;
  args?: unknown[];
}

/** Flattens an and/or tree into its leaf comparisons (undefined args dropped). */
function leaves(node: unknown): Cond[] {
  if (!node || typeof node !== 'object') return [];
  const cond = node as Cond;
  if (Array.isArray(cond.args)) return cond.args.flatMap(leaves);
  return [cond];
}

function leafFor(where: unknown, column: string): Cond | undefined {
  return leaves(where).find((c) => c.a === column);
}

const AGG = {
  org_id: 'org_agg',
  org_type: 'aggregator',
  service_user_id: 'svc',
};
const NETSVC = {
  org_id: 'org_net',
  org_type: 'network_service',
  service_user_id: 'svc',
};

const EMPTY_CONSENT = {
  terms_accepted: false,
  privacy_accepted: false,
  has_age: false,
};

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: 'i1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    lifecycle_status: 'live',
    item_state: { name: 'Public Name' },
    item_locations: [{ label: 'home' }],
    item_private_state: 'enc:blob',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-02T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  rowQueue.length = 0;
  queries.length = 0;
  dbState.failWith = null;
  configState.served_domains = [{ network: 'blue_dot', domain: 'seeker' }];
  declaredDomains.value = ['seeker'];
  networkCfgState.cfg = null;
  vi.clearAllMocks();
  decryptImpl.mockImplementation((row: { item_state: Record<string, unknown> }) => ({
    mergedState: { ...row.item_state, phone: '+919999900000' },
  }));
});

// --- participant_read ------------------------------------------------------

describe('participant_read_handler — identifier normalisation', () => {
  it('lower-cases and trims the email before the exact-match lookup', async () => {
    rowQueue.push([]); // user lookup: nobody

    await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: '  MiXeD@Example.COM  ' },
    });

    expect(queries[0].table).toBe('user');
    // A single identifier is passed as a bare condition, not wrapped in or().
    expect(queries[0].where).toEqual({
      op: 'eq',
      a: 'user.email',
      b: 'mixed@example.com',
    });
  });

  it('prepends the missing "+" so a bare E.164 phone still matches', async () => {
    rowQueue.push([]);

    await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { phone_number: ' 919876543210 ' },
    });

    expect(queries[0].where).toEqual({
      op: 'eq',
      a: 'user.phoneNumber',
      b: '+919876543210',
    });
  });

  it('keeps an already-canonical phone untouched', async () => {
    rowQueue.push([]);

    await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { phone_number: '+919876543210' },
    });

    expect((queries[0].where as Cond).b).toBe('+919876543210');
  });

  it('ORs the two conditions when both email and phone are supplied', async () => {
    rowQueue.push([]);

    await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: 'a@b.com', phone_number: '919876543210' },
    });

    expect((queries[0].where as Cond).op).toBe('or');
    expect(leaves(queries[0].where)).toEqual([
      { op: 'eq', a: 'user.email', b: 'a@b.com' },
      { op: 'eq', a: 'user.phoneNumber', b: '+919876543210' },
    ]);
  });

  it('400 MISSING_IDENTIFIER when both identifiers are blank strings', async () => {
    const reply = await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: '   ', phone_number: '  ' },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('MISSING_IDENTIFIER');
    // Rejected before any query is issued.
    expect(queries).toHaveLength(0);
  });

  it('checks the identifier BEFORE the acting-org gate (400 wins over 403)', async () => {
    const reply = await call(participant_read_handler, {
      acting_org: undefined,
      query: {},
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('MISSING_IDENTIFIER');
  });
});

describe('participant_read_handler — ownership disclosure', () => {
  it('returns user_id: null and empty consent for an unknown identifier', async () => {
    rowQueue.push([]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'nobody@example.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      user_id: null,
      user_consent: EMPTY_CONSENT,
      items: [],
    });
    expect(queries).toHaveLength(1); // no items / consent reads at all
  });

  it('an aggregator that did not onboard the user gets the id but no data', async () => {
    rowQueue.push([
      {
        id: 'u1',
        email: 'a@b.com',
        phoneNumber: null,
        onboardedByOrgId: 'org_other',
      },
    ]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      user_id: 'u1',
      user_consent: EMPTY_CONSENT,
      items: [],
    });
    // Existence is acknowledged, but nothing beyond the user lookup is read.
    expect(queries).toHaveLength(1);
  });

  it('a user with no onboarding org is not disclosed to an aggregator', async () => {
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: null },
    ]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { items: unknown[] }).items).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('network_service reads a user it did not onboard', async () => {
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_other' },
    ]);
    rowQueue.push([itemRow()]);
    rowQueue.push([{ itemId: 'i1' }]);
    rowQueue.push([{ category: 'terms' }, { category: 'privacy' }]);
    rowQueue.push([{ age: 20 }]);

    const reply = await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: 'a@b.com' },
    });

    const body = reply.body as {
      user_id: string;
      user_consent: Record<string, boolean>;
      items: { item_id: string; profile_consent_accepted: boolean }[];
    };
    expect(body.user_id).toBe('u1');
    expect(body.items.map((i) => i.item_id)).toEqual(['i1']);
    expect(body.user_consent).toEqual({
      terms_accepted: true,
      privacy_accepted: true,
      has_age: true,
    });
  });
});

describe('participant_read_handler — item + consent projection', () => {
  const onboarded = [
    { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg' },
  ];

  it('merges decrypted private state, drops the raw blob and ISO-formats dates', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([itemRow()]);
    rowQueue.push([{ itemId: 'i1' }]);
    rowQueue.push([]);
    rowQueue.push([{ age: null }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    const items = (reply.body as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      item_id: 'i1',
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      lifecycle_status: 'live',
      item_state: { name: 'Public Name', phone: '+919999900000' },
      item_locations: [{ label: 'home' }],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-02-02T00:00:00.000Z',
      profile_consent_accepted: true,
    });
    expect(items[0]).not.toHaveProperty('item_private_state');
    expect(decryptImpl).toHaveBeenCalledWith({
      item_state: { name: 'Public Name' },
      item_private_state: 'enc:blob',
    });
  });

  it('flags profile_consent_accepted per item from the item-level ledger', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([
      itemRow({ item_id: 'i1' }),
      itemRow({ item_id: 'i2' }),
      itemRow({ item_id: 'i3' }),
    ]);
    rowQueue.push([{ itemId: 'i1' }, { itemId: 'i3' }]);
    rowQueue.push([]);
    rowQueue.push([{ age: 30 }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    const items = (reply.body as {
      items: { item_id: string; profile_consent_accepted: boolean }[];
    }).items;
    expect(items.map((i) => [i.item_id, i.profile_consent_accepted])).toEqual([
      ['i1', true],
      ['i2', false],
      ['i3', true],
    ]);
    // The consent lookup is scoped to item-level profile_creation rows for
    // exactly the ids just read.
    const consentWhere = queries[2].where;
    expect(leafFor(consentWhere, 'cr.level')).toEqual({
      op: 'eq',
      a: 'cr.level',
      b: 'item',
    });
    expect(leafFor(consentWhere, 'cr.consentCategory')).toEqual({
      op: 'eq',
      a: 'cr.consentCategory',
      b: 'profile_creation',
    });
    expect(leafFor(consentWhere, 'cr.itemId')).toEqual({
      op: 'inArray',
      a: 'cr.itemId',
      b: ['i1', 'i2', 'i3'],
    });
  });

  it('skips the item-consent query entirely when the user has no items', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([]); // no items
    rowQueue.push([{ category: 'terms' }]);
    rowQueue.push([{ age: 17 }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { items: unknown[] }).items).toEqual([]);
    expect((reply.body as { user_consent: unknown }).user_consent).toEqual({
      terms_accepted: true,
      privacy_accepted: false,
      has_age: true,
    });
    // user lookup + items + user-consent + age — the item-consent read is
    // short-circuited for an empty id list.
    expect(queries.map((q) => q.table)).toEqual([
      'user',
      'items',
      'consent_record',
      'user',
    ]);
  });

  it('reports has_age false when the user row is missing entirely', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([]);
    rowQueue.push([]);
    rowQueue.push([]); // age lookup returns nothing

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { user_consent: unknown }).user_consent).toEqual(
      EMPTY_CONSENT,
    );
  });

  it('ignores non terms/privacy categories and keeps the user-consent read network-agnostic', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([]);
    rowQueue.push([{ category: 'profile_creation' }, { category: 'privacy' }]);
    rowQueue.push([{ age: 25 }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { user_consent: unknown }).user_consent).toEqual({
      terms_accepted: false,
      privacy_accepted: true,
      has_age: true,
    });
    const userConsentWhere = queries[2].where;
    expect(leafFor(userConsentWhere, 'cr.level')).toEqual({
      op: 'eq',
      a: 'cr.level',
      b: 'user',
    });
    expect(leafFor(userConsentWhere, 'cr.userId')).toEqual({
      op: 'eq',
      a: 'cr.userId',
      b: 'u1',
    });
    expect(leaves(userConsentWhere).map((c) => c.a)).not.toContain('cr.network');
  });

  it('scopes the item read to the creator and the served networks', async () => {
    configState.served_domains = [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'provider' },
      { network: 'yellow_dot', domain: 'student' },
    ];
    rowQueue.push(onboarded);
    rowQueue.push([]);
    rowQueue.push([]);
    rowQueue.push([{ age: 25 }]);

    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    const itemsWhere = queries[1].where;
    expect(leafFor(itemsWhere, 'items.created_by')).toEqual({
      op: 'eq',
      a: 'items.created_by',
      b: 'u1',
    });
    // Duplicate networks across served domains are de-duplicated.
    expect(leafFor(itemsWhere, 'items.item_network')).toEqual({
      op: 'inArray',
      a: 'items.item_network',
      b: ['blue_dot', 'yellow_dot'],
    });
  });

  it('drops the network filter when no domains are served', async () => {
    configState.served_domains = [];
    rowQueue.push(onboarded);
    rowQueue.push([]);
    rowQueue.push([]);
    rowQueue.push([{ age: 25 }]);

    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(queries[1].where).toEqual({
      op: 'eq',
      a: 'items.created_by',
      b: 'u1',
    });
  });

  it('admits a voice acting org (treated as a service org; retire via #518)', async () => {
    const reply = await call(participant_read_handler, {
      acting_org: { org_id: 'org_voice', org_type: 'voice', service_user_id: 's' },
      query: { email: 'a@b.com' },
    });

    // voice is admitted alongside aggregator/network_service — voice-dpg is a
    // platform layer, not a restricted actor. The redundant `voice` org type is
    // tracked for removal (model voice-dpg as network_service) in signals-dpg#518.
    expect(reply.statusCode).not.toBe(403);
    expect(queries.length).toBeGreaterThan(0);
  });

  it('propagates a DB failure instead of returning a 5xx body (no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(
      callRaw(participant_read_handler, {
        acting_org: NETSVC,
        query: { email: 'a@b.com' },
      }),
    ).rejects.toThrow('db down');
  });
});

// --- participant_decrypt ---------------------------------------------------

describe('participant_decrypt_handler — item_ids mode', () => {
  it('gates an aggregator on the creator onboarded_by_org_id, not item_metrics', async () => {
    rowQueue.push([]);

    await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { item_ids: ['i1'] },
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe('items');
    // Ownership comes from the joined user row, keyed on the creator.
    expect(queries[0].joined).toEqual(['user']);
    expect(leafFor(queries[0].where, 'user.onboardedByOrgId')).toEqual({
      op: 'eq',
      a: 'user.onboardedByOrgId',
      b: 'org_agg',
    });
    expect(leaves(queries[0].where).map((c) => c.a)).not.toContain(
      'item_metrics.org_id',
    );
  });

  it('also scopes an aggregator to the domains its org declares', async () => {
    // Defence in depth for per-domain default aggregators: the org tag is per
    // ACCOUNT and items are per DOMAIN, so without this a seeker default could
    // decrypt a provider profile belonging to an account that spans both.
    // Dashboard and export already filter this way (`export.ts`).
    declaredDomains.value = ['seeker'];
    rowQueue.push([]);

    await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { item_ids: ['i1'] },
    });

    expect(leafFor(queries[0].where, 'items.item_domain')).toEqual({
      op: 'inArray',
      a: 'items.item_domain',
      b: ['seeker'],
    });
  });

  it('applies NO domain filter for network_service', async () => {
    // A network_service caller is not a tenant; it sees every served network.
    declaredDomains.value = ['seeker'];
    rowQueue.push([]);

    await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'] },
    });

    expect(leafFor(queries[0].where, 'items.item_domain')).toBeUndefined();
  });

  it('400 NO_DOMAINS_CONFIGURED for an aggregator that declares nothing', async () => {
    // Fail closed: with no declared domains there is no scope to honour, and
    // defaulting to "all of them" on a path that returns decrypted PII is the
    // wrong direction. `aggregator/export.ts` refuses the same way.
    declaredDomains.value = [];

    const reply = await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { item_ids: ['i1'] },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('NO_DOMAINS_CONFIGURED');
    // Refused before any query ran — no chance of a wide read slipping out.
    expect(queries).toHaveLength(0);
  });

  it('applies no org filter for network_service but keeps the served-network scope', async () => {
    rowQueue.push([]);

    await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'] },
    });

    expect(leafFor(queries[0].where, 'user.onboardedByOrgId')).toBeUndefined();
    expect(leafFor(queries[0].where, 'items.item_network')).toEqual({
      op: 'inArray',
      a: 'items.item_network',
      b: ['blue_dot'],
    });
  });

  it('de-duplicates requested item_ids for both the query and the audit count', async () => {
    rowQueue.push([]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { item_ids: ['a', 'b', 'a', 'b', 'a'] },
    });

    expect(leafFor(queries[0].where, 'items.item_id')).toEqual({
      op: 'inArray',
      a: 'items.item_id',
      b: ['a', 'b'],
    });
    expect(reply.body).toEqual({ profiles: [], skipped: ['a', 'b'] });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'admin.participant.decrypt',
        acting_org_id: 'org_agg',
        org_type: 'aggregator',
        mode: 'item_ids',
        requested_count: 2,
        returned_count: 0,
        skipped_count: 2,
      }),
    );
  });

  it('returns decrypted snapshots and lists unreturned ids as skipped', async () => {
    rowQueue.push([itemRow({ item_id: 'i2' })]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1', 'i2', 'i3'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      profiles: [
        {
          item_id: 'i2',
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: { name: 'Public Name', phone: '+919999900000' },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-02-02T00:00:00.000Z',
        },
      ],
      // Not found / not owned / not in a served network are indistinguishable.
      skipped: ['i1', 'i3'],
    });
  });

  it('a snapshot never carries lifecycle_status, locations or the raw blob', async () => {
    rowQueue.push([itemRow()]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'] },
    });

    const profile = (reply.body as { profiles: Record<string, unknown>[] })
      .profiles[0];
    expect(Object.keys(profile).sort()).toEqual([
      'created_at',
      'item_domain',
      'item_id',
      'item_network',
      'item_state',
      'item_type',
      'updated_at',
    ]);
  });

  it('isolates a row whose decrypt throws: skipped, logged, batch still succeeds', async () => {
    decryptImpl.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    rowQueue.push([itemRow({ item_id: 'i1' }), itemRow({ item_id: 'i2' })]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1', 'i2'] },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      profiles: { item_id: string }[];
      skipped: string[];
    };
    expect(body.profiles.map((p) => p.item_id)).toEqual(['i2']);
    expect(body.skipped).toEqual(['i1']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'admin.participant.decrypt.row_failed',
        item_id: 'i1',
      }),
      expect.any(String),
    );
  });

  it('drops the network filter when no domains are served', async () => {
    configState.served_domains = [];
    rowQueue.push([]);

    await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'] },
    });

    expect(leafFor(queries[0].where, 'items.item_network')).toBeUndefined();
  });
});

describe('participant_decrypt_handler — user_id mode', () => {
  it('scopes to the creator and still enforces the aggregator ownership join', async () => {
    rowQueue.push([itemRow()]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { user_id: 'u1' },
    });

    expect(leafFor(queries[0].where, 'items.created_by')).toEqual({
      op: 'eq',
      a: 'items.created_by',
      b: 'u1',
    });
    expect(leafFor(queries[0].where, 'user.onboardedByOrgId')).toEqual({
      op: 'eq',
      a: 'user.onboardedByOrgId',
      b: 'org_agg',
    });
    expect((reply.body as { profiles: unknown[] }).profiles).toHaveLength(1);
    expect((reply.body as { skipped: string[] }).skipped).toEqual([]);
  });

  it('audits user_id mode with requested_count 1 regardless of rows returned', async () => {
    rowQueue.push([itemRow({ item_id: 'i1' }), itemRow({ item_id: 'i2' })]);

    await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { user_id: 'u1' },
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'user_id',
        requested_count: 1,
        returned_count: 2,
        skipped_count: 0,
      }),
    );
    // The audit entry carries counts only — never item_state values.
    const logged = log.info.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).not.toHaveProperty('item_state');
    expect(logged).not.toHaveProperty('profiles');
  });

  it('pushes an undecryptable row id into skipped', async () => {
    decryptImpl.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    rowQueue.push([itemRow({ item_id: 'i1' }), itemRow({ item_id: 'i2' })]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { user_id: 'u1' },
    });

    expect(reply.body).toEqual({
      profiles: [expect.objectContaining({ item_id: 'i2' })],
      skipped: ['i1'],
    });
  });

  it('returns empty results (not 404) when the user owns nothing visible', async () => {
    rowQueue.push([]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: AGG,
      body: { user_id: 'u-unknown' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ profiles: [], skipped: [] });
  });

  it('propagates a DB failure instead of returning a 5xx body (no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(
      callRaw(participant_decrypt_handler, {
        acting_org: AGG,
        body: { user_id: 'u1' },
      }),
    ).rejects.toThrow('db down');
  });
});

// --- participant_decrypt fields / contact / locations (#521) ---------------
//
// The fields/contact/locations-omitted path is exercised throughout the two
// describe blocks above (none of those bodies set any of the three), which is
// the regression this endpoint must never break. These cases cover the three
// independent controls: `fields` (pure item_state projection, no canonical
// mapping/user fallback), `contact` (canonical block resolved against a
// per-domain contact_fields fixture + the row's account columns), and
// `include_locations` (the row's item_locations column).

describe('participant_decrypt_handler — fields / contact / locations (#521)', () => {
  it('fields: ["full_name"] is a pure projection — no contact_fields mapping is consulted', async () => {
    // networkCfgState.cfg is deliberately left null: getNetworkConfigById
    // throws if called, so this also proves `fields` never triggers a config
    // lookup (that's `contact`'s job).
    decryptImpl.mockImplementationOnce(() => ({
      mergedState: { full_name: 'Real Name', mobile: '+911234567890' },
    }));
    rowQueue.push([itemRow()]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'], fields: ['full_name'] },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as { profiles: { item_state: Record<string, unknown> }[] };
    expect(body.profiles[0].item_state).toEqual({ full_name: 'Real Name' });
  });

  it('contact: ["name","phone"] resolve via contact_fields; profile value wins', async () => {
    networkCfgState.cfg = {
      domains: [
        {
          id: 'seeker',
          item_schemas: { 'profile_1.0': { display_name_field: 'full_name' } },
          card: { title_field: 'full_name' },
          contact_fields: { name: 'full_name', phone: 'mobile' },
        },
      ],
    };
    decryptImpl.mockImplementationOnce(() => ({
      mergedState: { full_name: 'Real Name', mobile: '+911234567890' },
    }));
    rowQueue.push([
      itemRow({
        user_name: 'Account Name',
        user_email: 'account@example.com',
        user_phone: '+910000000000',
      }),
    ]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'], contact: ['name', 'phone'] },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      profiles: {
        item_state: Record<string, unknown>;
        contact: Record<string, { value: string | null; source: string | null }>;
      }[];
    };
    // fields was omitted -> item_state stays the full merged state, unaffected
    // by the contact block.
    expect(body.profiles[0].item_state).toEqual({ full_name: 'Real Name', mobile: '+911234567890' });
    expect(body.profiles[0].contact).toEqual({
      name: { value: 'Real Name', source: 'item' },
      phone: { value: '+911234567890', source: 'item' },
    });
  });

  it('contact: ["email"] with no profile mapping/value falls back to the account email', async () => {
    networkCfgState.cfg = {
      domains: [
        {
          id: 'seeker',
          item_schemas: { 'profile_1.0': {} },
          contact_fields: { name: 'full_name' }, // no `email` mapping
        },
      ],
    };
    decryptImpl.mockImplementationOnce(() => ({ mergedState: { full_name: 'Real Name' } }));
    rowQueue.push([
      itemRow({ user_name: 'Account Name', user_email: 'account@example.com', user_phone: null }),
    ]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'], contact: ['email'] },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as { profiles: { contact: Record<string, unknown> }[] };
    expect(body.profiles[0].contact).toEqual({ email: { value: 'account@example.com', source: 'user' } });
  });

  it('canonical field absent in both profile and account resolves to {value:null, source:null}', async () => {
    networkCfgState.cfg = {
      domains: [{ id: 'seeker', item_schemas: {}, contact_fields: {} }],
    };
    decryptImpl.mockImplementationOnce(() => ({ mergedState: { full_name: 'Real Name' } }));
    rowQueue.push([
      itemRow({ user_name: 'Account Name', user_email: null, user_phone: null }),
    ]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'], contact: ['email'] },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as { profiles: { contact: Record<string, unknown> }[] };
    expect(body.profiles[0].contact).toEqual({ email: { value: null, source: null } });
  });

  it('include_locations: true returns the row\'s item_locations, without touching contact/fields', async () => {
    rowQueue.push([itemRow({ item_locations: [{ lat: 1, lng: 2, label: 'home' }] })]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { item_ids: ['i1'], include_locations: true },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as { profiles: { locations: unknown; contact?: unknown }[] };
    expect(body.profiles[0].locations).toEqual([{ lat: 1, lng: 2, label: 'home' }]);
    expect(body.profiles[0]).not.toHaveProperty('contact');
  });

  it('user_id mode applies contact + include_locations to every returned item', async () => {
    networkCfgState.cfg = {
      domains: [{ id: 'seeker', item_schemas: {}, contact_fields: { name: 'full_name' } }],
    };
    decryptImpl.mockImplementation((row: { item_state: Record<string, unknown> }) => ({
      mergedState: { ...row.item_state },
    }));
    rowQueue.push([
      itemRow({ item_id: 'i1', item_state: { full_name: 'A' }, item_locations: [{ lat: 1, lng: 1 }] }),
      itemRow({ item_id: 'i2', item_state: { full_name: 'B' }, item_locations: [{ lat: 2, lng: 2 }] }),
    ]);

    const reply = await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: { user_id: 'u1', contact: ['name'], include_locations: true },
    });

    expect(reply.statusCode).toBe(200);
    const body = reply.body as {
      profiles: { item_id: string; contact: Record<string, unknown>; locations: unknown }[];
    };
    expect(body.profiles.map((p) => [p.item_id, p.contact.name, p.locations])).toEqual([
      ['i1', { value: 'A', source: 'item' }, [{ lat: 1, lng: 1 }]],
      ['i2', { value: 'B', source: 'item' }, [{ lat: 2, lng: 2 }]],
    ]);
  });

  it('audits fields_requested / contact_requested / include_locations as counts/booleans only, never values', async () => {
    networkCfgState.cfg = {
      domains: [
        {
          id: 'seeker',
          item_schemas: {},
          contact_fields: { name: 'full_name', phone: 'mobile' },
        },
      ],
    };
    rowQueue.push([itemRow({ user_name: 'Account Name' })]);

    await call(participant_decrypt_handler, {
      acting_org: NETSVC,
      body: {
        item_ids: ['i1'],
        fields: ['full_name'],
        contact: ['name', 'phone'],
        include_locations: true,
      },
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        fields_requested: 1,
        contact_requested: 2,
        include_locations: true,
      }),
    );
    const logged = log.info.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).not.toHaveProperty('fields');
    expect(logged).not.toHaveProperty('contact');
    expect(logged).not.toHaveProperty('item_state');
    expect(logged).not.toHaveProperty('locations');
  });
});
