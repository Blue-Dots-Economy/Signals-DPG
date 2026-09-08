/**
 * OIDC Authorization Code + PKCE client for the signals UI.
 *
 * Thin wrapper over `oidc-client-ts`'s UserManager. The library owns the parts
 * that are easy to get subtly wrong — PKCE challenge/verifier, `state` and
 * `nonce` generation and validation, the code exchange, refresh-token rotation.
 *
 * Two deliberate configuration choices:
 *
 * 1. **No silent-renew iframes.** `automaticSilentRenew` drives renewal through
 *    a hidden iframe against Keycloak, which browsers increasingly break by
 *    blocking third-party cookies. We renew with the refresh token instead.
 * 2. **The access token is mirrored into `auth-token.ts`** after every sign-in
 *    and renewal, because the existing axios interceptor reads it from there.
 *    That keeps `api-client.ts` untouched and means every `*-api.ts` module
 *    works under either provider with no changes.
 *
 * Where tokens live is still an open decision (§10, decision 4): this follows
 * Build 2's stated assumption — bearer token in localStorage, as today — and a
 * later move to a BFF would replace this module wholesale rather than edit it.
 */

import { UserManager, WebStorageStateStore, type User as OidcUser } from 'oidc-client-ts';
import { getKeycloakConfig } from './keycloak-config';
import type { AuthConfigResponse } from './auth-api';
import { setAuthToken, clearAuthToken } from './auth-token';

let manager: UserManager | null = null;

/**
 * The UserManager, created on first use.
 *
 * Lazy because constructing it reads `window.location` and touches storage —
 * work that must not happen at import time in a deployment still running the
 * OTP login, or in tests.
 *
 * Takes the server's auth config because the Keycloak URL/realm/client now come
 * from `GET /api/v1/auth/config` rather than build-time env, so this cannot be
 * built until that response is in hand.
 */
export function getUserManager(serverConfig: AuthConfigResponse | null | undefined): UserManager | null {
  if (manager) return manager;

  const config = getKeycloakConfig(serverConfig);
  if (!config) return null;

  manager = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: 'code',
    scope: config.scope,
    // Keep the completed session in localStorage so a reload doesn't bounce the
    // user back through Keycloak; the in-flight PKCE verifier stays in
    // sessionStorage (the library's default) where it belongs.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    /**
     * Renew in the background, using the refresh token.
     *
     * This was `false`, which combined badly with the realm's 300s
     * `accessTokenLifespan`: five minutes after login the stored user reports
     * `expired`, `getStoredOidcUser` returns null, and the next `authCfg`
     * refetch (React Query returns a fresh object, re-running the restore in
     * auth-context) resolved that as "logged out" — the top bar flipped to a
     * Login button while React Query's cached data kept the rest of the page
     * looking signed in. Clicking Login appeared to "work" only because the
     * Keycloak SSO cookie was still valid.
     *
     * oidc-client-ts renews from the refresh token when one is present, so no
     * silent-iframe route (`silent_redirect_uri`) is required. If the refresh
     * token is gone or rejected, renewal fails and the user is treated as
     * signed out — which is then correct rather than premature.
     */
    automaticSilentRenew: true,
    // Renew a minute before expiry rather than racing the deadline.
    accessTokenExpiringNotificationTimeInSeconds: 60,
  });

  return manager;
}

/** Test seam: forget the memoised manager. Not used in normal operation. */
export function resetUserManager(): void {
  manager = null;
}

/**
 * Send the browser to Keycloak. Does not return — the page navigates away.
 *
 * `forceReauth` adds `prompt=login`, which is the only way to let someone pick
 * a different account: the aggregator portal shares this realm, so an existing
 * SSO cookie otherwise makes Keycloak reissue the same identity without asking
 * and the user lands back on the error they just came from (#753). Off by
 * default — an ordinary login should still reuse SSO.
 */
