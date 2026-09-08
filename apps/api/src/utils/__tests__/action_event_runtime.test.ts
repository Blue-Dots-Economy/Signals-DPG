import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock @/config so the env-validating loadEnv() never runs in tests
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://localhost:3000',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
    // The mirror aborts on this deadline; AbortSignal.timeout() rejects a
    // non-number, so the mock has to carry it.
    peer_fetch_timeout_ms: 10000,
  },
  getCurrentApiBaseUrl: () => 'http://localhost:3000',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
}));

const { decryptItemPrivate } = vi.hoisted(() => ({
  decryptItemPrivate: vi.fn((_row: { item_state: unknown; item_private_state: string }) => ({
    mergedState: { merged: true },
  })),
}));

vi.mock('../item_decrypt', () => ({
  decryptItemPrivate: (row: { item_state: unknown; item_private_state: string }) =>
    decryptItemPrivate(row),
}));

// The mirror SSRF guard validates the source instance URL against the source
// network's registered `instances`. Mock the config lookup so the unit test
// controls the allowlist: only https://peer.example.com is registered for
// network "n" / domain "d".
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'n',
    instances: [{ domain_id: 'd', instance_url: 'https://peer.example.com' }],
  })),
}));

import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import {
  buildActionEventPayload,
  buildNetworkActionTargetItem,
  fetchLocalItemSnapshot,
  insertActionEvent,
  isCurrentInstanceItem,
  mirrorActionEventToSourceInstance,
  normalizeInstanceUrl,
  validateActionEventPayload,
  type StoredActionEvent,
} from '../action_event_runtime';

describe('buildActionEventPayload consent', () => {
  const ctx = {
    action_type: 'connect',
    source_item: {
      item_network: 'n',
      item_domain: 'd',
      item_type: 't',
      item_id: '00000000-0000-0000-0000-000000000001',
      item_instance_url: 'http://localhost:3000',
    },
    target_item: {
      item_network: 'n',
      item_domain: 'd',
      item_type: 't',
      item_id: '00000000-0000-0000-0000-000000000002',
      item_instance_url: 'http://localhost:3000',
    },
    requirements_snapshot: {},
  };

  it('omits consent when none provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
    });
    expect(payload.consent).toBeUndefined();
  });

  it('includes consent with version + server-stamped consented_at when provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
      consent: { acknowledged: true, version: 1 },
    });
    expect(payload.consent).toMatchObject({
      acknowledged: true,
      version: 1,
    });
    expect(typeof (payload.consent as Record<string, unknown>).consented_at).toBe('string');
    expect(Number.isNaN(Date.parse(((payload.consent as Record<string, string>).consented_at)))).toBe(false);
  });
});

const CURRENT_URL = 'http://localhost:3000';

const remoteRef = {
  item_network: 'n',
  item_domain: 'd',
  item_type: 'profile_1.0',
  item_id: '00000000-0000-0000-0000-0000000000aa',
  item_instance_url: 'https://peer.example.com',
};

const localRef = {
  item_network: 'n',
  item_domain: 'd',
  item_type: 'profile_1.0',
  item_id: '00000000-0000-0000-0000-0000000000bb',
  item_instance_url: CURRENT_URL,
};

