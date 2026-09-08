import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/**
 * Server-side session store for BROWSER logins (AUTH-VULN-03/04).
 *
 * The UI used to hold the Keycloak access token — and, via `oidc-client-ts`'s
 * own store, the refresh token — in `localStorage`, where any script on the
 * origin could read both. A pentest lifted them and replayed the refresh token
 * against Keycloak to mint fresh access tokens, then called the API with no
 * cookie at all.
 *
 * The tokens now never reach the browser. They live here, keyed by an opaque
 * session id that is the only thing in the cookie, mirroring the model
 * `aggregator-dpg` already runs ("Tokens are never written to cookies. They
 * live in Redis only").
 *
 * The id is stored HASHED. Redis is shared infrastructure and its keys surface
 * in `KEYS`/`MONITOR` output, backups and support dumps; a raw id there would be
 * a bearer credential sitting in plaintext, which is the shape of the problem
 * this module exists to remove. The cookie carries the raw id, the store only
 * ever sees its SHA-256 — so a leaked key listing cannot be replayed as a login.
 */

const SESSION_PREFIX = 'bsess:';

/** Opaque id length. 32 bytes = 256 bits, well past guessability. */
const SESSION_ID_BYTES = 32;

/**
 * How long a browser session may live without being re-authenticated. Bounded
 * by the refresh token's own lifetime upstream — Keycloak refuses to refresh
 * past it, and `touch` never extends beyond `refreshTokenExp`.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface BrowserSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. Used to refresh slightly early rather than on a 401. */
  accessTokenExp: number;
  /** Epoch ms. A session cannot outlive this. */
  refreshTokenExp: number;
  /**
   * Kept only to pass as `id_token_hint` on logout. Without it Keycloak cannot
   * tell whose session is ending and interrupts the user with a "Do you want to
   * log out?" confirmation — a screen they never saw when the SPA held the
   * token and `oidc-client-ts` supplied the hint from its own store.
   *
   * Optional because a Keycloak that returns no id token must still yield a
   * usable session; logout then falls back to naming the client instead.
   */
  idToken?: string;
  /**
   * Per-session CSRF token, echoed by the UI in `x-csrf-token` on every
   * state-changing request. Checked in `plugins/auth/resolve_browser_session.ts`.
   */
  csrfToken: string;
  /**
   * The browser origin this session was opened from, validated against the CORS
   * allowlist at login (see `safeAppOrigin`). Kept so logout can send the user
   * back to the APP rather than to the API — the two are not necessarily the
   * same origin, and Keycloak only accepts post-logout URLs registered for the
   * app.
   */
  appOrigin: string;
  createdAt: number;
}

/** Never let a raw session id become a Redis key — see the note above. */
function storeKey(sessionId: string): string {
  return SESSION_PREFIX + createHash('sha256').update(sessionId).digest('hex');
}

export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time compare for the CSRF double-submit check.
 *
 * `!==` on secrets leaks position through timing. Lengths are compared first
 * because `timingSafeEqual` throws on a mismatch — length is not the secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function createSession(
  sessionId: string,
  data: BrowserSession
): Promise<void> {
  await redis.set(
    storeKey(sessionId),
    JSON.stringify(data),
    'EX',
    ttlFor(data)
  );
}

export async function readSession(
  sessionId: string
): Promise<BrowserSession | null> {
  const raw = await redis.get(storeKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BrowserSession;
  } catch {
    // A corrupt entry is treated as no session rather than a 500: the caller
    // is simply logged out and can sign in again.
    return null;
  }
}

export async function updateSession(
  sessionId: string,
  patch: Partial<BrowserSession>
): Promise<BrowserSession | null> {
  const current = await readSession(sessionId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await redis.set(storeKey(sessionId), JSON.stringify(next), 'EX', ttlFor(next));
  return next;
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(storeKey(sessionId));
}

/**
 * Remaining life for a session: the shorter of the sliding window and whatever
 * the refresh token has left. Without the second bound a session would appear
 * alive after Keycloak had stopped honouring its refresh token, and the user
 * would hit a failure mid-request instead of a clean re-login.
 */
function ttlFor(data: BrowserSession): number {
  const untilRefreshExpiry = Math.floor((data.refreshTokenExp - Date.now()) / 1000);
  return Math.max(1, Math.min(SESSION_TTL_SECONDS, untilRefreshExpiry));
}
