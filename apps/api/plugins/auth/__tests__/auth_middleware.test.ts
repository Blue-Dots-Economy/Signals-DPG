import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `auth_middleware` has exactly four dependencies: the better-auth instance
// (api-key verification + session read), `authConfig` (the kill switch), the
// drizzle db (api-key owner lookup) and the `user` table object.
const {
  verifyApiKey,
  getSession,
  authConfigState,
  dbState,
  rowQueue,
  whereConds,
  limitArgs,
} = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyApiKey: vi.fn((_args: any): Promise<any> => Promise.resolve({})),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSession: vi.fn((_args: any): Promise<any> => Promise.resolve(null)),
  authConfigState: { middleware_enabled: true, keycloak_enabled: false },
  // Set `failWith` to make the next query reject, without monkey-patching the
  // row queue (an override there leaks into every later test in the file).
  dbState: { failWith: null as Error | null },
  rowQueue: [] as unknown[][],
  whereConds: [] as unknown[],
  limitArgs: [] as number[],
}));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

vi.mock('@api/src/routes/auth/create_auth', () => ({
  authInstance: {
    api: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyApiKey: (a: any) => verifyApiKey(a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getSession: (a: any) => getSession(a),
    },
  },
}));

// authConfig drives the middleware; keycloakConfig/databasesConfig are only
// imported by the (dormant) Keycloak path — resolveKeycloakSession short-circuits
// to a better-auth fallthrough while `keycloak_enabled` is false, so empty
// shapes suffice here.
vi.mock('@api/src/config', () => ({
  authConfig: authConfigState,
  keycloakConfig: {},
  databasesConfig: {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          whereConds.push(cond);
          // A thenable so an awaited `.where(...)` works too. BOTH callbacks
          // must be forwarded — dropping `rej` makes a rejected query hang the
          // await until the test timeout.
          return {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              nextRows().then(res, rej),
            limit: (n: number) => {
              limitArgs.push(n);
              return nextRows();
            },
          };
        },
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema/auth', () => ({
  user: {
    id: 'user.id',
    email: 'user.email',
    name: 'user.name',
    role: 'user.role',
  },
}));

// These tests exercise the better-auth path (apikey + session). The Keycloak
// branch has its own coverage in `resolve_session.test.ts`, so stub it to always
// fall through — this also keeps the whole Keycloak graph (provisioning,
// service_account, redis) out of this suite.
vi.mock('../resolve_session', () => ({
  resolveKeycloakSession: vi.fn(async () => ({ ok: false, fallthrough: true })),
  sendAuthFailure: (reply: { status(c: number): unknown }, failure: { status: number }) =>
    reply.status(failure.status),
}));

/**
 * Stubbed for the same reason as `resolve_session` above, and it was missing:
 * without it this suite imported the real cookie channel, which reaches the
 * session store and constructs an ioredis client against 127.0.0.1:6379 — the
 * exact thing the comment above says the suite keeps out.
 *
 * What is asserted through it here is ORDERING, which only this file can see:
 * that the cookie channel runs after the api key and before the bearer path,
 * and that each of its three outcomes routes correctly. The contents of those
 * outcomes — the CSRF comparison, the refresh classification — belong to
 * `resolve_browser_session.test.ts` and are asserted there against the real
 * implementation.
 */
