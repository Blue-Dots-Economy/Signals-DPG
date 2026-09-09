/**
 * Session resolution, shared by `auth_middleware.ts` and `validate_session.ts`
 * so the two cannot drift.
 *
 * Which provider runs is decided entirely by `AUTH_PROVIDER`:
 *
 *   betterauth  the Keycloak branch is not reached at all; the caller falls
 *               through to better-auth's own session handling.
 *   keycloak    Keycloak only. There is no better-auth fallback — a request that
 *               carries no usable Keycloak token is simply unauthenticated.
 *
 * Bearer tokens are a SERVICE channel only (AUTH-VULN-03/04). A human token
 * presented in an `Authorization` header is refused however valid it is: a
 * browser session is the `sid` cookie, resolved by `resolve_browser_session.ts`,
 * which calls this module's `resolveHumanSession` itself.
 *
 * A token that *looks* Keycloak-issued but fails validation is rejected outright
 * rather than passed on. That mattered when a fallback existed (it would have
 * turned a precise failure — "expired", "wrong client" — into a generic 401, and
 * let a rejected token get a second evaluation by another code path), and it is
 * retained now because the precise failure is still the more useful answer.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig, keycloakConfig } from '../../src/config';
import {
  actingOrgGrant,
  extractBearerToken,
  hasRealmRole,
  isServiceAccountToken,
  looksLikeKeycloakToken,
  realmRoles,
  verifyKeycloakToken,
  type KeycloakClaims,
  type KeycloakTokenErrorCode,
} from '../../src/utils/keycloak_token';
import { provisionUserFromClaims } from '../../src/services/auth/provisioning';
import type { ProvisioningErrorCode } from '../../src/services/auth/provisioning';
import { resolveServiceAccount } from '../../src/services/auth/service_account';
import type { ServiceAccountErrorCode } from '../../src/services/auth/service_account';

/** Shape every auth failure shares, matching the existing middleware replies. */
export interface AuthFailure {
  status: number;
  code: string;
  error: string;
  message: string;
}

/**
 * Token-validation failures.
 *
 * `KEYCLOAK_UNAVAILABLE` is a 503, not a 401: when Keycloak's JWKS is
 * unreachable we do not know whether the token is good, and answering 401
 * would tell every user their session died during someone else's outage.
 */
export const TOKEN_FAILURES: Record<KeycloakTokenErrorCode, AuthFailure> = {
  TOKEN_EXPIRED: {
    status: 401,
    code: 'TOKEN_EXPIRED',
    error: 'Unauthorized',
    message: 'Access token has expired',
  },
  TOKEN_INVALID: {
    status: 401,
    code: 'UNAUTHORIZED',
    error: 'Unauthorized',
    message: 'Missing or invalid authentication',
  },
  TOKEN_CLIENT_REJECTED: {
    status: 403,
    code: 'TOKEN_CLIENT_REJECTED',
    error: 'Forbidden',
    message: 'This token was not issued for the Signals Stack',
  },
  KEYCLOAK_UNAVAILABLE: {
    status: 503,
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    error: 'Service Unavailable',
    message: 'Could not reach the identity provider to verify the session',
  },
  KEYCLOAK_NOT_CONFIGURED: {
    status: 500,
    code: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
    error: 'Internal Server Error',
    message: 'Keycloak is not configured on this instance',
  },
};

/** Provisioning failures. These are about the *account*, not the token. */
const PROVISIONING_FAILURES: Record<ProvisioningErrorCode, AuthFailure> = {
  LOGIN_CHANNEL_DISABLED: {
    status: 403,
    code: 'LOGIN_CHANNEL_DISABLED',
    error: 'Forbidden',
    message: 'Login channel disabled',
  },
  SELF_SIGNUP_DISABLED: {
    status: 403,
    code: 'SELF_SIGNUP_DISABLED',
    error: 'Forbidden',
    message: 'Self sign-up disabled',
  },
  USER_BANNED: {
    status: 403,
    code: 'USER_BANNED',
    error: 'Forbidden',
    message: 'Account suspended',
  },
  IDENTITY_CONFLICT: {
    status: 409,
    code: 'IDENTITY_CONFLICT',
    error: 'Conflict',
    message: 'Identity conflict',
  },
  NO_IDENTIFIER: {
    status: 403,
    code: 'NO_IDENTIFIER',
    error: 'Forbidden',
    message: 'Token carries no usable login identifier',
  },
  PROVISIONING_FAILED: {
    status: 500,
    code: 'PROVISIONING_FAILED',
    error: 'Internal Server Error',
    message: 'Could not resolve the local user record',
  },
};

