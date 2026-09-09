/**
 * Integration test for POST /api/v1/admin/participant/decrypt against a real
 * Postgres. Seeds two aggregator orgs + one network_service org and an
 * onboarded user with one item carrying masked public state + an encrypted
 * private blob. The item is deliberately given NO item_metrics row — ownership
 * is keyed on user.onboarded_by_org_id, so the export must work without the
 * lazily-materialized metrics cache. Verifies:
 *   1. aggregator A decrypts its own item (cleartext private fields) — with no
 *      item_metrics row present (proves the metrics cache is not required)
 *   2. aggregator B gets the same item in `skipped` (not owned)
 *   3. network_service decrypts any item
 *   4. unknown item_id → skipped; invariant profiles+skipped == requested
 *   5. user_id mode returns A's items for A, empty for B
 *   6. a corrupt private blob is skipped, not 500 — the batch survives
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
import { encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { resolveBindings, generateMinimalItemState, type ResolvedBinding } from '../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;
const hash_key = (raw: string) => createHash('sha256').update(raw).digest('base64url');

describeIf('POST /api/v1/admin/participant/decrypt (integration)', () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();
  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `decrypt-int-${ts}@signals.local`;

  const mk = (label: string) => ({
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `decrypt-int-${label}-${ts}`,
  });
  const agg_a = mk('a');
  const agg_b = mk('b');
  const ns = mk('ns');

  let primary: ResolvedBinding;
  let participant_user_id = '';
  let item_id = '';

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    authSchema = await import('../../../../../db/postgres/schema/auth.js');
    itemsTable = (await import('@dpg/database')).items;
    db = drizzle_mod.db;

    primary = (await resolveBindings()).primary;

    const { admin_routes } = await import('../admin_routes.js');
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.listen({ port: listen_port, host: '127.0.0.1' });

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: svc_user_id, email: svc_user_email, name: 'decrypt svc',
      emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(organization).values([
      { id: agg_a.org_id, slug: agg_a.slug, name: agg_a.slug, type: 'aggregator', createdAt: now },
      { id: agg_b.org_id, slug: agg_b.slug, name: agg_b.slug, type: 'aggregator', createdAt: now },
      { id: ns.org_id, slug: ns.slug, name: ns.slug, type: 'network_service', createdAt: now },
    ]);
    await db.insert(member).values([agg_a, agg_b, ns].map((v) => ({
      id: v.member_id, organizationId: v.org_id, userId: svc_user_id, role: 'service', createdAt: now,
    })));
    for (const v of [agg_a, agg_b, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id, name: v.slug, key: hash_key(v.raw_key), userId: svc_user_id,
        referenceId: svc_user_id, configId: 'default', start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_', enabled: true, rateLimitEnabled: false, createdAt: now, updatedAt: now,
      });
    }

    // Onboard a participant via the real POST route (agg A) so the item row is
    // created with every required column. onboard sets user.onboarded_by_org_id
    // to the acting org — that is the ownership signal the endpoint scopes on.
    const fixture = generateMinimalItemState(primary.schema);
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': agg_a.raw_key, 'x-acting-org-id': agg_a.org_id, 'content-type': 'application/json' },
      payload: {
        email: `participant-${ts}@a.test`,
        name: 'Velu Murugan',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    if (onboardRes.statusCode !== 200) {
      throw new Error(`onboard setup failed: ${onboardRes.statusCode} ${onboardRes.body}`);
    }
    const onboardBody = onboardRes.json();
    participant_user_id = onboardBody.user_id;
    item_id = onboardBody.items[0].item_id;

    // Overwrite the item with a known masked public state + encrypted private
    // blob so the decrypt assertions are deterministic regardless of which
    // fields the network schema marks private.
    const privateFields = { name: 'Velu Murugan', phone: '+919876801011' };
    await db
      .update(itemsTable)
      .set({
        item_state: { name: 'V***' },
        item_private_state: encryptPiiBlob(JSON.stringify(privateFields), getPiiKey()),
      })
      .where(eq(itemsTable.item_id, item_id));

    // NB: we deliberately do NOT create an item_metrics row. Ownership is keyed
    // on user.onboarded_by_org_id, so the export must succeed without the lazy
    // metrics cache — these tests would fail if scoping still inner-joined it.
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      await db.delete(itemsTable).where(eq(itemsTable.item_id, item_id));
      await db.delete(user).where(inArray(user.id, [participant_user_id, svc_user_id]));
      await db.delete(apikey).where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(organization).where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err);
    }
    if (app) await app.close();
  });

  const post = (v: typeof agg_a, payload: unknown) =>
    app.inject({
      method: 'POST', url: '/api/v1/admin/participant/decrypt',
      headers: { 'x-api-key': v.raw_key, 'x-acting-org-id': v.org_id, 'content-type': 'application/json' },
      payload: payload as Record<string, unknown>,
    });

  it('aggregator A decrypts its own item (cleartext private fields)', async () => {
    const res = await post(agg_a, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_id).toBe(item_id);
    expect(body.profiles[0].item_state.name).toBe('Velu Murugan');
    expect(body.profiles[0].item_state.phone).toBe('+919876801011');
    expect(body.skipped).toEqual([]);
  });

  it('aggregator B gets the item in skipped (not owned)', async () => {
    const res = await post(agg_b, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toEqual([]);
    expect(body.skipped).toEqual([item_id]);
  });

  it('network_service decrypts any item', async () => {
    const res = await post(ns, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles[0].item_state.name).toBe('Velu Murugan');
  });

  it('unknown id is skipped; profiles + skipped == requested', async () => {
    const ghost = randomUUID();
    const res = await post(agg_a, { item_ids: [item_id, ghost] });
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.skipped).toEqual([ghost]);
    expect(body.profiles.length + body.skipped.length).toBe(2);
  });

  it('user_id mode returns A items for A, empty for B', async () => {
    const a = (await post(agg_a, { user_id: participant_user_id })).json();
    expect(a.profiles).toHaveLength(1);
    expect(a.profiles[0].item_state.name).toBe('Velu Murugan');
    const b = (await post(agg_b, { user_id: participant_user_id })).json();
    expect(b.profiles).toEqual([]);
  });

  it('a corrupt private blob is skipped, not 500 — the batch survives', async () => {
    // Corrupt the encrypted blob so decryption throws for this row.
    await db
      .update(itemsTable)
      .set({ item_private_state: 'v1:not-valid-base64-$$$' })
      .where(eq(itemsTable.item_id, item_id));
    try {
      const res = await post(agg_a, { item_ids: [item_id] });
      // The whole batch must not 500 on one bad row.
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.profiles).toEqual([]);
      expect(body.skipped).toEqual([item_id]);
    } finally {
      // Restore the valid blob so test ordering stays independent.
      await db
        .update(itemsTable)
        .set({
          item_private_state: encryptPiiBlob(
            JSON.stringify({ name: 'Velu Murugan', phone: '+919876801011' }),
            getPiiKey(),
          ),
        })
        .where(eq(itemsTable.item_id, item_id));
    }
  });
});
