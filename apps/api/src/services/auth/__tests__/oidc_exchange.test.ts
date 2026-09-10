import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The server-side OIDC code exchange (AUTH-VULN-03/04).
 *
 * The two things worth pinning are the ones a reader cannot check by eye: which
 * base URL each kind of URL is built from (browser-facing vs cluster-internal —
 * conflating them is the classic way this breaks in a cluster), and that a
 * failing token response never carries the user's code or refresh token into a
 * log or an error message.
 */

vi.mock('@/config', () => ({
  keycloakConfig: {
    base_url: 'https://kc.public.example',
    internal_base_url: 'http://keycloak.svc.cluster.local:8080',
    realm: 'bluedots',
    ui_client_id: 'signals-ui',
  },
}));

const {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  newPkcePair,
  newStateValue,
  refreshTokens,
  idTokenNonce,
  OidcExchangeError,
} = await import('../oidc_exchange.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const tokenResponse = (body: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(
    tokenResponse({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'it',
      expires_in: 300,
      refresh_expires_in: 1800,
    }),
  );
});

describe('newPkcePair', () => {
  it('derives the challenge as the S256 of the verifier', () => {
    const { verifier, challenge } = newPkcePair();

    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('mints a fresh verifier and state every time', () => {
    const verifiers = new Set(Array.from({ length: 100 }, () => newPkcePair().verifier));
    expect(verifiers.size).toBe(100);

    const states = new Set(Array.from({ length: 100 }, () => newStateValue()));
    expect(states.size).toBe(100);
  });
});

describe('URLs the BROWSER is sent to', () => {
  it('builds the authorize URL on the public issuer, never the internal host', () => {
    // The browser cannot resolve a cluster-internal service name, and a token
    // minted against one issuer fails validation for the other.
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: 'http://localhost:2742/api/v1/auth/session/callback',
        state: 'st',
        nonce: 'no',
        challenge: 'ch',
      }),
    );

    expect(url.origin).toBe('https://kc.public.example');
    expect(url.pathname).toBe('/realms/bluedots/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('signals-ui');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:2742/api/v1/auth/session/callback',
    );
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // No implicit-flow leftovers: a token must never come back on the redirect.
    expect(url.searchParams.get('response_type')).not.toContain('token');
  });

  it('builds the end-session URL on the public issuer', () => {
    const url = new URL(
      buildEndSessionUrl({ postLogoutRedirectUri: 'http://localhost:3000/auth/login' }),
    );

    expect(url.origin).toBe('https://kc.public.example');
    expect(url.pathname).toBe('/realms/bluedots/protocol/openid-connect/logout');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:3000/auth/login',
    );
    // With no id_token to hint with, Keycloak needs the client named instead,
    // or it refuses the post-logout redirect.
    expect(url.searchParams.get('client_id')).toBe('signals-ui');
  });

  it('prefers the id_token hint over the client id when one is available', () => {
    const url = new URL(
      buildEndSessionUrl({ idToken: 'the-id-token', postLogoutRedirectUri: 'http://x/auth/login' }),
    );

    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(url.searchParams.get('client_id')).toBeNull();
  });
});

