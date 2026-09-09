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

const {
  rowQueue,
  queries,
  dbState,
  configState,
  decryptImpl,
  networkCfgState,
  consentVersionState,
} = vi.hoisted(() => ({
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
    // #692: the live version per consent category, as the instance's config
    // would report it. `null` models an unconfigured category.
    consentVersionState: {
      current: {} as Record<string, number | null>,
      calls: [] as Array<{
        category: string;
        variant?: 'adult' | 'u18';
        brand?: string | null;
        network: string;
      }>,
    },
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
    // #692: the reads now filter on the accepted version and the network.
    documentVersion: 'cr.documentVersion',
    network: 'cr.network',
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

// #692: the reads resolve the live document version per category. Mocked so
// these stay unit tests — `consentVersionState` drives what "current" is, which
// is exactly the axis the version-scoping tests need to vary.
// Keyed on category + variant + brand, not category alone: the read has to pass
// all three (u18 documents and brand overrides carry their own counters), and a
// mock that ignored them could not observe a missing discriminator at all.
// `calls` records every resolve so tests can assert what was actually asked for.
vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: async (input: {
    category: string;
    variant?: 'adult' | 'u18';
    brand?: string | null;
    network: string;
  }) => {
    consentVersionState.calls.push(input);
    const variant = input.variant ?? 'adult';
    const brand = input.brand ?? '';
    const keyed = consentVersionState.current[
      `${input.category}|${variant}|${brand}`
    ];
    if (keyed !== undefined) return keyed;
    return consentVersionState.current[input.category] ?? null;
  },
}));

// `@/services/minor` is deliberately NOT mocked. `isMinor` is a pure function of
// a number with no I/O, and the earlier mock (`age < 18`) inverted the real rule
// (`age <= 18`, fail-closed because the stored age is a year-only snapshot) —
// making 18 an adult in tests and a minor in production, at exactly the age
// where the rule is non-obvious.

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

// #692: the GET answers with the same `[{key,value}]` shape the POST accepts.
const EMPTY_COMPLIANCE = [
  { key: 'user_terms', value: false },
  { key: 'user_privacy', value: false },
  { key: 'has_age', value: false },
];

/** Compliance array with the given values, in the order the handler emits. */
function compliance(terms: boolean, privacy: boolean, hasAge: boolean) {
  return [
    { key: 'user_terms', value: terms },
    { key: 'user_privacy', value: privacy },
    { key: 'has_age', value: hasAge },
  ];
}

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
  // Reset, or a version set by one test silently drives the next.
  consentVersionState.current = {};
  consentVersionState.calls.length = 0;
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
      compliance: EMPTY_COMPLIANCE,
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
      compliance: EMPTY_COMPLIANCE,
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
    rowQueue.push([{ age: 20 }]);
    rowQueue.push([itemRow()]);
    rowQueue.push([{ itemId: 'i1' }]);
    rowQueue.push([
      { category: 'terms', version: 2 },
      { category: 'privacy', version: 2 },
    ]);
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: 'a@b.com' },
    });

    const body = reply.body as {
      user_id: string;
      compliance: { key: string; value: boolean }[];
      items: { item_id: string; profile_consent_accepted: boolean }[];
    };
    expect(body.user_id).toBe('u1');
    expect(body.items.map((i) => i.item_id)).toEqual(['i1']);
    expect(body.compliance).toEqual(compliance(true, true, true));
  });
});

