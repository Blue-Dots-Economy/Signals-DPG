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
      csrfToken = null;
      return { authenticated: false };
    }
    const session = (await response.json()) as BffSession;
    csrfToken = session.csrfToken ?? null;
    return session;
  } catch {
    // Network failure is indistinguishable from logged-out for our purposes;
    // the caller renders the signed-out state and the next call retries.
    csrfToken = null;
    return { authenticated: false };
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
 */
export async function endBffSession(): Promise<void> {
  let endSessionUrl: string | null = null;
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
      ({ endSessionUrl } = (await response.json()) as { endSessionUrl: string });
    }
  } catch {
    // Fall through: the cookie is cleared server-side on any successful call,
    // and if the call itself failed there is nothing useful to redirect to.
  }
  csrfToken = null;
  if (endSessionUrl) window.location.href = endSessionUrl;
}