export async function startOidcLogin(
  serverConfig: AuthConfigResponse | null | undefined,
  returnTo?: string,
  consentAttempt?: string,
  forceReauth = false
): Promise<void> {
  const userManager = getUserManager(serverConfig);
  if (!userManager) throw new Error('Keycloak is not configured');

  await userManager.signinRedirect({
    ...(forceReauth ? { prompt: 'login' } : {}),
    // Round-tripped through Keycloak in `state` and handed back on the
    // callback, so a deep link survives the redirect.
    //
    // `consentAttempt` rides along for a different reason: it is what lets the
    // callback prove a parked consent acceptance belongs to THIS login and not
    // to an earlier person who abandoned the round trip on a shared device.
    // See lib/pending-consent.ts. Because oidc-client-ts keys this payload by
    // the `state` parameter Keycloak echoes back, another login cannot receive
    // it — which is precisely the binding we need.
    state: returnTo || consentAttempt ? { returnTo, consentAttempt } : undefined,
  });
}

export interface OidcCallbackResult {
  accessToken: string;
  /** Where the user was headed before login, if anywhere. */
  returnTo?: string;
  /**
   * Id of the login attempt that started this redirect, when one parked a
   * consent acceptance. Only this login may consume that entry — see
   * lib/pending-consent.ts.
   */
  consentAttempt?: string;
}

/**
 * Complete the redirect: exchange the code, store the tokens, and mirror the
 * access token where the axios interceptor reads it.
 */
export async function completeOidcLogin(
  serverConfig: AuthConfigResponse | null | undefined
): Promise<OidcCallbackResult> {
  const userManager = getUserManager(serverConfig);
  if (!userManager) throw new Error('Keycloak is not configured');

  const user = await userManager.signinCallback();

  // Drop `code`/`state` from the address bar as soon as they are spent, so a
  // refresh or a shared URL can't replay them. Done here rather than on the
  // page so it also happens on the error path, where the page stays put.
  if (typeof window !== 'undefined') {
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (!user?.access_token) {
    throw new Error('Keycloak returned no access token');
  }

  setAuthToken(user.access_token);

  const state = user.state as { returnTo?: string; consentAttempt?: string } | undefined;
  return {
    accessToken: user.access_token,
    returnTo: state?.returnTo,
    consentAttempt: state?.consentAttempt,
  };
}

/**
 * The stored session, if there is a usable one.
 *
 * Returns null for an expired access token rather than handing back something
 * the API will reject; the caller renews or re-authenticates.
 */
export async function getStoredOidcUser(
  serverConfig: AuthConfigResponse | null | undefined
): Promise<OidcUser | null> {
  const userManager = getUserManager(serverConfig);
  if (!userManager) return null;

  const user = await userManager.getUser();
  if (!user || user.expired) return null;
  return user;
}

/**
 * Refresh the access token using the refresh token. Returns the new token, or
 * null when there is nothing to refresh with (which means "re-authenticate",
 * not "error").
 */
export async function renewOidcToken(
  serverConfig: AuthConfigResponse | null | undefined
): Promise<string | null> {
  const userManager = getUserManager(serverConfig);
  if (!userManager) return null;

  try {
    const user = await userManager.signinSilent();
    if (!user?.access_token) return null;
    setAuthToken(user.access_token);
    return user.access_token;
  } catch {
    return null;
  }
}

/**
 * Restore a session on page load: use the stored token if still valid, else
 * try one refresh. Returns the usable access token, or null.
 */
export async function restoreOidcSession(
  serverConfig: AuthConfigResponse | null | undefined
): Promise<string | null> {
  const stored = await getStoredOidcUser(serverConfig);
  if (stored?.access_token) {
    setAuthToken(stored.access_token);
    return stored.access_token;
  }
  return renewOidcToken(serverConfig);
}

/**
 * RP-initiated logout: clear local state first, then hand off to Keycloak so
 * the SSO session ends too. Clearing first means a failure to reach Keycloak
 * still logs the user out of this app rather than leaving a live local token.
 */
export async function oidcLogout(
  serverConfig: AuthConfigResponse | null | undefined
): Promise<void> {
  const userManager = getUserManager(serverConfig);
  clearAuthToken();

  if (!userManager) return;

  try {
    await userManager.signoutRedirect();
  } catch {
    // Keycloak unreachable, or no id_token to hand back. The local session is
    // already gone, which is the part that matters for this browser.
    await userManager.removeUser();
  }
}
