import axios from 'axios';

import { apiConfig } from './api-config';
import { getAuthToken } from './auth-token';
import { emitSessionExpired } from './auth-events';

export function createApiClient() {
  const client = axios.create({
    baseURL: apiConfig.getUrl(),
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  client.interceptors.request.use((config) => {
    const token = getAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // A rejected token must TERMINATE the client's session, not just fail one
  // request. There was no response interceptor at all, so nothing ever told the
  // app its credentials had stopped working: `auth-context` kept reporting
  // `isAuthenticated`, every `enabled: isAuthenticated` query kept polling, and
  // React Query's `retry` tripled each failure. Measured on an expired session:
  // bursts of nine 401s per poll cycle, indefinitely, with no redirect.
  //
  // Narrow on purpose. Only `TOKEN_EXPIRED` (`utils/keycloak_token.ts`) and
  // `NO_ACTIVE_SESSION` mean "your credentials are gone" — a 401 from anything
  // else (a route the user simply may not call) must stay an ordinary error, or
  // one unlucky request would sign them out. Keyed on the body's `code`, not
  // `error`: the API returns `{ code: 'TOKEN_EXPIRED', error: 'Unauthorized' }`.
  //
  // Renewal is handled upstream by `automaticSilentRenew` (`oidc-client.ts`),
  // so by the time a `TOKEN_EXPIRED` reaches here the refresh token is spent
  // too. This does not attempt its own refresh — that would race the library's.
  client.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      // Optional-chained: an interceptor that throws on a malformed rejection
      // would replace the real failure with a TypeError, hiding it.
      const res = (error as { response?: { status?: number; data?: { code?: string } } } | undefined)
        ?.response;
      const code = res?.data?.code;
      if (res?.status === 401 && (code === 'TOKEN_EXPIRED' || code === 'NO_ACTIVE_SESSION')) {
        emitSessionExpired();
      }
      return Promise.reject(error);
    },
  );

  return client;
}
