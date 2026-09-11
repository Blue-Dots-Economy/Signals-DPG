import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * The AUTH_PROVIDER routing contract (design §7).
 *
 * The load-bearing assertion in here is the `betterauth` block: Build 1 is only
 * safe to merge if, under the default flag, the Keycloak path is never entered
 * and better-auth behaves exactly as it does today.
 */

const mockAuthConfig = {
  provider: 'betterauth' as 'betterauth' | 'keycloak',
  keycloak_enabled: false,
  betterauth_enabled: true,
};

const mockKeycloakConfig = {
  session_client_ids: ['signals-ui'],
  service_client_ids: ['aggregator-dpg', 'voice-dpg'],
  required_realm_roles: ['signals_participant', 'signals_admin'],
};

vi.mock('../../../src/config', () => ({
  authConfig: mockAuthConfig,
  keycloakConfig: mockKeycloakConfig,
}));

const looksLikeKeycloakToken = vi.fn<(token: string) => boolean>(() => true);
const verifyKeycloakToken = vi.fn();
const isServiceAccountToken = vi.fn<(claims: unknown) => boolean>(() => false);

vi.mock('../../../src/utils/keycloak_token', async () => {
  // extractBearerToken is pure header parsing with its own coverage; keep the
  // real one so this suite exercises the actual header handling.
  const actual = await vi.importActual<
    typeof import('../../../src/utils/keycloak_token')
  >('../../../src/utils/keycloak_token');
  return {
    extractBearerToken: actual.extractBearerToken,
    looksLikeKeycloakToken: (token: string) => looksLikeKeycloakToken(token),
    verifyKeycloakToken: (token: string) => verifyKeycloakToken(token),
    isServiceAccountToken: (claims: unknown) => isServiceAccountToken(claims),
    // §5.1 acting-org grant. Keep the real extraction so the wiring is
    // exercised rather than stubbed away.
    actingOrgGrant: actual.actingOrgGrant,
    ACTING_ORG_WILDCARD: actual.ACTING_ORG_WILDCARD,
    // Realm-role gate: real claim reading, so the tests assert on the actual
    // `realm_access` shape rather than a stub's idea of it.
    hasRealmRole: actual.hasRealmRole,
    realmRoles: actual.realmRoles,
  };
});

const provisionUserFromClaims = vi.fn();
vi.mock('../../../src/services/auth/provisioning', () => ({
  provisionUserFromClaims: (...args: unknown[]) => provisionUserFromClaims(...args),
}));

const resolveServiceAccount = vi.fn();
vi.mock('../../../src/services/auth/service_account', () => ({
  resolveServiceAccount: (...args: unknown[]) => resolveServiceAccount(...args),
}));

const { resolveKeycloakSession, sendAuthFailure } = await import('../resolve_session.js');

const setProvider = (provider: 'betterauth' | 'keycloak') => {
  mockAuthConfig.provider = provider;
  mockAuthConfig.keycloak_enabled = provider !== 'betterauth';
  mockAuthConfig.betterauth_enabled = provider !== 'keycloak';
};

const makeRequest = (authorization?: string): FastifyRequest =>
  ({
    headers: authorization ? { authorization } : {},
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }) as unknown as FastifyRequest;

const okClaims = {
  sub: 'user-1',
  email: 'asha@example.org',
  azp: 'signals-ui',
  realm_access: { roles: ['signals_participant'] },
};

beforeEach(() => {
  setProvider('betterauth');
  mockKeycloakConfig.session_client_ids = ['signals-ui'];
  mockKeycloakConfig.service_client_ids = ['aggregator-dpg', 'voice-dpg'];
  mockKeycloakConfig.required_realm_roles = ['signals_participant', 'signals_admin'];
  looksLikeKeycloakToken.mockReset().mockReturnValue(true);
  verifyKeycloakToken.mockReset().mockResolvedValue({ ok: true, claims: okClaims });
  isServiceAccountToken.mockReset().mockReturnValue(false);
  provisionUserFromClaims.mockReset().mockResolvedValue({
    ok: true,
    created: false,
    user: { id: 'user-1', email: 'asha@example.org', name: 'Asha', role: 'user' },
  });
  resolveServiceAccount.mockReset().mockResolvedValue({
    ok: true,
    user: {
      id: 'usr_service_1',
      email: 'aggregator-dpg-svc@signals.local',
      name: 'aggregator-dpg',
      role: null,
    },
  });
});

