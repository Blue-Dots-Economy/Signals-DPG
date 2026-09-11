import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

// keycloak_token imports keycloakConfig from '@/config' at module load; mock it
// so we don't pull in loadEnv(). The object is mutable and read at call time,
// so tests can point it at the throwaway JWKS server started below.
//
// `accepted_client_ids` is the load-bearing field — it is what keeps
// aggregator's tokens out of signals in the shared realm (risk R9).
const mockKeycloakConfig = {
  base_url: '',
  internal_base_url: '',
  realm: 'bluedots',
  issuer: '',
  jwks_uri: '',
  ui_client_id: 'signals-ui',
  api_client_id: 'signals-api',
  api_client_secret: undefined as string | undefined,
  accepted_client_ids: ['signals-ui', 'signals-api'],
  // Empty by default, exactly as the real config is, so the `azp` branch of
  // isServiceAccountToken only fires for a client an operator has listed.
  service_client_ids: [] as string[],
  jwks_cache_max_age_ms: 600_000,
  clock_tolerance_seconds: 30,
};

vi.mock('@/config', () => ({ keycloakConfig: mockKeycloakConfig }));

const {
  verifyKeycloakToken,
  looksLikeKeycloakToken,
  extractBearerToken,
  resetKeycloakJwksCache,
  isServiceAccountToken,
  hasRealmRole,
  realmRoles,
  actingOrgGrant,
  grantIsWildcard,
} = await import('../keycloak_token.js');

const KID = 'test-signing-key';

let privateKey: CryptoKey;
/** A key that is NOT published in the served JWKS — the wrong-signature case. */
let foreignPrivateKey: CryptoKey;

/**
 * jose's remote key set talks to the JWKS endpoint over node:http, not global
 * fetch, so stubbing fetch does nothing. Serving the real thing on a loopback
 * port also means the caching and error paths are exercised for real.
 */
