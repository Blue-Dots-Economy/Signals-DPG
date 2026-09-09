import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The client half of the httpOnly-cookie session (AUTH-VULN-03/04).
 *
 * The module's defining property is a negative one — it holds no credential —
 * so most of what is worth asserting is that nothing lands in storage and that
 * every call carries the cookie. The CSRF token is the one value it does keep,
 * and only in memory.
 */

// `getUrl()` returns '' wherever the API is served under the UI's own origin —
// which is what the chart writes (`VITE_API_URL: ""`). Local dev is the only
// place it is absolute, so a fixture that is always absolute tests the case
// that does NOT ship.
const api = vi.hoisted(() => ({ base: 'http://api.test' }));
vi.mock('../api-config', () => ({ apiConfig: { getUrl: () => api.base } }));

const {
  clearCsrfToken,
  endBffSession,
  fetchBffSession,
  getCsrfToken,
  startBffLogin,
} = await import('../bff-session.js');

const fetchMock = vi.fn();
const originalLocation = window.location;

const setLocation = (href: string) => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href, origin: new URL(href).origin },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  api.base = 'http://api.test';
  vi.stubGlobal('fetch', fetchMock);
  clearCsrfToken();
  localStorage.clear();
  sessionStorage.clear();
  setLocation('http://localhost:3000/home');
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

describe('fetchBffSession', () => {
  it('asks the API and keeps the CSRF token in memory only', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: true, csrfToken: 'csrf-1' }));

    await expect(fetchBffSession()).resolves.toEqual({
      authenticated: true,
      csrfToken: 'csrf-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/auth/session');
    expect(getCsrfToken()).toBe('csrf-1');
    // The finding, as an assertion: nothing this module handles is persisted.
    // Keyed rather than counted, so a failure names what leaked.
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('sends credentials, which is what carries the cookie cross-origin', async () => {
    // The UI and API are different origins locally, and may be in a
    // deployment; without this the cookie is simply never sent and every
    // request looks logged out.
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: false }));

    await fetchBffSession();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('reports signed-out and drops any stale token on a non-OK response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ authenticated: true, csrfToken: 'c' }));
    await fetchBffSession();
    expect(getCsrfToken()).toBe('c');

    fetchMock.mockResolvedValue(jsonResponse({}, false));

    await expect(fetchBffSession()).resolves.toEqual({ authenticated: false });
    expect(getCsrfToken()).toBeNull();
  });

  it('treats a network failure as signed-out rather than throwing', async () => {
    // The caller renders the signed-out state and the next call retries; an
    // exception here would take down whatever rendered it.
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(fetchBffSession()).resolves.toEqual({ authenticated: false });
    expect(getCsrfToken()).toBeNull();
  });
});

describe('startBffLogin', () => {
  it('navigates to the API, carrying returnTo and this origin', async () => {
    startBffLogin('/profile/new');

    const target = new URL(window.location.href);
    expect(target.origin + target.pathname).toBe('http://api.test/api/v1/auth/session/login');
    expect(target.searchParams.get('returnTo')).toBe('/profile/new');
    // The API cannot work out where to send the browser back to on its own;
    // it validates this against its CORS allowlist before using it.
    expect(target.searchParams.get('appOrigin')).toBe('http://localhost:3000');
  });

  it('carries a consent attempt when one is in progress, and omits it otherwise', () => {
    startBffLogin('/', 'attempt-1');
    expect(new URL(window.location.href).searchParams.get('consentAttempt')).toBe('attempt-1');

    setLocation('http://localhost:3000/home');
    startBffLogin('/');
    expect(new URL(window.location.href).searchParams.has('consentAttempt')).toBe(false);
  });

  it('works when the API is same-origin, where getUrl() is the empty string', () => {
    // The deployed configuration. `new URL('/path')` with no base throws
    // `Invalid URL`, so this is the difference between login working and the
    // sign-in button dying before it ever reaches the API.
    api.base = '';

    expect(() => startBffLogin('/')).not.toThrow();

    const target = new URL(window.location.href);
    expect(target.origin).toBe('http://localhost:3000');
    expect(target.pathname).toBe('/api/v1/auth/session/login');
    expect(target.searchParams.get('appOrigin')).toBe('http://localhost:3000');
  });

  it('is a full navigation, not a fetch', () => {
    // The flow ends in a Keycloak redirect and a Set-Cookie on the way back,
    // neither of which survives an XHR.
    startBffLogin('/');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('endBffSession', () => {
  it('posts the logout with the CSRF token and then hands off to Keycloak', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: true, csrfToken: 'csrf-1' }));
    await fetchBffSession();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ endSessionUrl: 'https://kc.test/logout?x=1' }),
    );

    await endBffSession();

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://api.test/api/v1/auth/session/logout');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(init.headers['x-csrf-token']).toBe('csrf-1');
    // Both halves matter: dropping only the local session leaves SSO alive and
    // the next login signs the same user straight back in.
    expect(window.location.href).toBe('https://kc.test/logout?x=1');
  });

  it('reports whether the server actually ended the session', async () => {
    // The caller has already cleared the local UI by this point. A swallowed
    // failure leaves signed-out chrome over a live cookie, Redis session and
    // SSO session — on a shared machine the next reload restores the previous
    // user.
    fetchMock.mockResolvedValueOnce(jsonResponse({ endSessionUrl: 'https://kc.test/logout' }));
    await expect(endBffSession()).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    await expect(endBffSession()).resolves.toBe(false);

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(endBffSession()).resolves.toBe(false);
  });

  it('forgets the CSRF token even when the logout call fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ authenticated: true, csrfToken: 'csrf-1' }));
    await fetchBffSession();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await endBffSession();

    expect(getCsrfToken()).toBeNull();
    // Nothing useful to redirect to, so the user stays put rather than being
    // sent somewhere arbitrary.
    expect(window.location.href).toBe('http://localhost:3000/home');
  });

  it('does not redirect when the API refuses the logout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));

    await endBffSession();

    expect(window.location.href).toBe('http://localhost:3000/home');
  });

  it('omits the CSRF header when there is no session to prove', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ endSessionUrl: 'https://kc.test/logout' }));

    await endBffSession();

    expect(fetchMock.mock.calls[0][1].headers['x-csrf-token']).toBeUndefined();
  });
});
