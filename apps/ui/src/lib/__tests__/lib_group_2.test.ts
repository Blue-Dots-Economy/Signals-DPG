import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';

import {
  getEnumFilterFields,
  getEnumFilterFieldsForDomains,
  humanizeKey,
  itemPassesEnumFilters,
  type EnumFilterField,
} from '../enum-filters';
import { createPhotonProvider, parsePhotonFeatures } from '../geo/photon';
import {
  clearMatchScoreCache,
  generateCacheKey,
  getCachedMatchScore,
  setCachedMatchScore,
} from '@/utils/match-score-cache';
import type { MatchScoreResult } from '../match-score-api';

// ────────────────────────────────────────────────────────────────────────────
// Shared mock plumbing for the two axios-backed API wrappers. Both
// `network-api` and `action-api` build their client at MODULE LOAD time via
// `createApiClient()`, so each test re-imports the module under a fresh
// `../api-client` mock (same pattern as network-api.test.ts). The factories
// below are lazy (`vi.doMock`, not `vi.mock`) so closing over the local mock
// fns is safe — nothing is hoisted above them.
// ────────────────────────────────────────────────────────────────────────────

type GetMock = ReturnType<typeof makeGet>;
type PostMock = ReturnType<typeof makePost>;

function makeGet() {
  return vi.fn<
    (
      url: string,
      config?: {
        params?: URLSearchParams | Record<string, unknown>;
        signal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ) => Promise<{ status?: number; data: unknown }>
  >();
}

function makePost() {
  return vi.fn<
    (
      url: string,
      body?: unknown,
      config?: { signal?: AbortSignal },
    ) => Promise<{ status?: number; data: unknown }>
  >();
}

async function loadNetworkApi() {
  vi.resetModules();
  const get = makeGet();
  const post = makePost();
  vi.doMock('../api-client', () => ({
    createApiClient: () => ({ get, post }),
  }));
  const mod = await import('../network-api');
  return { mod, get, post };
}

function paramsOf(get: GetMock, call = 0): URLSearchParams {
  const params = get.mock.calls[call]?.[1]?.params;
  if (!(params instanceof URLSearchParams)) {
    throw new Error('expected URLSearchParams in the request config');
  }
  return params;
}

describe('network-api — fetch limits resolved from build/deploy env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the VITE override when it parses to a positive number', async () => {
    vi.stubEnv('VITE_PROFILE_FETCH_LIMIT', '500');
    vi.stubEnv('VITE_PROFILE_PAGE_SIZE', '25');
    vi.stubEnv('VITE_MAP_FETCH_LIMIT', '2000');
    const { mod } = await loadNetworkApi();

    expect(mod.resolveProfileFetchLimit()).toBe(500);
    expect(mod.resolveProfilePageSize()).toBe(25);
    expect(mod.resolveMapFetchLimit()).toBe(2000);
    // The module-load-time constants pick up the same override.
    expect(mod.PROFILE_FETCH_LIMIT).toBe(500);
    expect(mod.PROFILE_PAGE_SIZE).toBe(25);
    expect(mod.MAP_FETCH_LIMIT).toBe(2000);
  });

  it('falls back to the defaults when unset, empty, non-numeric, zero or negative', async () => {
    vi.stubEnv('VITE_PROFILE_FETCH_LIMIT', undefined);
    vi.stubEnv('VITE_PROFILE_PAGE_SIZE', '');
    vi.stubEnv('VITE_MAP_FETCH_LIMIT', 'lots');
    const { mod } = await loadNetworkApi();

    expect(mod.resolveProfileFetchLimit()).toBe(1000);
    expect(mod.resolveProfilePageSize()).toBe(50);
    expect(mod.resolveMapFetchLimit()).toBe(25000);

    vi.stubEnv('VITE_PROFILE_FETCH_LIMIT', '0');
    expect(mod.resolveProfileFetchLimit()).toBe(1000);
    vi.stubEnv('VITE_PROFILE_FETCH_LIMIT', '-5');
    expect(mod.resolveProfileFetchLimit()).toBe(1000);
    vi.stubEnv('VITE_PROFILE_PAGE_SIZE', '-1');
    expect(mod.resolveProfilePageSize()).toBe(50);
    vi.stubEnv('VITE_MAP_FETCH_LIMIT', '0');
    expect(mod.resolveMapFetchLimit()).toBe(25000);
  });
});

describe('fetchNetworkItems', () => {
  it('serializes every supported filter into the /network/item/fetch query string', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({ data: { meta: { total: 0 }, items: [] } });
    const controller = new AbortController();

    await mod.fetchNetworkItems(
      {
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: 'item-1',
        item_instance_url: 'https://peer.example',
        item_schema_url: 'https://schemas.example/profile_1.0.json',
        limit: 10,
        offset: 20,
        item_latitude: 12.97,
        item_longitude: 77.59,
        radius_meters: 5000,
        cache_ttl_seconds: 90,
      },
      controller.signal,
    );

    expect(get.mock.calls[0][0]).toBe('/api/v1/network/item/fetch');
    expect(get.mock.calls[0][1]?.signal).toBe(controller.signal);
    const params = paramsOf(get);
    expect(Object.fromEntries(params.entries())).toEqual({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_id: 'item-1',
      item_instance_url: 'https://peer.example',
      item_schema_url: 'https://schemas.example/profile_1.0.json',
      limit: '10',
      offset: '20',
      item_latitude: '12.97',
      item_longitude: '77.59',
      radius_meters: '5000',
      cache_ttl_seconds: '90',
    });
  });

  it('sends only network+domain when no optional filter is supplied (a blank item_type is dropped), and returns response.data', async () => {
    const { mod, get } = await loadNetworkApi();
    const payload = { meta: { total: 1 }, items: [{ item_id: 'x' }] };
    get.mockResolvedValue({ data: payload });

    const result = await mod.fetchNetworkItems({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: '',
    });

    expect(paramsOf(get).toString()).toBe('item_network=blue_dot&item_domain=seeker');
    expect(result).toBe(payload);
  });

  it('keeps a zero offset and a zero radius rather than dropping them as falsy', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({ data: { meta: {}, items: [] } });

    await mod.fetchNetworkItems({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      offset: 0,
      radius_meters: 0,
      cache_ttl_seconds: 0,
    });

    const params = paramsOf(get);
    expect(params.get('item_type')).toBe('profile_1.0');
    expect(params.get('offset')).toBe('0');
    expect(params.get('radius_meters')).toBe('0');
    expect(params.get('cache_ttl_seconds')).toBe('0');
  });
});

