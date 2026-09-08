import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth-context';

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
  fetchBffSession: async () => ({ authenticated: false }) as { authenticated: boolean },
}));
vi.mock('@/lib/bff-session', () => ({
  fetchBffSession: () => bff.fetchBffSession(),
  endBffSession: async () => {},
  startBffLogin: () => {},
  getCsrfToken: () => null,
  clearCsrfToken: () => {},
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
