import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const {
  getConfiguredNetworkSchemas,
  getOrFetchSchemaByUrl,
  refreshConsumedSchemas,
  getNetworkConfigById,
  getNetworkConfigs,
  getDomainItemSchema,
  getInstanceCustomItemSchemaUrl,
  configState,
} = vi.hoisted(() => ({
  getConfiguredNetworkSchemas: vi.fn(),
  getOrFetchSchemaByUrl: vi.fn(),
  refreshConsumedSchemas: vi.fn(),
  getNetworkConfigById: vi.fn(),
  getNetworkConfigs: vi.fn(),
  getDomainItemSchema: vi.fn(),
  getInstanceCustomItemSchemaUrl: vi.fn(),
  configState: {
    served_domains: [
      { network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' },
    ] as { network: string; domain: string; key: string }[],
    apiBaseUrl: 'https://instance-a.test',
  },
}));

// A minimal chainable zod stub: the route schemas are only declarations here,
// never used to validate anything (we call handlers directly).
vi.mock('@dpg/schemas', () => {
  const leaf: Record<string, unknown> = {};
  leaf.optional = () => leaf;
  leaf.min = () => leaf;
  const z = {
    object: () => leaf,
    string: () => leaf,
    number: () => leaf,
    boolean: () => leaf,
  };

  class SchemaFetchError extends Error {
    public readonly url: string;
    constructor(input: { url: string }) {
      super(`Failed to fetch schema from ${input.url}`);
      this.name = 'SchemaFetchError';
      this.url = input.url;
    }
  }

  return {
    default: z,
    SchemaFetchError,
    getDomainItemSchema: (...a: unknown[]) => getDomainItemSchema(...a),
    getInstanceCustomItemSchemaUrl: (...a: unknown[]) =>
      getInstanceCustomItemSchemaUrl(...a),
  };
});

vi.mock('@/network_schema_cache', () => ({
  getConfiguredNetworkSchemas: () => getConfiguredNetworkSchemas(),
  getOrFetchSchemaByUrl: (...a: unknown[]) => getOrFetchSchemaByUrl(...a),
  refreshConsumedSchemas: () => refreshConsumedSchemas(),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
  getNetworkConfigs: () => getNetworkConfigs(),
}));

// `served_domain_guard` is deliberately NOT mocked — the 403 body it builds is
// part of the behaviour under test — so `@/config` must supply what it reads.
vi.mock('@/config', () => ({
  apiConfig: {
    get served_domains() {
      return configState.served_domains;
    },
  },
  getCurrentApiBaseUrl: () => configState.apiBaseUrl,
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

// refetch_schemas now chains the acting-org preHandler and gates on the
// network-service principal (AUTHZ-VULN-13). Stub the preHandler so the route
// module loads without the DB-backed acting_org middleware.
vi.mock('@/middleware/acting_org', () => ({
  acting_org_preHandler: async () => {},
}));

import { SchemaFetchError } from '@dpg/schemas';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { fetch_schemas } from '../fetch_schemas';
import { fetch_schema } from '../fetch_schema';
import { refetch_schema } from '../refetch_schema';

// --- harness ---------------------------------------------------------------
interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

interface CapturedRoute {
  url: string;
  method: string;
  preHandler?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (request: any, reply: any) => Promise<unknown>;
}

async function loadRoute(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: any
): Promise<CapturedRoute> {
  const routes: CapturedRoute[] = [];
  await plugin({ route: (opts: CapturedRoute) => routes.push(opts) }, {});
  expect(routes).toHaveLength(1);
  return routes[0];
}

const log = { error: vi.fn() };

async function call(
  route: CapturedRoute,
  request: Record<string, unknown>
): Promise<FakeReply> {
  const reply = makeReply();
  await route.handler({ log, ...request }, reply);
  return reply;
}

const SCHEMAS = [
  {
    network: 'yellow_dot',
    domain: 'student',
    item_type: 'profile_1.0',
    schema_url: 'https://schemas.test/yd/student/profile_1.0.json',
  },
  {
    network: 'yellow_dot',
    domain: 'mentor',
    item_type: 'profile_1.0',
    schema_url: 'https://schemas.test/yd/mentor/profile_1.0.json',
  },
  {
    network: 'blue_dot',
    domain: 'student',
    item_type: 'opportunity_1.0',
    schema_url: 'https://schemas.test/bd/student/opportunity_1.0.json',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  configState.served_domains = [
    { network: 'yellow_dot', domain: 'student', key: 'yellow_dot/student' },
  ];
  configState.apiBaseUrl = 'https://instance-a.test';
  getConfiguredNetworkSchemas.mockResolvedValue(SCHEMAS);
  getNetworkConfigs.mockResolvedValue([
    {
      id: 'yellow_dot',
      domains: [
        {
          id: 'student',
          item_schemas: { 'profile_1.0': {}, 'opportunity_1.0': {} },
        },
      ],
    },
  ]);
});

describe('fetch_schemas (GET /schemas)', () => {
  it('registers a GET route at /schemas', async () => {
    const route = await loadRoute(fetch_schemas);

    expect(route.url).toBe('/schemas');
    expect(route.method).toBe('GET');
  });

  it('returns every configured schema when no filter is supplied', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, { query: {} });

    expect(reply.body).toEqual(SCHEMAS);
  });

  it('filters by network', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, { query: { network: 'yellow_dot' } });

    expect(reply.body).toEqual([SCHEMAS[0], SCHEMAS[1]]);
  });

  it('filters by domain', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, { query: { domain: 'student' } });

    expect(reply.body).toEqual([SCHEMAS[0], SCHEMAS[2]]);
  });

  it('filters by item_type', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, { query: { item_type: 'profile_1.0' } });

    expect(reply.body).toEqual([SCHEMAS[0], SCHEMAS[1]]);
  });

  it('filters by schema_url', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, {
      query: { schema_url: SCHEMAS[2].schema_url },
    });

    expect(reply.body).toEqual([SCHEMAS[2]]);
  });

  it('ANDs multiple filters together', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, {
      query: { network: 'yellow_dot', domain: 'mentor' },
    });

    expect(reply.body).toEqual([SCHEMAS[1]]);
  });

  it('returns an empty list when nothing matches (never 404)', async () => {
    const route = await loadRoute(fetch_schemas);

    const reply = await call(route, {
      query: { network: 'yellow_dot', domain: 'student', item_type: 'nope_9.9' },
    });

    expect(reply.body).toEqual([]);
    expect(reply.statusCode).toBe(0); // no explicit reply.code(...)
  });

  it('propagates a schema-cache failure to the framework error handler', async () => {
    const route = await loadRoute(fetch_schemas);
    getConfiguredNetworkSchemas.mockRejectedValue(new Error('cache down'));

    await expect(call(route, { query: {} })).rejects.toThrow('cache down');
  });
});

