import type { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import { verifyKeycloakToken } from '@/utils/keycloak_token';
import {
  readSession,
  updateSession,
  destroySession,
  safeEqual,
  type BrowserSession,
} from '@/services/auth/browser_session';
import { refreshTokens, OidcExchangeError } from '@/services/auth/oidc_exchange';
import {
  resolveHumanSession,
  TOKEN_FAILURES,
  type SessionResolution,
} from './resolve_session';

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-csrf-token';

/** Refresh this far before expiry rather than waiting for a 401 mid-request. */
const REFRESH_BEFORE_EXPIRY_MS = 30_000;

/**
 * Methods that cannot change state, so they need no CSRF token.
 *
 * A cookie is attached by the browser automatically, which is what makes
 * cookie auth vulnerable to cross-site requests in a way `Authorization` never
 * was. `SameSite=Lax` already blocks the cross-site POST case in current
 * browsers; the double-submit token below is the second layer, because
 * `SameSite` is a browser-side control and this is the server's own check.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves a browser session from the `sid` cookie (AUTH-VULN-03/04).
 *
 * This is the replacement for the SPA holding a token: the cookie carries only
 * an opaque id, the tokens live in Redis, and the access token is refreshed
 * here rather than by client-side JavaScript. Returns `fallthrough` when there
 * is no cookie so the caller can try the other auth paths — a request with no
 * session is not an error, it is an anonymous or service request.
 */
export async function resolveBrowserSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<SessionResolution> {
  /**
   * Dormant unless Keycloak is the provider, mirroring
   * `resolveKeycloakSession`. Without this the channel stays live under
   * `AUTH_PROVIDER=betterauth` — the stated rollback path — and a `sid` row
   * surviving the flip resolves all the way through Keycloak provisioning on an
   * instance that is supposed to have every Keycloak path switched off. It also
   * keeps this off Redis entirely on a betterauth instance.
   */
  if (!authConfig.keycloak_enabled) return { ok: false, fallthrough: true };

  const sessionId = request.cookies?.[SESSION_COOKIE];
  if (!sessionId) return { ok: false, fallthrough: true };

  const session = await readSession(sessionId);
  if (!session) {
    /**
     * Cookie present but the session is gone (expired, revoked, or a stale
     * cookie from a previous deployment). Clear it so the browser stops
     * re-sending a credential that can never work again.
     *
     * `fallthrough`, NOT a 401: `sid` is a generic name and `clearCookie` here
     * sets no `Domain`, so a host-only clear cannot remove a `sid` set by
     * something else on a parent domain. Answering 401 would re-reject that
     * cookie on every request and lock the user out permanently, with nothing
     * they could do about it. Falling through lets the other channels answer,
     * and an unauthenticated request still ends in the usual 401 from there.
     */
    clearSessionCookie(reply);
    return { ok: false, fallthrough: true };
  }

  if (!csrfOk(request, session)) {
    request.log.warn(
      { method: request.method, path: request.url.split('?')[0] },
      'Rejected browser-session request: CSRF token missing or mismatched'
    );
    return { ok: false, failure: CSRF_FAILED };
  }

  const refreshed = await currentAccessToken(request, sessionId, session);
  if (!refreshed.ok) {
    if (!refreshed.sessionOver) {
      // Keycloak is unwell. Keep the cookie and the session; fail this one
      // request with the same 503 the bearer path uses for an outage.
      return { ok: false, failure: TOKEN_FAILURES.KEYCLOAK_UNAVAILABLE };
    }
    clearSessionCookie(reply);
    return { ok: false, failure: UNAUTHENTICATED };
  }
  const accessToken = refreshed.accessToken;

  const verified = await verifyKeycloakToken(accessToken);
  if (!verified.ok) {
    /**
     * Only a verdict ABOUT THE TOKEN ends the session.
     *
     * `KEYCLOAK_UNAVAILABLE` (JWKS unreachable) and `KEYCLOAK_NOT_CONFIGURED`
     * mean we do not know whether the token is good. Destroying the session on
     * those turns a 30-second Keycloak restart into a permanent, fleet-wide
     * logout: every active browser's Redis row is deleted and its cookie
     * cleared, so nobody is signed back in when Keycloak recovers. The bearer
     * path already maps them to 503 for exactly this reason
     * (`TOKEN_FAILURES` in resolve_session.ts) — this path must not disagree.
     */
    if (verified.code === 'TOKEN_INVALID' || verified.code === 'TOKEN_EXPIRED') {
      await destroySession(sessionId);
      clearSessionCookie(reply);
      return { ok: false, failure: UNAUTHENTICATED };
    }
    request.log.error(
      { code: verified.code },
      'Could not verify a browser session token; leaving the session intact'
    );
    return { ok: false, failure: TOKEN_FAILURES[verified.code] };
  }

  return resolveHumanSession(verified.claims, request);
}

/**
 * Double-submit CSRF check.
 *
 * The token is minted per session and returned to the UI by `GET /auth/session`
 * (readable JSON, not a cookie), so only same-origin script can learn it. A
 * cross-site form POST carries the cookie but cannot read that response, so it
 * cannot supply the header.
 */
function csrfOk(request: FastifyRequest, session: BrowserSession): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const header = request.headers[CSRF_HEADER];
  if (typeof header !== 'string' || header.length === 0) return false;
  return safeEqual(header, session.csrfToken);
}

