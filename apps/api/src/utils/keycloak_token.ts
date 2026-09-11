/**
 * Keycloak access-token validation (JWKS-backed) for the better-auth →
 * Keycloak migration. See docs/superpowers/plans/2026-07-23-keycloak-migration-design.md.
 *
 * Build 0 (foundation): this module is complete but nothing calls it yet. The
 * auth middleware starts using it in Build 1, gated on AUTH_PROVIDER.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **Audience/azp is a real check, not a formality.** signals shares one
 *    `bluedots` realm with aggregator (§3.1), so an aggregator-issued token is
 *    signed by the same keys and carries the same `iss`. Signature + issuer
 *    alone would accept it as a signals session. Every token must also name a
 *    client signals actually serves — that is `accepted_client_ids` (R9).
 *
 * 2. **Nothing here throws.** Routes and middleware in this repo return
 *    `reply.code(N).send({ error, message })`; a verification failure is a
 *    value, not an exception. `verifyKeycloakToken` returns a discriminated
 *    result and the caller maps it to a status code.
 */

import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { keycloakConfig } from '@/config';

/**
 * The subset of Keycloak's access-token claims signals reads. Keycloak emits
 * plenty more; this is what the provisioning path (Build 1) maps onto the local
 * `user` mirror, plus the routing claims used to tell a human session from a
 * client-credentials service call.
 */
export interface KeycloakClaims {
  /** Realm-unique subject. By design this equals the signals `user.id` (§6.1). */
  sub: string;
  iss: string;
  aud: string[];
  /** Authorized party — the client the token was actually issued to. */
  azp?: string;
  exp: number;
  iat?: number;
  jti?: string;
  email?: string;
  email_verified?: boolean;
  /** Mapped from the `phoneNumber` user attribute by the realm's mapper. */
  phone_number?: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
  /**
   * Present on client-credentials tokens (service accounts). Its presence is
   * what distinguishes an integrating DPG's token from a human's.
   */
  client_id?: string;
  [claim: string]: unknown;
}

export type KeycloakTokenErrorCode =
  /** Malformed, wrong signature, wrong issuer, or otherwise unusable. */
  | 'TOKEN_INVALID'
  /** Well-formed and correctly signed, but past `exp` (or before `nbf`). */
  | 'TOKEN_EXPIRED'
  /** Valid realm token, but issued to a client signals does not serve (R9). */
  | 'TOKEN_CLIENT_REJECTED'
  /** JWKS could not be fetched — Keycloak down or unreachable. Retryable. */
  | 'KEYCLOAK_UNAVAILABLE'
  /** AUTH_PROVIDER is a Keycloak mode but no issuer is configured. */
  | 'KEYCLOAK_NOT_CONFIGURED';

export type KeycloakTokenResult =
  | { ok: true; claims: KeycloakClaims }
  | { ok: false; code: KeycloakTokenErrorCode; message: string };

/**
 * JWKS sets are memoised per URL. jose's remote set does its own caching,
 * rate-limited refetch on unknown `kid`, and cooldown — but only if we reuse
 * one instance. Creating one per request would refetch the keys per request.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: keycloakConfig.jwks_cache_max_age_ms,
      // Floor between refetches when an unknown `kid` arrives, so a burst of
      // bogus tokens cannot turn into a burst of requests to Keycloak.
      cooldownDuration: 30_000,
    });
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/** Test seam: drop the memoised JWKS sets. Not used in normal operation. */
export function resetKeycloakJwksCache(): void {
  jwksCache.clear();
}

/** Node socket-level failures that mean "Keycloak was unreachable". */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Distinguish "we could not fetch the key set" from "the token is bad".
 *
 * Worth the care: both arrive at the same catch, and conflating them turns a
 * Keycloak outage into a wave of 401s that looks like every user's token going
 * invalid at once. jose signals a non-200 from the JWKS endpoint with a plain
 * `JOSEError` (not a `JWKS*` subclass), and an unreachable host surfaces as a
 * Node system error, so neither is caught by an `instanceof JWKSTimeout` check
 * alone.
 *
 * `JWKSNoMatchingKey` is deliberately NOT treated as an outage — the key set
 * was fetched fine; the token just named a `kid` that is not in it.
 */
