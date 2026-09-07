import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `user_domains` only exports the plugin, so the handlers are reached by
// registering the plugin against a fake fastify and pulling the routes back
// out. Both handlers run one SELECT; the POST handler then runs an UPDATE.
const { rowQueue, updates, executes, dbState, auth_middleware_if_enabled } = vi.hoisted(() => ({
  rowQueue: [] as unknown[][],
  updates: [] as { table: unknown; values: unknown; where: unknown }[],
  executes: [] as unknown[],
  // Resettable failure flag — never monkey-patch the shared row queue, an
  // override there leaks into every later test in the file.
  dbState: {
    failWith: null as Error | null,
    /** What the write-once claim UPDATE returns. Non-empty `rows` = the account
     * had no domain AND owned no items, so this call claimed it. `{ rows: [] }`
     * = declined, which sends the handler on to `readLockedDomains`. */
    claim: { rows: [{ id: 'u1' }] } as { rows: Array<{ id: string }> },
    /** `readLockedDomains`' column read (`SELECT domains FROM "user"`). */
    heldColumn: { rows: [] } as { rows: Array<{ domains: string[] | null }> },
    /** `readLockedDomains`' items fallback, reached only when the column is
     * empty. This is the path a legacy row (blank column, existing items)
     * takes. */
    heldItems: { rows: [] } as { rows: Array<{ item_domain: string }> },
  },
  // Params declared so the spread-through in the vi.mock factory below
  // typechecks; vi.fn(async () => {}) infers a zero-arg signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: vi.fn(async (..._a: any[]) => {}),
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
          // A thenable so both `await .where(...)` and `.limit()` work. BOTH
          // callbacks must be forwarded — dropping `rej` makes a rejected
          // query hang the await forever.
          const result = {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              nextRows().then(res, rej),
            limit: () => nextRows(),
          };
          return result;
        },
      }),
    }),
    execute: (q: unknown) => {
      if (dbState.failWith) return Promise.reject(dbState.failWith);
      executes.push(q);
      // Routed by statement so each of the lock's three queries is separately
      // drivable. Discriminate the items fallback on `SELECT DISTINCT`, not on
      // `FROM items` — the claim's own `NOT EXISTS (SELECT 1 FROM items …)`
      // guard matches the looser pattern.
      const text = (q as { text?: string }).text ?? '';
      if (text.includes('SELECT DISTINCT item_domain')) {
        return Promise.resolve(dbState.heldItems);
      }
      if (text.includes('SELECT domains FROM')) {
        return Promise.resolve(dbState.heldColumn);
      }
      return Promise.resolve(dbState.claim);
    },
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (where: unknown) => {
          if (dbState.failWith) return Promise.reject(dbState.failWith);
          updates.push({ table, values, where });
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  user: { id: 'user.id', domains: 'user.domains', updatedAt: 'user.updatedAt' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: (...a: any[]) => auth_middleware_if_enabled(...a),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

vi.mock('@dpg/schemas', () => {
  const leaf = { min: () => leaf, max: () => leaf };
  return {
    default: {
      object: (shape: unknown) => ({ shape }),
      array: () => leaf,
      string: () => leaf,
    },
  };
});

// SS-3 (#640): the route now tags the user from the binding's default
// aggregator once their domain is decided. Mocked so this stays a unit test —
// the real module reaches served_domain_guard → network config.
const tagUserForDomain = vi.fn(async () => null);
vi.mock('@/services/aggregator/default_aggregator', () => ({
  tagUserForDomain: (...args: unknown[]) => tagUserForDomain(...(args as [])),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    served_domains: [{ domain: 'student' }, { domain: 'mentor' }],
  },
}));

import { user_domains } from '../user_domains';

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

interface FakeRoute {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preHandler?: (...a: any[]) => unknown;
  schema?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
}

const routes: FakeRoute[] = [];

async function loadRoutes() {
  routes.length = 0;
  const fakeFastify = {
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await user_domains(fakeFastify as any, {} as any);
}

function routeFor(method: string): FakeRoute {
  const found = routes.find((r) => r.method === method);
  if (!found) throw new Error(`no ${method} /domains route registered`);
  return found;
}

const log = { error: vi.fn() };

function call(method: string, req: Record<string, unknown>) {
  const reply = makeReply();
  return routeFor(method)
    .handler({ log, ...req }, reply)
    .then(() => reply);
}

beforeEach(async () => {
  rowQueue.length = 0;
  updates.length = 0;
  executes.length = 0;
  dbState.failWith = null;
  // Default: the user had no domain and this call claims it. Tests that need
  // the already-locked path set `{ rows: [] }` themselves.
  dbState.claim = { rows: [{ id: 'u1' }] };
  dbState.heldColumn = { rows: [] };
  dbState.heldItems = { rows: [] };
  vi.clearAllMocks();
  await loadRoutes();
});

describe('user_domains plugin registration', () => {
  it('registers GET and POST /domains, both behind auth', async () => {
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /domains',
      'POST /domains',
    ]);
    for (const route of routes) {
      // The preHandler must be wired per-route: this group file has no
      // group-level auth hook, so a missing preHandler means unauthenticated.
      expect(typeof route.preHandler).toBe('function');
      expect(route.schema?.tags).toEqual(['user']);
    }
  });

  it('the registered preHandler is the shared auth middleware', async () => {
    await routeFor('GET').preHandler?.({}, {});
    expect(auth_middleware_if_enabled).toHaveBeenCalledTimes(1);
  });

  it('only the POST route declares a request body schema', async () => {
    expect(routeFor('GET').schema?.body).toBeUndefined();
    expect(routeFor('POST').schema?.body).toBeDefined();
  });
});

