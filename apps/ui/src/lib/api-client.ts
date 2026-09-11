import axios from 'axios';

import { apiConfig } from './api-config';
import { emitSessionExpired } from './auth-events';
import { fetchBffSession, getCsrfToken } from './bff-session';

export function createApiClient() {
  const client = axios.create({
    baseURL: apiConfig.getUrl(),
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // No Authorization header: the session rides an httpOnly cookie the browser
  // attaches itself (`withCredentials` above), and the token it stands for
  // never reaches this code. A cookie is sent on cross-site requests too, so
  // state-changing calls carry a CSRF token the API checks against the session.
  client.interceptors.request.use(async (config) => {
    const method = (config.method ?? 'get').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      let csrf = getCsrfToken();
      /**
       * The token is held in memory and populated by `fetchBffSession()` in the
       * AuthProvider effect. React runs CHILD effects before parent ones, so on
       * a first login the callback page's chain (resolve user → flush the
       * parked consent) can start before the provider's fetch has landed —
       * sending the write without a token, earning a 403 nothing retries, and
       * losing that user's consent acknowledgment.
       *
       * Awaiting here closes the race deterministically. `fetchBffSession` uses
       * `fetch`, not this client, so there is no recursion, and once the token
       * is cached this costs nothing.
       */
      if (!csrf) {
        await fetchBffSession();
        csrf = getCsrfToken();
      }
      if (csrf) config.headers['x-csrf-token'] = csrf;
    }
    return config;
  });

  /**
   * A dead session must TERMINATE the client's, not just fail one request.
   *
   * There was no response interceptor at all, so nothing ever told the app its
   * credentials had stopped working: `auth-context` kept reporting
   * `isAuthenticated`, every `enabled: isAuthenticated` query kept polling, and
   * React Query's `retry` tripled each failure. Measured on an expired session:
   * bursts of nine 401s per poll cycle, indefinitely, with no redirect. The BFF
   * did not change that — `fetchSession` runs on mount only, so a session dying
   * mid-use is discovered ONLY here.
   *
   * ## Why the trigger is not just `code === 'UNAUTHORIZED'`
   *
   * Under the cookie session a dead session resolves to `UNAUTHORIZED` — but so
   * does a request from someone who was never signed in. Firing on the code
   * alone would tell a logged-out visitor their session expired.
   *
   * The gate must therefore be HERE, before `emitSessionExpired`, not inside the
   * handler: that emit is latched to fire once per page, so an anonymous 401
   * would spend the latch and swallow a real expiry later in the same page.
   *
   * `getCsrfToken()` is the non-React signal for "we hold a session" — it is
   * populated only by a successful `fetchBffSession`, and a 401 does not clear
   * it. `TOKEN_EXPIRED`/`NO_ACTIVE_SESSION` are kept for the betterauth and
   * service paths, which carry no CSRF token.
   *
   * Deliberately narrow either way: a 401 from a route the user merely may not
   * call has to stay an ordinary error. A 5xx never qualifies — the API answers
   * a dependency outage with 503 precisely so it does not read as a logout
   * (see `bff-session.ts`'s `unknown`).
   */
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      // Optional-chained: an interceptor that throws on a malformed rejection
      // would replace the real failure with a TypeError, hiding it.
      const res = (error as { response?: { status?: number; data?: { code?: string } } } | undefined)
        ?.response;
      const code = res?.data?.code;
      const sessionIsGone =
        code === 'TOKEN_EXPIRED' ||
        code === 'NO_ACTIVE_SESSION' ||
        (code === 'UNAUTHORIZED' && getCsrfToken() !== null);
      if (res?.status === 401 && sessionIsGone) {
        emitSessionExpired();
      }
      return Promise.reject(error);
    },
  );

  return client;
}
