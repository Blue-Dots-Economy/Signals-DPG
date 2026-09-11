import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth, resolveKeycloakUser, HOLD } from './auth-context';

const { clearSchemaCache } = vi.hoisted(() => ({ clearSchemaCache: vi.fn() }));
vi.mock('@/engine', () => ({ clearSchemaCache }));

/**
 * The BFF session client (AUTH-VULN-03/04). Hoisted rather than `vi.doMock`d
 * inside a test, because `auth-context` imports it statically — a late
 * `doMock` would not be seen and the real module would try to `fetch`.
 * `bff.fetchBffSession` is reassignable so a single test can control when the
 * restore resolves.
 */
const bff = vi.hoisted(() => ({
  fetchBffSession: async () =>
    ({ authenticated: false }) as { authenticated: boolean; unknown?: boolean },
}));
vi.mock('@/lib/bff-session', () => ({
  fetchBffSession: () => bff.fetchBffSession(),
  endBffSession: async () => {},
  startBffLogin: () => {},
  getCsrfToken: () => null,
  clearCsrfToken: () => clearCsrfToken(),
}));
vi.mock('@/lib/auth-api', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signOut: vi.fn().mockResolvedValue(undefined),
  fetchMe: vi.fn().mockResolvedValue({
    id: 'u1',
    name: 'Aadhya',
    email: null,
    phoneNumber: '+919620388881',
    role: 'user',
  }),
  fetchAuthConfig: vi.fn().mockResolvedValue({
    selfSignupAllowed: false,
    loginChannels: ['phone', 'email'],
    authProvider: 'betterauth',
  }),
}));

/**
 * `auth-token.ts` is gone with the BFF change — there is no token in the page.
 * The in-memory CSRF token is what stands for a live session now, so that is
 * what the terminal-expiry path has to clear.
 */
const { clearCsrfToken } = vi.hoisted(() => ({ clearCsrfToken: vi.fn() }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('AuthProvider signOut', () => {
  beforeEach(() => clearSchemaCache.mockClear());

  it('clears the schema cache on sign-out', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await result.current.signOut();
    });
    expect(clearSchemaCache).toHaveBeenCalled();
  });

  it('clears the schema cache even when the sign-out API call fails', async () => {
    const authApi = await import('@/lib/auth-api');
    vi.mocked(authApi.signOut).mockRejectedValueOnce(new Error('network'));
    const client = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow('network');
    });
    expect(clearSchemaCache).toHaveBeenCalled();
  });

  it('clears every per-user cache (my-items, profile-consent, edit-item, actions, consent-status) on sign-out', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'removeQueries');
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await result.current.signOut();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['my-items'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['profile-consent'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['edit-item'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['actions'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['consent-status'] });
  });

  /**
   * Regression guard for a Critical found in the sibling aggregator repo
   * (apps/web): there, a "Register another" affordance reset the form but not
   * the accepted-consent flag, so participant #2 onward inherited consent as
   * already given with no documents shown. Signals has no such affordance,
   * but the equivalent risk here is `['consent-status', themeId]`
   * (`use-consent-gate.ts`, feeding the U18 guardian consent gate on the home
   * page): it is keyed ONLY by network, never by user, and its endpoint
   * reflects whichever session's auth token is attached when the request
   * resolves. Left uncleared across sign-out, the query cache — a store that
   * outlives the single login attempt that populated it — would serve the
   * first user's "already consented" snapshot to a second, different user who
   * signs in on the same device/tab before the background refetch (staleTime
   * 0) corrects it, skipping the documents for that window. Seeding the cache
   * with an actual entry (not just spying on the call) proves the entry is
   * genuinely gone afterwards, not merely that some `removeQueries` call was
   * made with a key that happened to match.
   */
  it('actually evicts a seeded consent-status entry, not just calls removeQueries with that key', async () => {
    const client = new QueryClient();
    client.setQueryData(['consent-status', 'network-a'], { statuses: { terms: [1], privacy: [1] } });
    expect(client.getQueryData(['consent-status', 'network-a'])).toBeDefined();

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await result.current.signOut();
    });

    expect(client.getQueryData(['consent-status', 'network-a'])).toBeUndefined();
  });
});

