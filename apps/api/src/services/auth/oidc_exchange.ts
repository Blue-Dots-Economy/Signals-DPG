import { createHash, randomBytes } from 'node:crypto';
import { keycloakConfig } from '@/config';

/**
 * Server-side half of the OIDC authorization-code flow.
 *
 * The browser never sees a token: it is redirected to Keycloak, comes back with
 * a `code`, and this module exchanges that code for tokens which are then kept
 * in Redis (`browser_session.ts`). The SPA previously did this exchange itself
 * and stored the result in `localStorage` — the finding this replaces.
 *
 * PKCE is used with the public `signals-ui` client rather than a confidential
 * one, because the code verifier never leaves the server here: it is minted in
 * `buildAuthorizeUrl`, held in Redis against the `state`, and read back in the
 * callback. That keeps the flow within the client Keycloak already registers
 * (`__PUBLIC_BASE_URL__/*`), so no realm change is needed — the API's callback
 * is same-origin with the UI in every deployment.
 *
 * Requests go to `internal_base_url` (cluster-internal) while the URL the
 * BROWSER is sent to uses `base_url` (public issuer). Conflating them is the
 * classic way this breaks in a cluster: the browser cannot resolve an internal
 * service name, and a token minted against one issuer fails validation for the
 * other.
 */

export interface OidcTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  accessTokenExp: number;
  /** Epoch ms. */
  refreshTokenExp: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function newPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newStateValue(): string {
  return randomBytes(32).toString('base64url');
}

function realmUrl(base: string): string {
  return `${base}/realms/${keycloakConfig.realm}/protocol/openid-connect`;
}

/** Where the BROWSER is sent. Uses the public issuer, never the internal host. */
export function buildAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const url = new URL(`${realmUrl(keycloakConfig.base_url)}/auth`);
  url.searchParams.set('client_id', keycloakConfig.ui_client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Where the BROWSER is sent to end the Keycloak session. */
export function buildEndSessionUrl(input: {
  idToken?: string;
  postLogoutRedirectUri: string;
}): string {
  const url = new URL(`${realmUrl(keycloakConfig.base_url)}/logout`);
  url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
  if (input.idToken) url.searchParams.set('id_token_hint', input.idToken);
  else url.searchParams.set('client_id', keycloakConfig.ui_client_id);
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<OidcTokens> {
  const endpoint = `${realmUrl(keycloakConfig.internal_base_url || keycloakConfig.base_url)}/token`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // The body can carry the user's code/refresh token, so it is never logged
    // or surfaced — only the status, which is enough to tell a bad code from a
    // Keycloak outage.
    throw new OidcExchangeError(
      `token endpoint returned ${response.status}`,
      response.status
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token) {
    throw new OidcExchangeError('token response missing access or refresh token');
  }

  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    accessTokenExp: now + (json.expires_in ?? 300) * 1000,
    // `||`, not `??`: Keycloak sends `refresh_expires_in: 0` when the refresh
    // token does not expire. `??` keeps the 0, which makes `refreshTokenExp`
    // equal to now, which floors the session's Redis TTL at one second — it
    // presents as "login does nothing". Treat 0 as "unspecified".
    refreshTokenExp: now + (json.refresh_expires_in || 1800) * 1000,
  };
}

/**
 * A token-endpoint call that did not succeed.
 *
 * `status` is carried because the CALLER's response differs by kind: a 400
 * (`invalid_grant` — the refresh token is spent or revoked) means the session
 * is genuinely over, while a 5xx or a timeout means Keycloak is unwell and the
 * session must survive. Collapsing the two logs users out for an outage.
 * `status` is undefined for a transport failure (DNS, connect, timeout), which
 * is likewise transient.
 */
/**
 * The `nonce` claim carried by an id token, or null when there is none.
 *
 * The token comes straight from Keycloak's token endpoint over TLS, so the
 * transport already authenticates it — this reads the claim rather than
 * re-verifying a signature the channel has established.
 */
export function idTokenNonce(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { nonce?: unknown };
    return typeof claims.nonce === 'string' ? claims.nonce : null;
  } catch {
    return null;
  }
}

export class OidcExchangeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }

  /** A verdict about the grant itself, rather than about Keycloak's health. */
  get isGrantRejected(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<OidcTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: keycloakConfig.ui_client_id,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    })
  );
}

export async function refreshTokens(refreshToken: string): Promise<OidcTokens> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: keycloakConfig.ui_client_id,
      refresh_token: refreshToken,
    })
  );
}
