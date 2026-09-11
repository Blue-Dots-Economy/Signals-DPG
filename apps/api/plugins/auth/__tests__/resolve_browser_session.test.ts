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

// Controllable rather than inherited from the ambient env: the provider gate is
// one of the behaviours under test, and a suite that silently depended on
// whatever AUTH_PROVIDER happened to be set would assert nothing about it.
const mockAuthConfig = { keycloak_enabled: true };
vi.mock('@/config', () => ({ authConfig: mockAuthConfig }));

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
  // Mirrors the real class: the caller branches on `isGrantRejected`, so a
  // stub without it would make every failure look transient.
  OidcExchangeError: class OidcExchangeError extends Error {
    status?: number;
    constructor(message: string, status?: number) { super(message); this.status = status; }
    get isGrantRejected() { return this.status === 400 || this.status === 401; }
  },
}));

const verifyKeycloakToken = vi.fn();
vi.mock('@/utils/keycloak_token', () => ({
  verifyKeycloakToken: (...a: unknown[]) => verifyKeycloakToken(...a),
}));

const resolveHumanSession = vi.fn();
vi.mock('../resolve_session', () => ({
  resolveHumanSession: (...a: unknown[]) => resolveHumanSession(...a),
  // Real shape: the cookie path maps outage codes exactly as the bearer path
  // does, so a stub with different statuses would hide a divergence.
  TOKEN_FAILURES: {
    TOKEN_EXPIRED: { status: 401, code: 'TOKEN_EXPIRED', error: 'Unauthorized', message: '' },
    TOKEN_INVALID: { status: 401, code: 'UNAUTHORIZED', error: 'Unauthorized', message: '' },
    TOKEN_CLIENT_REJECTED: { status: 403, code: 'TOKEN_CLIENT_REJECTED', error: 'Forbidden', message: '' },
    KEYCLOAK_UNAVAILABLE: { status: 503, code: 'IDENTITY_PROVIDER_UNAVAILABLE', error: 'Service Unavailable', message: '' },
    KEYCLOAK_NOT_CONFIGURED: { status: 500, code: 'IDENTITY_PROVIDER_NOT_CONFIGURED', error: 'Internal Server Error', message: '' },
  },
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
  mockAuthConfig.keycloak_enabled = true;
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
  it('clears the cookie and falls through, rather than locking the browser out', async () => {
    /**
     * Fallthrough, not 401. `sid` is a generic name and the clear here is
     * host-only, so a `sid` set by something else on a PARENT domain cannot be
     * removed by it. Answering 401 would re-reject that cookie on every request
     * and lock the user out permanently with nothing they could do. Falling
     * through lets the other channels answer; an unauthenticated request still
     * ends in the usual 401 from there.
     */
    readSession.mockResolvedValue(null);
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toEqual({ ok: false, fallthrough: true });
    expect(reply.clearCookie).toHaveBeenCalled();
  });
});

describe('provider gate', () => {
  it('is dormant under betterauth, even with a session cookie present', async () => {
    /**
     * `AUTH_PROVIDER=betterauth` is the stated rollback path, and the realistic
     * rollback flips one env var while KEYCLOAK_* stays configured. Without
     * this gate a `sid` row surviving the flip resolved all the way through
     * Keycloak provisioning on an instance where every Keycloak path is
     * supposed to be off.
     */
    mockAuthConfig.keycloak_enabled = false;

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(result).toEqual({ ok: false, fallthrough: true });
    expect(readSession).not.toHaveBeenCalled();
    expect(resolveHumanSession).not.toHaveBeenCalled();
  });
});

describe('appOrigin', () => {
  it('is NOT compared against the request — isolation comes from the host-only cookie', async () => {
    /**
     * Pinning today's contract rather than asserting a guard that does not
     * exist. `appOrigin` is stored for the logout redirect and read only there;
     * cross-portal isolation is a property of the cookie being host-only, not
     * of a server-side check.
     *
     * Enforcing it here would BREAK the split-origin deployments this flow
     * already supports — locally the UI is :3000 and the API :2742, so
     * `appOrigin` never equals the request origin. If that ever changes, this
     * test should fail and be rewritten deliberately, not quietly deleted.
     */
    readSession.mockResolvedValue(storedSession({ appOrigin: 'https://a-different-portal.test' }));

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(result).toEqual({ ok: true });
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

  it('ends the session when the GRANT is rejected', async () => {
    const { OidcExchangeError } = await import('@/services/auth/oidc_exchange');
    readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() - 1 }));
    refreshTokens.mockRejectedValue(new OidcExchangeError('invalid_grant', 400));
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toMatchObject({ ok: false, failure: { status: 401 } });
    expect(destroySession).toHaveBeenCalledWith('sid-1');
    expect(reply.clearCookie).toHaveBeenCalled();
  });

  it('KEEPS the session when Keycloak is merely unwell', async () => {
    // A 5xx or a 10s timeout is not a verdict about the grant. Ending the
    // session here turns a brief outage into a forced re-login for everyone
    // mid-session; the request fails, the session lives.
    const { OidcExchangeError } = await import('@/services/auth/oidc_exchange');
    for (const err of [new OidcExchangeError('token endpoint returned 502', 502), new Error('timeout')]) {
      vi.clearAllMocks();
      readSession.mockResolvedValue(storedSession({ accessTokenExp: Date.now() - 1 }));
      refreshTokens.mockRejectedValue(err);
      const reply = makeReply();

      const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

      expect(result).toMatchObject({ ok: false, failure: { status: 503 } });
      expect(destroySession).not.toHaveBeenCalled();
      expect(reply.clearCookie).not.toHaveBeenCalled();
    }
  });

  it('recovers when another worker rotated the token first', async () => {
    // Two pods refreshing the same session look identical to a spent grant
    // from here. Re-reading before destroying turns that race into a success.
    const { OidcExchangeError } = await import('@/services/auth/oidc_exchange');
    readSession
      .mockResolvedValueOnce(storedSession({ accessTokenExp: Date.now() - 1 }))
      .mockResolvedValueOnce(storedSession({ accessToken: 'rotated-by-someone-else' }));
    refreshTokens.mockRejectedValue(new OidcExchangeError('invalid_grant', 400));

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), makeReply());

    expect(result).toEqual({ ok: true });
    expect(destroySession).not.toHaveBeenCalled();
    expect(verifyKeycloakToken).toHaveBeenCalledWith('rotated-by-someone-else');
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

  it('does NOT destroy the session when the JWKS is unreachable', async () => {
    // The bearer path maps this to 503 precisely so an outage does not tell
    // every user their session died. A 30-second Keycloak restart must not
    // delete every browser's session row.
    verifyKeycloakToken.mockResolvedValue({ ok: false, code: 'KEYCLOAK_UNAVAILABLE' });
    const reply = makeReply();

    const result = await resolveBrowserSession(makeRequest({ cookie: 'sid-1' }), reply);

    expect(result).toMatchObject({ ok: false, failure: { status: 503 } });
    expect(destroySession).not.toHaveBeenCalled();
    expect(reply.clearCookie).not.toHaveBeenCalled();
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
