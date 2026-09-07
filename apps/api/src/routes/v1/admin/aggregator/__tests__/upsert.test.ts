import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan 1 Task 7 — failing tests for POST /api/v1/admin/aggregator/upsert.
 *
 * These tests drive Task 8's implementation. They mount the route in isolation
 * (no global preHandler chain) and stub `request.acting_org` directly so we
 * can exercise the route's own NETWORK_SERVICE guard without re-running the
 * acting_org preHandler covered by Task 3.
 *
 * Strategy: vi.mock the drizzle `db` client with controllable in-memory state
 * (`dbState`). Each test resets the state in beforeEach. The mock factory must
 * be hoisted by vitest, so all the helpers it relies on are declared
 * inline / via top-level `dbState`.
 */

// State the tests drive. Mutating this between tests changes how the mocked
// `db.select/insert/update` chains behave on the next call.
const dbState = {
  // What `select(...).from(...).where(...).limit(1)` returns.
  existingOrgRows: [] as Array<{ id: string; metadata: string | null }>,
  // How `insert(organization).values(...)` behaves.
  insertMode: 'ok' as 'ok' | 'unique_violation',
  // Captured calls — for assertions.
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; set: Record<string, unknown> }>,
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(dbState.existingOrgRows)),
      })),
    })),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((row: Record<string, unknown>) => {
      if (dbState.insertMode === 'unique_violation') {
        const err: Error & { code?: string } = new Error(
          'duplicate key value violates unique constraint',
        );
        err.code = '23505';
        return Promise.reject(err);
      }
      dbState.inserts.push(row);
      return Promise.resolve();
    }),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        const target = dbState.existingOrgRows[0];
        dbState.updates.push({ id: target?.id ?? 'unknown', set: values });
        return Promise.resolve();
      }),
    })),
  }));
  return {
    db: { select, insert, update },
  };
});

// Import the route module AFTER the mock so it picks up the mocked db.
// Today this import FAILS — Task 8 hasn't written the file yet — and that's
// exactly the point of these failing tests.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { aggregator_upsert } from '../upsert.js';

const buildApp = async (
  acting: {
    org_id?: string;
    org_type?: 'aggregator' | 'voice' | 'network_service';
  } = {},
) => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Stub the acting_org preHandler — inject the test's chosen acting_org so
  // the route's NOT_NETWORK_SERVICE guard sees what we want.
  app.addHook('preHandler', async (req) => {
    (req as unknown as { acting_org: unknown }).acting_org = {
      org_id: acting.org_id ?? 'org_network_service',
      org_type: acting.org_type ?? 'network_service',
      service_user_id: 'svc_test',
    };
  });
  await app.register(aggregator_upsert);
  return app;
};

describe('POST /aggregator/upsert', () => {
  beforeEach(() => {
    dbState.existingOrgRows = [];
    dbState.insertMode = 'ok';
    dbState.inserts = [];
    dbState.updates = [];
  });

  it('creates a new aggregator org and returns created=true', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'agg_bbmp_001',
        name: 'BBMP',
        slug: 'bbmp',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.org_id).toMatch(/^org_/);
    expect(dbState.inserts).toHaveLength(1);
    expect(dbState.inserts[0]).toMatchObject({
      name: 'BBMP',
      slug: 'bbmp',
      type: 'aggregator',
    });
    expect(dbState.updates).toHaveLength(0);
  });

  it('updates an existing aggregator and returns created=false', async () => {
    dbState.existingOrgRows = [
      {
        id: 'org_existing',
        metadata: JSON.stringify({ external_id: 'agg_bbmp_001' }),
      },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'agg_bbmp_001',
        name: 'BBMP (renamed)',
        slug: 'bbmp',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ org_id: 'org_existing', created: false });
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].set).toMatchObject({ name: 'BBMP (renamed)' });
  });

  it('persists external_id and merges metadata on the org row', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'agg_xyz_42',
        name: 'XYZ NGO',
        slug: 'xyz-ngo',
        metadata: { region: 'KA', tier: 'gold' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts[0].metadata).toBeTruthy();
    const parsed = JSON.parse(dbState.inserts[0].metadata as string);
    expect(parsed).toMatchObject({
      external_id: 'agg_xyz_42',
      region: 'KA',
      tier: 'gold',
    });
  });

  it('returns 403 NOT_NETWORK_SERVICE when caller acts as an aggregator', async () => {
    const app = await buildApp({ org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'x',
        name: 'X',
        slug: 'x',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_NETWORK_SERVICE');
  });

  it('returns 403 NOT_NETWORK_SERVICE when caller acts as voice', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: { external_id: 'x', name: 'X', slug: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 409 SLUG_TAKEN on PG unique violation (23505)', async () => {
    dbState.insertMode = 'unique_violation';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: { external_id: 'a', name: 'A', slug: 'a' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SLUG_TAKEN');
    expect(res.json().message).toContain('a');
  });

  it('rejects invalid slug formats (uppercase, underscore, spaces)', async () => {
    const app = await buildApp();
    for (const badSlug of ['UPPER', 'with_underscore', 'with space', 'with.dot']) {
      const res = await app.inject({
        method: 'POST',
        url: '/aggregator/upsert',
        payload: { external_id: 'x', name: 'X', slug: badSlug },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('requires external_id, name, slug — 400 if any are missing', async () => {
    const app = await buildApp();
    for (const partial of [
      { name: 'X', slug: 'x' }, // missing external_id
      { external_id: 'x', slug: 'x' }, // missing name
      { external_id: 'x', name: 'X' }, // missing slug
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/aggregator/upsert',
        payload: partial as unknown as Record<string, unknown>,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('persists domains array into metadata when provided', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'ext_a',
        name: 'Agg A',
        slug: 'agg-a-domains',
        domains: ['seeker', 'provider'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
    const writtenMetadata = dbState.inserts[0].metadata as string;
    const meta = JSON.parse(writtenMetadata);
    expect(meta.domains).toEqual(['seeker', 'provider']);
    expect(meta.external_id).toBe('ext_a');
  });

  it('persists empty domains array when omitted', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'ext_b',
        name: 'Agg B',
        slug: 'agg-b-no-domains',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
    const writtenMetadata = dbState.inserts[0].metadata as string;
    const meta = JSON.parse(writtenMetadata);
    expect(meta.domains).toEqual([]);
    expect(meta.external_id).toBe('ext_b');
  });
});