function isJwksRetrievalFailure(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  if (
    err instanceof joseErrors.JOSEError &&
    err.code === 'ERR_JOSE_GENERIC' &&
    err.message.includes('JSON Web Key Set')
  ) {
    return true;
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/** Normalise the `aud` claim, which Keycloak emits as a string or an array. */
function toAudienceList(aud: JWTPayload['aud']): string[] {
  if (!aud) return [];
  return Array.isArray(aud) ? aud : [aud];
}

/**
 * Pull the bearer token out of an Authorization header. Returns undefined for
 * a missing or non-bearer header rather than throwing.
 */
export function extractBearerToken(
  authorization: string | string[] | undefined
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return undefined;
  const trimmed = header.trim();
  // Match only the scheme prefix and slice the rest: a `(.+)$` capture after
  // `\s+` is ambiguous (both match spaces) and backtracks super-linearly.
  const scheme = /^Bearer\s+/i.exec(trimmed);
  if (!scheme) return undefined;
  return trimmed.slice(scheme[0].length).trim() || undefined;
}

/**
 * Cheap, unverified pre-check: does this bearer token even claim to be from
 * our Keycloak realm?
 *
 * Build 1's middleware runs in `dual` mode, where the same Authorization
 * header may carry either a Keycloak JWT or a better-auth bearer token. This
 * decides which validator to run. It proves nothing about authenticity — the
 * payload is read without checking the signature — so it must only ever be
 * used to *route*, never to admit.
 */
export function looksLikeKeycloakToken(token: string): boolean {
  if (!keycloakConfig.issuer) return false;
  // A JWS compact serialisation has exactly three dot-separated segments;
  // better-auth's bearer tokens are opaque and do not.
  if (token.split('.').length !== 3) return false;
  try {
    return decodeJwt(token).iss === keycloakConfig.issuer;
  } catch {
    return false;
  }
}

/**
 * Verify a Keycloak access token: signature against the realm JWKS, `iss`,
 * `exp`/`nbf`, and — the part that matters in a shared realm — that the token
 * was issued to a client signals serves.
 *
 * Keycloak puts the requesting client in `azp` and typically only `account` in
 * `aud`, so `azp` is checked first and `aud` is accepted as a fallback for
 * tokens shaped by an explicit audience mapper. Either must intersect
 * `keycloakConfig.accepted_client_ids`; neither matching is a rejection.
 */
export async function verifyKeycloakToken(
  token: string
): Promise<KeycloakTokenResult> {
  if (!keycloakConfig.issuer || !keycloakConfig.jwks_uri) {
    return {
      ok: false,
      code: 'KEYCLOAK_NOT_CONFIGURED',
      message: 'Keycloak issuer is not configured (KEYCLOAK_BASE_URL unset)',
    };
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(keycloakConfig.jwks_uri), {
      issuer: keycloakConfig.issuer,
      clockTolerance: keycloakConfig.clock_tolerance_seconds,
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'Access token has expired' };
    }
    // Infrastructure, not an auth failure — callers should log it as such and
    // may retry, rather than telling the user their session is invalid.
    if (isJwksRetrievalFailure(err)) {
      return {
        ok: false,
        code: 'KEYCLOAK_UNAVAILABLE',
        message: 'Could not fetch the Keycloak JWKS to verify the token',
      };
    }
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message: err instanceof Error ? err.message : 'Access token is not valid',
    };
  }

  if (typeof payload.sub !== 'string' || !payload.sub) {
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message: 'Access token has no subject (sub) claim',
    };
  }

  const audiences = toAudienceList(payload.aud);
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  const accepted = keycloakConfig.accepted_client_ids;
  const clientIsAccepted =
    (azp !== undefined && accepted.includes(azp)) ||
    audiences.some((aud) => accepted.includes(aud));

  if (!clientIsAccepted) {
    const named = azp ?? (audiences.join(',') || 'unknown');
    return {
      ok: false,
      code: 'TOKEN_CLIENT_REJECTED',
      message: `Token was issued to client '${named}', which signals does not serve`,
    };
  }

  return {
    ok: true,
    claims: { ...payload, sub: payload.sub, aud: audiences } as KeycloakClaims,
  };
}