describe('fetch_schema (GET /schema/:network/:domain/:itemType)', () => {
  const params = {
    network: 'yellow_dot',
    domain: 'student',
    itemType: 'profile_1.0',
  };

  it('registers a GET route at the parameterised schema url', async () => {
    const route = await loadRoute(fetch_schema);

    expect(route.url).toBe('/schema/:network/:domain/:itemType');
    expect(route.method).toBe('GET');
  });

  it('403s with UNSERVED_DOMAIN_BINDING for a binding this instance does not serve', async () => {
    const route = await loadRoute(fetch_schema);

    const reply = await call(route, {
      params: { ...params, domain: 'mentor' },
    });

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      error: 'UNSERVED_DOMAIN_BINDING',
      message: 'This API instance does not serve "yellow_dot/mentor".',
      requested: {
        network: 'yellow_dot',
        domain: 'mentor',
        key: 'yellow_dot/mentor',
      },
      allowed_bindings: ['yellow_dot/student'],
      allowed_networks: ['yellow_dot'],
      allowed_domains: ['student'],
      allowed_item_types_by_binding: {
        'yellow_dot/student': ['profile_1.0', 'opportunity_1.0'],
      },
    });
    // The guard short-circuits before any schema resolution happens.
    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(getDomainItemSchema).not.toHaveBeenCalled();
  });

  it('403s when the network is unserved even if the domain name matches', async () => {
    const route = await loadRoute(fetch_schema);

    const reply = await call(route, {
      params: { ...params, network: 'blue_dot' },
    });

    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: string }).error).toBe(
      'UNSERVED_DOMAIN_BINDING'
    );
  });

  it('returns the domain item schema when the instance has no custom override', async () => {
    const route = await loadRoute(fetch_schema);
    const networkConfig = { id: 'yellow_dot' };
    const domainSchema = { $id: 'profile_1.0', type: 'object' };
    getNetworkConfigById.mockResolvedValue(networkConfig);
    getInstanceCustomItemSchemaUrl.mockReturnValue(undefined);
    getDomainItemSchema.mockReturnValue(domainSchema);

    const reply = await call(route, { params });

    expect(reply.statusCode).toBe(0);
    expect(reply.body).toBe(domainSchema);
    expect(getNetworkConfigById).toHaveBeenCalledWith('yellow_dot');
    expect(getDomainItemSchema).toHaveBeenCalledWith(
      networkConfig,
      'student',
      'profile_1.0'
    );
    expect(getOrFetchSchemaByUrl).not.toHaveBeenCalled();
  });

  it('resolves the instance-custom schema url through the schema cache when one exists', async () => {
    const route = await loadRoute(fetch_schema);
    const networkConfig = { id: 'yellow_dot' };
    const customSchema = { $id: 'custom-profile', type: 'object' };
    getNetworkConfigById.mockResolvedValue(networkConfig);
    getInstanceCustomItemSchemaUrl.mockReturnValue(
      'https://instance-a.test/custom/profile_1.0.json'
    );
    getOrFetchSchemaByUrl.mockResolvedValue(customSchema);

    const reply = await call(route, { params });

    expect(reply.body).toBe(customSchema);
    expect(getInstanceCustomItemSchemaUrl).toHaveBeenCalledWith(networkConfig, {
      domain: 'student',
      instanceUrl: 'https://instance-a.test',
      itemType: 'profile_1.0',
    });
    expect(getOrFetchSchemaByUrl).toHaveBeenCalledWith({
      schemaUrl: 'https://instance-a.test/custom/profile_1.0.json',
      network: 'yellow_dot',
      domain: 'student',
      itemType: 'profile_1.0',
      instanceUrl: 'https://instance-a.test',
      kind: 'instance_custom_item_schema',
    });
    // The custom branch returns early, so the bundled domain schema is skipped.
    expect(getDomainItemSchema).not.toHaveBeenCalled();
  });

  it('propagates a remote fetch failure for the custom schema url', async () => {
    const route = await loadRoute(fetch_schema);
    getNetworkConfigById.mockResolvedValue({ id: 'yellow_dot' });
    getInstanceCustomItemSchemaUrl.mockReturnValue(
      'https://instance-a.test/custom/profile_1.0.json'
    );
    getOrFetchSchemaByUrl.mockRejectedValue(
      new SchemaFetchError({
        url: 'https://instance-a.test/custom/profile_1.0.json',
      })
    );

    await expect(call(route, { params })).rejects.toBeInstanceOf(
      SchemaFetchError
    );
  });
});