describe('fetchNetworkMarkers', () => {
  it('sends bbox corners and a free-text q to /network/item/markers', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({
      data: { meta: { total: 0, limit: 25000, offset: 0, partial: false, unavailable_instances: [] }, markers: [] },
    });

    await mod.fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      min_lat: 12,
      min_lng: 77,
      max_lat: 13,
      max_lng: 78,
      q: 'welder',
      limit: 500,
      offset: 0,
      cache_ttl_seconds: 30,
    });

    expect(get.mock.calls[0][0]).toBe('/api/v1/network/item/markers');
    expect(Object.fromEntries(paramsOf(get).entries())).toEqual({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      min_lat: '12',
      min_lng: '77',
      max_lat: '13',
      max_lng: '78',
      q: 'welder',
      limit: '500',
      offset: '0',
      cache_ttl_seconds: '30',
    });
  });

  it('sends the radius triple on the distance path', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({ data: { meta: {}, markers: [] } });

    await mod.fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_latitude: 12.9,
      item_longitude: 77.6,
      radius_meters: 25000,
    });

    const params = paramsOf(get);
    expect(params.get('item_latitude')).toBe('12.9');
    expect(params.get('item_longitude')).toBe('77.6');
    expect(params.get('radius_meters')).toBe('25000');
    expect(params.has('min_lat')).toBe(false);
  });

  it('serializes a multi-select facet as REPEATED bracket keys, not one comma-joined value (#203 Task 7)', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({ data: { meta: {}, markers: [] } });

    await mod.fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_state: { gender: ['female', 'male'], work_experience: 'fresher' },
    });

    const params = paramsOf(get);
    expect(params.getAll('item_state[gender]')).toEqual(['female', 'male']);
    expect(params.toString()).not.toContain('female%2Cmale');
    // A scalar facet stays a single param (pre-#203 containment filter).
    expect(params.getAll('item_state[work_experience]')).toEqual(['fresher']);
  });

  it('omits q when it is an empty string, and returns the markers envelope', async () => {
    const { mod, get } = await loadNetworkApi();
    const payload = {
      meta: { total: 2, limit: 100, offset: 0, partial: true, unavailable_instances: ['https://down.example'] },
      markers: [{ item_id: 'm1', item_domain: 'seeker', item_instance_url: null, item_locations: [] }],
    };
    get.mockResolvedValue({ data: payload });

    const result = await mod.fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      q: '',
    });

    expect(paramsOf(get).has('q')).toBe(false);
    expect(result).toBe(payload);
  });
});

