/**
 * `startOidcLogin` must never send `prompt`.
 *
 * The aggregator portal shares this Keycloak realm. A forced re-prompt looks
 * like it would let a user pick a different account, but `prompt=login`
 * re-authenticates the CURRENT one: naming another makes Keycloak throw
 * USER_CONFLICT and report `invalid_user_credentials`, surfaced as "Invalid
 * username or password" on a passwordless flow. Switching goes through
 * `oidcLogout`; this file guards the option staying gone (#753).
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

  it('never sends `prompt`, even with a returnTo — switching goes via logout', async () => {
    const { startOidcLogin } = await import('@/lib/oidc-client');
    await startOidcLogin(serverConfig, { returnTo: '/my-actions' });
    const args = signinRedirect.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty('prompt');
    expect(args).toMatchObject({
      state: { returnTo: '/my-actions', consentAttempt: undefined },
    });
  });
});
