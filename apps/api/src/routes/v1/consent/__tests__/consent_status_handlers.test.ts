import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// One shared FIFO of result sets; each drizzle chain shifts the next entry.
// `get_consent_status_by_identifier` runs TWO queries (user lookup, then the
// consent read), so ordering in the queue matters for those tests.
const { rowQueue, getWardAge, dbState } = vi.hoisted(() => ({
  rowQueue: [] as unknown[][],
  getWardAge: vi.fn(),
  // Set `failWith` to make the next query reject, without monkey-patching the
  // queue (an override there leaks into every later test in the file).
  dbState: { failWith: null as Error | null },
}));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // A thenable, because some handlers await `.where(...)` directly
          // while others chain `.limit()`. BOTH callbacks must be forwarded —
          // dropping `rej` makes a rejected query hang the await forever.
          const result = {
            then: (
              res: (v: unknown) => unknown,
              rej?: (e: unknown) => unknown,
            ) => nextRows().then(res, rej),
            limit: () => nextRows(),
          };
          return result;
        },
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: {
    userId: 'cr.userId',
    level: 'cr.level',
    network: 'cr.network',
    consentCategory: 'cr.consentCategory',
    documentVersion: 'cr.documentVersion',
    itemId: 'cr.itemId',
    source: 'cr.source',
  },
  user: { id: 'user.id', email: 'user.email', phoneNumber: 'user.phoneNumber' },
}));

