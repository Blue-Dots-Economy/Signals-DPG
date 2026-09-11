/**
 * One-shot handoff of a wrong-portal bounce across the Keycloak logout redirect.
 *
 * Why this exists: when the domain gate turns a user away (they hold a profile
 * in a domain this portal does not serve), both login paths call `signOut()`
 * and then `navigate('/auth/login', { state: { wrongPortalDomain } })`, and the
 * login page turns that router state into the `auth.wrong_portal` toast.
 *
 * That works on the better-auth path, where `signOut()` is a local API call.
 * Under Keycloak it does not: `signOut()` → `endBffSession()` →
 * `userManager.signoutRedirect()`, a FULL-PAGE navigation to Keycloak's
 * end-session endpoint. The await never resolves, so the `navigate` after it
 * never runs; Keycloak then returns the browser to `postLogoutRedirectUri`
 * (the site root) with a fresh document and no router state. The user was
 * correctly blocked and signed out, but landed on the logged-out home page
 * with no explanation of why.
 *
 * Router state cannot survive a full page load, so the reason is parked here
 * instead — same read-once localStorage pattern as `pending-consent.ts` and
 * `pending-signup-extras.ts` — and surfaced by `<WrongPortalToast />`, which is
 * mounted app-wide precisely because the landing route is whatever
 * `postLogoutRedirectUri` points at, not `/auth/login`.
 */

const STORAGE_KEY = 'pendingWrongPortal';

/**
 * How long a parked bounce stays worth showing. The gap between parking and
 * landing is one Keycloak round-trip (seconds), so anything older belongs to an
 * abandoned logout — the tab was closed mid-redirect, or Keycloak never came
 * back. Without this, that stale entry would ambush the user with an
 * out-of-nowhere error on some later, unrelated visit.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

interface PendingWrongPortal {
  domain: string;
  at: number;
}

/**
 * Park the blocked domain immediately BEFORE signing out — `signOut()` may
 * never return control on the Keycloak path.
 *
 * @param domain - The domain the user already holds a profile in.
 * @param now - Injectable clock for tests.
 */
export function setPendingWrongPortal(domain: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ domain, at: now } satisfies PendingWrongPortal));
  } catch {
    // Storage unavailable (private mode, quota). The bounce itself still
    // happened — only the explanation is lost, which is today's behaviour.
  }
}

/**
 * Read and clear the parked bounce.
 *
 * @param now - Injectable clock for tests.
 * @returns The blocked domain, or null when there is no fresh bounce to report.
 */
export function takePendingWrongPortal(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as PendingWrongPortal;
    if (!parsed || typeof parsed.domain !== 'string' || parsed.domain === '') return null;
    if (typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null;
    return parsed.domain;
  } catch {
    // Corrupt payload — drop it rather than retrying forever.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}
