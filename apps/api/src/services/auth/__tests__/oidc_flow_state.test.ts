import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The in-flight half of a BFF login (AUTH-VULN-03/04).
 *
 * Everything asserted here is a redirect or replay control: a `state` is good
 * for exactly one callback, and neither of the two caller-supplied redirect
 * inputs (`returnTo`, `appOrigin`) may send a freshly authenticated user
 * somewhere we did not choose.
 */

const redisSet = vi.fn();
const redisGetdel = vi.fn();
vi.mock('@api/db/secondary/redis', () => ({
  redis: { set: redisSet, getdel: redisGetdel },
}));

vi.mock('@dpg/config', () => ({
  allowed_origins: ['http://localhost:3000', 'https://app.example.org'],
}));

const { consumeFlowState, safeAppOrigin, safeReturnTo, saveFlowState } = await import(
  '../oidc_flow_state.js'
);

const FLOW = {
  verifier: 'pkce-verifier',
  nonce: 'nonce',
  returnTo: '/',
  redirectUri: 'http://localhost:2742/api/v1/auth/session/callback',
  appOrigin: 'http://localhost:3000',
};

beforeEach(() => {
  vi.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  redisGetdel.mockResolvedValue(null);
});

describe('flow storage', () => {
  it('keys on the hash of the state, never the state itself', async () => {
    // `state` is a credential for this flow; a Redis key listing must not hand
    // an attacker one they can present on a crafted callback.
    await saveFlowState('the-state', FLOW);

    const key = redisSet.mock.calls[0][0] as string;
    expect(key).toBe('oidcflow:' + createHash('sha256').update('the-state').digest('hex'));
    expect(key).not.toContain('the-state');
  });

  it('expires the flow after five minutes', async () => {
    await saveFlowState('s', FLOW);

    expect(redisSet.mock.calls[0][2]).toBe('EX');
    expect(redisSet.mock.calls[0][3]).toBe(300);
  });

  it('keeps the PKCE verifier server-side, in the stored value', async () => {
    // The whole reason the exchange moved to the API: the verifier must never
    // be somewhere the browser can read it.
    await saveFlowState('s', FLOW);

    expect(JSON.parse(redisSet.mock.calls[0][1] as string).verifier).toBe('pkce-verifier');
  });
});

describe('consumeFlowState', () => {
  it('reads and deletes in one step, so a state is good for one callback', async () => {
    redisGetdel.mockResolvedValue(JSON.stringify(FLOW));

    await expect(consumeFlowState('s')).resolves.toEqual(FLOW);
    // GETDEL, not GET: a replayed callback must find nothing rather than mint a
    // second session from one authorization.
    expect(redisGetdel).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown or already-consumed state', async () => {
    await expect(consumeFlowState('s')).resolves.toBeNull();
  });

  it('returns null rather than throwing on a corrupt entry', async () => {
    redisGetdel.mockResolvedValue('{not json');

    await expect(consumeFlowState('s')).resolves.toBeNull();
  });
});

describe('safeReturnTo', () => {
  it('keeps a path on this origin', () => {
    expect(safeReturnTo('/profile/new')).toBe('/profile/new');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('rejects an absolute URL — the open-redirect case', () => {
    // Without this, `?returnTo=https://evil.test` authenticates the user for
    // real and then lands them on the attacker's page wearing a live session.
    expect(safeReturnTo('https://evil.test')).toBe('/');
    expect(safeReturnTo('http://evil.test')).toBe('/');
  });

  it('rejects a protocol-relative URL, which a "starts with /" check would admit', () => {
    expect(safeReturnTo('//evil.test/path')).toBe('/');
  });

  it('falls back for anything that is not a non-empty string', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo(42)).toBe('/');
    expect(safeReturnTo({ toString: () => '/x' })).toBe('/');
    expect(safeReturnTo(undefined, '/auth/login')).toBe('/auth/login');
  });
});

describe('safeAppOrigin', () => {
  const FALLBACK = 'http://localhost:2742';

  it('keeps an origin this instance already serves a browser at', () => {
    expect(safeAppOrigin('http://localhost:3000', FALLBACK)).toBe('http://localhost:3000');
    expect(safeAppOrigin('https://app.example.org', FALLBACK)).toBe('https://app.example.org');
  });

  it('refuses an origin that is not on the CORS allowlist', () => {
    expect(safeAppOrigin('https://evil.test', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a near-miss rather than matching on a prefix', () => {
    // Substring matching here would accept `https://app.example.org.evil.test`.
    expect(safeAppOrigin('https://app.example.org.evil.test', FALLBACK)).toBe(FALLBACK);
    expect(safeAppOrigin('http://localhost:3000/../..', FALLBACK)).toBe(FALLBACK);
    expect(safeAppOrigin('http://localhost:30001', FALLBACK)).toBe(FALLBACK);
  });

  it('falls back when nothing usable was supplied', () => {
    expect(safeAppOrigin(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeAppOrigin('', FALLBACK)).toBe(FALLBACK);
    expect(safeAppOrigin(['http://localhost:3000'], FALLBACK)).toBe(FALLBACK);
  });
});