describe('refetch_schema (POST /refetch_schemas)', () => {
  const NETWORK_SERVICE = { acting_org: { org_type: 'network_service' } };

  it('registers an authenticated, network-service-gated POST route at /refetch_schemas', async () => {
    const route = await loadRoute(refetch_schema);

    expect(route.url).toBe('/refetch_schemas');
    expect(route.method).toBe('POST');
    expect(route.preHandler).toEqual([
      auth_middleware_if_enabled,
      acting_org_preHandler,
    ]);
  });

  it('403s when the caller is not the network-service principal', async () => {
    const route = await loadRoute(refetch_schema);

    const reply = await call(route, { acting_org: { org_type: 'aggregator' } });

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      error: 'FORBIDDEN',
      message: 'only the network service caller may refresh consumed schemas',
    });
    expect(refreshConsumedSchemas).not.toHaveBeenCalled();
  });

  it('403s when there is no acting_org at all', async () => {
    const route = await loadRoute(refetch_schema);

    const reply = await call(route, {});

    expect(reply.statusCode).toBe(403);
    expect(refreshConsumedSchemas).not.toHaveBeenCalled();
  });

  it('reports the refreshed schema count on success', async () => {
    const route = await loadRoute(refetch_schema);
    refreshConsumedSchemas.mockResolvedValue([{}, {}, {}]);

    const reply = await call(route, NETWORK_SERVICE);

    expect(reply.statusCode).toBe(0);
    expect(reply.body).toEqual({ refreshed: true, schema_count: 3 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('reports zero when no consumed schemas are configured', async () => {
    const route = await loadRoute(refetch_schema);
    refreshConsumedSchemas.mockResolvedValue([]);

    const reply = await call(route, NETWORK_SERVICE);

    expect(reply.body).toEqual({ refreshed: true, schema_count: 0 });
  });

  it('502s REMOTE_SCHEMA_FETCH_FAILED when a remote schema cannot be fetched', async () => {
    const route = await loadRoute(refetch_schema);
    refreshConsumedSchemas.mockRejectedValue(
      new SchemaFetchError({ url: 'https://schemas.test/down.json' })
    );

    const reply = await call(route, NETWORK_SERVICE);

    expect(reply.statusCode).toBe(502);
    expect(reply.body).toEqual({
      error: 'REMOTE_SCHEMA_FETCH_FAILED',
      message:
        'Failed to fetch remote schema: https://schemas.test/down.json',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('500s INTERNAL_SERVER_ERROR for any other failure', async () => {
    const route = await loadRoute(refetch_schema);
    refreshConsumedSchemas.mockRejectedValue(new Error('redis exploded'));

    const reply = await call(route, NETWORK_SERVICE);

    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to refresh consumed schemas',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