describe('token requests', () => {
  it('exchanges a code on the INTERNAL issuer with the PKCE verifier', async () => {
    const tokens = await exchangeCode({
      code: 'the-code',
      redirectUri: 'http://localhost:2742/api/v1/auth/session/callback',
      verifier: 'the-verifier',
    });

    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe(
      'http://keycloak.svc.cluster.local:8080/realms/bluedots/protocol/openid-connect/token',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('client_id')).toBe('signals-ui');

    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.idToken).toBe('it');
  });

  it('turns the relative lifetimes into absolute epoch ms', async () => {
    const before = Date.now();
    const tokens = await exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' });

    expect(tokens.accessTokenExp).toBeGreaterThanOrEqual(before + 300_000);
    expect(tokens.refreshTokenExp).toBeGreaterThanOrEqual(before + 1_800_000);
  });

  it('falls back to conservative lifetimes when Keycloak omits them', async () => {
    // Guessing LONG here would leave the API using a dead access token; the
    // defaults must be short enough that the refresh path takes over.
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'at', refresh_token: 'rt' }));
    const before = Date.now();

    const tokens = await exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' });

    // A second of slack: the module reads its own `Date.now()` after this one,
    // so an exact bound makes the test fail whenever the clock ticks mid-call.
    // What matters is the order of magnitude, not the millisecond.
    expect(tokens.accessTokenExp - before).toBeLessThanOrEqual(301_000);
    expect(tokens.refreshTokenExp - before).toBeLessThanOrEqual(1_801_000);
  });

  it('refreshes with the refresh_token grant', async () => {
    await refreshTokens('the-refresh-token');

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
  });

  it('bounds the request, so a hanging Keycloak cannot pin a request open', async () => {
    await exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' });

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the status and OAuth reason on failure — never the rest of the body', async () => {
    // The response body can echo the code or refresh token back; putting THAT
    // in an Error message would land it in a log, which is the exact class of
    // leak this guards. `error`/`error_description` are the two fields that
    // exist to explain a refusal, and are read by name for that reason.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', refresh_token: 'super-secret' }),
    });

    const err = await refreshTokens('super-secret').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OidcExchangeError);
    expect((err as Error).message).toBe('token endpoint returned 400: invalid_grant');
    // Asserted on the whole serialised error, not just the message, so a stack
    // or an attached cause cannot smuggle the token through either.
    expect(JSON.stringify({ ...(err as Error), message: (err as Error).message, stack: (err as Error).stack }))
      .not.toContain('super-secret');
  });

  it('carries error_description, which is what names a host/issuer mismatch', async () => {
    // Verbatim from Keycloak 26.5.5 when a refresh is posted to a host that
    // disagrees with the token's `iss` — it names the host it expected, which
    // is the whole diagnostic value. Without it this is an unattributable
    // `returned 400`, indistinguishable from a genuinely spent grant.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: "Invalid token issuer. Expected 'http://keycloak:8080/realms/bluedots'",
      }),
    });

    const err = await refreshTokens('rt').catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      "token endpoint returned 400: invalid_grant — Invalid token issuer. Expected 'http://keycloak:8080/realms/bluedots'"
    );
    expect((err as InstanceType<typeof OidcExchangeError>).isGrantRejected).toBe(true);
  });

  it('falls back to the bare status when the body is not an OAuth error', async () => {
    // A 502 from a proxy is HTML, not JSON. Diagnosis must degrade to the
    // status rather than the parse failure replacing the real error.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const err = await refreshTokens('rt').catch((e: unknown) => e);

    expect((err as Error).message).toBe('token endpoint returned 502');
    expect((err as InstanceType<typeof OidcExchangeError>).isGrantRejected).toBe(false);
  });

  it('treats refresh_expires_in: 0 as unspecified, not as already-expired', async () => {
    // Keycloak sends 0 when the refresh token does not expire. `??` keeps the
    // 0, which makes refreshTokenExp === now, which floors the session's Redis
    // TTL at one second — it presents as "login does nothing".
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'at', refresh_token: 'rt', refresh_expires_in: 0 }),
    );
    const before = Date.now();

    const tokens = await exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' });

    expect(tokens.refreshTokenExp - before).toBeGreaterThan(60_000);
  });

  it('carries the HTTP status, so a spent grant is distinguishable from an outage', async () => {
    for (const [status, rejected] of [[400, true], [401, true], [500, false], [502, false]] as const) {
      fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) });
      const err = await refreshTokens('rt').catch((e: unknown) => e);
      expect((err as { status?: number }).status).toBe(status);
      expect((err as { isGrantRejected: boolean }).isGrantRejected).toBe(rejected);
    }
  });

  it('reads the nonce out of an id token, and tolerates a malformed one', async () => {
    const claims = Buffer.from(JSON.stringify({ nonce: 'n-1' })).toString('base64url');
    expect(idTokenNonce(`h.${claims}.sig`)).toBe('n-1');
    expect(idTokenNonce(undefined)).toBeNull();
    expect(idTokenNonce('not-a-jwt')).toBeNull();
    expect(idTokenNonce('h.%%%.sig')).toBeNull();
    const noNonce = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    expect(idTokenNonce(`h.${noNonce}.sig`)).toBeNull();
  });

  it('rejects a 200 that carries no usable tokens', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'at' }));

    await expect(exchangeCode({ code: 'c', redirectUri: 'r', verifier: 'v' })).rejects.toThrow(
      OidcExchangeError,
    );
  });
});
