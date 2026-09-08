import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The renewal wiring — the actual defect behind the "401s forever" report.
 *
 * `automaticSilentRenew` was already on and already working: the token request
 * fired and returned 200. But oidc-client-ts keeps the result in its own
 * `userStore`, and nothing copied it into the `auth-token` entry that
 * `api-client`'s request interceptor reads. Measured live against the test
 * realm (300s access tokens): the SAME token — identical `jti` and `sid` — was
 * still being sent 11 minutes past its `exp`, over 56 requests and climbing.
 */

const handlers: Record<string, ((u?: unknown) => void) | undefined> = {};
const events = {
  addUserLoaded: (cb: (u: unknown) => void) => {
    handlers.userLoaded = cb;
  },
  addUserUnloaded: (cb: () => void) => {
    handlers.userUnloaded = cb;
  },
  addSilentRenewError: (cb: () => void) => {
    handlers.silentRenewError = cb;
  },
};
const managerConfig: { value: unknown } = { value: null };

vi.mock('oidc-client-ts', () => ({
  UserManager: class {
    events = events;
    constructor(cfg: unknown) {
      managerConfig.value = cfg;
    }
  },
  WebStorageStateStore: class {},
}));

const setAuthToken = vi.fn();
const clearAuthToken = vi.fn();
vi.mock('../auth-token', () => ({
  setAuthToken: (t: string) => setAuthToken(t),
  clearAuthToken: () => clearAuthToken(),
  getAuthToken: () => null,
}));

const emitSessionExpired = vi.fn();
vi.mock('../auth-events', () => ({ emitSessionExpired: () => emitSessionExpired() }));

vi.mock('../keycloak-config', () => ({
  getKeycloakConfig: () => ({
    authority: 'https://auth.test/realms/bluedots',
    clientId: 'signals-ui',
    redirectUri: 'http://localhost/auth/callback',
    postLogoutRedirectUri: 'http://localhost/',
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const k of Object.keys(handlers)) delete handlers[k];
});

async function build() {
  const { getUserManager } = await import('../oidc-client');
  return getUserManager({ authProvider: 'keycloak' } as never);
}

describe('oidc-client — silent renew reaches the API client', () => {
  it('keeps automaticSilentRenew on, renewing before expiry', async () => {
    await build();
    const cfg = managerConfig.value as {
      automaticSilentRenew?: boolean;
      accessTokenExpiringNotificationTimeInSeconds?: number;
    };
    expect(cfg.automaticSilentRenew).toBe(true);
    // Renew ahead of the deadline rather than racing it.
    expect(cfg.accessTokenExpiringNotificationTimeInSeconds).toBeGreaterThan(0);
  });

  it('subscribes to userLoaded — the subscription that was missing', async () => {
    await build();
    expect(typeof handlers.userLoaded).toBe('function');
  });

  it('writes each renewed access token where the request interceptor reads it', async () => {
    await build();
    handlers.userLoaded?.({ access_token: 'renewed-token-2' });
    expect(setAuthToken).toHaveBeenCalledWith('renewed-token-2');
  });

  it('ignores a renew event carrying no access token', async () => {
    await build();
    handlers.userLoaded?.({});
    handlers.userLoaded?.(undefined);
    expect(setAuthToken).not.toHaveBeenCalled();
  });

  it('clears the stored token when the user is unloaded', async () => {
    await build();
    handlers.userUnloaded?.();
    expect(clearAuthToken).toHaveBeenCalledTimes(1);
  });

  it('raises session-expired only when RENEWAL fails', async () => {
    // Renewal failing means the refresh token is spent — the one legitimate
    // trigger for signing someone out. A routine 5-minute access-token expiry
    // is absorbed by userLoaded above and must never reach this path.
    await build();
    expect(emitSessionExpired).not.toHaveBeenCalled();

    handlers.silentRenewError?.();
    await new Promise((r) => setTimeout(r, 0)); // dynamic import in the handler

    expect(emitSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('binds the handlers once even when getUserManager is called repeatedly', async () => {
    const { getUserManager } = await import('../oidc-client');
    const a = getUserManager({ authProvider: 'keycloak' } as never);
    const b = getUserManager({ authProvider: 'keycloak' } as never);
    expect(a).toBe(b);

    handlers.userLoaded?.({ access_token: 'once' });
    expect(setAuthToken).toHaveBeenCalledTimes(1);
  });
});