describe('resolveKeycloakUser — a dependency outage is not a logout', () => {
  /**
   * Tested directly rather than through the provider. From a cold start the
   * provider's `user` is null whether we HOLD or assert null, so a
   * provider-level test of `unknown` passes even with the branch deleted —
   * verified by deleting it. Here the three outcomes are distinct values.
   */
  const notSuperseded = () => false;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HOLDs when the API could not answer, without asking who the user is', async () => {
    // The API maps a Keycloak or Redis outage to 503 on purpose so it does not
    // read as "your session died". Collapsing that into signed-out logged every
    // user out over a 30-second blip.
    bff.fetchBffSession = async () => ({ authenticated: false, unknown: true });
    const authApi = await import('@/lib/auth-api');

    await expect(resolveKeycloakUser(notSuperseded)).resolves.toBe(HOLD);
    expect(authApi.fetchMe).not.toHaveBeenCalled();
  });

  it('returns null when the API definitively says there is no session', async () => {
    bff.fetchBffSession = async () => ({ authenticated: false });

    await expect(resolveKeycloakUser(notSuperseded)).resolves.toBeNull();
  });

  it('returns the user when the session is live', async () => {
    bff.fetchBffSession = async () => ({ authenticated: true, csrfToken: 'c' });

    const out = await resolveKeycloakUser(notSuperseded);

    expect(out).not.toBe(HOLD);
    expect((out as { id: string } | null)?.id).toBeDefined();
  });

  it('HOLDs when a login lands mid-flight, before the second request', async () => {
    bff.fetchBffSession = async () => ({ authenticated: true, csrfToken: 'c' });
    const authApi = await import('@/lib/auth-api');

    await expect(resolveKeycloakUser(() => true)).resolves.toBe(HOLD);
    expect(authApi.fetchMe).not.toHaveBeenCalled();
  });
});

describe('AuthProvider — a late session restore must not clobber a fresh login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bff.fetchBffSession = async () => ({ authenticated: false });
  });

  it('keeps the user set by completeKeycloakLogin when the restore resolves afterwards', async () => {
    /**
     * The first-login race, reproduced: on a fresh browser the mount-time
     * restore finds EMPTY storage (the code exchange has not finished) and
     * resolves null, but only AFTER the callback has already established the
     * user. Without a precedence guard `setUser(null)` lands last and the user
     * is signed out holding a valid token — /me keeps returning 200, cached
     * queries keep rendering, and only the top bar looks wrong. A second login
     * appeared to fix it because storage was populated by then.
     */
    const authApi = await import('@/lib/auth-api');
    vi.mocked(authApi.fetchAuthConfig).mockResolvedValue({
      selfSignupAllowed: false,
      loginChannels: ['phone', 'email'],
      authProvider: 'keycloak',
      keycloak: {
        url: 'http://kc.test/auth',
        realm: 'bluedots',
        clientId: 'signals-ui',
      },
    } as Awaited<ReturnType<typeof authApi.fetchAuthConfig>>);

    // A restore that finds nothing and resolves LAST. `restoreStarted` lets the
    // test wait until it is genuinely in flight — otherwise it can finish before
    // the login and the race is never exercised.
    let releaseRestore: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const restoreGate = new Promise<void>((res) => {
      releaseRestore = res;
    });
    const restoreStarted = new Promise<void>((res) => {
      markStarted = res;
    });
    // The session now comes from the BFF (AUTH-VULN-03/04) rather than from a
    // token in storage — same ordering hazard, different source.
    bff.fetchBffSession = async () => {
      markStarted?.();
      await restoreGate;
      return { authenticated: false };
    };
    const client = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });

    // Wait until the mount-time restore is actually in flight, so the ordering
    // under test is the real one.
    await act(async () => {
      await restoreStarted;
    });

    // The callback establishes the session while that restore is still pending…
    await act(async () => {
      await result.current.completeKeycloakLogin();
    });
    expect(result.current.isAuthenticated).toBe(true);

    // …then the stale restore resolves null. It must be discarded.
    await act(async () => {
      releaseRestore?.();
      await Promise.resolve();
    });

    expect(result.current.isAuthenticated).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Terminal session expiry — the path an unrecoverable 401 takes.
