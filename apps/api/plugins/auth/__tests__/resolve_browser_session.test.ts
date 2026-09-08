import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The cookie auth channel that replaced the browser's bearer token
 * (AUTH-VULN-03/04).
 *
 * A cookie is attached by the browser automatically, which is the one way it is
 * WEAKER than the `Authorization` header it replaced — so the CSRF half of this
 * module is not a nicety, it is what makes the trade sound. Most of what is
 * pinned here is that check and the refresh path around it.
 */

// browser_session.ts is partially real (for safeEqual), which pulls in the
// redis client; stub it so importing the module does not need a server.
vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));

const readSession = vi.fn();
const updateSession = vi.fn();
const destroySession = vi.fn();
vi.mock('@/services/auth/browser_session', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/auth/browser_session')>(
    '../../../src/services/auth/browser_session',
  );
  return {
    readSession: (...a: unknown[]) => readSession(...a),
    updateSession: (...a: unknown[]) => updateSession(...a),
    destroySession: (...a: unknown[]) => destroySession(...a),
    // Real constant-time compare: stubbing the CSRF comparison would leave the
    // check asserted against a mock's idea of equality.
    safeEqual: actual.safeEqual,
  };
});

const refreshTokens = vi.fn();
vi.mock('@/services/auth/oidc_exchange', () => ({
  refreshTokens: (...a: unknown[]) => refreshTokens(...a),
  OidcExchangeError: class OidcExchangeError extends Error {},
}));

const verifyKeycloakToken = vi.fn();
vi.mock('@/utils/keycloak_token', () => ({
  verifyKeycloakToken: (...a: unknown[]) => verifyKeycloakToken(...a),
}));

const resolveHumanSession = vi.fn();
vi.mock('../resolve_session', () => ({
  resolveHumanSession: (...a: unknown[]) => resolveHumanSession(...a),
}));

const { resolveBrowserSession, SESSION_COOKIE, clearSessionCookie } = await import(
  '../resolve_browser_session.js'
);

const MINUTE = 60 * 1000;

const storedSession = (over: Record<string, unknown> = {}) => ({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessTokenExp: Date.now() + 5 * MINUTE,
  refreshTokenExp: Date.now() + 30 * MINUTE,
  csrfToken: 'the-csrf-token',
  appOrigin: 'http://localhost:3000',
  createdAt: Date.now(),
  ...over,
});

const makeRequest = (
  over: { cookie?: string; method?: string; csrf?: string } = {},
): FastifyRequest =>
  ({
    method: over.method ?? 'GET',
    url: '/api/v1/item',
    cookies: over.cookie === undefined ? {} : { [SESSION_COOKIE]: over.cookie },
    headers: over.csrf === undefined ? {} : { 'x-csrf-token': over.csrf },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }) as unknown as FastifyRequest;

const makeReply = () => ({ clearCookie: vi.fn() }) as unknown as FastifyReply;

beforeEach(() => {
  vi.clearAllMocks();
  readSession.mockResolvedValue(storedSession());
  verifyKeycloakToken.mockResolvedValue({ ok: true, claims: { sub: 'user-1' } });
  resolveHumanSession.mockResolvedValue({ ok: true });
  updateSession.mockImplementation(async (_id, patch) => ({ ...storedSession(), ...patch }));
});

describe('no cookie', () => {
  it('falls through so the service and anonymous paths still work', async () => {
    // Not an error: a request with no session is a service call or an
    // anonymous browse, and failing it here would break both.
    const result = await resolveBrowserSession(makeRequest(), makeReply());

    expect(result).toEqual({ ok: false, fallthrough: true });
    expect(readSession).not.toHaveBeenCalled();
  });
});

describe('cookie present but no session behind it', () => {
  it('clears the cookie and refuses, rather than leaving a dead credential in the browser', async () => {
    readSession.mockResolvedValue(null);
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    expect(reply.clearCookie).toHaveBeenCalled();
  });
});