/** Client-credentials (service) auth failures. */
const SERVICE_FAILURES: Record<ServiceAccountErrorCode, AuthFailure> = {
  SERVICE_CLIENT_UNKNOWN: {
    status: 401,
    code: 'SERVICE_CLIENT_UNKNOWN',
    error: 'Unauthorized',
    message: 'Token does not identify a client',
  },
  SERVICE_CLIENT_NOT_ALLOWED: {
    status: 403,
    code: 'SERVICE_CLIENT_NOT_ALLOWED',
    error: 'Forbidden',
    message: 'This client is not permitted to call the Signals Stack as a service',
  },
  SERVICE_ACCOUNT_NOT_PROVISIONED: {
    status: 403,
    code: 'SERVICE_ACCOUNT_NOT_PROVISIONED',
    error: 'Forbidden',
    message: 'No service account is provisioned for this client',
  },
  SERVICE_ACCOUNT_LOOKUP_FAILED: {
    status: 500,
    code: 'SERVICE_ACCOUNT_LOOKUP_FAILED',
    error: 'Internal Server Error',
    message: 'Could not resolve the service account',
  },
};

/**
 * A human token from a client that is only allowed on the service path (or the
 * reverse). Separate from TOKEN_CLIENT_REJECTED so logs distinguish "wrong
 * realm client" from "right client, wrong path".
 */
const WRONG_PATH_FOR_CLIENT: AuthFailure = {
  status: 403,
  code: 'TOKEN_CLIENT_REJECTED',
  error: 'Forbidden',
  message: 'This token was not issued for this kind of access',
};

/**
 * A human token presented as `Authorization: Bearer` (AUTH-VULN-03/04).
 *
 * Human sessions authenticate with the `sid` cookie now. Keeping this channel
 * open would leave the hole the cookie was introduced to close: a token that
 * any script on the origin can attach to a request is exactly what the pentest
 * replayed, and an httpOnly cookie is worth nothing while a second, script-
 * readable credential is still accepted for the same identity.
 *
 * Every human client signals serves today is the browser SPA, which is now
 * driven end to end by the BFF (`routes/v1/auth/session.ts`). Adding a human
 * client that CANNOT hold a cookie — a native app, say — means giving it a
 * channel of its own, not re-opening this one for everybody.
 *
 * Service callers are untouched: they present client-credentials tokens and
 * resolve on the service path, which never went through a browser.
 */
const BEARER_NOT_A_SESSION: AuthFailure = {
  status: 401,
  code: 'BEARER_SESSION_NOT_SUPPORTED',
  error: 'Unauthorized',
  message: 'User sessions authenticate with the session cookie, not a bearer token',
};

/**
 * A realm-valid token for an accepted client that carries none of the signals
 * realm roles (`KEYCLOAK_REQUIRED_REALM_ROLES`).
 *
 * The second gate around the shared realm. The client allowlist alone rests on
 * `azp`/`aud`, and an aggregator client given an `aud` mapper that names
 * `signals-ui` would satisfy it; a role the signals provisioning paths stamp and
 * aggregator's do not is not spoofable from the client side.
 */
const MISSING_REALM_ROLE: AuthFailure = {
  status: 403,
  code: 'TOKEN_ROLE_REJECTED',
  error: 'Forbidden',
  message: 'This account is not a participant of the Signals Stack',
};

export const UNAUTHORIZED: AuthFailure = {
  status: 401,
  code: 'UNAUTHORIZED',
  error: 'Unauthorized',
  message: 'Missing or invalid authentication',
};

export type SessionResolution =
  | { ok: true }
  /** Handled by the Keycloak path and failed — reply and stop. */
  | { ok: false; failure: AuthFailure }
  /** Not a Keycloak token; the caller should try better-auth. */
  | { ok: false; fallthrough: true };

/**
 * Try to resolve the request against Keycloak, populating `request.user` from
 * the local mirror on success.
 *
 * Returns `fallthrough` only under `AUTH_PROVIDER=betterauth`, meaning the caller
 * should hand the request to better-auth. Under `keycloak` this either resolves
 * the request or fails it — there is no second provider to defer to, so a request
 * with no usable Keycloak token is unauthenticated rather than passed on.
 */
export async function resolveKeycloakSession(
  request: FastifyRequest
): Promise<SessionResolution> {
  if (!authConfig.keycloak_enabled) return { ok: false, fallthrough: true };

  const token = extractBearerToken(request.headers.authorization);

  if (!token || !looksLikeKeycloakToken(token)) {
    return { ok: false, failure: UNAUTHORIZED };
  }

  const verified = await verifyKeycloakToken(token);
  if (!verified.ok) {
    logTokenFailure(request, verified.code, verified.message);
    return { ok: false, failure: TOKEN_FAILURES[verified.code] };
  }

  /**
   * Only one kind of caller may authenticate with a bearer token: an
   * integrating DPG holding a client-credentials token. A human token gets a
   * 401 here regardless of how valid it is — see `BEARER_NOT_A_SESSION`. The
   * human path still exists and is still reached, but only through the cookie
   * (`resolve_browser_session.ts`), which calls `resolveHumanSession` directly.
   *
   * The fork is still on `isServiceAccountToken` rather than on the client
   * allowlist, because conflating the two was the original risk: a service
   * token must never be run through human provisioning (it has no email or
   * phone, and would otherwise try to mint a user mirror).
   */
  if (!isServiceAccountToken(verified.claims)) {
    const azp = typeof verified.claims.azp === 'string' ? verified.claims.azp : null;
    request.log.warn(
      { azp },
      'rejected a user bearer token: user sessions authenticate with the session cookie'
    );
    return { ok: false, failure: BEARER_NOT_A_SESSION };
  }

  return resolveServiceSession(verified.claims, request);
}