vi.mock('@api/db/postgres/schema/auth', () => ({
  user: { id: 'user.id', email: 'user.email', phoneNumber: 'user.phoneNumber' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/schemas', () => ({
  default: { object: () => ({}), string: () => ({ min: () => ({}) }) },
  ConsentStatusQuerySchema: {},
  ConsentStatusResponseSchema: {},
  ProfileConsentStatusResponseSchema: {},
}));

vi.mock('@/services/minor_guardian_repo', () => ({
  getWardAge: (...a: unknown[]) => getWardAge(...a),
}));

vi.mock('@/services/minor', () => ({ isMinor: (age: number) => age < 18 }));

// Per-IP rate limit on the by-identifier enumeration endpoint. Default under
// the cap; a test overrides `rlState.count` to exercise the 429.
const { rlState } = vi.hoisted(() => ({
  rlState: { count: 1, throw: false },
}));
vi.mock('@/utils/rate_window', () => ({
  incrWithinWindow: vi.fn(async () => {
    if (rlState.throw) throw new Error('redis down');
    return rlState.count;
  }),
}));

import { get_consent_status_handler } from '../get_consent_status';
import { get_profile_consent_status_handler } from '../get_profile_consent_status';
import { get_consent_status_by_identifier_handler } from '../get_consent_status_by_identifier';

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

const log = { error: vi.fn(), warn: vi.fn() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(handler: any, req: Record<string, unknown>) {
  const reply = makeReply();
  return handler({ log, ...req }, reply).then(() => reply);
}

beforeEach(() => {
  rowQueue.length = 0;
  dbState.failWith = null;
  rlState.count = 1;
  rlState.throw = false;
  vi.clearAllMocks();
});

describe('get_consent_status_handler', () => {
  it('401 when unauthenticated', async () => {
    const reply = await call(get_consent_status_handler, {
      user: undefined,
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
  });

  it('groups accepted versions by category', async () => {
    rowQueue.push([
      { consentCategory: 'terms', documentVersion: 1 },
      { consentCategory: 'privacy', documentVersion: 2 },
    ]);

    const reply = await call(get_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ statuses: { terms: [1], privacy: [2] } });
  });

  it('returns empty version lists when nothing is accepted', async () => {
    rowQueue.push([]);

    const reply = await call(get_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.body).toEqual({ statuses: { terms: [], privacy: [] } });
  });

  it('de-duplicates and sorts versions ascending (append-only ledger)', async () => {
    rowQueue.push([
      { consentCategory: 'terms', documentVersion: 3 },
      { consentCategory: 'terms', documentVersion: 1 },
      { consentCategory: 'terms', documentVersion: 3 },
      { consentCategory: 'terms', documentVersion: 2 },
    ]);

    const reply = await call(get_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect((reply.body as { statuses: { terms: number[] } }).statuses.terms)
      .toEqual([1, 2, 3]);
  });

  it('ignores categories outside terms/privacy', async () => {
    rowQueue.push([
      { consentCategory: 'terms', documentVersion: 1 },
      { consentCategory: 'profile_creation', documentVersion: 9 },
    ]);

    const reply = await call(get_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.body).toEqual({ statuses: { terms: [1], privacy: [] } });
  });

  it('500 CONSENT_READ_FAILED when the read throws', async () => {
    dbState.failWith = new Error('db down');

    const reply = await call(get_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('CONSENT_READ_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('get_profile_consent_status_handler', () => {
  it('401 when unauthenticated', async () => {
    const reply = await call(get_profile_consent_status_handler, {
      user: undefined,
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(401);
  });

  it('returns the distinct consented item ids for an adult', async () => {
    getWardAge.mockResolvedValue(25);
    rowQueue.push([{ itemId: 'i1' }, { itemId: 'i2' }, { itemId: 'i1' }]);

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ consented_item_ids: ['i1', 'i2'] });
  });

  it('treats a user with no stored age as an adult', async () => {
    getWardAge.mockResolvedValue(null);
    rowQueue.push([{ itemId: 'i1' }]);

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.body).toEqual({ consented_item_ids: ['i1'] });
  });

  it('for a MINOR, only guardian-sourced consent counts (D13)', async () => {
    // The self row create_item writes at create time must NOT satisfy the
    // gate; the handler adds a source='guardian' condition for minors, so the
    // filtered query is what we assert against.
    getWardAge.mockResolvedValue(15);
    rowQueue.push([{ itemId: 'guardian-confirmed' }]);

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(getWardAge).toHaveBeenCalledWith('u1');
    expect(reply.body).toEqual({
      consented_item_ids: ['guardian-confirmed'],
    });
  });

  it('a minor with no guardian-sourced row yet gets an empty list', async () => {
    getWardAge.mockResolvedValue(15);
    rowQueue.push([]);

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.body).toEqual({ consented_item_ids: [] });
  });

  it('skips rows with a null itemId', async () => {
    getWardAge.mockResolvedValue(30);
    rowQueue.push([{ itemId: null }, { itemId: 'i1' }]);

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.body).toEqual({ consented_item_ids: ['i1'] });
  });

  it('500 CONSENT_READ_FAILED when the age lookup throws', async () => {
    getWardAge.mockRejectedValue(new Error('db down'));

    const reply = await call(get_profile_consent_status_handler, {
      user: { id: 'u1' },
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('CONSENT_READ_FAILED');
  });
});

describe('get_consent_status_by_identifier_handler', () => {
  // This route is deliberately unauthenticated (pre-login), and an unknown
  // user is NOT an error — it means a new user who still needs consent.

  it('returns empty statuses when neither phone nor email is supplied', async () => {
    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ statuses: { terms: [], privacy: [] } });
  });

  it('returns empty statuses for an unknown identifier rather than 404', async () => {
    rowQueue.push([]); // user lookup finds nobody

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', email: 'nobody@example.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ statuses: { terms: [], privacy: [] } });
  });

  it('resolves by email and returns that user consent versions', async () => {
    rowQueue.push([{ id: 'u1' }]); // user lookup
    rowQueue.push([
      { consentCategory: 'terms', documentVersion: 2 },
      { consentCategory: 'privacy', documentVersion: 2 },
    ]);

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ statuses: { terms: [2], privacy: [2] } });
  });

  it('resolves by phone alone', async () => {
    rowQueue.push([{ id: 'u1' }]);
    rowQueue.push([{ consentCategory: 'terms', documentVersion: 1 }]);

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', phone: '9990001111' },
    });

    expect(reply.body).toEqual({ statuses: { terms: [1], privacy: [] } });
  });

  it('500 CONSENT_READ_FAILED when the lookup throws', async () => {
    dbState.failWith = new Error('db down');

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(500);
    expect((reply.body as { error: string }).error).toBe('CONSENT_READ_FAILED');
  });

  it('429 CONSENT_RATE_LIMITED once the per-IP window cap is exceeded', async () => {
    rlState.count = 31; // over CONSENT_RL_MAX_PER_WINDOW (30)

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', email: 'a@b.com' },
      ip: '203.0.113.9',
    });

    expect(reply.statusCode).toBe(429);
    expect((reply.body as { error: string }).error).toBe('CONSENT_RATE_LIMITED');
  });

  it('fails open (serves the request) when the rate-limit backend is unavailable', async () => {
    rlState.throw = true;
    rowQueue.push([]); // user lookup finds nobody

    const reply = await call(get_consent_status_by_identifier_handler, {
      query: { network: 'blue_dot', email: 'a@b.com' },
      ip: '203.0.113.9',
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ statuses: { terms: [], privacy: [] } });
  });
});