describe('participant_read_handler — item + consent projection', () => {
  const onboarded = [
    { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg' },
  ];

  it('merges decrypted private state, drops the raw blob and ISO-formats dates', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([{ age: null }]);
    rowQueue.push([itemRow()]);
    rowQueue.push([{ itemId: 'i1', version: 1, brand: null }]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

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
    rowQueue.push([{ age: 30 }]);
    rowQueue.push([
      itemRow({ item_id: 'i1' }),
      itemRow({ item_id: 'i2' }),
      itemRow({ item_id: 'i3' }),
    ]);
    rowQueue.push([
      { itemId: 'i1', version: 1, brand: null },
      { itemId: 'i3', version: 1, brand: null },
    ]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

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
    const consentWhere = queries[3].where;
    expect(leafFor(consentWhere, 'cr.level')).toEqual({
      op: 'eq',
      a: 'cr.level',
      b: 'item',
    });
    // The version is deliberately NOT a SQL predicate: each row is compared
    // against the current version for its OWN stored brand, so there is no
    // single integer to filter on. The comparison is asserted behaviourally
    // instead — see the superseded-version tests below.
    expect(leaves(consentWhere).map((c) => c.a)).not.toContain(
      'cr.documentVersion',
    );
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
    // #692 review: the item-level read must carry the SAME network predicate
    // the user-level read does — a row accepted on another network must not
    // satisfy this query. Its absence here is what let that bug survive.
    expect(leafFor(consentWhere, 'cr.network')).toEqual({
      op: 'eq',
      a: 'cr.network',
      b: 'blue_dot',
    });
  });

  it('skips the item-consent query entirely when the user has no items', async () => {
    rowQueue.push(onboarded);
    // age 17 would be a minor, but this caller is an aggregator — the U18 gate
    // is scoped to voice/network_service, so the read proceeds.
    rowQueue.push([{ age: 17 }]);
    rowQueue.push([]); // no items
    rowQueue.push([{ category: 'terms', version: 1 }]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { items: unknown[] }).items).toEqual([]);
    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, false, true),
    );
    // user lookup + age + items + user-consent — the item-consent read is
    // short-circuited for an empty id list.
    expect(queries.map((q) => q.table)).toEqual([
      'user',
      'user',
      'items',
      'consent_record',
    ]);
  });

  it('reports has_age false when the user row is missing entirely', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([]); // age lookup returns nothing
    rowQueue.push([]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      EMPTY_COMPLIANCE,
    );
  });

  it('ignores non terms/privacy categories and scopes the user-consent read to the network', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 25 }]);
    rowQueue.push([]);
    rowQueue.push([
      { category: 'profile_creation', version: 1 },
      { category: 'privacy', version: 1 },
    ]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(false, true, true),
    );
    const userConsentWhere = queries[3].where;
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
    // #692 deliberately REVERSES the old network-agnostic behaviour: the
    // comparison is against this network's document, so a row accepted on
    // another network must not satisfy it.
    expect(leafFor(userConsentWhere, 'cr.network')).toEqual({
      op: 'eq',
      a: 'cr.network',
      b: 'blue_dot',
    });
  });

  it('scopes the item read to the creator and the served networks', async () => {
    configState.served_domains = [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'provider' },
      { network: 'yellow_dot', domain: 'student' },
    ];
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 25 }]);
    rowQueue.push([]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

    // Two networks are served, so the compliance comparison needs to be told
    // which one; the item scope itself still spans both.
    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com', network: 'blue_dot' },
    });

    const itemsWhere = queries[2].where;
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
    rowQueue.push([{ age: 25 }]);
    rowQueue.push([]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 1, privacy: 1, profile_creation: 1 };

    // No served bindings means no network can be inferred for the version
    // comparison, so the caller has to name one.
    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com', network: 'blue_dot' },
    });

    expect(queries[2].where).toEqual({
      op: 'eq',
      a: 'items.created_by',
      b: 'u1',
    });
  });

  // ---------------------------------------------------------------------------
  // #692 — the flags are version-scoped, and the U18 gate
  // ---------------------------------------------------------------------------

  /** Queue a disclose-path read: user, age, items, item-consent, user-consent. */
  function queueRead(opts: {
    age?: number | null;
    userConsentRows?: { category: string; version: number }[];
  }) {
    rowQueue.push(onboarded);
    rowQueue.push([{ age: opts.age ?? 30 }]);
    rowQueue.push([]); // no items — item-consent read is short-circuited
    rowQueue.push(opts.userConsentRows ?? []);
  }

  it('reports false when the only accepted version is superseded', async () => {
    // The prod case this whole change exists for: users migrated from the old
    // portal carry version 1 while the live document is version 2. They used to
    // read as consented forever, so the voice channel never re-prompted them.
    queueRead({
      userConsentRows: [
        { category: 'terms', version: 1 },
        { category: 'privacy', version: 1 },
      ],
    });
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(false, false, true),
    );
  });

  it('reports true once the current version is accepted, with the old row still present', async () => {
    // The ledger is append-only, so re-accepting adds a row rather than
    // replacing one — both versions are present and the current one decides.
    queueRead({
      userConsentRows: [
        { category: 'terms', version: 1 },
        { category: 'terms', version: 2 },
        { category: 'privacy', version: 1 },
        { category: 'privacy', version: 2 },
      ],
    });
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, true, true),
    );
  });

  it('scopes each category independently', async () => {
    queueRead({
      userConsentRows: [
        { category: 'terms', version: 2 },
        { category: 'privacy', version: 1 },
      ],
    });
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, false, true),
    );
  });

  it('reports false for an unconfigured category', async () => {
    // `resolveConsentVersion` answers null when the category has no document.
    // Nothing can have been accepted against a document that does not exist, so
    // the caller is sent to a consent flow rather than proceeding on a claim
    // that cannot be checked. A stated decision, not a fallthrough.
    queueRead({ userConsentRows: [{ category: 'terms', version: 1 }] });
    consentVersionState.current = { terms: null, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(false, false, true),
    );
  });

  it('an item consented at a superseded version drops out of the item flag', async () => {
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);
    rowQueue.push([itemRow({ item_id: 'i1' })]);
    // The row EXISTS — it is simply at a superseded version. Returning rows
    // here (rather than none) is what makes this test fail if the version
    // comparison is removed; an empty result would pass either way.
    rowQueue.push([{ itemId: 'i1', version: 1, brand: null }]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    const items = (reply.body as {
      items: { profile_consent_accepted: boolean }[];
    }).items;
    expect(items[0].profile_consent_accepted).toBe(false);
  });

  it('flags an item consented AT the current version', async () => {
    // The positive half of the pair above: same query, same shape, only the
    // row's version differs — so together they pin the comparison itself.
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);
    rowQueue.push([itemRow({ item_id: 'i1' })]);
    rowQueue.push([{ itemId: 'i1', version: 2, brand: null }]);
    rowQueue.push([]);
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    const items = (reply.body as {
      items: { profile_consent_accepted: boolean }[];
    }).items;
    expect(items[0].profile_consent_accepted).toBe(true);
  });

  it('rejects a minor for a voice caller with U18_NOT_ALLOWED', async () => {
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_x' },
    ]);
    rowQueue.push([{ age: 15 }]);

    const reply = await call(participant_read_handler, {
      acting_org: { org_id: 'org_voice', org_type: 'voice', service_user_id: 's' },
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('U18_NOT_ALLOWED');
    // Nothing beyond the user + age lookups is read.
    expect(queries.map((q) => q.table)).toEqual(['user', 'user']);
  });

  it('rejects a minor for network_service too', async () => {
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_x' },
    ]);
    rowQueue.push([{ age: 15 }]);

    const reply = await call(participant_read_handler, {
      acting_org: NETSVC,
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('U18_NOT_ALLOWED');
  });

  it('does NOT reject a minor for an aggregator caller', async () => {
    // aggregator-dpg's probeUser is a read-only "resume or start fresh" check
    // that reads only user_id/items and treats any 400 as a hard failure.
    // Rejecting it would break registration for an already-onboarded minor.
    queueRead({ age: 15, userConsentRows: [{ category: 'terms', version: 2 }] });
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, false, true),
    );
  });

  it('returns all-false for an aggregator not entitled to the user', async () => {
    // Covers the non-disclosing branch's shape. It does NOT prove the gate
    // ORDERING, and cannot: no caller can currently be both U18-rejectable and
    // non-disclosing (network_service and voice always disclose; aggregator is
    // exempt from the rejection). The ordering is still deliberate — see the
    // handler comment — but it is structurally inert today, so this test is
    // named for what it actually pins rather than implying more.
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_other' },
    ]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      EMPTY_COMPLIANCE,
    );
  });

  it('400s when several networks are served and none is named', async () => {
    configState.served_domains = [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'yellow_dot', domain: 'student' },
    ];
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('NETWORK_REQUIRED');
  });

  it('an explicit ?network= overrides the served default', async () => {
    configState.served_domains = [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'yellow_dot', domain: 'student' },
    ];
    queueRead({ userConsentRows: [{ category: 'terms', version: 2 }] });
    consentVersionState.current = { terms: 2, privacy: 2, profile_creation: 2 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com', network: 'yellow_dot' },
    });

    expect(reply.statusCode).toBe(200);
    expect(leafFor(queries[3].where, 'cr.network')).toEqual({
      op: 'eq',
      a: 'cr.network',
      b: 'yellow_dot',
    });
  });

  // --- #692 review: the discriminators fed to the version comparison ---

  it('resolves the u18 document set for a minor (aggregator reads one)', async () => {
    // A ward's rows are written with `variant: 'u18'` against `u18_documents`,
    // which carries its own per-category counter. The aggregator that onboarded
    // them is exempt from the U18 rejection, so it DOES reach the comparison —
    // resolving the adult counter here would report a guardian-completed ward
    // as un-consented the moment the two sets diverge.
    queueRead({
      age: 15,
      userConsentRows: [
        { category: 'terms', version: 7 },
        { category: 'privacy', version: 7 },
      ],
    });
    // adult terms=2, u18 terms=7 — divergent on purpose.
    consentVersionState.current = {
      'terms|u18|': 7,
      'privacy|u18|': 7,
      'terms|adult|': 2,
      'privacy|adult|': 2,
    };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, true, true),
    );
    expect(
      consentVersionState.calls.every((c) => c.variant === 'u18'),
    ).toBe(true);
  });

  it('treats age 18 as a minor, matching isMinor (age <= 18)', async () => {
    // The boundary the old mock inverted. 18 is u18 by the real rule.
    queueRead({ age: 18, userConsentRows: [{ category: 'terms', version: 1 }] });
    consentVersionState.current = { terms: 1, privacy: 1 };

    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(consentVersionState.calls.every((c) => c.variant === 'u18')).toBe(true);
  });

  it('resolves the adult set when no age is on file', async () => {
    queueRead({ age: null, userConsentRows: [{ category: 'terms', version: 1 }] });
    consentVersionState.current = { terms: 1, privacy: 1 };

    await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect(consentVersionState.calls.every((c) => c.variant === 'adult')).toBe(true);
  });

  it("compares each row against its OWN brand's current version", async () => {
    // The false-positive direction the review flagged: the network default
    // bumps to 2 while brand `upsdm` stays at 1. A row accepted under upsdm at
    // v1 is still current FOR UPSDM and must read true; resolving only the
    // default would have compared it against 2 and reported a false false —
    // and the inverse (brand bumped, default not) a false TRUE.
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);
    rowQueue.push([]);
    rowQueue.push([
      { category: 'terms', version: 1, brand: 'upsdm' },
      { category: 'privacy', version: 2, brand: null },
    ]);
    consentVersionState.current = {
      'terms|adult|upsdm': 1,
      'terms|adult|': 2,
      'privacy|adult|': 2,
    };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(true, true, true),
    );
    expect(
      consentVersionState.calls.some((c) => c.brand === 'upsdm'),
    ).toBe(true);
  });

  it("reports false when the row's brand has moved on", async () => {
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);
    rowQueue.push([]);
    rowQueue.push([{ category: 'terms', version: 1, brand: 'upsdm' }]);
    consentVersionState.current = { 'terms|adult|upsdm': 2, 'privacy|adult|': 1 };

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com' },
    });

    expect((reply.body as { compliance: unknown }).compliance).toEqual(
      compliance(false, false, true),
    );
  });

  it('400s NETWORK_NOT_SERVED for a network this instance does not serve', async () => {
    // A typo (`blue-dot`) used to return 200 with every flag false — a confident
    // "not consented" for a network we know nothing about, which for a voice
    // channel means re-collecting consent the participant already gave.
    rowQueue.push(onboarded);
    rowQueue.push([{ age: 30 }]);

    const reply = await call(participant_read_handler, {
      acting_org: AGG,
      query: { email: 'a@b.com', network: 'blue-dot' },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { error: string }).error).toBe('NETWORK_NOT_SERVED');
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