let jwksServer: Server;
let issuer: string;
let jwksUri: string;
/** Requests the JWKS endpoint has received — asserts the cache actually caches. */
let jwksRequests = 0;
/** Flip to make the endpoint fail, simulating a Keycloak outage. */
let jwksServerFails = false;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  foreignPrivateKey = (await generateKeyPair('RS256')).privateKey;

  const publicJwk: JWK = {
    ...(await exportJWK(pair.publicKey)),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };

  jwksServer = createServer((req, res) => {
    jwksRequests += 1;
    if (jwksServerFails) {
      res.writeHead(500).end('keycloak is down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });

  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const { port } = jwksServer.address() as AddressInfo;

  issuer = `http://127.0.0.1:${port}/realms/bluedots`;
  jwksUri = `${issuer}/protocol/openid-connect/certs`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    jwksServer.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  resetKeycloakJwksCache();
  // Reset between tests: two cases below set it, and a leaked value would make
  // an unrelated token look like a service account.
  mockKeycloakConfig.service_client_ids = [];
  jwksRequests = 0;
  jwksServerFails = false;
  mockKeycloakConfig.issuer = issuer;
  mockKeycloakConfig.jwks_uri = jwksUri;
  mockKeycloakConfig.accepted_client_ids = ['signals-ui', 'signals-api'];
});

/** Mint a token shaped the way Keycloak shapes one. */
async function mintToken(
  overrides: {
    sub?: string | null;
    iss?: string;
    azp?: string;
    aud?: string | string[];
    expiresIn?: string;
    claims?: Record<string, unknown>;
    key?: CryptoKey;
  } = {}
): Promise<string> {
  const {
    sub = '11111111-2222-3333-4444-555555555555',
    iss = issuer,
    azp = 'signals-ui',
    // Keycloak's default shape: the requesting client lands in `azp`, and
    // `aud` is just `account` unless an audience mapper is configured.
    aud = 'account',
    expiresIn = '5m',
    claims = {},
    key = privateKey,
  } = overrides;

  const jwt = new SignJWT({ ...(azp ? { azp } : {}), ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn);

  if (sub !== null) jwt.setSubject(sub);

  return jwt.sign(key);
}

describe('extractBearerToken', () => {
  it('pulls the token out of a Bearer header, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('  Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('returns undefined for missing, empty or non-Bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
  });

  it('reads the first value when the header arrives as an array', () => {
    expect(extractBearerToken(['Bearer abc.def.ghi', 'Bearer other'])).toBe('abc.def.ghi');
  });
});

describe('looksLikeKeycloakToken', () => {
  it('recognises a token minted by our issuer', async () => {
    expect(looksLikeKeycloakToken(await mintToken())).toBe(true);
  });

  it('rejects an opaque better-auth-style bearer token', () => {
    expect(looksLikeKeycloakToken('9f8c1c2e3a4b5d6e7f8091a2b3c4d5e6')).toBe(false);
  });

  it('rejects a JWT from a different issuer', async () => {
    expect(
      looksLikeKeycloakToken(await mintToken({ iss: 'https://other.example/realms/x' }))
    ).toBe(false);
  });

  it('rejects garbage that happens to have three segments', () => {
    expect(looksLikeKeycloakToken('not.a.jwt')).toBe(false);
  });

  it('is false when Keycloak is not configured', async () => {
    const token = await mintToken();
    mockKeycloakConfig.issuer = '';
    expect(looksLikeKeycloakToken(token)).toBe(false);
  });

  it('never hits the network — it only routes, it does not admit', async () => {
    looksLikeKeycloakToken(await mintToken({ key: foreignPrivateKey }));
    expect(jwksRequests).toBe(0);
  });
});

describe('verifyKeycloakToken', () => {
  it('accepts a well-formed token from an accepted client', async () => {
    const result = await verifyKeycloakToken(await mintToken());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe('11111111-2222-3333-4444-555555555555');
    expect(result.claims.iss).toBe(issuer);
    expect(result.claims.azp).toBe('signals-ui');
    // `aud` is normalised to an array whichever shape Keycloak sent.
    expect(result.claims.aud).toEqual(['account']);
  });

  it('accepts a token whose audience (not azp) names a signals client', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({ azp: undefined, aud: ['account', 'signals-api'] })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an aggregator token that is otherwise valid in the shared realm', async () => {
    // Same issuer, same signing key — only the client differs. This is exactly
    // the case R9 warns about: signature + iss alone would let it through.
    const result = await verifyKeycloakToken(
      await mintToken({ azp: 'aggregator-portal', aud: 'account' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_CLIENT_REJECTED');
    expect(result.message).toContain('aggregator-portal');
  });

  it('rejects a token signed by a key that is not in the realm JWKS', async () => {
    const result = await verifyKeycloakToken(await mintToken({ key: foreignPrivateKey }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token from a different issuer', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({ iss: 'https://other.example/realms/x' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_INVALID');
  });

  it('reports an expired token distinctly from an invalid one', async () => {
    // Well past the 30s clock tolerance.
    const result = await verifyKeycloakToken(await mintToken({ expiresIn: '-5m' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_EXPIRED');
  });

  it('reports an unreachable JWKS as unavailable, not as a bad token', async () => {
    // A Keycloak outage must not read as "every user's token went invalid".
    const token = await mintToken();
    jwksServerFails = true;
    const result = await verifyKeycloakToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('KEYCLOAK_UNAVAILABLE');
  });

  it('reports an unknown kid as an invalid token, not as an outage', async () => {
    // The key set was fetched fine; the token just names a key that is not in
    // it. That is the token's problem, and it must not look like a Keycloak
    // outage to whoever is reading the logs.
    const token = await new SignJWT({ azp: 'signals-ui' })
      .setProtectedHeader({ alg: 'RS256', kid: 'a-kid-the-realm-never-published' })
      .setIssuer(issuer)
      .setAudience('account')
      .setSubject('11111111-2222-3333-4444-555555555555')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(foreignPrivateKey);

    const result = await verifyKeycloakToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_INVALID');
  });

  it('refuses to verify anything when Keycloak is not configured', async () => {
    const token = await mintToken();
    mockKeycloakConfig.issuer = '';
    mockKeycloakConfig.jwks_uri = '';
    const result = await verifyKeycloakToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('KEYCLOAK_NOT_CONFIGURED');
    expect(jwksRequests).toBe(0);
  });

  it('rejects a token with no subject', async () => {
    const result = await verifyKeycloakToken(await mintToken({ sub: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOKEN_INVALID');
    expect(result.message).toContain('sub');
  });

  it('fetches the JWKS once across repeated verifications', async () => {
    await verifyKeycloakToken(await mintToken());
    await verifyKeycloakToken(await mintToken());
    await verifyKeycloakToken(await mintToken());
    expect(jwksRequests).toBe(1);
  });

  it('accepts a service client once it is added to the accepted list', async () => {
    mockKeycloakConfig.accepted_client_ids = ['signals-ui', 'signals-api', 'aggregator-dpg'];
    const result = await verifyKeycloakToken(await mintToken({ azp: 'aggregator-dpg' }));
    expect(result.ok).toBe(true);
  });
});

describe('claim helpers', () => {
  it('reads realm roles, defaulting to an empty list', async () => {
    const withRoles = await verifyKeycloakToken(
      await mintToken({ claims: { realm_access: { roles: ['signals_participant'] } } })
    );
    expect(withRoles.ok).toBe(true);
    if (!withRoles.ok) return;
    expect(realmRoles(withRoles.claims)).toEqual(['signals_participant']);
    expect(hasRealmRole(withRoles.claims, 'signals_participant')).toBe(true);
    // aggregator's realm role must not read as a signals capability.
    expect(hasRealmRole(withRoles.claims, 'org_owner')).toBe(false);

    const withoutRoles = await verifyKeycloakToken(await mintToken());
    expect(withoutRoles.ok).toBe(true);
    if (!withoutRoles.ok) return;
    expect(realmRoles(withoutRoles.claims)).toEqual([]);
  });

  it('identifies a client-credentials token by client_id', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({ azp: 'signals-api', claims: { client_id: 'signals-api' } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isServiceAccountToken(result.claims)).toBe(true);
  });

  it('identifies a client-credentials token by its service-account username', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({
        azp: 'signals-api',
        claims: { preferred_username: 'service-account-signals-api' },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isServiceAccountToken(result.claims)).toBe(true);
  });

  it('identifies a service token by azp alone, with no client_id or username claim', () => {
    /**
     * The lockout case. The bundled realm's service clients carry no
     * `client_id` mapper, and `preferred_username` needs the `profile` scope —
     * so an operator trimming that scope from a machine client left it looking
     * human, which now means 401 BEARER_SESSION_NOT_SUPPORTED on every call.
     * `azp` against the configured list is the signal a realm cannot remove.
     */
    mockKeycloakConfig.service_client_ids = ['aggregator-dpg'];

    expect(isServiceAccountToken({ azp: 'aggregator-dpg' } as never)).toBe(true);
  });

  it('does not treat an unlisted azp as a service account', () => {
    mockKeycloakConfig.service_client_ids = ['aggregator-dpg'];

    expect(isServiceAccountToken({ azp: 'signals-ui' } as never)).toBe(false);
  });

  it('does not mistake a human session token for a service account', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({ claims: { preferred_username: 'asha@example.org' } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isServiceAccountToken(result.claims)).toBe(false);
  });
});

describe('actingOrgGrant', () => {
  /**
   * The acting-org grant (§5.1). The load-bearing distinction is absent (no
   * claim → fall back to the header) versus empty (a real grant of nothing).
   */
  const withClaim = (value: unknown) =>
    ({ sub: 's', iss: issuer, aud: ['account'], exp: 1, signals_acting_orgs: value }) as never;

  it('is undefined when the claim is absent — fall back to the header', async () => {
    const result = await verifyKeycloakToken(await mintToken());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(actingOrgGrant(result.claims)).toBeUndefined();
  });

  it('reads a JSON array from a multivalued mapper', () => {
    expect(actingOrgGrant(withClaim(['org_a', 'org_b']))).toEqual(['org_a', 'org_b']);
  });

  it('reads a comma-separated string from a hardcoded-claim mapper', () => {
    // Keycloak's hardcoded-claim mapper emits a plain string unless
    // jsonType.label is JSON, so both shapes must work.
    expect(actingOrgGrant(withClaim('org_a,org_b'))).toEqual(['org_a', 'org_b']);
  });

  it('trims whitespace and drops empties', () => {
    expect(actingOrgGrant(withClaim(' org_a , , org_b '))).toEqual(['org_a', 'org_b']);
  });

  it('preserves an EMPTY grant as empty, not undefined', () => {
    // A grant of nothing must authorise nothing — it is not the same as absent.
    expect(actingOrgGrant(withClaim([]))).toEqual([]);
    expect(actingOrgGrant(withClaim(''))).toEqual([]);
  });

  it('is undefined for a claim of an unusable type', () => {
    expect(actingOrgGrant(withClaim(42))).toBeUndefined();
    expect(actingOrgGrant(withClaim(null))).toBeUndefined();
  });

  it('detects the wildcard grant', () => {
    expect(grantIsWildcard(actingOrgGrant(withClaim(['*'])))).toBe(true);
    expect(grantIsWildcard(actingOrgGrant(withClaim(['org_a'])))).toBe(false);
    expect(grantIsWildcard(undefined)).toBe(false);
  });

  it('survives a real token round-trip', async () => {
    const result = await verifyKeycloakToken(
      await mintToken({ claims: { signals_acting_orgs: ['org_a', '*'] } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(actingOrgGrant(result.claims)).toEqual(['org_a', '*']);
    expect(grantIsWildcard(actingOrgGrant(result.claims))).toBe(true);
  });
});
