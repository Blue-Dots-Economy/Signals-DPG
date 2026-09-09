import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

/**
 * The four BFF routes that replaced the SPA's own OIDC exchange
 * (AUTH-VULN-03/04).
 *
 * The pentest lifted the access AND refresh tokens out of `localStorage` and
 * replayed them. What is asserted here is the property that makes that
 * impossible rather than merely harder: nothing these routes send to the
 * browser contains a token, in any header or body, on any path.
 */

// session.ts pulls in the cookie plugin for SESSION_COOKIE/clearSessionCookie,
// which reaches the session store and from there the redis client. Stubbed so
// the routes can be exercised without a server; the real clearSessionCookie is
// kept, since one of the assertions below is about the cookie it clears.
vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));
vi.mock('@/utils/keycloak_token', () => ({ verifyKeycloakToken: vi.fn() }));
vi.mock('@api/plugins/auth/resolve_session', () => ({ resolveHumanSession: vi.fn() }));

const mockAuthConfig = { keycloak_enabled: true };
const mockInstance = { INSTANCE_ENV: 'production' as string };
vi.mock('@/config', () => ({
  authConfig: mockAuthConfig,
  instance: mockInstance,
  getCurrentApiBaseUrl: () => 'https://api.example.org',
}));

const exchangeCode = vi.fn();
// Default: the id token carries no nonce claim, so the check is skipped — the
// shape most of these cases are about. The mismatch case sets it explicitly.
const idTokenNonce = vi.fn<(t?: string) => string | null>(() => null);
const buildAuthorizeUrl = vi.fn(() => 'https://kc.example.org/authorize?state=st');
const buildEndSessionUrl = vi.fn(
  (input: { idToken?: string; postLogoutRedirectUri: string }) =>
    `https://kc.example.org/logout?post_logout_redirect_uri=${encodeURIComponent(input.postLogoutRedirectUri)}`,
);
vi.mock('@/services/auth/oidc_exchange', () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
  buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrl(...(a as [])),
  buildEndSessionUrl: (...a: unknown[]) => buildEndSessionUrl(...(a as [never])),
  newPkcePair: () => ({ verifier: 'the-verifier', challenge: 'the-challenge' }),
  newStateValue: () => 'the-state',
  idTokenNonce: (...a: unknown[]) => idTokenNonce(...(a as [string])),
  OidcExchangeError: class OidcExchangeError extends Error {},
}));

const saveFlowState = vi.fn();
const consumeFlowState = vi.fn();
vi.mock('@/services/auth/oidc_flow_state', () => ({
  saveFlowState: (...a: unknown[]) => saveFlowState(...a),
  consumeFlowState: (...a: unknown[]) => consumeFlowState(...a),
  safeReturnTo: (raw: unknown, fallback = '/') =>
    typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : fallback,
  safeAppOrigin: (raw: unknown, fallback: string) =>
    raw === 'https://app.example.org' ? raw : fallback,
}));

const createSession = vi.fn();
const readSession = vi.fn();
const destroySession = vi.fn();
vi.mock('@/services/auth/browser_session', () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  readSession: (...a: unknown[]) => readSession(...a),
  destroySession: (...a: unknown[]) => destroySession(...a),
  newSessionId: () => 'the-session-id',
  newCsrfToken: () => 'the-csrf-token',
  SESSION_TTL_SECONDS: 28800,
}));

const TOKENS = {
  accessToken: 'the-access-token',
  refreshToken: 'the-refresh-token',
  idToken: 'the-id-token',
  accessTokenExp: Date.now() + 300_000,
  refreshTokenExp: Date.now() + 1_800_000,
};

