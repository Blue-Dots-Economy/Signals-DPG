import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The CSRF header on state-changing requests (AUTH-VULN-03/04).
 *
 * A cookie is attached by the browser automatically, so the token is what tells
 * the API this request came from our own page. Sending it late — or not at all
 * — is a 403 the caller does not retry, which on a first login costs that
 * user's parked consent acknowledgment.
 */

const state = vi.hoisted(() => ({ token: null as string | null, fetches: 0 }));

vi.mock('../bff-session', () => ({
  fetchBffSession: async () => {
    state.fetches += 1;
    state.token = 'csrf-late';
    return { authenticated: true };
  },
  getCsrfToken: () => state.token,
  clearCsrfToken: () => { state.token = null; },
}));
vi.mock('../api-config', () => ({ apiConfig: { getUrl: () => '' } }));

const { createApiClient } = await import('../api-client.js');

type Interceptor = (c: { method: string; headers: Record<string, string> }) =>
  Promise<{ headers: Record<string, string> }>;

function requestInterceptor(): Interceptor {
  const client = createApiClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.interceptors.request as any).handlers[0].fulfilled as Interceptor;
}

beforeEach(() => { state.token = null; state.fetches = 0; });

describe('createApiClient request interceptor', () => {
  it('waits for the session rather than sending a write with no token', async () => {
    // The token is populated by `fetchBffSession()` in the AuthProvider effect,
    // and React runs CHILD effects before parent ones — so the callback page's
    // chain can POST before the provider's fetch has landed.
    const run = requestInterceptor();

    const posted = await run({ method: 'post', headers: {} });

    expect(state.fetches).toBe(1);
    expect(posted.headers['x-csrf-token']).toBe('csrf-late');
  });

  it('does not pay for it twice once the token is known', async () => {
    const run = requestInterceptor();
    await run({ method: 'post', headers: {} });
    const again = await run({ method: 'put', headers: {} });

    expect(state.fetches).toBe(1);
    expect(again.headers['x-csrf-token']).toBe('csrf-late');
  });

  it('never sends the token, or fetches, on a safe method', async () => {
    const run = requestInterceptor();

    for (const method of ['get', 'head', 'options']) {
      const res = await run({ method, headers: {} });
      expect(res.headers['x-csrf-token']).toBeUndefined();
    }
    expect(state.fetches).toBe(0);
  });

  it('never sends an Authorization header', async () => {
    // The whole point: there is no token in the page to put in one.
    const run = requestInterceptor();
    const posted = await run({ method: 'post', headers: {} });

    expect(posted.headers.Authorization).toBeUndefined();
    expect(posted.headers.authorization).toBeUndefined();
  });
});