describe('AUTH_PROVIDER=betterauth — the Keycloak path is inert', () => {
  it('falls through without inspecting the token', async () => {
    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result).toEqual({ ok: false, fallthrough: true });
    // Not even a header parse — this is what makes Build 1 a no-op in prod.
    expect(looksLikeKeycloakToken).not.toHaveBeenCalled();
    expect(verifyKeycloakToken).not.toHaveBeenCalled();
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('falls through with no Authorization header at all', async () => {
    const result = await resolveKeycloakSession(makeRequest());
    expect(result).toEqual({ ok: false, fallthrough: true });
  });
});

describe('AUTH_PROVIDER=keycloak — token validation', () => {
  beforeEach(() => setProvider('keycloak'));

  it('validates a Keycloak token and populates request.user from the mirror', async () => {
    const request = makeRequest('Bearer a.b.c');

    const result = await resolveKeycloakSession(request);

    expect(result.ok).toBe(true);
    expect(verifyKeycloakToken).toHaveBeenCalledWith('a.b.c');
    expect(provisionUserFromClaims).toHaveBeenCalledWith(okClaims, request.log);
    expect(request.user).toEqual({
      id: 'user-1',
      email: 'asha@example.org',
      name: 'Asha',
      role: 'user',
    });
  });

  it('surfaces the precise token failure rather than a generic 401', async () => {
    // This began as "does not retry against better-auth" and outlived the
    // fallback: reporting TOKEN_EXPIRED beats a bare 401 for anyone debugging a
    // login, so the specific code is still the contract.
    verifyKeycloakToken.mockResolvedValue({
      ok: false,
      code: 'TOKEN_EXPIRED',
      message: 'expired',
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(false);
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(401);
    expect(result.failure.code).toBe('TOKEN_EXPIRED');
  });

  it('logs a rejected token at warn, but an outage at error', async () => {
    const rejected = makeRequest('Bearer a.b.c');
    verifyKeycloakToken.mockResolvedValue({
      ok: false,
      code: 'TOKEN_INVALID',
      message: 'bad signature',
    });
    await resolveKeycloakSession(rejected);
    expect(rejected.log.warn).toHaveBeenCalled();
    expect(rejected.log.error).not.toHaveBeenCalled();

    const outage = makeRequest('Bearer a.b.c');
    verifyKeycloakToken.mockResolvedValue({
      ok: false,
      code: 'KEYCLOAK_UNAVAILABLE',
      message: 'jwks unreachable',
    });
    await resolveKeycloakSession(outage);
    expect(outage.log.error).toHaveBeenCalled();
  });
});

describe('AUTH_PROVIDER=keycloak — no better-auth fallback', () => {
  beforeEach(() => setProvider('keycloak'));

  it('rejects a request with no bearer token instead of falling through', async () => {
    const result = await resolveKeycloakSession(makeRequest());

    expect(result.ok).toBe(false);
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(401);
  });

  it('rejects an opaque better-auth token', async () => {
    looksLikeKeycloakToken.mockReturnValue(false);

    const result = await resolveKeycloakSession(makeRequest('Bearer opaque-token'));

    expect(result.ok).toBe(false);
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(401);
  });
});

describe('service vs human fork (Build 3)', () => {
  beforeEach(() => setProvider('keycloak'));

  const serviceClaims = {
    sub: 'service-account-sub',
    azp: 'aggregator-dpg',
    client_id: 'aggregator-dpg',
  };

  it('resolves a client-credentials token to the service user', async () => {
    isServiceAccountToken.mockReturnValue(true);
    verifyKeycloakToken.mockResolvedValue({ ok: true, claims: serviceClaims });
    const request = makeRequest('Bearer a.b.c');

    const result = await resolveKeycloakSession(request);

    expect(result.ok).toBe(true);
    expect(resolveServiceAccount).toHaveBeenCalledWith(serviceClaims, request.log);
    expect(request.user).toEqual({
      id: 'usr_service_1',
      email: 'aggregator-dpg-svc@signals.local',
      name: 'aggregator-dpg',
      role: null,
    });
  });

  it('never runs a service token through human provisioning', async () => {
    // A service token has no email or phone; provisioning would reject it as
    // NO_IDENTIFIER at best, and must never try to mint a user mirror for it.
    isServiceAccountToken.mockReturnValue(true);
    verifyKeycloakToken.mockResolvedValue({ ok: true, claims: serviceClaims });

    await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('never runs a human token through service resolution', async () => {
    await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(resolveServiceAccount).not.toHaveBeenCalled();
    expect(provisionUserFromClaims).toHaveBeenCalled();
  });

  it('refuses a human token from a service-only client', async () => {
    // The public signals-ui client must not be able to reach the service path,
    // and an integrating DPG's client must not be provisioned as a person.
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 'x', azp: 'aggregator-dpg', email: 'someone@example.org' },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(false);
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(403);
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('refuses a human token that carries no azp at all', async () => {
    // The audience gate in verifyKeycloakToken accepts on an `aud` match with no
    // `azp` required, so treating a missing `azp` as "no client to check" let a
    // token with a matching `aud` skip this gate and reach provisioning
    // unattributed. Keycloak always emits `azp`; this must be a rejection.
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: {
        sub: 'x',
        email: 'someone@example.org',
        aud: ['signals-ui'],
        realm_access: { roles: ['signals_participant'] },
      },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(false);
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(403);
    expect(result.failure.code).toBe('TOKEN_CLIENT_REJECTED');
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it.each([
    ['SERVICE_CLIENT_UNKNOWN', 401],
    ['SERVICE_CLIENT_NOT_ALLOWED', 403],
    ['SERVICE_ACCOUNT_NOT_PROVISIONED', 403],
    ['SERVICE_ACCOUNT_LOOKUP_FAILED', 500],
  ] as const)('maps service failure %s to HTTP %i', async (code, status) => {
    isServiceAccountToken.mockReturnValue(true);
    verifyKeycloakToken.mockResolvedValue({ ok: true, claims: serviceClaims });
    resolveServiceAccount.mockResolvedValue({ ok: false, code, message: 'nope' });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(status);
    expect(result.failure.code).toBe(code);
  });
});

describe('realm-role gate on the human path (shared-realm defence in depth)', () => {
  beforeEach(() => setProvider('keycloak'));

  /** Resolves a human-path token carrying the given claims. */
  async function resolveWith(claims: Record<string, unknown>) {
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 'x', azp: 'signals-ui', email: 'someone@example.org', ...claims },
    });
    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    return result.failure;
  }

  it('names the aggregator account when an org owner reaches signals', async () => {
    // Shared realm: signing into the aggregator leaves an SSO session Keycloak
    // reuses here silently. Still refused, but "not a participant" reads as
    // "your account is broken" and leaves the user nowhere (#753).
    const failure = await resolveWith({ realm_access: { roles: ['org_owner'] } });
    expect(failure.status).toBe(403);
    expect(failure.code).toBe('TOKEN_AGGREGATOR_ACCOUNT');
    expect(failure.message).toMatch(/aggregator account/i);
    expect(failure.message).toMatch(/different account/i);
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('names the aggregator account for a coordinator (aggregator_id claim)', async () => {
    const failure = await resolveWith({
      aggregator_id: 'agg-1',
      realm_access: { roles: [] },
    });
    expect(failure.code).toBe('TOKEN_AGGREGATOR_ACCOUNT');
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('keeps the generic message for a realm user that is neither', async () => {
    // Only claim "you are an aggregator account" when that is certain.
    const failure = await resolveWith({ realm_access: { roles: ['offline_access'] } });
    expect(failure.status).toBe(403);
    expect(failure.code).toBe('TOKEN_ROLE_REJECTED');
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('refuses a token with no realm_access claim at all', async () => {
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 'x', azp: 'signals-ui', email: 'someone@example.org' },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.code).toBe('TOKEN_ROLE_REJECTED');
    expect(provisionUserFromClaims).not.toHaveBeenCalled();
  });

  it('accepts signals_admin as well as signals_participant', async () => {
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { ...okClaims, realm_access: { roles: ['signals_admin'] } },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(true);
    expect(provisionUserFromClaims).toHaveBeenCalled();
  });

  it('skips the gate when the required-role list is empty (operator opt-out)', async () => {
    mockKeycloakConfig.required_realm_roles = [];
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 'user-1', azp: 'signals-ui', email: 'asha@example.org' },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(true);
  });

  it('does not apply the role gate to service tokens', async () => {
    // Service accounts carry realm-management roles, not signals_participant.
    isServiceAccountToken.mockReturnValue(true);
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 's', azp: 'aggregator-dpg', client_id: 'aggregator-dpg' },
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    expect(result.ok).toBe(true);
    expect(resolveServiceAccount).toHaveBeenCalled();
  });
});

describe('failure mapping', () => {
  beforeEach(() => setProvider('keycloak'));

  it.each([
    ['TOKEN_EXPIRED', 401],
    ['TOKEN_INVALID', 401],
    ['TOKEN_CLIENT_REJECTED', 403],
    ['KEYCLOAK_UNAVAILABLE', 503],
    ['KEYCLOAK_NOT_CONFIGURED', 500],
  ] as const)('maps token failure %s to HTTP %i', async (code, status) => {
    verifyKeycloakToken.mockResolvedValue({ ok: false, code, message: 'nope' });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(status);
  });

  it('answers 503 — not 401 — when Keycloak is unreachable', async () => {
    // An outage must not tell every user their session died.
    verifyKeycloakToken.mockResolvedValue({
      ok: false,
      code: 'KEYCLOAK_UNAVAILABLE',
      message: 'jwks unreachable',
    });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(503);
    expect(result.failure.code).toBe('IDENTITY_PROVIDER_UNAVAILABLE');
  });

  it.each([
    ['SELF_SIGNUP_DISABLED', 403],
    ['LOGIN_CHANNEL_DISABLED', 403],
    ['USER_BANNED', 403],
    ['NO_IDENTIFIER', 403],
    ['IDENTITY_CONFLICT', 409],
    ['PROVISIONING_FAILED', 500],
  ] as const)('maps provisioning failure %s to HTTP %i', async (code, status) => {
    provisionUserFromClaims.mockResolvedValue({ ok: false, code, message: 'detail' });

    const result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));

    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.status).toBe(status);
    expect(result.failure.code).toBe(code);
  });

  it('surfaces the provisioning message to the user, except on a 500', async () => {
    provisionUserFromClaims.mockResolvedValue({
      ok: false,
      code: 'SELF_SIGNUP_DISABLED',
      message: 'Self sign-up is disabled on this instance.',
    });
    let result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.message).toBe('Self sign-up is disabled on this instance.');

    // A 500's internal detail must not reach the client.
    provisionUserFromClaims.mockResolvedValue({
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'relation "user" does not exist',
    });
    result = await resolveKeycloakSession(makeRequest('Bearer a.b.c'));
    if (result.ok || !('failure' in result)) throw new Error('expected a failure');
    expect(result.failure.message).not.toContain('relation');
  });
});

describe('sendAuthFailure', () => {
  it('replies in the shape the rest of the API uses', () => {
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    sendAuthFailure(reply as never, {
      status: 403,
      code: 'USER_BANNED',
      error: 'Forbidden',
      message: 'Account suspended',
    });

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      code: 'USER_BANNED',
      error: 'Forbidden',
      message: 'Account suspended',
    });
  });
});

describe('acting-org grant plumbing (§5.1)', () => {
  beforeEach(() => setProvider('keycloak'));

  it('threads the grant off a human token onto the request', async () => {
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { ...okClaims, signals_acting_orgs: ['org_a', 'org_b'] },
    });
    const request = makeRequest('Bearer a.b.c');

    await resolveKeycloakSession(request);

    expect(request.acting_org_grant).toEqual(['org_a', 'org_b']);
  });

  it('threads the grant off a service token onto the request', async () => {
    isServiceAccountToken.mockReturnValue(true);
    verifyKeycloakToken.mockResolvedValue({
      ok: true,
      claims: { sub: 's', azp: 'aggregator-dpg', client_id: 'aggregator-dpg', signals_acting_orgs: '*' },
    });
    const request = makeRequest('Bearer a.b.c');

    await resolveKeycloakSession(request);

    expect(request.acting_org_grant).toEqual(['*']);
  });

  it('leaves the grant undefined when the token carries no claim', async () => {
    // Distinct from an empty grant — acting_org.ts treats undefined as
    // "fall back to the header".
    const request = makeRequest('Bearer a.b.c');

    await resolveKeycloakSession(request);

    expect(request.acting_org_grant).toBeUndefined();
  });
});