describe('GET /domains', () => {
  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const reply = await call('GET', { user: undefined });

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  });

  it('returns the stored domains for the current user', async () => {
    rowQueue.push([{ domains: ['student', 'mentor'] }]);

    const reply = await call('GET', { user: { id: 'u1' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student', 'mentor'] });
  });

  it('returns an empty array when the column is null', async () => {
    rowQueue.push([{ domains: null }]);

    const reply = await call('GET', { user: { id: 'u1' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: [] });
  });

  it('returns an empty array when no user row is found', async () => {
    rowQueue.push([]);

    const reply = await call('GET', { user: { id: 'ghost' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: [] });
  });

  it('propagates a failing read (the route has no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(call('GET', { user: { id: 'u1' } })).rejects.toThrow('db down');
  });
});

describe('POST /domains', () => {
  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const reply = await call('POST', { user: undefined, body: { domains: ['student'] } });

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(updates).toHaveLength(0);
  });

  it('400 UNSERVED_DOMAIN for a domain this instance does not serve', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['martian'] },
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'UNSERVED_DOMAIN',
      message: 'Not served: martian',
    });
    // Nothing may be written — an arbitrary string would poison the picker.
    expect(updates).toHaveLength(0);
  });

  it('lists every unserved domain and rejects the whole request', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student', 'martian', 'venusian'] },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { message: string }).message).toBe('Not served: martian, venusian');
    expect(updates).toHaveLength(0);
  });

  // WRITE-ONCE (was: union). Unioning let any authenticated user grant
  // themselves a second domain and walk past `assertSingleDomain`, which reads
  // this column — and a two-domain account is exactly what lets one domain's
  // default aggregator decrypt the other's participant.
  it('claims the domain when the user has none', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student'] });
    // Claimed by the guarded UPDATE, so no follow-up read was needed.
    expect(executes).toHaveLength(1);
    expect(rowQueue).toHaveLength(0);
  });

  it('the claim carries BOTH guards, scoped to the caller', async () => {
    await call('POST', { user: { id: 'u1' }, body: { domains: ['student'] } });

    const q = executes[0] as { text: string; values: unknown[] };
    // Write-once at the database level: no later call can re-point an existing
    // lock, and two concurrent calls picking different domains cannot both win.
    expect(q.text).toMatch(/domains IS NULL OR cardinality\(domains\) = 0/);
    // REGRESSION: this assertion was missing, and its absence is exactly what
    // shipped a route whose claim lacked the guard — the earlier version of
    // this test pinned the buggy statement. Without it, an account with an
    // empty column but existing items (every aggregator-onboarded participant
    // until 0015 runs) is handed a second domain here, and the create path then
    // trusts the non-empty column instead of reading `items`.
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM items WHERE created_by =/);
    expect(q.text).toMatch(/RETURNING id/);
    expect(q.values).toContain('student');
    expect(q.values).toContain('u1');
  });

  it('shares one implementation with the create path', async () => {
    // The two sites were copies of the same SQL and they drifted. Assert the
    // route emits the shared statement verbatim, so a change on one side cannot
    // silently leave the other behind.
    await call('POST', { user: { id: 'u1' }, body: { domains: ['student'] } });
    const routeSql = ((executes[0] as { text: string }).text ?? '').replace(/\s+/g, ' ').trim();

    expect(routeSql).toBe(
      'UPDATE "user" SET domains = ARRAY[?]::text[], updated_at = now() ' +
        'WHERE id = ? AND (domains IS NULL OR cardinality(domains) = 0) ' +
        'AND NOT EXISTS (SELECT 1 FROM items WHERE created_by = ?) RETURNING id',
    );
  });

  it('refuses a legacy account whose column is blank but whose items are elsewhere', async () => {
    // THE BUG. Blank column + a seeker item = the state of every aggregator- and
    // voice-onboarded participant before 0015, and of every account the
    // documented `SET domains='{}'` support reset touches. Two HTTP calls used
    // to turn it into a two-domain account with the wrong owner.
    dbState.claim = { rows: [] }; // NOT EXISTS items declines the claim
    dbState.heldColumn = { rows: [{ domains: [] }] };
    dbState.heldItems = { rows: [{ item_domain: 'student' }] };

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['mentor'] },
    });

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      error: 'DOMAIN_LOCKED',
      locked_domain: 'student',
      requested_domain: 'mentor',
    });
    expect(tagUserForDomain).not.toHaveBeenCalled();
  });

  it('lets that same legacy account re-confirm the domain it actually holds', async () => {
    dbState.claim = { rows: [] };
    dbState.heldColumn = { rows: [{ domains: [] }] };
    dbState.heldItems = { rows: [{ item_domain: 'student' }] };

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student'] });
  });

  it('is idempotent: re-posting the domain already stored returns 200', async () => {
    dbState.claim = { rows: [] }; // already set → claim writes nothing
    dbState.heldColumn = { rows: [{ domains: ['student'] }] };

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student'] });
  });

  it('403 DOMAIN_LOCKED when switching to a different domain', async () => {
    dbState.claim = { rows: [] };
    dbState.heldColumn = { rows: [{ domains: ['student'] }] };

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['mentor'] },
    });

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      error: 'DOMAIN_LOCKED',
      message: 'You are registered as "student" and cannot switch to "mentor".',
      locked_domain: 'student',
      requested_domain: 'mentor',
    });
    // Nothing was written, and no tagging ran for the domain it refused.
    expect(tagUserForDomain).not.toHaveBeenCalled();
  });

  it('does not tag the requested domain when it refuses the switch', async () => {
    // Regression guard: tagging on a refused switch would hand the user to the
    // WRONG binding's default aggregator while the lock says they are elsewhere.
    dbState.claim = { rows: [] };
    dbState.heldColumn = { rows: [{ domains: ['student'] }] };

    await call('POST', { user: { id: 'u1' }, body: { domains: ['mentor'] } });

    expect(tagUserForDomain).not.toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      'mentor',
    );
  });

  it('a missing user row is not reported as a domain lock', async () => {
    // Nothing to lock and nothing to grant — do not claim the user is
    // "registered as undefined".
    dbState.claim = { rows: [] };
    dbState.heldColumn = { rows: [] };

    const reply = await call('POST', {
      user: { id: 'gone' },
      body: { domains: ['student'] },
    });

    expect(reply.statusCode).toBe(200);
  });

  it('validates against served domains before touching the database', async () => {
    // The unserved check runs before the claim, so nothing is executed.
    await call('POST', { user: { id: 'u1' }, body: { domains: ['martian'] } });

    expect(executes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('propagates a failing write (the route has no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(
      call('POST', { user: { id: 'u1' }, body: { domains: ['student'] } }),
    ).rejects.toThrow('db down');
  });
});

describe('POST /user/domains — default-aggregator tagging (SS-3, #640)', () => {
  // The user's domain is decided here, so this is the user-level moment the
  // default aggregator can own them — not on every later profile write.
  it('tags the user for the domain it claims', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });
    expect(reply.statusCode).toBe(200);
    expect(tagUserForDomain).toHaveBeenCalledTimes(1);
    expect(tagUserForDomain).toHaveBeenCalledWith(expect.anything(), 'u1', 'student');
  });

  // A tagging failure must not fail the domain write the client is waiting on.
  it('still returns 200 when tagging throws', async () => {
    tagUserForDomain.mockRejectedValueOnce(new Error('boom'));
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });
    expect(reply.statusCode).toBe(200);
  });
});