describe('normalizeInstanceUrl', () => {
  it('collapses loopback hostnames to localhost and drops the trailing slash', () => {
    expect(normalizeInstanceUrl('http://127.0.0.1:3000/')).toBe('http://localhost:3000');
    expect(normalizeInstanceUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('strips the default port for the matching protocol only', () => {
    expect(normalizeInstanceUrl('http://api.example.com:80')).toBe(
      'http://api.example.com'
    );
    expect(normalizeInstanceUrl('https://api.example.com:443')).toBe(
      'https://api.example.com'
    );
    // non-default port is preserved, and a mismatched default is NOT stripped
    expect(normalizeInstanceUrl('https://api.example.com:80')).toBe(
      'https://api.example.com:80'
    );
    expect(normalizeInstanceUrl('http://api.example.com:8080/')).toBe(
      'http://api.example.com:8080'
    );
  });

  it('keeps the path when the url is not a bare origin', () => {
    expect(normalizeInstanceUrl('https://api.example.com/base/')).toBe(
      'https://api.example.com/base'
    );
  });

  it('does NOT collapse the IPv6 loopback (WHATWG hostname is bracketed "[::1]")', () => {
    // Documented discrepancy: the source compares hostname === '::1', but
    // URL.hostname yields '[::1]', so the branch never fires.
    expect(normalizeInstanceUrl('http://[::1]:3000/')).toBe('http://[::1]:3000');
  });

  it('throws on a non-absolute url', () => {
    expect(() => normalizeInstanceUrl('not-a-url')).toThrow();
  });
});

describe('isCurrentInstanceItem', () => {
  it('treats a loopback alias of the configured base url as current', () => {
    expect(isCurrentInstanceItem({ ...localRef, item_instance_url: 'http://127.0.0.1:3000' })).toBe(
      true
    );
    expect(isCurrentInstanceItem(localRef)).toBe(true);
  });

  it('returns false for a foreign instance url', () => {
    expect(isCurrentInstanceItem(remoteRef)).toBe(false);
  });
});

describe('buildNetworkActionTargetItem', () => {
  it('projects only the five item-ref fields, dropping extras', () => {
    const built = buildNetworkActionTargetItem({
      ...localRef,
      // extra properties present on the perform-action body must not leak through
      lifecycle_status: 'live',
    } as unknown as Parameters<typeof buildNetworkActionTargetItem>[0]);

    expect(built).toEqual(localRef);
    expect(Object.keys(built).sort()).toEqual([
      'item_domain',
      'item_id',
      'item_instance_url',
      'item_network',
      'item_type',
    ]);
  });
});

describe('validateActionEventPayload', () => {
  const mutableConfig = apiConfig as unknown as { allow_extra_schema_data: boolean };
  let originalAllowExtra: boolean;

  beforeEach(() => {
    originalAllowExtra = mutableConfig.allow_extra_schema_data;
  });

  afterEach(() => {
    mutableConfig.allow_extra_schema_data = originalAllowExtra;
  });

  it('is a no-op when there is no event schema or the schema is empty', () => {
    expect(validateActionEventPayload(undefined, { anything: 1 })).toBeUndefined();
    expect(validateActionEventPayload({}, { anything: 1 })).toBeUndefined();
  });

  it('accepts a payload matching the schema', () => {
    expect(
      validateActionEventPayload(
        {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
        { note: 'hi', status: 'accepted', remark: 'r' }
      )
    ).toBeUndefined();
  });

  it('throws a labelled error when a required schema field is missing', () => {
    expect(() =>
      validateActionEventPayload(
        {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
        { status: 'accepted' }
      )
    ).toThrow(/Invalid event payload/);
  });

  it('throws when a declared field has the wrong type', () => {
    expect(() =>
      validateActionEventPayload(
        { type: 'object', properties: { count: { type: 'number' } } },
        { count: 'not-a-number' }
      )
    ).toThrow(/Invalid event payload: .*number/);
  });

  it('ignores the system keys status/remark/consent in both schema and payload', () => {
    // `status` is declared as a number and required, yet a string status passes:
    // the system keys are stripped from the payload and from `required`.
    expect(
      validateActionEventPayload(
        {
          type: 'object',
          properties: { status: { type: 'number' }, consent: { type: 'number' } },
          required: ['status', 'remark', 'consent'],
        },
        { status: 'accepted', remark: 'r', consent: { acknowledged: true } }
      )
    ).toBeUndefined();
  });

  it('allows undeclared extra keys when allow_extra_schema_data is true', () => {
    mutableConfig.allow_extra_schema_data = true;
    expect(
      validateActionEventPayload(
        {
          type: 'object',
          properties: { note: { type: 'string' } },
          additionalProperties: false,
        },
        { note: 'hi', surprise: true }
      )
    ).toBeUndefined();
  });

  it('rejects undeclared extra keys when allow_extra_schema_data is false', () => {
    mutableConfig.allow_extra_schema_data = false;
    expect(() =>
      validateActionEventPayload(
        {
          type: 'object',
          properties: { note: { type: 'string' } },
          additionalProperties: false,
        },
        { note: 'hi', surprise: true }
      )
    ).toThrow(/Invalid event payload/);
  });
});

describe('buildActionEventPayload projection', () => {
  const context = {
    action_type: 'connect',
    source_item: localRef,
    target_item: remoteRef,
    requirements_snapshot: { resume_url: 'https://cv.example.com', extra: 7 },
  };

  it('returns only status + default remark when there is no event schema', () => {
    expect(buildActionEventPayload({ action_status: 'pending', context })).toEqual({
      status: 'pending',
      remark: 'Action status set to pending',
    });
  });

  it('projects context fields and requirements_snapshot fields declared by the schema', () => {
    const payload = buildActionEventPayload({
      event_schema: {
        type: 'object',
        properties: {
          action_type: { type: 'string' },
          resume_url: { type: 'string' },
          // declared but present in neither context nor snapshot -> omitted
          missing_key: { type: 'string' },
          // system key -> never projected from the schema
          status: { type: 'string' },
        },
      },
      action_status: 'accepted',
      remarks: 'looks good',
      context,
    });

    expect(payload).toEqual({
      action_type: 'connect',
      resume_url: 'https://cv.example.com',
      status: 'accepted',
      remark: 'looks good',
    });
    // `extra` is in the snapshot but undeclared, so it is not projected
    expect(payload.extra).toBeUndefined();
  });

  it('projects nothing when schema.properties is not a plain object', () => {
    expect(
      buildActionEventPayload({
        event_schema: { type: 'object', properties: ['action_type'] },
        action_status: 'rejected',
        context,
      })
    ).toEqual({ status: 'rejected', remark: 'Action status set to rejected' });
  });

  it('prefers a context field over a same-named requirements_snapshot field', () => {
    const payload = buildActionEventPayload({
      event_schema: { properties: { action_type: { type: 'string' } } },
      action_status: 'accepted',
      context: {
        ...context,
        requirements_snapshot: { action_type: 'snapshot-wins?' },
      },
    });
    expect(payload.action_type).toBe('connect');
  });
});

// --- insertActionEvent -------------------------------------------------------

const insertState: {
  values: Record<string, unknown> | null;
  conflict: unknown;
  returned: Record<string, unknown>[];
  failWith: Error | null;
} = { values: null, conflict: null, returned: [], failWith: null };

function makeInsertDb() {
  return {
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        insertState.values = values;
        return {
          onConflictDoNothing: (conflict: unknown) => {
            insertState.conflict = conflict;
            return {
              returning: async (_cols: unknown) => {
                if (insertState.failWith) throw insertState.failWith;
                return insertState.returned;
              },
            };
          },
        };
      },
    }),
  } as unknown as Parameters<typeof insertActionEvent>[0];
}

function makeEvent(overrides: Partial<StoredActionEvent> = {}): StoredActionEvent {
  return {
    origin_instance_domain: CURRENT_URL,
    action_type: 'connect',
    action_id: '00000000-0000-0000-0000-0000000000cc',
    action_status: 'pending',
    update_count: 0,
    source_item: localRef,
    target_item: remoteRef,
    event_payload: { status: 'pending' },
    ...overrides,
  };
}

describe('insertActionEvent', () => {
  beforeEach(() => {
    insertState.values = null;
    insertState.conflict = null;
    insertState.returned = [];
    insertState.failWith = null;
  });

  it('flattens the item refs and defaults locations to [] and remarks to null', async () => {
    insertState.returned = [
      {
        event_id: 'e1',
        action_id: '00000000-0000-0000-0000-0000000000cc',
        action_type: 'connect',
        action_status: 'pending',
        update_count: 0,
      },
    ];

    const created = await insertActionEvent(makeInsertDb(), makeEvent());

    expect(created).toEqual({
      event_id: 'e1',
      action_id: '00000000-0000-0000-0000-0000000000cc',
      action_type: 'connect',
      action_status: 'pending',
      update_count: 0,
    });
    expect(insertState.values).toMatchObject({
      action_type: 'connect',
      origin_instance_domain: CURRENT_URL,
      action_status: 'pending',
      update_count: 0,
      source_item_network: 'n',
      source_item_domain: 'd',
      source_item_type: 'profile_1.0',
      source_item_id: localRef.item_id,
      source_item_instance_url: CURRENT_URL,
      source_item_locations: [],
      target_item_id: remoteRef.item_id,
      target_item_instance_url: remoteRef.item_instance_url,
      target_item_locations: [],
      event_payload: { status: 'pending' },
      remarks: null,
    });
    expect(Array.isArray((insertState.conflict as { target: unknown[] }).target)).toBe(true);
  });

  it('passes through supplied owners, locations and remarks', async () => {
    const locations = [{ type: 'Point', coordinates: [1, 2] }] as unknown as NonNullable<
      StoredActionEvent['source_item_locations']
    >;
    insertState.returned = [{ event_id: 'e2' }];

    await insertActionEvent(
      makeInsertDb(),
      makeEvent({
        source_item_owner: 'user-1',
        target_item_owner: 'user-2',
        source_item_locations: locations,
        target_item_locations: locations,
        remarks: 'because',
      })
    );

    expect(insertState.values).toMatchObject({
      source_item_owner: 'user-1',
      target_item_owner: 'user-2',
      source_item_locations: locations,
      target_item_locations: locations,
      remarks: 'because',
    });
  });

  it('partitions by the TARGET network when the target item is local', async () => {
    insertState.returned = [{ event_id: 'e3' }];
    await insertActionEvent(
      makeInsertDb(),
      makeEvent({
        source_item: { ...remoteRef, item_network: 'source_net' },
        target_item: { ...localRef, item_network: 'target_net' },
      })
    );
    expect(insertState.values?.partition_network).toBe('target_net');
  });

  it('partitions by the SOURCE network when the target item is remote', async () => {
    insertState.returned = [{ event_id: 'e4' }];
    await insertActionEvent(
      makeInsertDb(),
      makeEvent({
        source_item: { ...localRef, item_network: 'source_net' },
        target_item: { ...remoteRef, item_network: 'target_net' },
      })
    );
    expect(insertState.values?.partition_network).toBe('source_net');
  });

  it('returns null when the conflict clause swallowed the insert', async () => {
    insertState.returned = [];
    await expect(insertActionEvent(makeInsertDb(), makeEvent())).resolves.toBeNull();
  });

  it('propagates a database failure to the caller', async () => {
    insertState.failWith = new Error('db down');
    await expect(insertActionEvent(makeInsertDb(), makeEvent())).rejects.toThrow('db down');
  });
});

// --- fetchLocalItemSnapshot --------------------------------------------------

const selectState: {
  results: Record<string, unknown>[][];
  queries: number;
  failWith: Error | null;
} = { results: [], queries: 0, failWith: null };

function makeSelectDb() {
  return {
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => {
            selectState.queries += 1;
            if (selectState.failWith) throw selectState.failWith;
            return selectState.results.shift() ?? [];
          },
        }),
      }),
    }),
  } as unknown as Parameters<typeof fetchLocalItemSnapshot>[0];
}

