/**
 * One-time removal of the credentials the browser used to hold (AUTH-VULN-03/04).
 *
 * Moving the session behind an httpOnly cookie stops NEW tokens being written,
 * but it does nothing about the ones already sitting in `localStorage` on every
 * user's machine — and those are the tokens the pentest actually read. Nothing
 * in the app looks at them any more, so without this they would simply stay
 * there, readable by any script on the origin, until the storage was cleared by
 * hand.
 *
 * Two writers to undo: `auth-token.ts`, which kept the access token under a
 * fixed key, and `oidc-client-ts`, whose own store held the REFRESH token under
 * `oidc.user:<authority>:<client>` — a key that varies per deployment, so it is
 * matched by prefix rather than named.
 *
 * Safe to keep indefinitely and safe to drop once every active browser has run
 * it at least once; it is a few string comparisons on boot.
 */

const LEGACY_TOKEN_KEY = 'auth_token';
const LEGACY_OIDC_PREFIX = 'oidc.';

export function purgeLegacyAuthStorage(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);

    for (const store of [localStorage, sessionStorage]) {
      // Collected before removing: mutating the store mid-iteration reindexes
      // it, which silently skips entries.
      const stale = Object.keys(store).filter((key) => key.startsWith(LEGACY_OIDC_PREFIX));
      for (const key of stale) store.removeItem(key);
    }
  } catch {
    // Storage can be unavailable (Safari private mode, a blocked third-party
    // context). Failing to clean up must not stop the app from booting.
  }
}
