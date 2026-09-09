import { createHash } from 'node:crypto';
import { allowed_origins } from '@dpg/config';
import { redis } from '@api/db/secondary/redis';

/**
 * The origins a browser may legitimately reach this API from.
 *
 * Seeded with the env allowlist and REPLACED at boot with the same merged list
 * CORS enforces (`app.ts` adds the per-domain instance URLs from network
 * config). Checking only the env list would reject a portal whose origin comes
 * from network config: the login would succeed, the callback would fall back to
 * `API_DOMAIN`, and the browser would be sent to a host that serves no UI — a
 * blank page holding a valid session.
 */
let browserOrigins: readonly string[] = allowed_origins;

export function setBrowserAllowedOrigins(origins: readonly string[]): void {
  browserOrigins = origins;
}

/**
 * The in-flight half of a login: what the callback needs to finish a flow the
 * `/login` redirect started.
 *
 * Held server-side keyed by `state` rather than in a cookie, so the PKCE
 * verifier never reaches the browser — the point of doing the exchange on the
 * server at all. Single-use: `consume` deletes as it reads, so a replayed
 * callback finds nothing and is rejected rather than starting a second session
 * from one authorization.
 *
 * Short TTL because this only has to survive one Keycloak round-trip; a longer
 * window would just widen the replay surface on the `state` value.
 */

const FLOW_PREFIX = 'oidcflow:';
const FLOW_TTL_SECONDS = 5 * 60;

export interface OidcFlowState {
  verifier: string;
  nonce: string;
  /** Path within the app to return to. Validated before use — see `safeReturnTo`. */
  returnTo: string;
  /**
   * Opaque marker the UI uses to resume a consent the user was mid-way through
   * when login interrupted it. Carried through the flow so the callback page's
   * existing landing logic behaves exactly as it did when the SPA owned the
   * exchange and got this back from `completeOidcLogin`.
   */
  consentAttempt?: string;
  redirectUri: string;
  /** Browser origin to hand the user back to. See `safeAppOrigin`. */
  appOrigin: string;
}

/** `state` is a credential for this flow; keep it out of Redis keys in the clear. */
function flowKey(state: string): string {
  return FLOW_PREFIX + createHash('sha256').update(state).digest('hex');
}

export async function saveFlowState(
  state: string,
  data: OidcFlowState
): Promise<void> {
  await redis.set(flowKey(state), JSON.stringify(data), 'EX', FLOW_TTL_SECONDS);
}

/** Reads and deletes in one step: a `state` is good for exactly one callback. */
export async function consumeFlowState(
  state: string
): Promise<OidcFlowState | null> {
  const key = flowKey(state);
  const raw = await redis.getdel(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OidcFlowState;
  } catch {
    return null;
  }
}

/**
 * Constrains `returnTo` to a path on this origin.
 *
 * The value arrives as a query parameter on `/login`, so without this an
 * attacker could send `?returnTo=https://evil.test` and use our login as an
 * open redirect — the user authenticates for real, then lands on a page of the
 * attacker's choosing wearing a fresh session. Anything not starting with a
 * single `/` is discarded, including protocol-relative `//host` (which a naive
 * "starts with /" check would let through).
 */
export function safeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  return raw;
}

/**
 * Constrains the caller-supplied app origin to one this instance already serves
 * a browser at.
 *
 * The UI and the API are not necessarily the same origin — locally they are
 * :3000 and :2742, and a deployment may split them across hosts — so the
 * callback cannot just redirect to a path and assume it lands on the app. The
 * origin therefore has to come from the request, and an unchecked origin from
 * the request is an open redirect: `?appOrigin=https://evil.test` would send a
 * freshly authenticated user there.
 *
 * Checked against the CORS allowlist rather than a list of its own, so the set
 * of origins the browser may be sent to is exactly the set it may call from —
 * one list, no drift. See `setBrowserAllowedOrigins`.
 */
export function safeAppOrigin(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  return browserOrigins.includes(raw) ? raw : fallback;
}