async function build(): Promise<FastifyInstance> {
  const { auth_session } = await import('../session');
  // `trustProxy` mirrors app.ts. Without it `request.host` is the injected
  // host rather than the edge's `X-Forwarded-Host`, so the harness would be a
  // different server from the one that runs — and the multi-host case below
  // would silently pass for the wrong reason.
  const app = Fastify({ trustProxy: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(auth_session, { prefix: '/api/v1/auth' });
  await app.ready();
  return app;
}

const inject = async (opts: InjectOptions): Promise<LightMyRequestResponse> => {
  const app = await build();
  const res = await app.inject(opts);
  await app.close();
  return res;
};

/**
 * What the edge forwards for a browser on a participant hostname. `trustProxy`
 * turns these into `request.protocol` / `request.host`.
 */
const asPortalHost = {
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'app.example.org',
};

/** Everything the browser is told, flattened — headers and body together. */
const everythingSentBack = (res: LightMyRequestResponse) =>
  JSON.stringify(res.headers) + res.body;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthConfig.keycloak_enabled = true;
  mockInstance.INSTANCE_ENV = 'production';
  saveFlowState.mockResolvedValue(undefined);
  consumeFlowState.mockResolvedValue({
    verifier: 'the-verifier',
    nonce: 'nonce',
    returnTo: '/',
    redirectUri: 'https://api.example.org/api/v1/auth/session/callback',
    appOrigin: 'https://app.example.org',
  });
  exchangeCode.mockResolvedValue(TOKENS);
  idTokenNonce.mockReturnValue(null);
  createSession.mockResolvedValue(undefined);
  readSession.mockResolvedValue(null);
  destroySession.mockResolvedValue(undefined);
});

describe('GET /auth/session/login', () => {
  it('redirects to Keycloak and parks the PKCE verifier server-side', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/auth/session/login?returnTo=/profile' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://kc.example.org/authorize?state=st');
    expect(saveFlowState).toHaveBeenCalledWith(
      'the-state',
      expect.objectContaining({ verifier: 'the-verifier', returnTo: '/profile' }),
    );
    // The verifier is the thing that must not reach the browser — that is the
    // whole reason the exchange moved to the server.
    expect(everythingSentBack(res)).not.toContain('the-verifier');
  });

  it('names the API — not the UI — as the OIDC redirect target', async () => {
    // Keycloak has to send the code back to the server that holds the verifier.
    await inject({ method: 'GET', url: '/api/v1/auth/session/login' });

    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'https://api.example.org/api/v1/auth/session/callback',
      }),
    );
  });

  it('sends the callback back to the HOST THE BROWSER USED, not the canonical API_DOMAIN', async () => {
    // One instance is served under several participant hostnames. Sending the
    // callback to API_DOMAIN sets the session cookie on that origin, which is
    // then never sent to the portal the user is actually on — they complete a
    // valid login and land back signed out.
    await inject({
      method: 'GET',
      url: '/api/v1/auth/session/login',
      headers: asPortalHost,
    });

    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'https://app.example.org/api/v1/auth/session/callback',
      }),
    );
    expect(saveFlowState.mock.calls[0][1]).toMatchObject({
      appOrigin: 'https://app.example.org',
    });
  });

  it('ignores a Host that is not on the CORS allowlist', async () => {
    // `X-Forwarded-Host` is client-influenced, so an unrecognised value must
    // never become a redirect target.
    await inject({
      method: 'GET',
      url: '/api/v1/auth/session/login',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test' },
    });

    expect(buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'https://api.example.org/api/v1/auth/session/callback',
      }),
    );
  });

  it('carries an allowlisted app origin, and falls back for anything else', async () => {
    await inject({
      method: 'GET',
      url: '/api/v1/auth/session/login?appOrigin=https%3A%2F%2Fapp.example.org',
    });
    expect(saveFlowState.mock.calls[0][1]).toMatchObject({ appOrigin: 'https://app.example.org' });

    await inject({
      method: 'GET',
      url: '/api/v1/auth/session/login?appOrigin=https%3A%2F%2Fevil.test',
    });
    expect(saveFlowState.mock.calls[1][1]).toMatchObject({ appOrigin: 'https://api.example.org' });
  });

  it('carries a consent the user was part-way through', async () => {
    await inject({
      method: 'GET',
      url: '/api/v1/auth/session/login?consentAttempt=attempt-1',
    });

    expect(saveFlowState.mock.calls[0][1]).toMatchObject({ consentAttempt: 'attempt-1' });
  });

  it('404s when the instance is not running Keycloak', async () => {
    mockAuthConfig.keycloak_enabled = false;

    const res = await inject({ method: 'GET', url: '/api/v1/auth/session/login' });

    expect(res.statusCode).toBe(404);
    expect(saveFlowState).not.toHaveBeenCalled();
  });
});

