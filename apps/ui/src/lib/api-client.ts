import axios from 'axios';

import { apiConfig } from './api-config';
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

  return client;
}
