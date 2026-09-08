/**
 * `startOidcLogin`'s forced re-prompt.
 *
 * The aggregator portal shares this Keycloak realm, so an existing SSO cookie
 * makes Keycloak reissue the same identity without asking. `prompt=login` is
 * the only thing that lets a user pick a different account — and it must stay
 * OFF by default, or every ordinary sign-in loses SSO (#753).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const signinRedirect =
  vi.fn<(args?: Record<string, unknown>) => Promise<void>>(async () => undefined);

vi.mock('oidc-client-ts', () => ({
  UserManager: class {
    signinRedirect = signinRedirect;
  },
  WebStorageStateStore: class {},
}));

vi.mock('@/lib/keycloak-config', () => ({
  getKeycloakConfig: () => ({
    authority: 'http://kc.test/realms/bluedots',
    clientId: 'signals-ui',
    redirectUri: 'http://app.test/auth/callback',
    postLogoutRedirectUri: 'http://app.test/',
    scope: 'openid profile email',
  }),
}));

vi.mock('@/lib/auth-token', () => ({ setAuthToken: vi.fn(), clearAuthToken: vi.fn() }));

const serverConfig = { keycloak: { authority: 'x', clientId: 'y' } } as never;

describe('startOidcLogin', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetUserManager } = await import('@/lib/oidc-client');
    resetUserManager();
  });

  it('does not send `prompt` on an ordinary login, so SSO still applies', async () => {
    const { startOidcLogin } = await import('@/lib/oidc-client');
    await startOidcLogin(serverConfig);
    expect(signinRedirect).toHaveBeenCalledTimes(1);
    expect(signinRedirect.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
  });

  it('sends `prompt=login` when a re-prompt is forced', async () => {
    const { startOidcLogin } = await import('@/lib/oidc-client');
    await startOidcLogin(serverConfig, undefined, undefined, true);
    expect(signinRedirect.mock.calls[0]?.[0]).toMatchObject({ prompt: 'login' });
  });

  it('still round-trips returnTo alongside the forced prompt', async () => {
    // The two features must not cancel each other: switching account should
    // still land the user where they were headed.
    const { startOidcLogin } = await import('@/lib/oidc-client');
    await startOidcLogin(serverConfig, '/my-actions', undefined, true);
    expect(signinRedirect.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'login',
      state: { returnTo: '/my-actions', consentAttempt: undefined },
    });
  });
});