/**
 * The claim carrying the set of signals organizations a caller may act for
 * (§5.1 of the migration design).
 */
export const ACTING_ORG_CLAIM = 'signals_acting_orgs';

/** Grant value meaning "any org" — see the note on `["*"]` in §5.1. */
export const ACTING_ORG_WILDCARD = '*';

/**
 * The acting-org grant this token carries, or **undefined when the claim is
 * absent entirely**.
 *
 * That distinction is load-bearing: absent means "this token predates the claim,
 * fall back to the header" (`claim_preferred`), whereas an empty array is a real
 * grant of nothing and must authorise nothing.
 *
 * Accepts both shapes Keycloak produces: a JSON array from a multivalued mapper,
 * and a comma-separated string from a hardcoded-claim mapper (which emits a
 * plain string unless `jsonType.label` is set to JSON).
 */
export function actingOrgGrant(claims: KeycloakClaims): string[] | undefined {
  const raw = claims[ACTING_ORG_CLAIM];
  if (raw === undefined || raw === null) return undefined;

  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    values = raw.split(',');
  } else {
    return undefined;
  }

  return values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** True when the grant permits acting for any org. */
export function grantIsWildcard(grant: string[] | undefined): boolean {
  return grant !== undefined && grant.includes(ACTING_ORG_WILDCARD);
}

/** Realm roles carried by the token, or an empty array. */
export function realmRoles(claims: KeycloakClaims): string[] {
  return claims.realm_access?.roles ?? [];
}

/**
 * Used by `resolve_session.ts` as the second gate on the human path
 * (`KEYCLOAK_REQUIRED_REALM_ROLES`). The client allowlist above is checked
 * against `azp`/`aud`; a realm role is assigned by the realm rather than named
 * by the client, so it is the part of the shared-realm defence a misconfigured
 * audience mapper cannot undo.
 */
export function hasRealmRole(claims: KeycloakClaims, role: string): boolean {
  return realmRoles(claims).includes(role);
}

/**
 * True for a client-credentials (service account) token — an integrating DPG
 * calling signals — as opposed to a human's session token.
 *
 * Keycloak marks service-account tokens with a `client_id` claim and a
 * `service-account-<clientId>` username; either signal is sufficient.
 *
 * `azp` is checked FIRST and is the only signal that cannot be configured away.
 * The other two are both optional in practice: the bundled realm's service
 * clients carry no `client_id` mapper, and `preferred_username` requires the
 * `profile` scope. Trimming that scope from a machine client is a natural
 * hardening step, and without this branch it would silently reclassify that
 * client as a human — which now means `401 BEARER_SESSION_NOT_SUPPORTED` on
 * every call. The failure mode of this discriminator is a lockout, so it errs
 * toward recognising a service token, not toward doubting one.
 *
 * Recognising a token here is not by itself an authorization: the caller still
 * has to resolve to a service account, and `service_client_ids` is empty by
 * default, so an unlisted client gains nothing from matching.
 */
export function isServiceAccountToken(claims: KeycloakClaims): boolean {
  return (
    (typeof claims.azp === 'string' &&
      keycloakConfig.service_client_ids.includes(claims.azp)) ||
    typeof claims.client_id === 'string' ||
    (typeof claims.preferred_username === 'string' &&
      claims.preferred_username.startsWith('service-account-'))
  );
}