describe('GET /auth/session/callback', () => {
  const CALLBACK = '/api/v1/auth/session/callback?code=the-code&state=the-state';

  it('exchanges the code, opens a session, and sets an opaque cookie', async () => {
    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(exchangeCode).toHaveBeenCalledWith({
      code: 'the-code',
      redirectUri: 'https://api.example.org/api/v1/auth/session/callback',
      verifier: 'the-verifier',
    });
    expect(createSession).toHaveBeenCalledWith(
      'the-session-id',
      expect.objectContaining({
        accessToken: 'the-access-token',
        refreshToken: 'the-refresh-token',
        idToken: 'the-id-token',
        appOrigin: 'https://app.example.org',
      }),
    );
    expect(res.cookies[0]).toMatchObject({ name: 'sid', value: 'the-session-id' });
  });

  it('sends no token to the browser, in any header or the body', async () => {
    // The finding, stated as an assertion: the pentest read both of these out
    // of the page. Nothing on this response may carry either.
    const res = await inject({ method: 'GET', url: CALLBACK });

    const sent = everythingSentBack(res);
    expect(sent).not.toContain('the-access-token');
    expect(sent).not.toContain('the-refresh-token');
    expect(sent).not.toContain('the-id-token');
  });

  it('marks the cookie httpOnly, Secure and SameSite=Lax outside development', async () => {
    const res = await inject({ method: 'GET', url: CALLBACK });

    // httpOnly is the control: script cannot read it, which is the whole point.
    expect(res.cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  });

  it('drops Secure in development, where the cookie would otherwise be discarded', async () => {
    // A Secure cookie over plain http is silently dropped, which presents as
    // "login does nothing" locally.
    mockInstance.INSTANCE_ENV = 'development';

    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(res.cookies[0].httpOnly).toBe(true);
    expect(res.cookies[0].secure).toBeFalsy();
  });

  it('redirects to the app origin, carrying the flow parameters back to the UI', async () => {
    consumeFlowState.mockResolvedValue({
      verifier: 'the-verifier',
      nonce: 'n',
      returnTo: '/profile/new',
      consentAttempt: 'attempt-1',
      redirectUri: 'https://api.example.org/api/v1/auth/session/callback',
      appOrigin: 'https://app.example.org',
    });

    const res = await inject({ method: 'GET', url: CALLBACK });

    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe('https://app.example.org');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('returnTo')).toBe('/profile/new');
    expect(location.searchParams.get('consentAttempt')).toBe('attempt-1');
  });

  it('refuses an id token whose nonce does not match the flow', async () => {
    // The nonce binds the id token to the authorize request we made. It is
    // minted and sent, so it is checked — a stored field nothing compares
    // reads as a control that exists.
    idTokenNonce.mockReturnValue('a-different-nonce');

    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(res.headers.location).toContain('auth_error=1');
    expect(createSession).not.toHaveBeenCalled();
    expect(res.cookies).toHaveLength(0);
  });

  it('accepts a matching nonce', async () => {
    idTokenNonce.mockReturnValue('nonce');

    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(createSession).toHaveBeenCalled();
    expect(res.cookies[0]).toMatchObject({ name: 'sid' });
  });

  it('refuses a replayed callback rather than minting a second session', async () => {
    // consumeFlowState deletes as it reads, so the second callback for one
    // authorization finds nothing.
    consumeFlowState.mockResolvedValue(null);

    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('auth_error=1');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reports a cancelled login without touching the flow store', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/v1/auth/session/callback?error=access_denied',
    });

    expect(res.headers.location).toContain('auth_error=1');
    expect(consumeFlowState).not.toHaveBeenCalled();
  });

  it('opens no session when the exchange fails', async () => {
    exchangeCode.mockRejectedValue(new Error('token endpoint returned 400'));

    const res = await inject({ method: 'GET', url: CALLBACK });

    expect(res.headers.location).toBe('https://app.example.org/auth/login?auth_error=1');
    expect(createSession).not.toHaveBeenCalled();
    expect(res.cookies).toHaveLength(0);
  });
});

