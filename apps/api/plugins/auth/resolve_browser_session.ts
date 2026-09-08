import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyKeycloakToken } from '@/utils/keycloak_token';
import {
  readSession,
  updateSession,
  destroySession,
  safeEqual,
  type BrowserSession,
} from '@/services/auth/browser_session';
import { refreshTokens, OidcExchangeError } from '@/services/auth/oidc_exchange';
import { resolveHumanSession, type SessionResolution } from './resolve_session';

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
  const sessionId = request.cookies?.[SESSION_COOKIE];
  if (!sessionId) return { ok: false, fallthrough: true };

  const session = await readSession(sessionId);
  if (!session) {
    // Cookie present but the session is gone (expired, revoked, or a stale
    // cookie from a previous deployment). Clear it so the browser stops
    // re-sending a credential that can never work again.
    clearSessionCookie(reply);
    return { ok: false, failure: UNAUTHENTICATED };
  }

  if (!csrfOk(request, session)) {
    request.log.warn(
      { method: request.method, path: request.url.split('?')[0] },
      'Rejected browser-session request: CSRF token missing or mismatched'
    );
    return { ok: false, failure: CSRF_FAILED };
  }

  const accessToken = await currentAccessToken(request, sessionId, session);
  if (!accessToken) {
    clearSessionCookie(reply);
    return { ok: false, failure: UNAUTHENTICATED };
  }

  const verified = await verifyKeycloakToken(accessToken);
  if (!verified.ok) {
    // The session held a token this API will not accept — treat as logged out
    // rather than leaving the browser in a loop with a cookie it cannot use.
    await destroySession(sessionId);
    clearSessionCookie(reply);
    return { ok: false, failure: UNAUTHENTICATED };
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
 * The session's access token, refreshed if it is at or near expiry.
 *
 * Returns null when the refresh fails, which means the refresh token is spent
 * or rejected — the session is destroyed rather than left holding credentials
 * Keycloak will not honour.
 */
async function currentAccessToken(
  request: FastifyRequest,
  sessionId: string,
  session: BrowserSession
): Promise<string | null> {
  if (session.accessTokenExp - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
    return session.accessToken;
  }

  try {
    const refreshed = await refreshTokens(session.refreshToken);
    const updated = await updateSession(sessionId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExp: refreshed.accessTokenExp,
      refreshTokenExp: refreshed.refreshTokenExp,
    });
    return updated ? refreshed.accessToken : null;
  } catch (err) {
    request.log.warn(
      { err: err instanceof OidcExchangeError ? err.message : 'refresh failed' },
      'Browser session refresh failed; ending session'
    );
    await destroySession(sessionId);
    return null;
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