describe('fetchNetworkConfigs / fetchNetworkConfig', () => {
  it('returns only the network_config schemas, dropping item/consent schema entries', async () => {
    const { mod, get } = await loadNetworkApi();
    const blueDot = { id: 'blue_dot', domains: [] };
    const yellowDot = { id: 'yellow_dot', domains: [] };
    get.mockResolvedValue({
      data: [
        { cache_key: 'a', kind: 'domain_item_schema', schema: { id: 'not-a-network' } },
        { cache_key: 'b', kind: 'network_config', schema: blueDot },
        { cache_key: 'c', kind: 'consent_config', schema: { id: 'consent' } },
        { cache_key: 'd', kind: 'network_config', schema: yellowDot },
      ],
    });

    const configs = await mod.fetchNetworkConfigs();

    expect(get.mock.calls[0][0]).toBe('/api/v1/network/schemas');
    expect(configs).toEqual([blueDot, yellowDot]);
  });

  it('fetches one network by id, passing it as the `network` query param', async () => {
    const { mod, get } = await loadNetworkApi();
    const blueDot = { id: 'blue_dot', domains: [] };
    get.mockResolvedValue({
      data: [
        { cache_key: 'x', kind: 'item_schema_url', schema: { id: 'other' } },
        { cache_key: 'y', kind: 'network_config', schema: blueDot },
      ],
    });

    const config = await mod.fetchNetworkConfig('blue_dot');

    expect(get.mock.calls[0][1]?.params).toEqual({ network: 'blue_dot' });
    expect(config).toEqual(blueDot);
  });

  it('throws a named "not found" error when the response carries no network_config entry', async () => {
    const { mod, get } = await loadNetworkApi();
    get.mockResolvedValue({ data: [{ cache_key: 'x', kind: 'consent_config', schema: {} }] });

    await expect(mod.fetchNetworkConfig('green_dot')).rejects.toThrow(
      'Network "green_dot" not found',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// action-api
// ────────────────────────────────────────────────────────────────────────────

interface StubInstance {
  post: PostMock;
  interceptors: { request: { use: (fn: RequestInterceptor) => void } };
}
type RequestInterceptor = (config: { headers: Record<string, string> }) => {
  headers: Record<string, string>;
};

async function loadActionApi() {
  vi.resetModules();
  const get = makeGet();
  const post = makePost();
  const instancePost = makePost();
  const created: Array<{ baseURL?: string; withCredentials?: boolean }> = [];
  const interceptors: RequestInterceptor[] = [];

  vi.doMock('../api-client', () => ({
    createApiClient: () => ({ get, post }),
  }));
  vi.doMock('axios', async () => {
    const actual = await vi.importActual<typeof import('axios')>('axios');
    return {
      ...actual,
      isAxiosError: actual.isAxiosError,
      default: {
        isAxiosError: actual.isAxiosError,
        create: (config: { baseURL?: string; withCredentials?: boolean }): StubInstance => {
          // Recorded outside so tests can assert which baseURL was used.
          created.push(config);
          return {
            post: instancePost,
            interceptors: { request: { use: (fn: RequestInterceptor) => void interceptors.push(fn) } },
          };
        },
      },
    };
  });

  const mod = await import('../action-api');
  return { mod, get, post, instancePost, created, interceptors };
}

function envelope<T extends object>(entry: T) {
  return {
    status: 200,
    data: {
      results: [{ index: 0, status: 'success', ...entry }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    },
  };
}

const SOURCE_ITEM = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_id: 'src-1',
};
const TARGET_ITEM = { ...SOURCE_ITEM, item_domain: 'provider', item_id: 'tgt-1', item_instance_url: 'https://peer.example' };
const PERFORM_PAYLOAD = {
  action_type: 'connect',
  source_item: SOURCE_ITEM,
  target_item: TARGET_ITEM,
  requirements_snapshot: {},
};

describe('action-api — guardian OTP error classification', () => {
  it('recognises the action-route codes verbatim', async () => {
    const { mod } = await loadActionApi();
    expect(mod.guardianOtpErrorOf({ error: 'GUARDIAN_OTP_REQUIRED' })).toBe('GUARDIAN_OTP_REQUIRED');
    expect(mod.guardianOtpErrorOf({ error: 'GUARDIAN_OTP_INVALID' })).toBe('GUARDIAN_OTP_INVALID');
    expect(mod.guardianOtpErrorOf({ error: 'GUARDIAN_OTP_THROTTLED' })).toBe('GUARDIAN_OTP_THROTTLED');
    expect(mod.guardianOtpErrorOf({ error: 'GUARDIAN_OTP_RATE_LIMITED' })).toBe('GUARDIAN_OTP_RATE_LIMITED');
    expect(mod.guardianOtpErrorOf({ error: 'OTP_PROVIDER_UNAVAILABLE' })).toBe('OTP_PROVIDER_UNAVAILABLE');
  });

  it('maps the profile-consent route aliases onto the shared codes', async () => {
    const { mod } = await loadActionApi();
    expect(mod.guardianOtpErrorOf({ error: 'INVALID_OTP' })).toBe('GUARDIAN_OTP_INVALID');
    expect(mod.guardianOtpErrorOf({ error: 'OTP_VERIFY_THROTTLED' })).toBe('GUARDIAN_OTP_THROTTLED');
    expect(mod.guardianOtpErrorOf({ error: 'OTP_RATE_LIMITED' })).toBe('GUARDIAN_OTP_RATE_LIMITED');
  });

  it('returns null for a success entry, an unrelated code, and a missing entry', async () => {
    const { mod } = await loadActionApi();
    expect(mod.guardianOtpErrorOf({})).toBeNull();
    expect(mod.guardianOtpErrorOf({ error: 'ACTION_LIMIT_REACHED' })).toBeNull();
    expect(mod.guardianOtpErrorOf(null)).toBeNull();
    expect(mod.guardianOtpErrorOf(undefined)).toBeNull();
  });

  it('pulls the code out of an axios error body, a BulkSingleError-shaped throw, and neither', async () => {
    const { mod } = await loadActionApi();
    const axiosErr = new axios.AxiosError(
      'nope',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 422,
        statusText: 'Unprocessable',
        headers: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
        data: { error: 'GUARDIAN_OTP_REQUIRED', message: 'need otp' },
      },
    );
    expect(mod.guardianOtpErrorFromThrown(axiosErr)).toBe('GUARDIAN_OTP_REQUIRED');

    expect(mod.guardianOtpErrorFromThrown({ code: 'GUARDIAN_OTP_INVALID' })).toBe('GUARDIAN_OTP_INVALID');
    expect(mod.guardianOtpErrorFromThrown(new Error('network down'))).toBeNull();
    expect(mod.guardianOtpErrorFromThrown(null)).toBeNull();

    // An axios error with no response at all (request never completed).
    const offline = new axios.AxiosError('Network Error', 'ERR_NETWORK');
    expect(mod.guardianOtpErrorFromThrown(offline)).toBeNull();
  });
});

describe('action-api — performAction', () => {
  it('POSTs a single object to /action/perform on the default client and unwraps results[0]', async () => {
    const { mod, post, created } = await loadActionApi();
    post.mockResolvedValue(
      envelope({
        action_id: 'a1',
        action_type: 'connect',
        action_status: 'requested',
        update_count: 0,
        source_item_id: 'src-1',
        target_item_id: 'tgt-1',
      }),
    );

    const result = await mod.performAction(PERFORM_PAYLOAD);

    expect(post.mock.calls[0][0]).toBe('/api/v1/action/perform');
    expect(post.mock.calls[0][1]).toEqual(PERFORM_PAYLOAD);
    expect(created).toHaveLength(0); // no per-instance client built
    // `index`/`status` envelope fields are stripped from the caller's result.
    expect(result).toEqual({
      action_id: 'a1',
      action_type: 'connect',
      action_status: 'requested',
      update_count: 0,
      source_item_id: 'src-1',
      target_item_id: 'tgt-1',
    });
  });

  it('adds guardian_otp to the body only when resubmitting with a code', async () => {
    const { mod, post } = await loadActionApi();
    post.mockResolvedValue(envelope({ action_id: 'a1' }));

    await mod.performAction(PERFORM_PAYLOAD, undefined, '123456');

    expect(post.mock.calls[0][1]).toEqual({ ...PERFORM_PAYLOAD, guardian_otp: '123456' });
    // The caller's payload object is not mutated.
    expect('guardian_otp' in PERFORM_PAYLOAD).toBe(false);
  });

  it('builds a per-source-instance client (with the bearer interceptor) when sourceInstanceUrl is given', async () => {
    const { mod, post, instancePost, created, interceptors } = await loadActionApi();
    instancePost.mockResolvedValue(envelope({ action_id: 'a1' }));
    localStorage.setItem('auth_token', 'tok-abc');

    await mod.performAction(PERFORM_PAYLOAD, 'https://source.example');

    expect(created[0]?.baseURL).toBe('https://source.example');
    expect(created[0]?.withCredentials).toBe(true);
    expect(instancePost.mock.calls[0][0]).toBe('/api/v1/action/perform');
    expect(post).not.toHaveBeenCalled();

    const withToken = interceptors[0]({ headers: {} });
    expect(withToken.headers.Authorization).toBe('Bearer tok-abc');

    localStorage.removeItem('auth_token');
    expect(interceptors[0]({ headers: {} }).headers.Authorization).toBeUndefined();
  });

  it('throws a BulkSingleError carrying the per-item code when the single item fails (422)', async () => {
    const { mod, post } = await loadActionApi();
    const rejection = new axios.AxiosError('Unprocessable', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      data: {
        results: [{ index: 0, status: 'error', error: 'GUARDIAN_OTP_REQUIRED', message: 'Guardian OTP required' }],
        summary: { total: 1, succeeded: 0, failed: 1 },
      },
    });
    post.mockRejectedValue(rejection);

    await expect(mod.performAction(PERFORM_PAYLOAD)).rejects.toMatchObject({
      name: 'BulkSingleError',
      code: 'GUARDIAN_OTP_REQUIRED',
      message: 'Guardian OTP required',
    });
  });

  it('rethrows a request-level failure (401, no envelope) unchanged', async () => {
    const { mod, post } = await loadActionApi();
    const unauthorized = new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      data: { error: 'UNAUTHORIZED', message: 'no session' },
    });
    post.mockRejectedValue(unauthorized);

    await expect(mod.performAction(PERFORM_PAYLOAD)).rejects.toBe(unauthorized);
  });
});

describe('action-api — updateActionStatus and the bulk variants', () => {
  it('wraps the single update payload in an ARRAY for /action/update-status', async () => {
    const { mod, post } = await loadActionApi();
    post.mockResolvedValue(
      envelope({ action_id: 'a1', action_type: 'connect', action_status: 'accepted', update_count: 1 }),
    );

    const result = await mod.updateActionStatus({ action_id: 'a1', action_status: 'accepted', remarks: 'ok' });

    expect(post.mock.calls[0][0]).toBe('/api/v1/action/update-status');
    expect(post.mock.calls[0][1]).toEqual([{ action_id: 'a1', action_status: 'accepted', remarks: 'ok' }]);
    expect(result).toEqual({
      action_id: 'a1',
      action_type: 'connect',
      action_status: 'accepted',
      update_count: 1,
    });
  });

  it('threads a guardian OTP onto the single update payload', async () => {
    const { mod, post } = await loadActionApi();
    post.mockResolvedValue(envelope({ action_id: 'a1' }));

    await mod.updateActionStatus({ action_id: 'a1', action_status: 'accepted' }, '999111');

    expect(post.mock.calls[0][1]).toEqual([
      { action_id: 'a1', action_status: 'accepted', guardian_otp: '999111' },
    ]);
  });

  it('performActionsBulk posts the array to the dedicated /perform/bulk route and returns the whole envelope', async () => {
    const { mod, post } = await loadActionApi();
    const partial = {
      results: [
        { index: 0, status: 'success', action_id: 'a1' },
        { index: 1, status: 'error', error: 'ACTION_LIMIT_REACHED', message: 'too many' },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    };
    post.mockResolvedValue({ status: 207, data: partial });

    const env = await mod.performActionsBulk([PERFORM_PAYLOAD, PERFORM_PAYLOAD]);

    expect(post.mock.calls[0][0]).toBe('/api/v1/action/perform/bulk');
    expect(post.mock.calls[0][1]).toEqual([PERFORM_PAYLOAD, PERFORM_PAYLOAD]);
    // Partial success is surfaced, not thrown.
    expect(env.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });

  it('performActionsBulk stamps ONE guardian OTP onto every payload in the batch (#393)', async () => {
    const { mod, instancePost } = await loadActionApi();
    instancePost.mockResolvedValue({ status: 200, data: { results: [], summary: { total: 0, succeeded: 0, failed: 0 } } });

    await mod.performActionsBulk([PERFORM_PAYLOAD, PERFORM_PAYLOAD], 'https://source.example', '424242');

    expect(instancePost.mock.calls[0][1]).toEqual([
      { ...PERFORM_PAYLOAD, guardian_otp: '424242' },
      { ...PERFORM_PAYLOAD, guardian_otp: '424242' },
    ]);
  });

  it('updateActionStatusBulk posts the array to /update-status and returns a 422 all-fail envelope instead of throwing', async () => {
    const { mod, post } = await loadActionApi();
    const allFail = {
      results: [{ index: 0, status: 'error', error: 'GUARDIAN_OTP_INVALID', message: 'Incorrect code' }],
      summary: { total: 1, succeeded: 0, failed: 1 },
    };
    post.mockRejectedValue(
      new axios.AxiosError('Unprocessable', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
        data: allFail,
      }),
    );

    const env = await mod.updateActionStatusBulk(
      [{ action_id: 'a1', action_status: 'accepted' }],
      '000000',
    );

    expect(post.mock.calls[0][0]).toBe('/api/v1/action/update-status');
    expect(post.mock.calls[0][1]).toEqual([
      { action_id: 'a1', action_status: 'accepted', guardian_otp: '000000' },
    ]);
    expect(env).toEqual(allFail);
    expect(mod.guardianOtpErrorOf(allFail.results[0])).toBe('GUARDIAN_OTP_INVALID');
  });
});

describe('action-api — reads', () => {
  it('fetchMyActions always sends ownership_role, defaulting to "all"', async () => {
    const { mod, get } = await loadActionApi();
    get.mockResolvedValue({ data: { meta: { total: 0, limit: 20, offset: 0 }, actions: [] } });

    await mod.fetchMyActions();

    expect(get.mock.calls[0][0]).toBe('/api/v1/action/fetch');
    expect(paramsOf(get).toString()).toBe('ownership_role=all');
  });

  it('fetchMyActions forwards every filter and the abort signal', async () => {
    const { mod, get } = await loadActionApi();
    const payload = { meta: { total: 0, limit: 5, offset: 0 }, actions: [] };
    get.mockResolvedValue({ data: payload });
    const controller = new AbortController();

    const result = await mod.fetchMyActions(
      {
        ownership_role: 'received',
        action_id: 'a1',
        action_type: 'connect',
        action_status: 'requested',
        item_id: 'src-1',
        limit: 5,
        offset: 0,
      },
      controller.signal,
    );

    expect(Object.fromEntries(paramsOf(get).entries())).toEqual({
      ownership_role: 'received',
      action_id: 'a1',
      action_type: 'connect',
      action_status: 'requested',
      item_id: 'src-1',
      limit: '5',
      offset: '0',
    });
    expect(get.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(result).toBe(payload);
  });

  it('fetchActionEvents sends the required type+id, and update_count only when supplied', async () => {
    const { mod, get } = await loadActionApi();
    get.mockResolvedValue({ data: { meta: { total: 0, limit: 20, offset: 0 }, events: [] } });

    await mod.fetchActionEvents({ action_type: 'connect', action_id: 'a1' });
    expect(get.mock.calls[0][0]).toBe('/api/v1/action/fetch-events');
    expect(paramsOf(get).toString()).toBe('action_type=connect&action_id=a1');

    await mod.fetchActionEvents({ action_type: 'connect', action_id: 'a1', update_count: 0, limit: 3, offset: 6 });
    const second = paramsOf(get, 1);
    expect(second.get('update_count')).toBe('0');
    expect(second.get('limit')).toBe('3');
    expect(second.get('offset')).toBe('6');
  });
});

describe('action-api — getActionContactDetails', () => {
  it('requests the reveal with Cache-Control: no-store and returns the body', async () => {
    const { mod, get } = await loadActionApi();
    const payload = {
      action_id: 'a1',
      action_status: 'accepted',
      revealed: true,
      other_actor: { item: { item_id: 'tgt-1' } },
    };
    get.mockResolvedValue({ data: payload });

    const result = await mod.getActionContactDetails('a1');

    expect(get.mock.calls[0][0]).toBe('/api/v1/action/a1/contact-details');
    expect(get.mock.calls[0][1]?.headers).toEqual({ 'Cache-Control': 'no-store' });
    expect(result).toBe(payload);
  });

  it('converts an error response into a typed error carrying status + machine code', async () => {
    const { mod, get } = await loadActionApi();
    get.mockRejectedValue(
      new axios.AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
        data: { error: 'PII_NOT_REVEALED', message: 'Reveal not permitted yet' },
      }),
    );

    await expect(mod.getActionContactDetails('a1')).rejects.toMatchObject({
      message: 'Reveal not permitted yet',
      status: 403,
      code: 'PII_NOT_REVEALED',
    });
  });

  it('falls back to "HTTP error <status>" + INTERNAL_SERVER_ERROR when the body has neither field', async () => {
    const { mod, get } = await loadActionApi();
    get.mockRejectedValue(
      new axios.AxiosError('Boom', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
        data: {},
      }),
    );

    await expect(mod.getActionContactDetails('a1')).rejects.toMatchObject({
      message: 'HTTP error 502',
      status: 502,
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('rethrows a non-HTTP failure (no response) untouched', async () => {
    const { mod, get } = await loadActionApi();
    const boom = new Error('socket hang up');
    get.mockRejectedValue(boom);

    await expect(mod.getActionContactDetails('a1')).rejects.toBe(boom);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// enum-filters
// ────────────────────────────────────────────────────────────────────────────

describe('humanizeKey', () => {
  it('title-cases snake_case and camelCase keys', () => {
    expect(humanizeKey('looking_for')).toBe('Looking For');
    expect(humanizeKey('providerCategory')).toBe('Provider Category');
    expect(humanizeKey('nature_of_jobType')).toBe('Nature Of Job Type');
    expect(humanizeKey('gender')).toBe('Gender');
    expect(humanizeKey('')).toBe('');
  });
});

describe('getEnumFilterFields — label, option and shape handling', () => {
  it('prefers a non-blank schema title and falls back to the humanized key otherwise', () => {
    const schema = {
      type: 'object',
      properties: {
        work_experience: { type: 'string', title: '  Experience  ', enum: ['fresher'] },
        nature_of_job: { type: 'array', title: '   ', items: { enum: ['full_time'] } },
        preferred_language: { type: 'string', enum: ['en'] },
      },
    } as unknown as RJSFSchema;

    const byKey = new Map(getEnumFilterFields([schema]).map((f) => [f.key, f]));
    expect(byKey.get('work_experience')?.label).toBe('Experience');
    expect(byKey.get('nature_of_job')?.label).toBe('Nature Of Job');
    expect(byKey.get('preferred_language')?.label).toBe('Preferred Language');
    expect(byKey.get('nature_of_job')?.isArray).toBe(true);
    expect(byKey.get('work_experience')?.isArray).toBe(false);
  });

  it('stringifies numeric enum values and drops non-scalar ones', () => {
    const schema = {
      type: 'object',
      properties: {
        rating: { type: 'number', enum: [1, 2, 3] },
        weird: { type: 'string', enum: [null, true, { a: 1 }] },
      },
    } as unknown as RJSFSchema;

    const fields = getEnumFilterFields([schema]);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'rating', options: ['1', '2', '3'], isArray: false });
  });

  it('ignores schemas and properties that cannot yield options', () => {
    const noProperties = { type: 'object' } as RJSFSchema;
    const unusable = {
      type: 'object',
      properties: {
        // boolean property (additionalProperties style)
        anything: true,
        empty_enum: { type: 'string', enum: [] },
        plain_string: { type: 'string' },
        // tuple `items` is an array, not an object → ignored
        tuple: { type: 'array', items: [{ enum: ['a'] }] },
        array_no_enum: { type: 'array', items: { type: 'string' } },
        array_empty_enum: { type: 'array', items: { enum: [] } },
        array_nonscalar_enum: { type: 'array', items: { enum: [{ a: 1 }] } },
      },
    } as unknown as RJSFSchema;

    expect(getEnumFilterFields([noProperties])).toEqual([]);
    expect(getEnumFilterFields([unusable])).toEqual([]);
    expect(getEnumFilterFields([])).toEqual([]);
  });

  it('unions options across schemas, keeping first-seen label, order and isArray', () => {
    const first = {
      type: 'object',
      properties: { city: { type: 'string', title: 'City', enum: ['blr', 'del'] } },
    } as unknown as RJSFSchema;
    const second = {
      type: 'object',
      properties: {
        city: { type: 'array', title: 'Cities', items: { enum: ['del', 'mum'] } },
        gender: { type: 'string', enum: ['female'] },
      },
    } as unknown as RJSFSchema;

    const fields = getEnumFilterFields([first, second]);
    expect(fields.map((f) => f.key)).toEqual(['city', 'gender']);
    const city = fields[0];
    expect(city.label).toBe('City');
    expect(city.isArray).toBe(false);
    expect(city.options).toEqual(['blr', 'del', 'mum']);
  });
});

describe('getEnumFilterFieldsForDomains — schema sources', () => {
  it('reads default_item_schemas.profile for a domain with no item_schemas map (backwards-compat)', () => {
    const legacy = {
      id: 'seeker',
      description: 'seeker',
      default_item_schemas: {
        profile: {
          type: 'object',
          properties: { gender: { type: 'string', enum: ['female', 'male'] } },
        } as unknown as RJSFSchema,
      },
    } as DotNetworkDomain;

    expect(getEnumFilterFieldsForDomains([legacy]).map((f) => f.key)).toEqual(['gender']);
  });

  it('unions item_schemas and default_item_schemas.profile for the same domain', () => {
    const domain = {
      id: 'seeker',
      description: 'seeker',
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: { gender: { type: 'string', enum: ['female'] } },
        } as unknown as RJSFSchema,
      },
      default_item_schemas: {
        profile: {
          type: 'object',
          properties: {
            gender: { type: 'string', enum: ['male'] },
            city: { type: 'string', enum: ['blr'] },
          },
        } as unknown as RJSFSchema,
      },
    } as DotNetworkDomain;

    const fields = getEnumFilterFieldsForDomains([domain]);
    expect(fields.map((f) => f.key)).toEqual(['gender', 'city']);
    expect(fields[0].options).toEqual(['female', 'male']);
  });

  it('returns nothing for a domain that declares no schemas at all', () => {
    const bare = { id: 'seeker', description: 'seeker' } as DotNetworkDomain;
    expect(getEnumFilterFieldsForDomains([bare])).toEqual([]);
  });
});

describe('itemPassesEnumFilters', () => {
  const enumFields: EnumFilterField[] = [
    { key: 'gender', label: 'Gender', options: ['female', 'male'], isArray: false },
    { key: 'nature_of_job', label: 'Nature Of Job', options: ['full_time', 'part_time'], isArray: true },
  ];

  it('passes an item with no active selections', () => {
    expect(itemPassesEnumFilters({ gender: 'female' }, {}, enumFields)).toBe(true);
    expect(itemPassesEnumFilters({ gender: 'female' }, { gender: [] }, enumFields)).toBe(true);
  });

  it('ANDs across fields and ORs within one field', () => {
    const data = { gender: 'female', nature_of_job: ['part_time', 'contract'] };
    expect(
      itemPassesEnumFilters(data, { gender: ['female', 'male'], nature_of_job: ['part_time'] }, enumFields),
    ).toBe(true);
    // Fails the second field → whole item fails.
    expect(
      itemPassesEnumFilters(data, { gender: ['female'], nature_of_job: ['full_time'] }, enumFields),
    ).toBe(false);
    expect(itemPassesEnumFilters(data, { gender: ['male'] }, enumFields)).toBe(false);
  });

  it('passes an item that simply does not declare the filtered field (domain-safe)', () => {
    expect(itemPassesEnumFilters({ gender: 'female' }, { nature_of_job: ['full_time'] }, enumFields)).toBe(true);
  });

  it('treats a scalar stored in an array-typed field as a one-element array', () => {
    expect(itemPassesEnumFilters({ nature_of_job: 'full_time' }, { nature_of_job: ['full_time'] }, enumFields)).toBe(true);
    expect(itemPassesEnumFilters({ nature_of_job: 'full_time' }, { nature_of_job: ['part_time'] }, enumFields)).toBe(false);
  });

  it('compares array members as strings, so numeric values still match', () => {
    const numeric: EnumFilterField[] = [{ key: 'grades', label: 'Grades', options: ['1', '2'], isArray: true }];
    expect(itemPassesEnumFilters({ grades: [2, 3] }, { grades: ['2'] }, numeric)).toBe(true);
    expect(itemPassesEnumFilters({ grades: [3] }, { grades: ['2'] }, numeric)).toBe(false);
  });

  it('normalizes a null/undefined single value to the empty string (never an accidental match)', () => {
    expect(itemPassesEnumFilters({ gender: null }, { gender: ['female'] }, enumFields)).toBe(false);
    expect(itemPassesEnumFilters({ gender: undefined }, { gender: [''] }, enumFields)).toBe(true);
    expect(itemPassesEnumFilters({ gender: 3 }, { gender: ['3'] }, enumFields)).toBe(true);
  });

  it('infers array-ness from the item value when the field has no metadata', () => {
    expect(itemPassesEnumFilters({ skills: ['welding', 'wiring'] }, { skills: ['wiring'] }, [])).toBe(true);
    expect(itemPassesEnumFilters({ skills: ['welding'] }, { skills: ['wiring'] }, [])).toBe(false);
    expect(itemPassesEnumFilters({ skills: 'wiring' }, { skills: ['wiring'] }, [])).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// geo/photon
// ────────────────────────────────────────────────────────────────────────────

describe('parsePhotonFeatures', () => {
  it('builds a comma-joined label from name/city/state/postcode/country and keeps components', () => {
    const suggestions = parsePhotonFeatures({
      features: [
        {
          geometry: { coordinates: [77.59, 12.97] },
          properties: {
            name: 'Indiranagar',
            city: 'Bengaluru',
            state: 'Karnataka',
            postcode: '560038',
            country: 'India',
          },
        },
      ],
    });

    expect(suggestions).toEqual([
      {
        label: 'Indiranagar, Bengaluru, Karnataka, 560038, India',
        lat: 12.97,
        lng: 77.59,
        components: {
          locality: 'Indiranagar',
          city: 'Bengaluru',
          state: 'Karnataka',
          postcode: '560038',
          country: 'India',
        },
      },
    ]);
  });

  it('skips blank and missing label parts instead of emitting empty segments', () => {
    const [suggestion] = parsePhotonFeatures({
      features: [
        {
          geometry: { coordinates: [77.6, 12.9] },
          properties: { name: '   ', city: 'Bengaluru', country: 'India' },
        },
      ],
    });

    expect(suggestion.label).toBe('Bengaluru, India');
    // The blank `name` is dropped from the LABEL but still carried verbatim in
    // `components.locality` — parsing never rewrites the raw property values.
    expect(suggestion.components).toEqual({
      locality: '   ',
      city: 'Bengaluru',
      state: undefined,
      postcode: undefined,
      country: 'India',
    });
  });

  it('falls back to "lat, lng" when no property yields any label text', () => {
    expect(parsePhotonFeatures({ features: [{ geometry: { coordinates: [77.6, 12.9] } }] })).toEqual([
      { label: '12.9, 77.6', lat: 12.9, lng: 77.6, components: {
        locality: undefined, city: undefined, state: undefined, postcode: undefined, country: undefined,
      } },
    ]);
  });

  it('drops features with missing, short or non-numeric coordinates', () => {
    expect(
      parsePhotonFeatures({
        features: [
          {},
          { geometry: {} },
          { geometry: { coordinates: [77.6] } },
          { geometry: { coordinates: [77.6, 12.9, 100] } },
          { geometry: { coordinates: ['77.6', 12.9] } },
          { geometry: { coordinates: [77.6, null] } },
        ],
      }),
    ).toEqual([]);
  });

  it('returns an empty array for a body with no features, and for null/garbage input', () => {
    expect(parsePhotonFeatures({})).toEqual([]);
    expect(parsePhotonFeatures(null)).toEqual([]);
    expect(parsePhotonFeatures(undefined)).toEqual([]);
    expect(parsePhotonFeatures('not json')).toEqual([]);
  });
});

describe('createPhotonProvider', () => {
  const fetchMock = vi.fn<(url: string, init?: { signal?: AbortSignal }) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(body: unknown): Response {
    return { ok: true, json: async () => body } as Response;
  }

  it('queries the default Photon host with an encoded query, limit 5, and the abort signal', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ features: [{ geometry: { coordinates: [77.59, 12.97] }, properties: { city: 'Bengaluru' } }] }),
    );
    const controller = new AbortController();

    const results = await createPhotonProvider().suggest('  MG Road, Bengaluru  ', controller.signal);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://photon.komoot.io/api?q=MG%20Road%2C%20Bengaluru&limit=5',
    );
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(results).toEqual([
      {
        label: 'Bengaluru',
        lat: 12.97,
        lng: 77.59,
        components: {
          locality: undefined, city: 'Bengaluru', state: undefined, postcode: undefined, country: undefined,
        },
      },
    ]);
  });

  it('strips a single trailing slash from a custom base URL', async () => {
    fetchMock.mockResolvedValue(okResponse({ features: [] }));

    await createPhotonProvider('https://geo.internal/photon/').suggest('pune');

    expect(fetchMock.mock.calls[0][0]).toBe('https://geo.internal/photon/api?q=pune&limit=5');
  });

  it('returns [] without hitting the network for a blank query', async () => {
    expect(await createPhotonProvider().suggest('')).toEqual([]);
    expect(await createPhotonProvider().suggest('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to [] on a non-ok response, a rejected fetch, and a malformed body', async () => {
    const provider = createPhotonProvider();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) } as Response);
    expect(await provider.suggest('pune')).toEqual([]);

    fetchMock.mockRejectedValueOnce(new Error('AbortError'));
    expect(await provider.suggest('pune')).toEqual([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      },
    } as unknown as Response);
    expect(await provider.suggest('pune')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// utils/match-score-cache
// ────────────────────────────────────────────────────────────────────────────

describe('match-score-cache', () => {
  // #646 §5.2: 0-100 scale; §5.5 removed the `band` field.
  const score: MatchScoreResult = { provider: 'llm', score: 84 };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('namespaces the key by version (v2 since #646 §5.2), local item and network item', () => {
    expect(generateCacheKey('local-1', 'net-2')).toBe('dpg:matchScore:v2:local-1:net-2');
  });

  it('round-trips a score under the versioned key', () => {
    setCachedMatchScore('local-1', 'net-2', score);

    const raw = localStorage.getItem('dpg:matchScore:v2:local-1:net-2');
    expect(raw).not.toBeNull();

    const cached = getCachedMatchScore('local-1', 'net-2');
    expect(cached?.score).toEqual(score);
    expect(cached?.localItemId).toBe('local-1');
    expect(cached?.networkItemId).toBe('net-2');
    expect(typeof cached?.timestamp).toBe('number');
  });

  it('returns null for a key that was never written', () => {
    expect(getCachedMatchScore('local-1', 'never-scored')).toBeNull();
  });

  it('evicts and returns null once an entry is older than the 24h TTL', () => {
    const key = generateCacheKey('local-1', 'net-2');
    localStorage.setItem(
      key,
      JSON.stringify({
        score,
        timestamp: Date.now() - (24 * 60 * 60 * 1000 + 1000),
        localItemId: 'local-1',
        networkItemId: 'net-2',
      }),
    );

    expect(getCachedMatchScore('local-1', 'net-2')).toBeNull();
    // Expired entry is actively removed, not just ignored.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('keeps an entry that is just inside the TTL', () => {
    localStorage.setItem(
      generateCacheKey('local-1', 'net-2'),
      JSON.stringify({
        score,
        timestamp: Date.now() - (24 * 60 * 60 * 1000 - 5000),
        localItemId: 'local-1',
        networkItemId: 'net-2',
      }),
    );

    expect(getCachedMatchScore('local-1', 'net-2')?.score).toEqual(score);
  });

  it('returns null instead of throwing when the stored value is not JSON', () => {
    localStorage.setItem(generateCacheKey('local-1', 'net-2'), '{not json');
    expect(getCachedMatchScore('local-1', 'net-2')).toBeNull();
  });

  it('swallows storage failures on both read and write', () => {
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(getCachedMatchScore('local-1', 'net-2')).toBeNull();
    getItem.mockRestore();

    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setCachedMatchScore('local-1', 'net-2', score)).not.toThrow();
    setItem.mockRestore();
  });

  it('clears exactly one entry when both ids are given', () => {
    setCachedMatchScore('local-1', 'net-a', score);
    setCachedMatchScore('local-1', 'net-b', score);

    clearMatchScoreCache('local-1', 'net-a');

    expect(getCachedMatchScore('local-1', 'net-a')).toBeNull();
    expect(getCachedMatchScore('local-1', 'net-b')).not.toBeNull();
  });

  it('clears every namespaced entry (and nothing else) when called with no ids', () => {
    setCachedMatchScore('local-1', 'net-a', score);
    setCachedMatchScore('local-1', 'net-b', score);
    setCachedMatchScore('local-2', 'net-a', score);
    localStorage.setItem('auth_token', 'keep-me');

    clearMatchScoreCache();

    expect(getCachedMatchScore('local-1', 'net-a')).toBeNull();
    expect(getCachedMatchScore('local-1', 'net-b')).toBeNull();
    expect(getCachedMatchScore('local-2', 'net-a')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBe('keep-me');
  });

  it('clears only the FIRST matching entry when scoped to a local item — it removes keys while index-iterating localStorage (bug)', () => {
    setCachedMatchScore('local-1', 'net-a', score);
    setCachedMatchScore('local-1', 'net-b', score);
    setCachedMatchScore('local-2', 'net-a', score);

    clearMatchScoreCache('local-1');

    // Intended behaviour is "clear ALL entries for local-1"; because the loop
    // removes from localStorage while walking it by index, every entry after a
    // removed one is skipped, so net-b survives.
    expect(getCachedMatchScore('local-1', 'net-a')).toBeNull();
    expect(getCachedMatchScore('local-1', 'net-b')).not.toBeNull();
    // A second pass finishes the job — which is what makes the skip observable.
    clearMatchScoreCache('local-1');
    expect(getCachedMatchScore('local-1', 'net-b')).toBeNull();
    // Another local item's entry is never touched.
    expect(getCachedMatchScore('local-2', 'net-a')).not.toBeNull();
  });

  it('swallows storage failures while clearing', () => {
    setCachedMatchScore('local-1', 'net-a', score);
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearMatchScoreCache('local-1', 'net-a')).not.toThrow();
    expect(() => clearMatchScoreCache()).not.toThrow();
  });
});