describe('betterauth instances', () => {
  it('404s the callback and the logout rather than throwing on an unset Keycloak URL', async () => {
    // `keycloakConfig.base_url` is '' under betterauth, so buildEndSessionUrl
    // would construct a URL from nothing and throw — an unhandled 500 on a
    // public route.
    mockAuthConfig.keycloak_enabled = false;

    const cb = await inject({ method: 'GET', url: '/api/v1/auth/session/callback?code=c&state=s' });
    const out = await inject({ method: 'POST', url: '/api/v1/auth/session/logout' });

    expect(cb.statusCode).toBe(404);
    expect(out.statusCode).toBe(404);
    expect(buildEndSessionUrl).not.toHaveBeenCalled();
  });
});

describe('GET /auth/session', () => {
  it('answers "no" with no cookie, and hands back no token', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/auth/session' });

    expect(res.json()).toEqual({ authenticated: false });
    expect(readSession).not.toHaveBeenCalled();
  });

  it('returns only the CSRF token for a live session', async () => {
    readSession.mockResolvedValue({
      accessToken: 'the-access-token',
      refreshToken: 'the-refresh-token',
      csrfToken: 'the-csrf-token',
      appOrigin: 'https://app.example.org',
    });

    const res = await inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { sid: 'the-session-id' },
    });

    // The CSRF token is readable by script on purpose — the UI has to echo it.
    // The tokens behind the session are not, and this is the endpoint that
    // would be the obvious place to leak them.
    expect(res.json()).toEqual({ authenticated: true, csrfToken: 'the-csrf-token' });
    expect(everythingSentBack(res)).not.toContain('the-access-token');
    expect(everythingSentBack(res)).not.toContain('the-refresh-token');
  });

  it('clears a cookie whose session no longer exists', async () => {
    readSession.mockResolvedValue(null);

    const res = await inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { sid: 'stale' },
    });

    expect(res.json()).toEqual({ authenticated: false });
    expect(res.cookies[0]).toMatchObject({ name: 'sid', value: '' });
  });
});

describe('POST /auth/session/logout', () => {
  it('destroys the session, clears the cookie, and ends the Keycloak session too', async () => {
    readSession.mockResolvedValue({ csrfToken: 'c', appOrigin: 'https://app.example.org' });

    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/session/logout',
      cookies: { sid: 'the-session-id' },
    });

    expect(destroySession).toHaveBeenCalledWith('the-session-id');
    expect(res.cookies[0]).toMatchObject({ name: 'sid', value: '' });
    // Dropping only the local session leaves SSO alive, so the next login
    // signs the same user straight back in without asking.
    expect(res.json().endSessionUrl).toContain('kc.example.org/logout');
  });

  it('sends the user back to the app that opened the session', async () => {
    // Not the API's own origin: Keycloak only honours post-logout URLs it has
    // registered for the client, and those name the app.
    readSession.mockResolvedValue({ csrfToken: 'c', appOrigin: 'https://app.example.org' });

    await inject({
      method: 'POST',
      url: '/api/v1/auth/session/logout',
      cookies: { sid: 'the-session-id' },
    });

    expect(buildEndSessionUrl).toHaveBeenCalledWith(
      expect.objectContaining({ postLogoutRedirectUri: 'https://app.example.org/auth/login' }),
    );
  });

  it('names the ending session, so Keycloak does not stop to ask the user', async () => {
    // Without the hint Keycloak shows a "Do you want to log out?" interstitial.
    // The SPA never hit that, because oidc-client-ts supplied the id token from
    // its own store — the store this change removes.
    readSession.mockResolvedValue({
      csrfToken: 'c',
      appOrigin: 'https://app.example.org',
      idToken: 'the-id-token',
    });

    await inject({
      method: 'POST',
      url: '/api/v1/auth/session/logout',
      cookies: { sid: 'the-session-id' },
    });

    expect(buildEndSessionUrl).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'the-id-token' }),
    );
  });

  it('still clears the cookie and answers when there is no session to destroy', async () => {
    const res = await inject({ method: 'POST', url: '/api/v1/auth/session/logout' });

    expect(res.statusCode).toBe(200);
    expect(destroySession).not.toHaveBeenCalled();
    expect(res.cookies[0]).toMatchObject({ name: 'sid', value: '' });
  });
});
