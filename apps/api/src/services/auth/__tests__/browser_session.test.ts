import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The server-side session store that replaced `localStorage` (AUTH-VULN-03/04).
 *
 * Two properties carry the security weight and are pinned here rather than left
 * to review: the raw session id never becomes a Redis key, and a session never
 * outlives the refresh token behind it.
 */

const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();
vi.mock('@api/db/secondary/redis', () => ({
  redis: { get: redisGet, set: redisSet, del: redisDel },
}));

const {
  createSession,
  destroySession,
  newCsrfToken,
  newSessionId,
  readSession,
  safeEqual,
  updateSession,
  SESSION_TTL_SECONDS,
} = await import('../browser_session.js');

const HOUR = 60 * 60 * 1000;

const session = (over: Partial<Record<string, unknown>> = {}) => ({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessTokenExp: Date.now() + 5 * 60 * 1000,
  refreshTokenExp: Date.now() + 30 * HOUR,
  csrfToken: 'csrf',
  appOrigin: 'http://localhost:3000',
  createdAt: Date.now(),
  ...over,
});

/** What the module should have used as the Redis key for `id`. */
const hashedKey = (id: string) =>
  'bsess:' + createHash('sha256').update(id).digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue('OK');
  redisDel.mockResolvedValue(1);
});

describe('session ids', () => {
  it('mints unguessable ids and csrf tokens, and never repeats one', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
    // 32 bytes base64url — the length is the entropy claim, so assert it.
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(43);

    const tokens = new Set(Array.from({ length: 200 }, () => newCsrfToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('the raw session id never reaches Redis', () => {
  it('writes, reads and deletes under the SHA-256 of the id', async () => {
    const id = 'raw-session-id';

    await createSession(id, session() as never);
    expect(redisSet.mock.calls[0][0]).toBe(hashedKey(id));

    await readSession(id);
    expect(redisGet.mock.calls[0][0]).toBe(hashedKey(id));

    await destroySession(id);
    expect(redisDel.mock.calls[0][0]).toBe(hashedKey(id));

    // The point of the hashing: a KEYS listing cannot be replayed as a login.
    const everyArgument = [...redisSet.mock.calls, ...redisGet.mock.calls, ...redisDel.mock.calls]
      .flat()
      .map(String);
    expect(everyArgument.some((arg) => arg.includes(id))).toBe(false);
  });
});

describe('time to live', () => {
  it('uses the sliding window while the refresh token outlives it', async () => {
    await createSession('id', session({ refreshTokenExp: Date.now() + 30 * HOUR }) as never);
    expect(redisSet.mock.calls[0][2]).toBe('EX');
    expect(redisSet.mock.calls[0][3]).toBe(SESSION_TTL_SECONDS);
  });

  it('never outlives the refresh token', async () => {
    // Keycloak stops honouring the refresh token in an hour; a session that
    // claimed eight would leave the user failing mid-request rather than
    // being asked to sign in again.
    await createSession('id', session({ refreshTokenExp: Date.now() + HOUR }) as never);

    const ttl = redisSet.mock.calls[0][3] as number;
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(ttl).toBeGreaterThan(3500);
  });

  it('floors an already-expired refresh token at one second rather than a negative TTL', async () => {
    // `EX` with a non-positive value is an error in Redis, which would turn a
    // stale session into a 500 instead of a logout.
    await createSession('id', session({ refreshTokenExp: Date.now() - HOUR }) as never);
    expect(redisSet.mock.calls[0][3]).toBe(1);
  });
});

describe('readSession', () => {
  it('returns the stored session', async () => {
    const stored = session();
    redisGet.mockResolvedValue(JSON.stringify(stored));

    await expect(readSession('id')).resolves.toEqual(stored);
  });

  it('returns null for a missing entry', async () => {
    await expect(readSession('id')).resolves.toBeNull();
  });

  it('treats a corrupt entry as no session rather than throwing', async () => {
    redisGet.mockResolvedValue('{not json');

    await expect(readSession('id')).resolves.toBeNull();
  });
});

describe('updateSession', () => {
  it('merges the patch and rewrites with a TTL derived from the NEW expiry', async () => {
    redisGet.mockResolvedValue(
      JSON.stringify(session({ refreshTokenExp: Date.now() + HOUR })),
    );

    const next = await updateSession('id', {
      accessToken: 'rotated',
      refreshTokenExp: Date.now() + 30 * HOUR,
    });

    expect(next?.accessToken).toBe('rotated');
    // Untouched fields survive the merge.
    expect(next?.appOrigin).toBe('http://localhost:3000');
    // The refreshed token extends the session; using the OLD expiry here would
    // expire a session that had just been renewed.
    expect(redisSet.mock.calls[0][3]).toBe(SESSION_TTL_SECONDS);
  });

  it('returns null without writing when the session is already gone', async () => {
    const result = await updateSession('id', { accessToken: 'x' });

    expect(result).toBeNull();
    // A write here would resurrect a destroyed session from a patch.
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects everything else', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths: timingSafeEqual throws on these, so the length check
    // has to come first — a throw here would surface as a 500 on a bad CSRF
    // token instead of a 403.
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('abc', '')).toBe(false);
  });
});