describe('CSRF double-submit', () => {
  it('lets safe methods through without a token', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const result = await resolveBrowserSession(
        makeRequest({ cookie: 'sid-1', method }),
        makeReply(),
      );
      expect(result).toEqual({ ok: true });
    }
  });

  it('accepts a state-changing request that echoes the session token', async () => {
    const result = await resolveBrowserSession(
      makeRequest({ cookie: 'sid-1', method: 'POST', csrf: 'the-csrf-token' }),
      makeReply(),
    );

    expect(result).toEqual({ ok: true });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a %s with no CSRF token — the cross-site form case',
    async (method) => {
      // A cross-site page can cause the cookie to be sent, but cannot read
      // GET /auth/session to learn the token, so it cannot supply this header.
      const result = await resolveBrowserSession(
        makeRequest({ cookie: 'sid-1', method }),
        makeReply(),
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { status: 403, code: 'CSRF_TOKEN_INVALID' },
      });
    },
  );

  it('refuses a mismatched or empty token', async () => {
    for (const csrf of ['wrong-token', '']) {
      const result = await resolveBrowserSession(
        makeRequest({ cookie: 'sid-1', method: 'POST', csrf }),
        makeReply(),
      );
      expect(result).toMatchObject({ ok: false, failure: { code: 'CSRF_TOKEN_INVALID' } });
    }
  });

  it('does not verify the token or resolve a user on a CSRF failure', async () => {
    await resolveBrowserSession(
      makeRequest({ cookie: 'sid-1', method: 'POST' }),
      makeReply(),
    );

    expect(verifyKeycloakToken).not.toHaveBeenCalled();
    expect(resolveHumanSession).not.toHaveBeenCalled();
  });

  it('does not clear the cookie on a CSRF failure', async () => {
    // The session is fine; it is this request that is not. Logging the user out
    // would let any cross-site page sign them out at will.
    const reply = makeReply();

    await resolveBrowserSession(makeRequest({ cookie: 'sid-1', method: 'POST' }), reply);

    expect(reply.clearCookie).not.toHaveBeenCalled();
  });
});

describe('access-token refresh', () => {
  it('uses the stored token while it has life left', async () => {
    await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(verifyKeycloakToken).toHaveBeenCalledWith('access-token');
  });

  it('refreshes slightly BEFORE expiry rather than waiting for a 401', async () => {
    // Refreshing only on expiry means a request that started valid can arrive
    // at Keycloak expired; the early window is what avoids that.
    readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() + 5_000 }));
    refreshTokens.mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      accessTokenExp: Date.now() + 5 * MINUTE,
      refreshTokenExp: Date.now() + 30 * MINUTE,
    });

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(refreshTokens).toHaveBeenCalledWith('refresh-token');
    expect(result).toEqual({ ok: true });
    expect(verifyKeycloakToken).toHaveBeenCalledWith('fresh-access');
  });

  it('stores the ROTATED refresh token, not just the new access token', async () => {
    // Keycloak rotates refresh tokens; keeping the old one would work once and
    // then log the user out at the next refresh.
    readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() - 1 }));
    refreshTokens.mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      accessTokenExp: Date.now() + 5 * MINUTE,
      refreshTokenExp: Date.now() + 30 * MINUTE,
    });

    await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(updateSession).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }),
    );
  });

  it('ends the session when the refresh is refused', async () => {
    readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() - 1 }));
    refreshTokens.mockRejectedValue(new Error('invalid_grant'));
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    expect(destroySession).toHaveBeenCalledWith('sid-1');
    expect(reply.clearCookie).toHaveBeenCalled();
  });

  it('refuses when the session vanished mid-refresh', async () => {
    // A concurrent logout: the refreshed tokens have nowhere to live, so the
    // request must not proceed on them.
    readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() - 1 }));
    refreshTokens.mockResolvedValue({
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      accessTokenExp: Date.now() + 5 * MINUTE,
      refreshTokenExp: Date.now() + 30 * MINUTE,
    });
    updateSession.mockResolvedValue(null);

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
  });
});

describe('token verification', () => {
  it('destroys the session when the API will not accept its token', async () => {
    // Otherwise the browser loops: a cookie it cannot use, re-sent forever.
    verifyKeycloakToken.mockResolvedValue({ ok: false, code: 'TOKEN_INVALID' });
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    expect(destroySession).toHaveBeenCalledWith('sid-1');
    expect(reply.clearCookie).toHaveBeenCalled();
  });

  it('hands the verified claims to the same human path a bearer token used to take', async () => {
    // The gates in resolveHumanSession (client allowlist, realm role,
    // provisioning) still apply — only how the token arrived has changed.
    const request = makeRequest({ cookie: 'sid-1' });

    await resolveBrowserSession(request, makeReply());

    expect(resolveHumanSession).toHaveBeenCalledWith({ sub: 'user-1' }, request);
  });

  it('propagates a refusal from the human path unchanged', async () => {
    resolveHumanSession.mockResolvedValue({
      ok: false,
      failure: { status: 403, code: 'USER_BANNED', error: 'Forbidden', message: 'Account suspended' },
    });

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(result).toMatchObject({ ok: false, failure: { code: 'USER_BANNED' } });
  });
});

describe('clearSessionCookie', () => {
  it('clears at the root path, matching where the cookie was set', () => {
    // A mismatched path silently clears nothing, leaving the browser to keep
    // sending a session it has been told to forget.
    const reply = makeReply();

    clearSessionCookie(reply);

    expect(reply.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
  });
});
