import { apiConfig } from './api-config';

/**
 * Client half of the httpOnly-cookie session (AUTH-VULN-03/04).
 *
 * There is deliberately no token here. The browser holds an opaque `sid`
 * cookie it cannot read (httpOnly), the access and refresh tokens live in Redis
 * on the API, and every request authenticates by simply carrying the cookie.
 * This module knows only two things: whether a session exists, and the CSRF
 * token to echo on state-changing requests.
 *
 * That CSRF token is the one value that IS readable by script — necessarily, as
 * the UI has to send it back in a header. It is not a credential on its own: a
 * cross-site page can cause the cookie to be sent but cannot read this response
 * to learn the token, which is what makes the double-submit work.
 */

export interface BffSession {
  authenticated: boolean;
  csrfToken?: string;
  /**
   * The server could not answer — NOT a statement that the session is gone.
   *
   * The API deliberately answers a Keycloak or Redis outage with 503 rather
   * than 401, precisely so it does not read as "your session died". Collapsing
   * every non-2xx into `authenticated: false` threw that distinction away and
   * showed a 30-second blip to every signed-in user as being logged out. The
   * caller should hold its existing state when this is set.
   */
  unknown?: boolean;
}

/** In-memory only. A reload re-reads it from the API; nothing is persisted. */
let csrfToken: string | null = null;

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

function url(path: string): string {
  return `${apiConfig.getUrl()}${path}`;
}

/**
 * Asks the API whether this browser has a session.
 *
 * `credentials: 'include'` is required even same-origin here, because the UI
 * may be served from a different origin than the API in local development.
 */
export async function fetchBffSession(): Promise<BffSession> {
  try {
    const response = await fetch(url('/api/v1/auth/session'), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      /**
       * A 5xx is the server saying it could not reach its own dependencies —
       * the session may well still be alive. Keep the CSRF token so a write
       * still works once the dependency recovers, and tell the caller the
       * answer is unknown rather than negative.
       */
      if (response.status >= 500) return { authenticated: false, unknown: true };
      // 401/403/404: a real answer. The session is gone or was never there.
      csrfToken = null;
      return { authenticated: false };
    }
    const session = (await response.json()) as BffSession;
    csrfToken = session.csrfToken ?? null;
    return session;
  } catch {
    // Could not reach the API at all — offline, DNS, a dropped connection.
    // That says nothing about the session, so it is `unknown` too.
    return { authenticated: false, unknown: true };
  }
}

/**
 * Sends the browser to the API to start a login.
 *
 * A full navigation, not a fetch: the flow ends in a Keycloak redirect and a
 * `Set-Cookie` on the way back, neither of which survives an XHR.
 */
export function startBffLogin(returnTo: string, consentAttempt?: string): void {
  // `window.location.origin` is the BASE, not the value: `apiConfig.getUrl()`
  // returns '' in every deployment that serves the API under the UI's own
  // origin (the chart writes `VITE_API_URL: ""`), which makes `url()` a
  // relative path — and single-argument `new URL('/path')` throws `Invalid
  // URL`. Passing a base resolves the relative case and is ignored when the
  // configured value is already absolute, as it is in local dev.
  const target = new URL(url('/api/v1/auth/session/login'), window.location.origin);
  target.searchParams.set('returnTo', returnTo);
  // The API may not be on this origin (locally it is :2742 to our :3000), so it
  // cannot work out on its own where to send the browser back to. It checks
  // this against its CORS allowlist before redirecting anywhere.
  target.searchParams.set('appOrigin', window.location.origin);
  // Carried through the flow and handed back on the callback redirect, so a
  // consent the user was part-way through survives the login round-trip.
  if (consentAttempt) target.searchParams.set('consentAttempt', consentAttempt);
  window.location.href = target.toString();
}

/**
 * Ends the session, then hands off to Keycloak's end-session endpoint.
 *
 * Both halves matter: dropping only the local session leaves the SSO session
 * alive, so the next login silently signs the same user straight back in.
 *
 * Returns whether the server actually ended the session, so the caller can tell
 * the user their sign-out did not take rather than showing signed-out chrome
 * over a live session.
 */
export async function endBffSession(): Promise<boolean> {
  let endSessionUrl: string | null = null;
  let ended = false;
  try {
    const response = await fetch(url('/api/v1/auth/session/logout'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
    });
    if (response.ok) {
      ended = true;
      ({ endSessionUrl } = (await response.json()) as { endSessionUrl: string });
    }
  } catch {
    // Reported, not swallowed. The caller has already cleared the local UI, so
    // a failure here means the cookie, the Redis session and the SSO session
    // are all still alive while the screen says "signed out" — on a shared
    // machine the next reload silently restores the previous user.
  }
  csrfToken = null;
  if (endSessionUrl) window.location.href = endSessionUrl;
  return ended;
}