function makeRow(instanceUrl: string) {
  return {
    item_id: localRef.item_id,
    item_instance_url: instanceUrl,
    item_state: { name: 'Ada' },
    item_private_state: 'cipher',
    created_by: 'user-1',
    item_locations: [],
    lifecycle_status: 'live',
  };
}

describe('fetchLocalItemSnapshot', () => {
  beforeEach(() => {
    selectState.results = [];
    selectState.queries = 0;
    selectState.failWith = null;
    decryptItemPrivate.mockClear();
  });

  it('returns the exact-url row decoded, keeping the public state next to private_state', async () => {
    selectState.results = [[makeRow(CURRENT_URL)]];

    const snapshot = await fetchLocalItemSnapshot(makeSelectDb(), localRef);

    expect(selectState.queries).toBe(1);
    // #483 kept `item_state` (the PUBLIC projection) on the snapshot instead of
    // dropping it — the facet/geo filtering added by #439 reads it — while
    // `item_private_state` (the ciphertext) is still swapped for the decrypted
    // `private_state`.
    expect(snapshot).toEqual({
      item_id: localRef.item_id,
      item_instance_url: CURRENT_URL,
      created_by: 'user-1',
      item_locations: [],
      lifecycle_status: 'live',
      item_state: { name: 'Ada' },
      private_state: { merged: true },
    });
    expect(decryptItemPrivate).toHaveBeenCalledWith({
      item_state: { name: 'Ada' },
      item_private_state: 'cipher',
    });
  });

  it('does not run the alias fallback for a foreign instance url', async () => {
    selectState.results = [[]];

    await expect(fetchLocalItemSnapshot(makeSelectDb(), remoteRef)).resolves.toBeNull();
    expect(selectState.queries).toBe(1);
  });

  it('falls back to the loopback-alias row when the requested url is this instance', async () => {
    selectState.results = [[], [makeRow('http://127.0.0.1:3000')]];

    const snapshot = await fetchLocalItemSnapshot(makeSelectDb(), {
      ...localRef,
      item_instance_url: 'http://127.0.0.1:3000/',
    });

    expect(selectState.queries).toBe(2);
    expect(snapshot).toMatchObject({ private_state: { merged: true } });
  });

  it('returns null when the alias row belongs to a different instance', async () => {
    selectState.results = [[], [makeRow('https://peer.example.com')]];

    await expect(fetchLocalItemSnapshot(makeSelectDb(), localRef)).resolves.toBeNull();
    expect(selectState.queries).toBe(2);
    expect(decryptItemPrivate).not.toHaveBeenCalled();
  });

  it('returns null when neither query finds a row', async () => {
    selectState.results = [[], []];
    await expect(fetchLocalItemSnapshot(makeSelectDb(), localRef)).resolves.toBeNull();
    expect(selectState.queries).toBe(2);
  });

  it('propagates a database failure', async () => {
    selectState.failWith = new Error('select boom');
    await expect(fetchLocalItemSnapshot(makeSelectDb(), localRef)).rejects.toThrow(
      'select boom'
    );
  });
});