function logTokenFailure(
  request: FastifyRequest,
  code: KeycloakTokenErrorCode,
  reason: string,
) {
  if (code === 'KEYCLOAK_UNAVAILABLE' || code === 'KEYCLOAK_NOT_CONFIGURED') {
    request.log.error({ code, reason }, 'keycloak token verification could not complete');
  } else {
    request.log.warn({ code, reason }, 'keycloak token rejected');
  }
}

/** Client-credentials path: an integrating DPG's service identity. */
async function resolveServiceSession(
  claims: KeycloakClaims,
  request: FastifyRequest,
): Promise<SessionResolution> {
  const service = await resolveServiceAccount(claims, request.log);
  if (!service.ok) {
    return { ok: false, failure: SERVICE_FAILURES[service.code] };
  }
  request.user = {
    id: service.user.id,
    email: service.user.email,
    name: service.user.name,
    role: service.user.role,
  };
  // Acting-org grant (§5.1). Carried to acting_org.ts, which decides whether
  // to enforce it based on ACTING_ORG_SOURCE.
  request.acting_org_grant = actingOrgGrant(claims);
  return { ok: true };
}

/**
 * Human path: named-client and realm-role gates, then the local user mirror.
 *
 * Reached only from the cookie path now (`resolve_browser_session.ts`) — the
 * bearer fork above refuses human tokens outright. The gates below still apply
 * in full, because the token behind a session cookie is the same realm token
 * with the same claims; only how it reached the API changed.
 *
 * A missing `azp` is a rejection, not a pass: the audience gate in
 * `verifyKeycloakToken` accepts on an `aud` match alone, so a token with no
 * `azp` but an `aud` naming an accepted client would otherwise skip the client
 * check entirely and reach provisioning unattributed. Keycloak always emits
 * `azp`, so nothing legitimate lands there.
 */
export async function resolveHumanSession(
  claims: KeycloakClaims,
  request: FastifyRequest,
): Promise<SessionResolution> {
  const azp = typeof claims.azp === 'string' ? claims.azp : undefined;

  if (azp === undefined || !keycloakConfig.session_client_ids.includes(azp)) {
    request.log.warn(
      { azp: azp ?? null, aud: claims.aud },
      azp === undefined
        ? 'keycloak token rejected: no azp claim, so the human session path cannot attribute it to a client'
        : 'keycloak token rejected: client may not use the human session path',
    );
    return { ok: false, failure: WRONG_PATH_FOR_CLIENT };
  }

  // Second gate on the shared realm (defence in depth). Skipped only when an
  // operator has emptied KEYCLOAK_REQUIRED_REALM_ROLES.
  const required = keycloakConfig.required_realm_roles;
  if (required.length > 0 && !required.some((role) => hasRealmRole(claims, role))) {
    request.log.warn(
      { azp, roles: realmRoles(claims), required },
      'keycloak token rejected: carries none of the required signals realm roles ' +
        '(check the client\'s `roles` scope and that migration assigned the role)',
    );
    return { ok: false, failure: MISSING_REALM_ROLE };
  }

  const provisioned = await provisionUserFromClaims(claims, request.log);
  if (!provisioned.ok) {
    return {
      ok: false,
      failure: {
        ...PROVISIONING_FAILURES[provisioned.code],
        // Provisioning writes a user-facing message per case; prefer it over
        // the generic one, except for the 500 (which must not leak detail).
        message:
          provisioned.code === 'PROVISIONING_FAILED'
            ? PROVISIONING_FAILURES.PROVISIONING_FAILED.message
            : provisioned.message,
      },
    };
  }

  if (provisioned.created) {
    request.log.info(
      { user_id: provisioned.user.id },
      'provisioned a new local user mirror from a Keycloak token',
    );
  }

  request.user = {
    id: provisioned.user.id,
    email: provisioned.user.email,
    name: provisioned.user.name,
    role: provisioned.user.role,
  };
  request.acting_org_grant = actingOrgGrant(claims);

  return { ok: true };
}

/** Send an auth failure using the shape the rest of the API already returns. */
export function sendAuthFailure(reply: FastifyReply, failure: AuthFailure) {
  return reply.status(failure.status).send({
    code: failure.code,
    error: failure.error,
    message: failure.message,
  });
}
