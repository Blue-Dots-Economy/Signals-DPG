/**
 * Plan C Task 4 — integration test for POST /api/v1/admin/participant
 * exercising the tier-aware upsert matrix against a real Postgres.
 *
 * Filename ends in .integration.test.ts so the default vitest config
 * excludes it from `pnpm --filter api test`. Runs via the sibling
 * integration config:
 *
 *   docker compose up -d db redis
 *   pnpm db:init:api
 *   pnpm --filter api test:integration
 *
 * The test fully self-contains the world it exercises:
 *
 *   - seeds two aggregator-type orgs + one network_service-type org, each
 *     pointing at one shared service user, each with its own apikey row
 *     (raw key hashed SHA-256 → base64url to match better-auth's
 *     defaultKeyHasher, the same pattern seed_service_users.ts uses);
 *   - drives 6 cases through the route via app.inject, asserting both the
 *     response body and the resulting DB state where each case is
 *     load-bearing (attribution, item count, item_state mutation, the
 *     read-isolation rule, and the cross-user item_id 403);
 *   - boots Fastify on API_PORT (default 2742) with an EADDRINUSE guard
 *     mirroring Plan A's integration suite.
 *
 * Cleanup: afterAll drops items created by every seeded user, deletes
 * the users (cascades member/apikey via FKs), then the three orgs.
 *
 * Skip conditions: if POSTGRES_URL / POSTGRES_USER are unset the suite
 * is described as `.skip` so CI without a DB stays green.
 *
 * Config-driven: served-domain bindings are resolved from apiConfig at
 * beforeAll. The test passes explicit network/domain/item_type in every
 * request so the route never falls back to hard-coded defaults. A minimal
 * valid item_state is generated from the JSON schema for the first
 * item_type declared in each binding's domain config.
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
  nonPrivateFields,
  resolveBindings,
  type ResolvedBinding,
} from '../../__tests__/integration_helpers';
import { apiConfig } from '@/config';
import { guardianConsentRequired } from '@/services/minor';
import { getNetworkConfigById } from '@/network_configs';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const skip_reason = !pg_url
  ? 'POSTGRES_URL / POSTGRES_USER not set — skipping integration suite'
  : '';

const describeIf = can_run ? describe : describe.skip;

const hash_key = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIf(`POST /api/v1/admin/participant (integration)${
  can_run ? '' : ` — ${skip_reason}`
}`, () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let itemsTable: typeof import('@dpg/database').items;
  let consentRecordTable: typeof import('@api/db/postgres/schema')['consent_record'];

  // Default to the network-config port so the route's downstream
  // partition-ensure / signUp paths see the same host they would in the
  // dev server. EADDRINUSE guarded below.
  const listen_port = Number(process.env.API_PORT ?? 2742);

  const ts = Date.now();

  // Aggregator A onboards the canonical user and reads it back.
  const agg_a = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-c-a-${ts}`,
  };

  // Aggregator B — used for the agg-b-cant-read-agg-a's-items case.
  const agg_b = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `agg-int-c-b-${ts}`,
  };

  // Network service — drives update_item / insert_item / item-not-owned.
  const ns = {
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `ns-int-c-${ts}`,
  };

  // One shared service user owns all three apikeys / members — we don't
  // care about distinct service-user identities for this matrix (the
  // route only inspects acting_org.type and acting_org.org_id). Sharing
  // keeps cleanup trivial: one row to delete.
  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `signals-c-int-${ts}@signals.local`;

  // Track every onboarded participant so we can drop their items + user
  // rows in afterAll. The first push is the canonical user that drives
  // cases 1–5, the second is the secondary user seeded inside case 6.
  const onboarded_user_ids: string[] = [];

  // Resolved at beforeAll — schema-derived bindings consumed by each test.
  let primary: ResolvedBinding;
  let secondary: ResolvedBinding | null;

  beforeAll(async () => {
    // Lazy-import the DB / database-package surfaces so a CI box without
    // a live DB doesn't blow up on import (drizzle_config builds a Pool
    // eagerly).
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    const auth_mod = await import('../../../../../db/postgres/schema/auth.js');
    const database_pkg = await import('@dpg/database');
    db = drizzle_mod.db;
    authSchema = auth_mod;
    itemsTable = database_pkg.items;
    const schema_mod = await import('@api/db/postgres/schema');
    consentRecordTable = schema_mod.consent_record;

    // Resolve primary + secondary served-domain bindings from env config.
    const resolved = await resolveBindings();
    primary = resolved.primary;
    secondary = resolved.secondary;

    const { admin_routes } = await import('../admin_routes.js');
    const network_routes_mod = await import('../../network/network_routes.js');

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // /admin/participant's update_item branch loops back through
    // /api/v1/network/schema/... over HTTP to fetch the json-schema for
    // item_state validation, so the network scope has to be reachable on
    // the same listening port (see apiConfig.served_domains → instance_url).
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

    // One shared service user backing every apikey / member row.
    await db.insert(user).values({
      id: svc_user_id,
      email: svc_user_email,
      name: 'plan-c integration svc',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Three orgs spanning the tier matrix: two aggregator-type, one
    // network_service-type. Type column gates which verdict the helper
    // emits for each case.
    await db.insert(organization).values([
      {
        id: agg_a.org_id,
        slug: agg_a.slug,
        name: `${agg_a.slug} (integration aggregator A)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: agg_b.org_id,
        slug: agg_b.slug,
        name: `${agg_b.slug} (integration aggregator B)`,
        type: 'aggregator',
        createdAt: now,
      },
      {
        id: ns.org_id,
        slug: ns.slug,
        name: `${ns.slug} (integration network_service)`,
        type: 'network_service',
        createdAt: now,
      },
    ]);

    // Shared service user is a 'service' member of each org so the
    // acting_org middleware accepts the org_id for any of the three
    // apikeys.
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

    // Three apikeys, one per org — same userId / referenceId since the
    // route picks the acting org from the x-acting-org-id header, not
    // from the apikey row. The hashing matches better-auth's
    // defaultKeyHasher (SHA-256 → base64url, no padding).
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
        try {
          await db
            .delete(consentRecordTable)
            .where(inArray(consentRecordTable.userId, onboarded_user_ids));
        } catch {
          /* swallow cleanup errors */
        }
        // items has no FK on user.id — delete by created_by explicitly.
        await db
          .delete(itemsTable)
          .where(inArray(itemsTable.created_by, onboarded_user_ids));
        await db.delete(user).where(inArray(user.id, onboarded_user_ids));
      }
      // Service apikeys + member rows cascade away with svc user delete,
      // but we drop apikeys explicitly to be defensive in case schema
      // changes loosen the FK in future.
      await db
        .delete(apikey)
        .where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(user).where(eq(user.id, svc_user_id));
      await db
        .delete(organization)
        .where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // Don't mask the actual test failure with a cleanup blow-up.
      // eslint-disable-next-line no-console
      console.error('integration test cleanup failed:', err);
    }
    if (app) await app.close();
  });

  // Shared canonical user identifiers populated by case #1, consumed by
  // cases #2–#5. Case #6 seeds its own secondary user.
  let canonical_user_id: string;
  let canonical_user_email: string;
  let canonical_item_id: string;

  it('agg_A onboards a brand-new user; row exists with onboardedByOrgId = agg_A.org_id, items[0] present', async () => {
    canonical_user_email = `int_c_${randomUUID().slice(0, 6)}@a.test`;
    const initialFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'Int C A',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: initialFixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].item_id).toBeTruthy();
    // POST response now surfaces item_locations (array; [] when no location set)
    expect(Array.isArray(body.items[0].item_locations)).toBe(true);

    canonical_user_id = body.user_id;
    canonical_item_id = body.items[0].item_id;
    onboarded_user_ids.push(canonical_user_id);

    const { user } = authSchema;
    const [row] = await db
      .select({
        id: user.id,
        onboardedByOrgId: user.onboardedByOrgId,
      })
      .from(user)
      .where(eq(user.id, canonical_user_id))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.onboardedByOrgId).toBe(agg_a.org_id);
  });

  it('agg_A hits the same user again with item_state — creates ANOTHER profile (#349 always-create)', async () => {
    const sameTriple = (rows: Array<Record<string, unknown>>) =>
      rows.filter(
        (r) =>
          r.item_network === primary.network &&
          r.item_domain === primary.domain &&
          r.item_type === primary.item_type,
      );
    const before = sameTriple(
      await db.select().from(itemsTable).where(eq(itemsTable.created_by, canonical_user_id)),
    );
    expect(before.length).toBeGreaterThan(0); // already has one from the create test

    // Same body, no item_id → a create is always an insert now (not a dedup-to-update).
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
        email: canonical_user_email,
        name: 'doesnt matter',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(canonical_user_id);

    const after = sameTriple(
      await db.select().from(itemsTable).where(eq(itemsTable.created_by, canonical_user_id)),
    );
    // A brand-new same-type row was added.
    expect(after.length).toBe(before.length + 1);
    const returnedId = body.items[0].item_id as string;
    expect(before.map((r) => r.item_id as string)).not.toContain(returnedId);
  });

  it('per-user profile cap: creating past MAX_PROFILES_PER_USER returns 409 PROFILE_LIMIT_REACHED', async () => {
    // Fresh user so the count starts clean. Default cap = MAX_PROFILES_PER_USER (5).
    const limit = apiConfig.max_profiles_per_user;
    const capEmail = `cap-${randomUUID()}@test.local`;
    const capPhone = `+9199${Math.floor(randomBytes(4).readUInt32BE(0) % 1e8).toString().padStart(8, '0')}`;
    const mk = (n: number) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': ns.raw_key,
          'x-acting-org-id': ns.org_id,
          'content-type': 'application/json',
        },
        payload: {
          email: capEmail,
          phone_number: capPhone,
          name: `Cap User ${n}`,
          channel: 'bulk',
          network: primary.network,
          domain: primary.domain,
          item_type: primary.item_type,
          item_state: generateMinimalItemState(primary.schema),
        },
      });

    // First `limit` creates succeed.
    let capUserId: string | undefined;
    for (let i = 0; i < limit; i++) {
      const ok = await mk(i);
      expect(ok.statusCode).toBe(200);
      capUserId = ok.json().user_id;
    }
    // The next one is rejected by the cap.
    const over = await mk(limit);
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('PROFILE_LIMIT_REACHED');

    // cleanup — only this test user's rows.
    if (capUserId) {
      await db.delete(itemsTable).where(eq(itemsTable.created_by, capUserId));
    }
  });

  it('per-user cap holds under CONCURRENCY on the insert_item path (no TOCTOU over-insert)', async () => {
    const limit = apiConfig.max_profiles_per_user;
    const ccEmail = `capcc-${randomUUID()}@test.local`;
    const ccPhone = `+9199${Math.floor(randomBytes(4).readUInt32BE(0) % 1e8).toString().padStart(8, '0')}`;
    const mk = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/participant',
        headers: {
          'x-api-key': ns.raw_key,
          'x-acting-org-id': ns.org_id,
          'content-type': 'application/json',
        },
        payload: {
          email: ccEmail,
          phone_number: ccPhone,
          name: 'Cap CC User',
          channel: 'bulk',
          network: primary.network,
          domain: primary.domain,
          item_type: primary.item_type,
          item_state: generateMinimalItemState(primary.schema),
        },
      });

    // 1) One sequential create so the user exists — subsequent calls hit the
    //    insert_item path (existing user → new profile), the one #349 fixes.
    const first = await mk();
    expect(first.statusCode).toBe(200);
    const ccUserId = first.json().user_id as string;
    const slotsLeft = limit - 1;

    // 2) Fire more concurrent creates than there are free slots. Only `slotsLeft`
    //    may succeed; the rest must be capped. Without the advisory lock holding
    //    across count+insert (the TOCTOU bug), several would read the same count
    //    and over-insert past the cap.
    const attempts = slotsLeft + 3;
    const results = await Promise.all(Array.from({ length: attempts }, () => mk()));
    const ok = results.filter((r) => r.statusCode === 200).length;
    const capped = results.filter(
      (r) => r.statusCode === 409 && r.json().error === 'PROFILE_LIMIT_REACHED',
    ).length;

    expect(ok).toBe(slotsLeft);
    expect(capped).toBe(attempts - slotsLeft);

    // DB truth: exactly `limit` same-type profiles for this user, never more.
    const rows = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, ccUserId));
    const sameType = rows.filter(
      (r) =>
        r.item_network === primary.network &&
        r.item_domain === primary.domain &&
        r.item_type === primary.item_type,
    );
    expect(sameType.length).toBe(limit);

    // cleanup — only this test user's rows.
    await db.delete(itemsTable).where(eq(itemsTable.created_by, ccUserId));
  });

  it('network_service updates an existing item via item_id; item_state in DB reflects the new payload', async () => {
    const updateFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS Update',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: updateFixture,
        item_id: canonical_item_id,
      },
    });
    expect(res.statusCode).toBe(200);

    const [refreshed] = await db
      .select({ item_state: itemsTable.item_state })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, canonical_item_id))
      .limit(1);
    expect(refreshed).toBeTruthy();
    // Private fields land in item_state as type-aware masks (PII encryption at
    // rest, see 2026-05-28-pii-encryption-at-rest design). The unmasked values
    // live in item_private_state. Round-trip assert on the public-only subset.
    const publicFromFixture = nonPrivateFields(primary.schema, updateFixture);
    const publicFromDb = nonPrivateFields(
      primary.schema,
      refreshed.item_state as Record<string, unknown>,
    );
    expect(publicFromDb).toEqual(publicFromFixture);
  });

  it('network_service inserts an additional item for the same user (secondary served-domain binding); item count goes up by 1', async (ctx) => {
    if (secondary === null) {
      ctx.skip();
      return;
    }

    const before = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));

    const secondaryFixture = generateMinimalItemState(secondary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS Insert',
        channel: 'bulk',
        network: secondary.network,
        domain: secondary.domain,
        item_type: secondary.item_type,
        item_state: secondaryFixture,
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    expect(after.length).toBe(before.length + 1);
  });

  it("agg_B trying to read agg_A's user gets user_existed=true but items: []", async () => {
    const probeFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_b.raw_key,
        'x-acting-org-id': agg_b.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'agg_b probe',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: probeFixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(canonical_user_id);
    expect(body.items).toEqual([]);
  });

  it("agg_B probing agg_A's MINOR user gets owned_elsewhere, never U18_NOT_ALLOWED (no cross-tenant minor-status leak)", async () => {
    // Regression: the U18/AGE gates must run AFTER the ownership verdict, so a
    // non-owning aggregator can't probe another tenant's minor-status/age. Seed a
    // minor owned by agg_A directly in the DB — the API rejects onboarding a
    // minor, so one can't be created through it.
    const { user } = authSchema;
    const minor_email = `int_minorprobe_${randomUUID().slice(0, 6)}@a.test`;
    const seed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: minor_email,
        name: 'Minor Owned By A',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
      },
    });
    expect(seed.statusCode).toBe(200);
    const minor_user_id: string = seed.json().user_id;
    onboarded_user_ids.push(minor_user_id);
    // Force the stored age to a minor (can't be done via the API).
    await db.update(user).set({ age: 15 }).where(eq(user.id, minor_user_id));

    // agg_B probes with NO age → must get owned_elsewhere, not U18_NOT_ALLOWED.
    const probe = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_b.raw_key,
        'x-acting-org-id': agg_b.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: minor_email,
        name: 'agg_b minor probe',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
      },
    });
    expect(probe.statusCode).toBe(200);
    const probeBody = probe.json();
    expect(probeBody.error).toBeUndefined();
    expect(probeBody.owned_elsewhere).toBe(true);
    expect(probeBody.user_existed).toBe(true);
    expect(probeBody.items).toEqual([]);
  });

  it('network_service with item_id from a different user → 403 ITEM_NOT_OWNED_BY_USER, no writes', async () => {
    // Seed a second user via agg_A so we have an item owned by someone
    // other than the canonical user.
    const other_email = `int_c_${randomUUID().slice(0, 6)}@b.test`;
    const seedFixture = generateMinimalItemState(primary.schema);
    const seed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a.raw_key,
        'x-acting-org-id': agg_a.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: other_email,
        name: 'Other Int C',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: seedFixture,
      },
    });
    expect(seed.statusCode).toBe(200);
    const seed_body = seed.json();
    const other_user_id: string = seed_body.user_id;
    const other_item_id: string = seed_body.items[0].item_id;
    onboarded_user_ids.push(other_user_id);

    // Snapshot the canonical user's items so we can assert "no writes"
    // happened against them.
    const before_canonical = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    const before_other = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, other_item_id))
      .limit(1);

    const badFixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: canonical_user_email,
        name: 'NS bad update',
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: badFixture,
        item_id: other_item_id, // belongs to the OTHER user
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');

    // Canonical user untouched.
    const after_canonical = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.created_by, canonical_user_id));
    expect(after_canonical.length).toBe(before_canonical.length);

    // Other user's item likewise untouched (full state equality check).
    const [after_other] = await db
      .select({
        item_id: itemsTable.item_id,
        item_state: itemsTable.item_state,
        updated_at: itemsTable.updated_at,
      })
      .from(itemsTable)
      .where(eq(itemsTable.item_id, other_item_id))
      .limit(1);
    expect(after_other).toBeTruthy();
    expect(after_other.item_state).toEqual(before_other[0].item_state);
  });

  it('records compliance consent and promotes an adult profile to live', async () => {
    const email = `int_c_compliance_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Compliance Adult',
        age: 25,
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].lifecycle_status).toBe('live');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    const cats = rows.map((r) => r.consentCategory).sort();
    expect(cats).toEqual(['privacy', 'profile_creation', 'terms']);
    const profileRow = rows.find((r) => r.consentCategory === 'profile_creation');
    expect(profileRow?.source).toBe('profile');
    expect(profileRow?.metadata).toMatchObject({
      channel: 'voice',
      via: 'admin_participant',
    });
  });

  it('strips the removed terms_accepted/privacy_accepted and records no consent (#692)', async () => {
    const email = `int_c_legacy_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Legacy Booleans',
        channel: 'bulk',
        // Removed from the schema in #692; still sent here on purpose — a
        // legacy integrator must keep getting a 200, with no ledger row.
        terms_accepted: true,
        privacy_accepted: true,
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded ?? 0).toBe(0);
    expect(body.items[0].lifecycle_status).toBe('draft');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    expect(rows).toHaveLength(0);
  });

  it('does not record profile_creation without the terms+privacy prerequisite', async () => {
    const email = `int_c_prereq_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Prereq Missing',
        age: 25,
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [{ key: 'profile_creation', value: true }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    onboarded_user_ids.push(body.user_id);
    expect(body.consent_recorded ?? 0).toBe(0);
    expect(body.items[0].lifecycle_status).toBe('draft');

    const rows = await db
      .select()
      .from(consentRecordTable)
      .where(eq(consentRecordTable.userId, body.user_id));
    expect(rows).toHaveLength(0);
  });

  it('minor age (#331/#359) is rejected outright — 400 U18_NOT_ALLOWED, nothing created', async () => {
    // age:15 is unambiguously a minor (isMinor is age <= 18) regardless of the
    // served domain's guardian-gating — the U18 check runs before any DB
    // write and before the domain gate is even consulted.
    const email = `int_c_minor_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Compliance Minor',
        age: 15,
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('U18_NOT_ALLOWED');

    // No user was created for this identity — the check runs before any write.
    const { user } = authSchema;
    const userRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    expect(userRows).toHaveLength(0);
  });

  it('gated domain: user consent without age → 400 AGE_REQUIRED', async () => {
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: `int_agereq_${randomUUID().slice(0, 6)}@a.test`,
        name: 'Age Required',
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    if (gated) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('AGE_REQUIRED');
    } else {
      // non-gated served domain: consent without age is allowed
      expect(res.statusCode).toBe(200);
      onboarded_user_ids.push(res.json().user_id);
    }
  });

  it('gated domain: explicit age:null must be treated as absent — 400 AGE_REQUIRED, never U18_NOT_ALLOWED', async () => {
    // Regression for the z.coerce bug: age:null used to coerce to 0, which
    // isMinor() treats as a minor, producing a false 400 U18_NOT_ALLOWED. With
    // age:null correctly treated as "not provided", a gated domain + full
    // consent + complete item_state but no age must fail with AGE_REQUIRED
    // (or succeed on a non-gated domain) — U18_NOT_ALLOWED must never fire.
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email: `int_agenull_${randomUUID().slice(0, 6)}@a.test`,
        name: 'Age Null',
        age: null,
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(res.json().error).not.toBe('U18_NOT_ALLOWED');
    if (gated) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('AGE_REQUIRED');
    } else {
      // non-gated served domain: consent without age is allowed
      expect(res.statusCode).toBe(200);
      onboarded_user_ids.push(res.json().user_id);
    }
  });

  it('gated domain: returning user with stored age may re-send the consent pair without age (no AGE_REQUIRED)', async () => {
    const email = `int_reage_${randomUUID().slice(0, 6)}@a.test`;
    // 1) create live with full consent + adult age on the (gated) primary domain
    const c = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Returning', channel: 'voice', age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(c.statusCode).toBe(200);
    onboarded_user_ids.push(c.json().user_id);
    // 2) re-send the user pair WITHOUT age, no item → must NOT 400 AGE_REQUIRED
    const r = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Returning', channel: 'voice',
        network: primary.network, domain: primary.domain,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
  });

  it('activates a gated draft by later supplying age via item_id', async () => {
    const email = `int_activate_${randomUUID().slice(0, 6)}@a.test`;
    // 1) create WITH consent but NO age on a gated domain → stays draft
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    if (!gated) return; // this scenario only applies on a gated served domain
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Activate Later', channel: 'voice',
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        // gated + consent + no age would 400 (AGE_REQUIRED); so create with NO
        // consent first (bulk-style draft), then add consent+age on activation.
      },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json();
    onboarded_user_ids.push(created.user_id);
    const itemId = created.items[0].item_id as string;
    expect(created.items[0].lifecycle_status).toBe('draft');

    // 2) activate: item_id + full consent + adult age → live
    const actRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Activate Later', channel: 'voice',
        item_id: itemId, age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(actRes.statusCode).toBe(200);
    const activated = actRes.json();
    const row = activated.items.find((i: { item_id: string }) => i.item_id === itemId);
    expect(row.lifecycle_status).toBe('live');
  });

  it('gated domain: adding a NEW profile to an existing age-less user persists the age sent on that call and goes live (insert_item)', async () => {
    // Regression: the insert_item branch (existing user + item_state, no item_id)
    // used to drop body.age, so a new profile for a previously age-less user was
    // stuck draft (guardian gate fail-closes on unknown age) and GET has_age
    // stayed false even though the request supplied an adult age.
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    if (!gated) return; // the age gate only bites on a gated domain

    const email = `int_insertage_${randomUUID().slice(0, 6)}@a.test`;
    // 1) create the user with NO age and NO item (account-only, bulk-style).
    const c = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Insert Age', channel: 'voice',
        network: primary.network, domain: primary.domain,
      },
    });
    expect(c.statusCode).toBe(200);
    onboarded_user_ids.push(c.json().user_id);

    // 2) existing user + item_state + adult age + full consent, no item_id → insert_item.
    const r = await app.inject({
      method: 'POST', url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id, 'content-type': 'application/json' },
      payload: {
        email, name: 'Insert Age', channel: 'voice', age: 25,
        network: primary.network, domain: primary.domain, item_type: primary.item_type,
        item_state: generateMinimalItemState(primary.schema),
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user_existed).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.items[0].lifecycle_status).toBe('live');

    // 3) GET confirms the age landed on the user record.
    const g = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/participant?email=${encodeURIComponent(email)}`,
      headers: { 'x-api-key': ns.raw_key, 'x-acting-org-id': ns.org_id },
    });
    expect(g.statusCode).toBe(200);
    expect(g.json().compliance).toEqual(
      expect.arrayContaining([{ key: 'has_age', value: true }]),
    );
  });

  it('gated domain: minor + full consent + complete item_state → 400 U18_NOT_ALLOWED, no consent recorded, no item created', async () => {
    const gated = guardianConsentRequired(
      await getNetworkConfigById(primary.network),
      primary.domain,
    );
    if (!gated) return; // this scenario is specifically about the gated domain path

    const email = `int_u18gated_${randomUUID().slice(0, 6)}@a.test`;
    const fixture = generateMinimalItemState(primary.schema);

    const itemsBefore = await db
      .select({ item_id: itemsTable.item_id })
      .from(itemsTable)
      .where(eq(itemsTable.item_network, primary.network));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': ns.raw_key,
        'x-acting-org-id': ns.org_id,
        'content-type': 'application/json',
      },
      payload: {
        email,
        name: 'Gated Minor',
        age: 15,
        channel: 'voice',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
          { key: 'profile_creation', value: true },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('U18_NOT_ALLOWED');

    // No user was created for this identity, so no consent_record row could
    // reference it either — confirm the identity never made it into the DB.
    const { user } = authSchema;
    const userRows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    expect(userRows).toHaveLength(0);

    // Guard inArray against an empty id list (drizzle can't build `IN ()`).
    const consentRows =
      userRows.length > 0
        ? await db
            .select()
            .from(consentRecordTable)
            .where(inArray(consentRecordTable.userId, userRows.map((r) => r.id)))
        : [];
    expect(consentRows).toHaveLength(0);

    // No item was created under this network as a side effect of the call.
    const itemsAfter = await db
      .select({ item_id: itemsTable.item_id })
      .from(itemsTable)
      .where(eq(itemsTable.item_network, primary.network));
    expect(itemsAfter.length).toBe(itemsBefore.length);
  });
});