const resolveBrowserSession = vi.fn(async () => ({ ok: false, fallthrough: true }) as unknown);
vi.mock('../resolve_browser_session', () => ({
  resolveBrowserSession: (...a: unknown[]) => resolveBrowserSession(...(a as [])),
  SESSION_COOKIE: 'sid',
  CSRF_HEADER: 'x-csrf-token',
  clearSessionCookie: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

import { resolveKeycloakSession } from '../resolve_session';
import {
  auth_middleware,
  auth_middleware_if_enabled,
} from '../auth_middleware';

// --- fakes -----------------------------------------------------------------

interface FakeReply {
  statusCode: number;
  body: unknown;
  sendCount: number;
  status(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    sendCount: 0,
    status(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      this.sendCount += 1;
      return this;
    },
  };
}

type FakeRequest = {
  headers: Record<string, string | string[] | undefined>;
  permissions?: Record<string, string[]>;
  user?: unknown;
};

function makeRequest(over: Partial<FakeRequest> = {}): FakeRequest {
  return { headers: {}, ...over };
}

async function run(
  middleware: typeof auth_middleware,
  request: FakeRequest,
): Promise<FakeReply> {
  const reply = makeReply();
  await middleware(
    request as unknown as Parameters<typeof auth_middleware>[0],
    reply as unknown as Parameters<typeof auth_middleware>[1],
  );
  return reply;
}

function bodyOf(reply: FakeReply) {
  return reply.body as { code: string; error: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  rowQueue.length = 0;
  whereConds.length = 0;
  limitArgs.length = 0;
  dbState.failWith = null;
  authConfigState.middleware_enabled = true;
  getSession.mockResolvedValue(null);
  verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
  resolveBrowserSession.mockResolvedValue({ ok: false, fallthrough: true });
});

// ---------------------------------------------------------------------------
// Cookie path (after the api key, before the bearer)
// ---------------------------------------------------------------------------

describe('browser session cookie', () => {
  const CSRF_FAILURE = {
    status: 403,
    code: 'CSRF_TOKEN_INVALID',
    error: 'Forbidden',
    message: 'Missing or invalid CSRF token',
  };

  it('stops on a resolved cookie session without consulting the bearer path', async () => {
    resolveBrowserSession.mockResolvedValue({ ok: true });

    const reply = await run(auth_middleware, makeRequest());

    expect(reply.statusCode).toBe(0);
    expect(resolveKeycloakSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('fails the request on a CSRF failure rather than falling through', async () => {
    // Falling through here would let an unsafe cross-site request keep looking
    // for another channel to accept it.
    resolveBrowserSession.mockResolvedValue({ ok: false, failure: CSRF_FAILURE });

    const reply = await run(auth_middleware, makeRequest());

    expect(reply.statusCode).toBe(403);
    expect(resolveKeycloakSession).not.toHaveBeenCalled();
  });

  it('falls through to the bearer path when no cookie was sent', async () => {
    const reply = await run(auth_middleware, makeRequest());

    // Reaching the later channels IS the fallthrough. With no bearer and no
    // better-auth session either, the request ends unauthenticated — which is
    // the point: the cookie channel declined rather than answering.
    expect(resolveKeycloakSession).toHaveBeenCalled();
    expect(reply.statusCode).toBe(401);
  });

  it('is not consulted at all when an api key is present', async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key: { userId: 'u1' } });
    rowQueue.push([{ id: 'u1', email: 'a@b.com', name: 'Ada', role: 'user' }]);

    await run(auth_middleware, makeRequest({ headers: { 'x-api-key': 'k' } }));

    expect(resolveBrowserSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API key path (highest priority)
// ---------------------------------------------------------------------------

describe('auth_middleware — api-key path', () => {
  it('hydrates request.user from the key owner row and does not reply', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    rowQueue.push([
      { id: 'u1', email: 'a@b.com', name: 'Ada', role: 'user' },
    ]);
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    const reply = await run(auth_middleware, request);

    expect(reply.sendCount).toBe(0);
    expect(reply.statusCode).toBe(0);
    expect(request.user).toEqual({
      id: 'u1',
      email: 'a@b.com',
      name: 'Ada',
      role: 'user',
    });
    // Owner lookup is keyed on the resolved user id, and bounded to one row.
    expect(whereConds[0]).toEqual({ op: 'eq', col: 'user.id', val: 'u1' });
    expect(limitArgs).toEqual([1]);
  });

  it('never falls back to the session when the key is present', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    rowQueue.push([{ id: 'u1', email: 'a@b.com', name: 'Ada', role: 'user' }]);

    await run(
      auth_middleware,
      makeRequest({ headers: { 'x-api-key': 'k-live', cookie: 'session=xyz' } }),
    );

    expect(getSession).not.toHaveBeenCalled();
  });

  it('forwards request.permissions to verifyApiKey', async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key: null });

    await run(
      auth_middleware,
      makeRequest({
        headers: { 'x-api-key': 'k-live' },
        permissions: { item: ['create'] },
      }),
    );

    expect(verifyApiKey).toHaveBeenCalledWith({
      body: { key: 'k-live', permissions: { item: ['create'] } },
    });
  });

  it('sends permissions as undefined when the route declares none', async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key: null });

    await run(
      auth_middleware,
      makeRequest({ headers: { 'x-api-key': 'k-live' } }),
    );

    expect(verifyApiKey).toHaveBeenCalledWith({
      body: { key: 'k-live', permissions: undefined },
    });
  });

  it('falls back to key.referenceId when userId is absent', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: null, referenceId: 'ref-9' },
    });
    rowQueue.push([{ id: 'ref-9', email: 'r@b.com', name: 'Ref', role: null }]);
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    await run(auth_middleware, request);

    expect(whereConds[0]).toEqual({ op: 'eq', col: 'user.id', val: 'ref-9' });
    expect(request.user).toEqual({
      id: 'ref-9',
      email: 'r@b.com',
      name: 'Ref',
      role: null,
    });
  });

  it('normalises a null owner email to an empty string', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    rowQueue.push([{ id: 'u1', email: null, name: 'Ada', role: 'user' }]);
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    await run(auth_middleware, request);

    expect(request.user).toEqual({
      id: 'u1',
      email: '',
      name: 'Ada',
      role: 'user',
    });
  });

  it('still authenticates with only the id when the owner row is missing', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'ghost' },
    });
    rowQueue.push([]); // owner row deleted / not found
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    const reply = await run(auth_middleware, request);

    expect(reply.sendCount).toBe(0);
    expect(request.user).toEqual({ id: 'ghost' });
  });

  it('leaves request.user unset when the key has no owner id at all', async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key: {} });
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    const reply = await run(auth_middleware, request);

    expect(reply.sendCount).toBe(0);
    expect(request.user).toBeUndefined();
    // No owner lookup is attempted without an id.
    expect(whereConds).toHaveLength(0);
  });

  it('leaves request.user unset when verifyApiKey returns a null key', async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key: null });
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    await run(auth_middleware, request);

    expect(request.user).toBeUndefined();
    expect(whereConds).toHaveLength(0);
  });

  it('403 INVALID_API_KEY when the key is invalid', async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    const request = makeRequest({ headers: { 'x-api-key': 'bogus' } });

    const reply = await run(auth_middleware, request);

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).code).toBe('INVALID_API_KEY');
    // NOTE: the machine-readable code lives in `code`; `error` carries the
    // human/HTTP label, unlike the `{ error: '<CODE>' }` shape used by routes.
    expect(bodyOf(reply).error).toBe('Forbidden');
    expect(bodyOf(reply).message).toBe('Invalid API key provided');
    expect(request.user).toBeUndefined();
  });

  it('403 INVALID_API_KEY when verifyApiKey reports an error, even if valid', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: { message: 'key expired' },
      key: { userId: 'u1' },
    });

    const reply = await run(
      auth_middleware,
      makeRequest({ headers: { 'x-api-key': 'expired' } }),
    );

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).code).toBe('INVALID_API_KEY');
    expect(whereConds).toHaveLength(0);
  });

  it('403s a bad key WITHOUT falling back to a valid session', async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    getSession.mockResolvedValue({ user: { id: 'session-user' } });
    const request = makeRequest({
      headers: { 'x-api-key': 'bogus', cookie: 'session=valid' },
    });

    const reply = await run(auth_middleware, request);

    expect(reply.statusCode).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('treats a duplicated (array) x-api-key header as absent and uses the session', async () => {
    getSession.mockResolvedValue({ user: { id: 'session-user' } });
    const request = makeRequest({
      headers: { 'x-api-key': ['k1', 'k2'] },
    });

    const reply = await run(auth_middleware, request);

    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
    expect(reply.sendCount).toBe(0);
    expect(request.user).toEqual({ id: 'session-user' });
  });

  it('treats an empty-string x-api-key as a key attempt and 403s', async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });

    const reply = await run(
      auth_middleware,
      makeRequest({ headers: { 'x-api-key': '' } }),
    );

    expect(verifyApiKey).toHaveBeenCalledWith({
      body: { key: '', permissions: undefined },
    });
    expect(reply.statusCode).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('propagates an owner-lookup failure instead of replying (no try/catch)', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    dbState.failWith = new Error('db down');

    await expect(
      run(auth_middleware, makeRequest({ headers: { 'x-api-key': 'k' } })),
    ).rejects.toThrow('db down');
  });

  it('propagates a verifyApiKey rejection instead of replying', async () => {
    verifyApiKey.mockRejectedValue(new Error('auth service down'));

    await expect(
      run(auth_middleware, makeRequest({ headers: { 'x-api-key': 'k' } })),
    ).rejects.toThrow('auth service down');
  });
});

