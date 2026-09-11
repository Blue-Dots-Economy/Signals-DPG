/**
 * Local-dev seed for the aggregator-dpg integrating-DPG service user.
 *
 * The service user lives inside an organization with type='network_service'
 * and owns one apikey. Run after `pnpm db:push:api` so the better-auth
 * tables exist.
 *
 * Run from repo root:  pnpm db:seed:services:api
 * Run inside apps/api: pnpm db:seed:services
 *
 * Idempotent — safe to re-run. Existing rows are reused; existing apikeys
 * are left alone. Minted keys are printed ONCE — capture them then.
 *
 * For production (k8s), the deploy-time migrate-job (in the separate
 * charts repo) applies `provision_service_users.sql` on every
 * install/upgrade, reading the raw key from the AGGREGATOR_DPG_API_KEY
 * Secret. The cluster Secret is the source of truth there.
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

// Build our own pg pool + drizzle instance rather than importing
// `apps/api/db/postgres/drizzle_config`, which transitively pulls in
// the API's full Zod env validation (INSTANCE_NAME, INSTANCE_ENV, etc.).
// A standalone DB-only script shouldn't require app-context env vars —
// matches the pattern db_init.ts uses for the same reason.
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const pool = new Pool({ connectionString: pgUrl, ssl: false });
const db = drizzle(pool);

import {
  user as userTable,
  organization,
  member,
  apikey,
} from '../db/postgres/schema/auth.js';

// The org type below is `network_service` — network-wide scope. Which org type
// a principal gets determines its reach, because acting-org reach is checked by
// TYPE downstream, not by which org id a caller asserts (see the scope model in
// `src/middleware/acting_org.ts`). A principal that should reach only PART of
// the network cannot be expressed that way: it needs the `signals_acting_orgs`
// claim and `ACTING_ORG_SOURCE=claim_preferred`, enabled in the same change
// that adds it here.
const SERVICES = [
  { slug: 'aggregator-dpg', user_email: 'aggregator-dpg-svc@signals.local' },
] as const;

const ensure_org = async (slug: string, name: string): Promise<string> => {
  const [existing] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const id = `org_${randomUUID()}`;
  await db.insert(organization).values({
    id,
    slug,
    name,
    type: 'network_service',
    createdAt: new Date(),
  });
  return id;
};

const ensure_user = async (email: string, name: string): Promise<string> => {
  const [existing] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (existing) return existing.id;
  const id = `usr_${randomUUID()}`;
  const now = new Date();
  await db.insert(userTable).values({
    id,
    email,
    name,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

const ensure_member = async (user_id: string, org_id: string): Promise<string> => {
  const [existing] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, user_id))
    .limit(1);
  if (existing) return existing.id;
  const id = `mem_${randomUUID()}`;
  await db.insert(member).values({
    id,
    organizationId: org_id,
    userId: user_id,
    role: 'service',
    createdAt: new Date(),
  });
  return id;
};

const ensure_apikey = async (
  user_id: string,
  name: string,
): Promise<{ minted: boolean; raw_key: string | null }> => {
  const [existing] = await db
    .select({ id: apikey.id })
    .from(apikey)
    .where(eq(apikey.userId, user_id))
    .limit(1);
  if (existing) {
    return { minted: false, raw_key: null };
  }
  const raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  // @better-auth/api-key stores SHA-256(key) base64url-encoded (no padding)
  // and compares the hash at verify time. We must insert the hash, not the
  // raw key. See node_modules/@better-auth/api-key/dist/index.mjs
  // `defaultKeyHasher`. Node's `digest('base64url')` is unpadded by default,
  // matching better-auth's `base64Url.encode(..., { padding: false })`.
  const hashed_key = createHash('sha256').update(raw_key).digest('base64url');
  const now = new Date();
  await db.insert(apikey).values({
    id: `key_${randomUUID()}`,
    name,
    key: hashed_key,
    userId: user_id,
    referenceId: user_id,
    configId: 'default',
    start: raw_key.slice(0, 6),
    prefix: 'sk_signals_',
    enabled: true,
    rateLimitEnabled: false,
    createdAt: now,
    updatedAt: now,
  });
  return { minted: true, raw_key };
};

const main = async () => {
  for (const svc of SERVICES) {
    const org_id = await ensure_org(
      svc.slug,
      `${svc.slug} (network service)`,
    );
    const user_id = await ensure_user(svc.user_email, svc.slug);
    const member_id = await ensure_member(user_id, org_id);
    const apikey_result = await ensure_apikey(user_id, svc.slug);

    // Always print the IDs so operators don't need psql to find them.
    // Raw key is printed ONLY on mint — re-runs show '(existing — capture
    // from first-run logs or rotate via TRUNCATE apikey + reseed)'.
    console.log(`\n${svc.slug}:`);
    console.log(`  org_id:    ${org_id}`);
    console.log(`  user_id:   ${user_id}`);
    console.log(`  member_id: ${member_id}`);
    if (apikey_result.minted) {
      console.log(`  apikey:    ${apikey_result.raw_key}`);
      console.log(`             ↑ raw key — NOT SHOWN AGAIN. Capture now.`);
    } else {
      console.log(
        `  apikey:    (existing — capture from first-run logs, or rotate via TRUNCATE apikey + reseed)`,
      );
    }
  }
  console.log('\nseed complete.');
  process.exit(0);
};

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
