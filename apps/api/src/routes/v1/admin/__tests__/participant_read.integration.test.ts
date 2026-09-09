/**
 * Integration test for GET /api/v1/admin/participant (read-only endpoint)
 * Tests the tier-aware lookup matrix against a real Postgres.
 *
 * The test seeds two aggregator-type orgs + one network_service-type org,
 * then exercises the read endpoint across:
 *   1. network_service can lookup any user (gets items)
 *   2. aggregator can lookup only users they onboarded (gets items)
 *   3. aggregator looking up another aggregator's user (gets empty items)
 *   4. lookup of non-existent user (returns user_id: null)
 *
 * Skip conditions: if POSTGRES_URL / POSTGRES_USER are unset the suite
 * is described as `.skip` so CI without a DB stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateMinimalItemState,
  resolveBindings,
  type ResolvedBinding,
} from '../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

describeIf(`GET /api/v1/admin/participant (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let consentTable: typeof import('@api/db/postgres/schema').consent_record;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();

  const agg_a = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-read-a-${ts}`,
  };

  const agg_b = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-read-b-${ts}`,
  };

  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-int-read-${ts}`,
  };

  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-read-int-${ts}@signals.local`;

  const onboarded_user_ids: string[] = [];
  let primary: ResolvedBinding;

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    consentTable = (await import('@api/db/postgres/schema')).consent_record;

    const resolved = await resolveBindings();
    primary = resolved.primary;

    const { admin_routes } = await import('../admin_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.register(network_routes_mod.default, { prefix: '/api/v1/network' });

    try {
      await app.listen({ port: listen_port, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `integration test requires port ${listen_port} to be free ` +
            `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'read endpoint svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(organization).values([
      {
        id: agg_a.org_id,
        slug: agg_a.slug,
        name: `${agg_a.slug} (aggregator A)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: agg_b.org_id,
        slug: agg_b.slug,
        name: `${agg_b.slug} (aggregator B)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug} (network_service)`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    await db.insert(member).values([
      {
        id: agg_a.member_id,
        organizationId: agg_a.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: agg_b.member_id,
        organizationId: agg_b.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
      {
        id: ns.member_id,
        organizationId: ns.org_id,
        userId: svc_user_id,
        role: 'service',
        createdAt: now,
      },
    ]);

    for (const v of [agg_a, agg_b, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id,
        name: v.slug,
        key: hash_key(v.raw_key),
        userId: svc_user_id,
        referenceId: svc_user_id,
        configId: 'default',
        start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_',
        enabled: true,
        rateLimitEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      if (onboarded_user_ids.length > 0) {
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, onboarded_user_ids));
        await db.delete(user).where(inArray(user.id, onboarded_user_ids));
      }
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  let agg_a_user_id: string;
  let agg_a_user_email: string;
  let agg_a_item_id: string;

  it('agg_A onboards a user via POST (setup)', async () => {
    agg_a_user_email = `int_read_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: agg_a_user_email,
        name: 'Agg A User',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    agg_a_user_id = body.user_id;
    agg_a_item_id = body.items[0].item_id;
    onboarded_user_ids.push(agg_a_user_id);
  });

  it('network_service can lookup agg_A user by email and sees items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(agg_a_user_id);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].item_id).toBe(agg_a_item_id);
    // item_locations is now projected on every item (array of {lat,lng,label?}).
    expect(Array.isArray(body.items[0].item_locations)).toBe(true);
  });

  it('GET returns the stored item_locations for an item that has coordinates', async () => {
    // Set coordinates directly on the row (coarsened ~2dp, as a private location
    // field would be stored) and confirm the read surfaces them verbatim.
    const coords = [{ lat: 29.47, lng: 77.71 }];
    await db
      .update(itemsTable)
      .set({ item_locations: coords })
      .where(eq(itemsTable.item_id, agg_a_item_id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0].item_id).toBe(agg_a_item_id);
    expect(body.items[0].item_locations).toEqual(coords);

    // empty case: clearing the column returns [] (not null/undefined)
    await db
      .update(itemsTable)
      .set({ item_locations: [] })
      .where(eq(itemsTable.item_id, agg_a_item_id));
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(res2.json().items[0].item_locations).toEqual([]);
  });

  it('agg_A can lookup their own user by email and sees items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(agg_a_user_id);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].item_id).toBe(agg_a_item_id);
  });

  it("agg_B looking up agg_A's user sees user_id but items: []", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: {
        'x-api-key': agg_b.raw_key,
        'x-acting-org-id': agg_b.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(agg_a_user_id);
    expect(body.items).toEqual([]);
  });

  it('lookup of non-existent user returns user_id: null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/participant?email=nonexistent@test.local',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(null);
    expect(body.items).toEqual([]);
  });

  it('lookup with phone_number works the same as email', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/participant?phone_number=%2B911234567890',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(null);
    expect(body.items).toEqual([]);
  });

  it('missing both email and phone_number returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('MISSING_IDENTIFIER');
  });

  it('GET returns compliance + per-item profile_consent_accepted', async () => {
    const email = `int_read_${randomUUID().slice(0, 6)}@a.test`;
    // create a live profile with full consent + adult age on a gated domain
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Read Status', channel: 'voice', age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(createRes.statusCode).toBe(200);
    onboarded_user_ids.push(createRes.json().user_id);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    // #692: `[{key,value}]`, mirroring the POST's `compliance` shape, and true
    // only because the consent was just recorded at the CURRENT version.
    expect(body.compliance).toEqual(
      expect.arrayContaining([
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'has_age', value: true },
      ]),
    );
    expect(body).not.toHaveProperty('user_consent');
    expect(body.items[0].profile_consent_accepted).toBe(true);
    expect(body.items[0].lifecycle_status).toBe('live');
  });

  it('GET reports false once the accepted version is superseded (#692)', async () => {
    // The prod migration case: the ledger row stays, the live document moves on.
    // Bumping the row's version DOWN is equivalent to the document moving up and
    // avoids mutating the instance's consent config mid-suite.
    const email = `int_stale_${randomUUID().slice(0, 6)}@a.test`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Stale Consent', channel: 'voice', age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const userId = createRes.json().user_id;
    onboarded_user_ids.push(userId);

    const beforeRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(beforeRes.json().compliance).toEqual(
      expect.arrayContaining([{ key: 'user_terms', value: true }]),
    );

    // Rewrite this user's rows to a version the config cannot be serving.
    await db
      .update(consentTable)
      .set({ documentVersion: -1 })
      .where(eq(consentTable.userId, userId));

    const afterRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    const after = afterRes.json();
    expect(after.compliance).toEqual(
      expect.arrayContaining([
        { key: 'user_terms', value: false },
        { key: 'user_privacy', value: false },
        // Age is unrelated to document versions and must stay true.
        { key: 'has_age', value: true },
      ]),
    );
    expect(after.items[0].profile_consent_accepted).toBe(false);
  });

  it('GET rejects a minor for a service caller with U18_NOT_ALLOWED (#692)', async () => {
    // Minors are onboarded through the portal, so create the user via POST as an
    // adult and then age them down — the POST refuses a minor outright.
    const email = `int_minor_${randomUUID().slice(0, 6)}@a.test`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Minor Read', channel: 'voice', age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const userId = createRes.json().user_id;
    onboarded_user_ids.push(userId);

    await db
      .update(authSchema.user)
      .set({ age: 15 })
      .where(eq(authSchema.user.id, userId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('U18_NOT_ALLOWED');
  });

  it('missing x-acting-org-id returns 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(agg_a_user_email)}`,
      headers: {
        'x-api-key': ns.raw_key,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