/**
 * In-flight refreshes, keyed by session.
 *
 * A page load fires several requests at once and they all see the same
 * near-expiry token. Without this each one calls the token endpoint with the
 * SAME refresh token, and with Keycloak's "Revoke Refresh Token" enabled only
 * the first is honoured — the rest get `invalid_grant` and would end a session
 * that is in perfectly good health. Sharing one promise per session makes the
 * common case a single call.
 *
 * Per-process only. Two pods can still race, which is what the `invalid_grant`
 * re-read in `refreshAccessToken` recovers from.
 */
const refreshesInFlight = new Map<string, Promise<RefreshOutcome>>();

type RefreshOutcome =
  | { ok: true; accessToken: string }
  /** The grant is spent or revoked: this session is genuinely over. */
  | { ok: false; sessionOver: true }
  /** Keycloak is unwell: the session survives, this one request fails. */
  | { ok: false; sessionOver: false };

/**
 * The session's access token, refreshed if it is at or near expiry.
 *
 * The distinction that matters is WHY a refresh failed. A rejected grant means
 * the session is over. A 5xx or a timeout means Keycloak is unwell — ending the
 * session there would turn a brief outage into a forced re-login for everyone
 * mid-session, which is the same mistake as destroying on `KEYCLOAK_UNAVAILABLE`
 * above.
 */
async function currentAccessToken(
  request: FastifyRequest,
  sessionId: string,
  session: BrowserSession
): Promise<RefreshOutcome> {
  if (session.accessTokenExp - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
    return { ok: true, accessToken: session.accessToken };
  }

  const existing = refreshesInFlight.get(sessionId);
  if (existing) return existing;

  const attempt = refreshAccessToken(request, sessionId, session).finally(() => {
    refreshesInFlight.delete(sessionId);
  });
  refreshesInFlight.set(sessionId, attempt);
  return attempt;
}

async function refreshAccessToken(
  request: FastifyRequest,
  sessionId: string,
  session: BrowserSession
): Promise<RefreshOutcome> {
  try {
    const refreshed = await refreshTokens(session.refreshToken);
    const updated = await updateSession(sessionId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExp: refreshed.accessTokenExp,
      refreshTokenExp: refreshed.refreshTokenExp,
    });
    // `updateSession` returns null only when the row vanished mid-refresh —
    // a concurrent logout. The freshly minted tokens have nowhere to live.
    if (!updated) {
      /**
       * Logged because this branch is otherwise invisible: Keycloak said yes,
       * the user is signed out anyway, and nothing else here records why. If
       * sessions are dying at their first refresh while Keycloak's SSO session
       * stays healthy, this line and the `rejected` one below are what tell
       * "the grant was refused" apart from "the grant was fine and the store
       * lost it" — two faults that look identical from the browser.
       */
      request.log.warn(
        'Browser session refresh succeeded but its session row was gone; ending session'
      );
      return { ok: false, sessionOver: true };
    }
    return { ok: true, accessToken: refreshed.accessToken };
  } catch (err) {
    const rejected = err instanceof OidcExchangeError && err.isGrantRejected;

    if (!rejected) {
      request.log.error(
        { err: err instanceof Error ? err.message : 'refresh failed' },
        'Browser session refresh could not complete; leaving the session intact'
      );
      return { ok: false, sessionOver: false };
    }

    /**
     * The grant was rejected — but another worker rotating the same token would
     * look identical from here. Re-read before destroying: if the stored token
     * has moved on, that race is what happened and the session is fine.
     */
    const current = await readSession(sessionId);
    if (current && current.accessToken !== session.accessToken) {
      return { ok: true, accessToken: current.accessToken };
    }

    request.log.warn(
      { err: err instanceof Error ? err.message : 'refresh rejected' },
      'Browser session refresh token was rejected; ending session'
    );
    await destroySession(sessionId);
    return { ok: false, sessionOver: true };
  }
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const UNAUTHENTICATED = {
  status: 401 as const,
  code: 'UNAUTHORIZED',
  error: 'Unauthorized',
  message: 'Missing or invalid authentication',
};

const CSRF_FAILED = {
  status: 403 as const,
  code: 'CSRF_TOKEN_INVALID',
  error: 'Forbidden',
  message: 'Missing or invalid CSRF token',
};
