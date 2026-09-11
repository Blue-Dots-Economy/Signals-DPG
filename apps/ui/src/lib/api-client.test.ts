import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the interceptors the module registers, without a real axios instance
// or network. `use` is what we assert against.
const requestUse = vi.fn();
const responseUse = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({
      interceptors: {
        request: { use: requestUse },
        response: { use: responseUse },
      },
    }),
  },
}));
vi.mock('./api-config', () => ({ apiConfig: { getUrl: () => 'http://api.test' } }));
/**
 * `getCsrfToken` is the non-React signal for "this browser holds a session".
 * The interceptor gates on it, so it has to be controllable here.
 */
let csrfToken: string | null = 'the-csrf-token';
vi.mock('./bff-session', () => ({
  getCsrfToken: () => csrfToken,
  fetchBffSession: vi.fn(async () => ({ authenticated: true })),
}));

const emitSessionExpired = vi.fn();
vi.mock('./auth-events', () => ({ emitSessionExpired: () => emitSessionExpired() }));

import { createApiClient } from './api-client';

/** The rejection handler the module installs on the response interceptor. */
function onRejected(): (e: unknown) => Promise<never> {
  createApiClient();
  const call = responseUse.mock.calls.at(-1);
  return call?.[1] as (e: unknown) => Promise<never>;
}

const reject = async (error: unknown) => {
  await expect(onRejected()(error)).rejects.toBe(error);
};

beforeEach(() => {
  vi.clearAllMocks();
  csrfToken = 'the-csrf-token';
});

describe('api-client — response interceptor', () => {
  it('registers a response interceptor at all', () => {
    // There was none, which is the whole reason an expired session polled 401s
    // forever: nothing ever told the app its credentials had stopped working.
    createApiClient();
    expect(responseUse).toHaveBeenCalledTimes(1);
  });

  it('signals expiry on 401 TOKEN_EXPIRED', async () => {
    await reject({ response: { status: 401, data: { code: 'TOKEN_EXPIRED' } } });
    expect(emitSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('signals expiry on 401 NO_ACTIVE_SESSION', async () => {
    await reject({ response: { status: 401, data: { code: 'NO_ACTIVE_SESSION' } } });
    expect(emitSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does NOT sign the user out on an unrelated 401', async () => {
    // A 401 from a route the user simply may not call must stay an ordinary
    // error. Signing out on any 401 would let one unlucky request end a
    // perfectly good session.
    await reject({ response: { status: 401, data: { error: 'UNAUTHORIZED' } } });
    await reject({ response: { status: 401, data: {} } });
    await reject({ response: { status: 401 } });
    expect(emitSessionExpired).not.toHaveBeenCalled();
  });

  it('signals expiry on a 401 UNAUTHORIZED when we hold a session', async () => {
    // What a dead cookie session actually returns. The old codes never appear
    // on the BFF path, so without this the interceptor would never fire for the
    // very case it exists to catch.
    await reject({ response: { status: 401, data: { code: 'UNAUTHORIZED' } } });
    expect(emitSessionExpired).toHaveBeenCalled();
  });

  it('does NOT sign out an anonymous caller getting the same UNAUTHORIZED', async () => {
    /**
     * A visitor who was never signed in gets the identical code from any
     * authenticated route. Telling them their session expired would be wrong —
     * and worse, `emitSessionExpired` is latched to fire once per page, so
     * spending it here would swallow a REAL expiry later in the same page.
     * Hence the gate lives in the interceptor, not in the handler.
     */
    csrfToken = null;

    await reject({ response: { status: 401, data: { code: 'UNAUTHORIZED' } } });
    expect(emitSessionExpired).not.toHaveBeenCalled();
  });

  it('leaves a 503 alone — an outage is not a logout', async () => {
    // The API answers a Keycloak/Redis outage with 503 on purpose so it does
    // not read as "your session died" (see bff-session's `unknown`).
    await reject({ response: { status: 503, data: { code: 'IDENTITY_PROVIDER_UNAVAILABLE' } } });
    expect(emitSessionExpired).not.toHaveBeenCalled();
  });

  it('ignores non-401 statuses even with an expiry-looking code', async () => {
    await reject({ response: { status: 403, data: { code: 'TOKEN_EXPIRED' } } });
    await reject({ response: { status: 500, data: { code: 'TOKEN_EXPIRED' } } });
    expect(emitSessionExpired).not.toHaveBeenCalled();
  });

  it('survives a transport error with no response at all', async () => {
    await reject(new Error('Network Error'));
    await reject(undefined);
    expect(emitSessionExpired).not.toHaveBeenCalled();
  });

  it('always re-rejects, so callers still see the failure', async () => {
    const err = { response: { status: 401, data: { code: 'TOKEN_EXPIRED' } } };
    await expect(onRejected()(err)).rejects.toBe(err);
  });

  it('passes successful responses through untouched', () => {
    createApiClient();
    const onFulfilled = responseUse.mock.calls.at(-1)?.[0] as (r: unknown) => unknown;
    const res = { status: 200, data: { ok: true } };
    expect(onFulfilled(res)).toBe(res);
  });
});
