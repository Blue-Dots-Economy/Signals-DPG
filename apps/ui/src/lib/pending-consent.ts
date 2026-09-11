/**
 * One-shot handoff of an accepted-but-not-yet-persisted consent across the
 * Keycloak redirect.
 *
 * `POST /api/v1/consent/accept` is **authenticated**, so a consent accepted on
 * the login screen can only be written once the user actually has a session.
 * The better-auth flow solves this by carrying the pending acceptance in router
 * state from `login-page` to `otp-page`, which calls `acceptConsent` after the
 * OTP verifies.
 *
 * The Keycloak flow can't use router state: signing in leaves the SPA entirely
 * for Keycloak's own pages, so in-memory and history state are both gone by the
 * time we return to `/auth/callback`. Storage survives that round trip.
 *
 * Read-once, like `signup-domain.ts`: the callback clears it as soon as it is
 * consumed, so a stale acceptance can never be replayed onto a later, unrelated
 * login — BUT read-once only protects against replaying it onto the SAME
 * person's later logins. It does nothing if the round trip is simply never
 * finished: `createAccountAndSignIn` writes this, then hands off to Keycloak's
 * hosted pages, a full-page navigation this app has no visibility into. If
 * that browser tab is abandoned there (closed, walked away from, the person
 * gives up) the entry sits in `localStorage` — which, unlike router state or
 * `sessionStorage`, is shared by every tab and survives indefinitely — until
 * SOME OTHER Keycloak callback on that device finds it and `acceptConsent`s it
 * onto whichever unrelated person's session happens to complete next. That
 * person never saw the documents this consent claims they accepted.
 *
 * ## Why a timestamp alone is not enough
 *
 * A TTL narrows that window; it cannot close it. `ConsentAcceptBody` carries no
 * subject — it is `{ network, brand, source, items }` — so nothing in the
 * payload says WHO accepted. Within the TTL, a second person signing in on the
 * same device lands on a callback that finds the first person's parked entry
 * and posts it against the second person's authenticated session. Because the
 * endpoint is authenticated and the body carries no subject, the server
 * attributes it to whoever is signed in and cannot detect the substitution.
 * That is manufactured evidence of consent, which is worse than no record at
 * all — and QR/kiosk registration on shared phones is a core journey here, so
 * it is not a theoretical ordering.
 *
 * So the entry is **bound to the login attempt that created it**. The caller
 * mints an opaque `attempt` id, parks it alongside the body, and hands it to
 * `startBffLogin`, which carries it through the flow server-side against that
 * login's `state` (see `services/auth/oidc_flow_state.ts` in the API). On the
 * callback, `takePendingConsent` returns the body only if the id handed back by
 * that specific login matches. A different person's login carries a different
 * `state`, so it can never consume this entry — regardless of timing.
 *
 * The timestamp is retained as belt-and-braces (bounding how long an
 * abandoned entry lingers at all), not as the primary defence.
 *
 * Entries written by an earlier version carry no `attempt` and are dropped on
 * read rather than honoured, so an upgrade cannot inherit an unbound record.
 */

import type { ConsentAcceptBody } from '@dpg/schemas';

const STORAGE_KEY = 'pendingConsent';

/** How long a parked acceptance stays worth honouring. See module doc. */
const MAX_AGE_MS = 5 * 60 * 1000;

interface StoredPendingConsent {
  body: ConsentAcceptBody;
  at: number;
  /** Opaque id of the login attempt allowed to consume this. See module doc. */
  attempt: string;
}

/**
 * Mint an id for one login attempt, or null if this browser cannot do so
 * securely.
 *
 * `getRandomValues` and nothing else. `randomUUID` would read better but
 * requires a secure context, and this app is served over plain http on a LAN
 * address during field testing, where it is `undefined`; `getRandomValues`
 * carries no such restriction, so one branch covers every browser we support.
 *
 * Deliberately no `Math.random()` fallback. It would only ever run where
 * `crypto` is absent entirely — which is no browser this app targets — so it
 * bought nothing, while making the weakest possible source the one used in the
 * least understood environment. Returning null instead pushes that decision to
 * the caller, which declines to park the acceptance at all: the user is
 * re-prompted after login, which is the safe direction to fail. A binding is
 * only worth having if it cannot be forged.
 */
export function newConsentAttemptId(): string | null {
  try {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      return null;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // A throwing `crypto` is treated the same as an absent one.
    return null;
  }
}

/**
 * Park the accepted consent immediately before redirecting to Keycloak.
 *
 * @param body - The consent acceptance to write once the session exists.
 * @param attempt - Id of this login attempt, from {@link newConsentAttemptId}.
 *   The same id must be routed through the OIDC `state` so the callback can
 *   prove the entry belongs to the login that landed. See module doc.
 * @param now - Injectable clock for tests.
 */
export function setPendingConsent(
  body: ConsentAcceptBody,
  attempt: string,
  now: number = Date.now(),
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ body, at: now, attempt } satisfies StoredPendingConsent),
    );
  } catch {
    // Storage unavailable (private mode, quota). The consent gate will simply
    // re-prompt on the next login rather than the login failing.
  }
}

/**
 * Read and clear.
 *
 * Always clears, including on every rejection path: an entry that this login
 * is not entitled to must not be left behind for the next one to find.
 *
 * @param expectedAttempt - The attempt id carried back by the login that just
 *   landed. A parked entry is honoured only when it matches. `undefined` — a
 *   sign-in that parked no consent — never matches, which is the case that
 *   stops one person's acceptance being written against another's session.
 * @param now - Injectable clock for tests.
 * @returns The parked acceptance, or null when there is nothing pending, it
 *   belongs to a different login attempt, it is too old to trust, or the
 *   payload is corrupt.
 */
export function takePendingConsent(
  expectedAttempt: string | undefined,
  now: number = Date.now(),
): ConsentAcceptBody | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as StoredPendingConsent;
    if (!parsed || typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null;
    if (!parsed.body) return null;
    // Identity check. Both sides must be present and equal — a blank or absent
    // id on either side is a non-match, so neither a pre-upgrade entry (no
    // `attempt`) nor a plain sign-in (no `expectedAttempt`) can consume this.
    if (typeof parsed.attempt !== 'string' || parsed.attempt === '') return null;
    if (!expectedAttempt || parsed.attempt !== expectedAttempt) return null;
    return parsed.body;
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

export function clearPendingConsent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