// ---------------------------------------------------------------------------
// Session path (fallback)
// ---------------------------------------------------------------------------

describe('auth_middleware — session path', () => {
  it('sets request.user from the session and does not reply', async () => {
    const sessionUser = { id: 'u2', email: 'x@y.com', name: 'Sess' };
    getSession.mockResolvedValue({ user: sessionUser });
    const request = makeRequest({ headers: { cookie: 'session=abc' } });

    const reply = await run(auth_middleware, request);

    expect(reply.sendCount).toBe(0);
    expect(request.user).toBe(sessionUser);
  });

  it('forwards the request headers to getSession as a Headers object', async () => {
    getSession.mockResolvedValue({ user: { id: 'u2' } });

    await run(
      auth_middleware,
      makeRequest({ headers: { cookie: 'session=abc', 'x-trace': 't1' } }),
    );

    const arg = getSession.mock.calls[0][0] as { headers: Headers };
    expect(arg.headers).toBeInstanceOf(Headers);
    expect(arg.headers.get('cookie')).toBe('session=abc');
    expect(arg.headers.get('x-trace')).toBe('t1');
  });

  it('401 UNAUTHORIZED when there is no session', async () => {
    getSession.mockResolvedValue(null);
    const request = makeRequest({ headers: {} });

    const reply = await run(auth_middleware, request);

    expect(reply.statusCode).toBe(401);
    expect(bodyOf(reply).code).toBe('UNAUTHORIZED');
    expect(bodyOf(reply).error).toBe('Unauthorized');
    expect(bodyOf(reply).message).toBe('Missing or invalid authentication');
    expect(request.user).toBeUndefined();
  });

  it('401 UNAUTHORIZED when the session carries no user', async () => {
    getSession.mockResolvedValue({ session: { id: 's1' } });

    const reply = await run(auth_middleware, makeRequest());

    expect(reply.statusCode).toBe(401);
    expect(bodyOf(reply).code).toBe('UNAUTHORIZED');
  });

  it('never consults the api-key path when no key header is present', async () => {
    getSession.mockResolvedValue({ user: { id: 'u2' } });

    await run(auth_middleware, makeRequest());

    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Idempotency — routes under a group hook run this twice by design.
// ---------------------------------------------------------------------------

describe('auth_middleware — idempotency (called twice per request by design)', () => {
  it('is idempotent on the api-key path', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    const row = { id: 'u1', email: 'a@b.com', name: 'Ada', role: 'admin' };
    rowQueue.push([row], [row]);
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    const first = await run(auth_middleware, request);
    const afterFirst = request.user;
    const second = await run(auth_middleware, request);

    expect(first.sendCount).toBe(0);
    expect(second.sendCount).toBe(0);
    expect(request.user).toEqual(afterFirst);
    expect(request.user).toEqual({
      id: 'u1',
      email: 'a@b.com',
      name: 'Ada',
      role: 'admin',
    });
    expect(verifyApiKey).toHaveBeenCalledTimes(2);
  });

  it('is idempotent on the session path', async () => {
    getSession.mockResolvedValue({ user: { id: 'u2', email: 'x@y.com' } });
    const request = makeRequest({ headers: { cookie: 'session=abc' } });

    await run(auth_middleware, request);
    const afterFirst = request.user;
    const second = await run(auth_middleware, request);

    expect(second.sendCount).toBe(0);
    expect(request.user).toEqual(afterFirst);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('an already-authenticated request is still re-verified (no short-circuit)', async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    const request = makeRequest({
      headers: { 'x-api-key': 'revoked' },
      user: { id: 'u1' },
    });

    const reply = await run(auth_middleware, request);

    expect(reply.statusCode).toBe(403);
    expect(verifyApiKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('auth_middleware_if_enabled', () => {
  it('short-circuits with no auth work when the middleware is disabled', async () => {
    authConfigState.middleware_enabled = false;
    const request = makeRequest({ headers: { 'x-api-key': 'bogus' } });

    const reply = await run(auth_middleware_if_enabled, request);

    expect(reply.sendCount).toBe(0);
    expect(reply.statusCode).toBe(0);
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('does not 401 an anonymous request when disabled', async () => {
    authConfigState.middleware_enabled = false;

    const reply = await run(auth_middleware_if_enabled, makeRequest());

    expect(reply.sendCount).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('delegates to auth_middleware when enabled (api-key path)', async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      error: null,
      key: { userId: 'u1' },
    });
    rowQueue.push([{ id: 'u1', email: 'a@b.com', name: 'Ada', role: 'user' }]);
    const request = makeRequest({ headers: { 'x-api-key': 'k-live' } });

    const reply = await run(auth_middleware_if_enabled, request);

    expect(reply.sendCount).toBe(0);
    expect(request.user).toEqual({
      id: 'u1',
      email: 'a@b.com',
      name: 'Ada',
      role: 'user',
    });
  });

  it('propagates the 403 from an invalid key when enabled', async () => {
    verifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });

    const reply = await run(
      auth_middleware_if_enabled,
      makeRequest({ headers: { 'x-api-key': 'bogus' } }),
    );

    expect(reply.statusCode).toBe(403);
    expect(bodyOf(reply).code).toBe('INVALID_API_KEY');
  });

  it('propagates the 401 from a missing session when enabled', async () => {
    getSession.mockResolvedValue(null);

    const reply = await run(auth_middleware_if_enabled, makeRequest());

    expect(reply.statusCode).toBe(401);
    expect(bodyOf(reply).code).toBe('UNAUTHORIZED');
  });
});