//
// `setUser(null)` here is what actually stops the polling: every polled query
// carries `enabled: isAuthenticated` (`use-actions.ts`). Before this existed,
// the client kept believing it was signed in and emitted 401s indefinitely —
// measured at 33 requests in 45s, in bursts of nine.
describe('AuthProvider — session expired', () => {
  let href: string;
  let pathname: string;
  let search: string;

  async function mountAndExpire(at = '/my-actions', qs = '?profile=abc') {
    pathname = at;
    search = qs;
    const client = new QueryClient();
    const cancelQueries = vi.spyOn(client, 'cancelQueries').mockResolvedValue(undefined);
    const removeQueries = vi.spyOn(client, 'removeQueries').mockReturnValue(undefined);
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    // The subscription is registered from a dynamic import inside an effect.
    const { emitSessionExpired } = await import('@/lib/auth-events');
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      emitSessionExpired();
      await new Promise((r) => setTimeout(r, 0));
    });
    return { result, cancelQueries, removeQueries };
  }

  beforeEach(async () => {
    vi.resetModules();
    clearCsrfToken.mockClear();
    toastError.mockClear();
    clearSchemaCache.mockClear();
    href = '';
    pathname = '/my-actions';
    search = '';
    const { resetSessionExpiredForTests } = await import('@/lib/auth-events');
    resetSessionExpiredForTests();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        get pathname() {
          return pathname;
        },
        get search() {
          return search;
        },
        set href(v: string) {
          href = v;
        },
        get href() {
          return href;
        },
      },
    });
  });

  it('drops the user, which is what disables every polled query', async () => {
    const { result } = await mountAndExpire();
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('clears the stored token', async () => {
    await mountAndExpire();
    expect(clearCsrfToken).toHaveBeenCalled();
  });

  it('cancels in-flight queries and drops the cache', async () => {
    // Otherwise a signed-out page keeps rendering the previous user's data.
    const { cancelQueries, removeQueries } = await mountAndExpire();
    expect(cancelQueries).toHaveBeenCalled();
    expect(removeQueries).toHaveBeenCalled();
    expect(clearSchemaCache).toHaveBeenCalled();
  });

  // Telling the user why is split by path, because a toast cannot survive a
  // full-page navigation: the sonner/i18next dynamic imports resolve on a later
  // microtask while `window.location.href` is assigned synchronously.
  it('carries the reason in the URL instead of a toast that cannot be seen', async () => {
    await mountAndExpire('/my-actions', '?profile=abc');
    expect(href).toContain('reason=expired');
    // Firing one here would be dead code that reads like user-facing feedback.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts when it stays on the page, where a toast can actually render', async () => {
    await mountAndExpire('/auth/login', '');
    expect(href).toBe('');
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('redirects to login carrying the reason and where to return', async () => {
    await mountAndExpire('/my-actions', '?profile=abc');
    expect(href).toContain('/auth/login');
    expect(href).toContain('reason=expired');
    expect(href).toContain(encodeURIComponent('/my-actions?profile=abc'));
  });

  it('does NOT navigate when already inside the login flow', async () => {
    // Navigating would discard a half-entered login.
    await mountAndExpire('/auth/login', '?reason=expired');
    expect(href).toBe('');
    expect(clearCsrfToken).toHaveBeenCalled();
  });
});