// --- mirrorActionEventToSourceInstance ---------------------------------------

describe('mirrorActionEventToSourceInstance', () => {
  const makeLog = () => ({
    error: vi.fn((_obj: unknown, _msg?: string) => {}),
  });
  const asLog = (log: ReturnType<typeof makeLog>) =>
    log as unknown as Parameters<typeof mirrorActionEventToSourceInstance>[1];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the mirror entirely when the source item is on this instance', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();

    await mirrorActionEventToSourceInstance(
      makeEvent({ source_item: { ...localRef, item_instance_url: 'http://127.0.0.1:3000' } }),
      asLog(log)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('POSTs the whole event to the source instance /api/v1/event/store', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({ source_item: remoteRef, target_item: localRef });

    await mirrorActionEventToSourceInstance(event, asLog(log));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://peer.example.com/api/v1/event/store');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual(event);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs (but does not throw) when the peer responds not-ok', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({ source_item: remoteRef, target_item: localRef });

    await expect(
      mirrorActionEventToSourceInstance(event, asLog(log))
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatchObject({
      action_id: event.action_id,
      source_instance_url: 'https://peer.example.com',
      status_code: 503,
      status_text: 'Service Unavailable',
    });
    expect(log.error.mock.calls[0][1]).toBe(
      'Failed to mirror action event to source instance'
    );
  });

  it('swallows a network error and logs it with the err field', async () => {
    const boom = new Error('econnrefused');
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => {
      throw boom;
    });
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({ source_item: remoteRef, target_item: localRef });

    await expect(
      mirrorActionEventToSourceInstance(event, asLog(log))
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatchObject({
      err: boom,
      action_id: event.action_id,
      source_instance_url: 'https://peer.example.com',
    });
  });

  it('refuses to mirror (no fetch) when the source instance URL is not registered for its network — SSRF guard', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({
      source_item: { ...remoteRef, item_instance_url: 'http://169.254.169.254' },
      target_item: localRef,
    });

    await mirrorActionEventToSourceInstance(event, asLog(log));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toMatch(/possible SSRF/i);
  });

  it('refuses to mirror (no fetch) when the origin matches but the source domain is not the one registered for that instance', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    // instance_url origin is the registered peer, but item_domain is not "d",
    // which is the domain that instance is registered under.
    const event = makeEvent({
      source_item: { ...remoteRef, item_domain: 'other' },
      target_item: localRef,
    });

    await mirrorActionEventToSourceInstance(event, asLog(log));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toMatch(/possible SSRF/i);
  });

  it('refuses to mirror (no fetch) when a registered instance_url is itself unparseable', async () => {
    vi.mocked(getNetworkConfigById).mockResolvedValueOnce({
      id: 'n',
      instances: [{ domain_id: 'd', instance_url: 'not-a-url' }],
    } as unknown as Awaited<ReturnType<typeof getNetworkConfigById>>);
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({ source_item: remoteRef, target_item: localRef });

    await mirrorActionEventToSourceInstance(event, asLog(log));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error.mock.calls[0][1]).toMatch(/possible SSRF/i);
  });

  it('refuses to mirror (no fetch) and logs when the network-config lookup throws', async () => {
    vi.mocked(getNetworkConfigById).mockRejectedValueOnce(
      new Error('network "n" is not configured')
    );
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const log = makeLog();
    const event = makeEvent({ source_item: remoteRef, target_item: localRef });

    await mirrorActionEventToSourceInstance(event, asLog(log));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][1]).toMatch(/Failed to validate source instance/i);
  });
});
