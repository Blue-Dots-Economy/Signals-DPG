import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
  jsonb,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text('role'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires'),
  phoneNumber: text('phone_number').unique(),
  phoneNumberVerified: boolean('phone_number_verified'),
  // Age (years) captured at registration for U18 gating (#331). Snapshot, not
  // a birthdate — a minor is age <= 18 (the boundary year is treated as u18,
  // no month). Optional. `location` is an optional free-text account location.
  age: integer('age'),
  location: text('location'),
  // Domain roles the user signed up for / is allowed to create profiles in
  // (e.g. ['seeker'] now; ['seeker','provider'] once multi-role is enabled).
  // Persisted at signup; profile creation is restricted to these. Null/empty
  // for users onboarded before this existed — callers fall back to held items.
  domains: text('domains').array(),
  termsAccepted: boolean('terms_accepted').default(false),
  privacyAccepted: boolean('privacy_accepted').default(false),
  // Plan 2: participant attribution. Set by POST /api/v1/admin/onboard_participant
  // (which acts on behalf of an aggregator or voice org via acting_org). Null
  // for users created by other paths (better-auth signUp from a UI etc.).
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  // SS-3 (#640): true when `onboarded_by_org_id` was filled from the
  // instance's DEFAULT aggregator rather than from a real onboarding act.
  // Server-only and deliberately NOT derived from `onboarded_via` — that
  // column is written from the request's `channel` field, so a caller could
  // set it, and this flag is what the later re-assignment job scopes on (it
  // decides who is handed PII-decrypt rights over whom).
  onboardedByDefault: boolean('onboarded_by_default').notNull().default(false),
  onboardedVia: text('onboarded_via'),
  onboardedSourceId: text('onboarded_source_id'),
  onboardedAt: timestamp('onboarded_at'),
  // Extensible support/ops markers on the user. Keyed jsonb so new flags can
  // be added without a migration. Current key: `is_test` (boolean) — marks a
  // user (and, by the created_by/owner join, their profiles, posts, and
  // applications) as test data for analysis + later bulk cleanup.
  tags: jsonb('tags').notNull().default({}),
}, (table) => [
  index('user_onboarded_by_org_via_idx').on(
    table.onboardedByOrgId,
    table.onboardedVia,
  ),
  // GIN index accelerates `tags @> '{"is_test": true}'` containment lookups.
  index('user_tags_gin_idx').using('gin', table.tags),
]);

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').$defaultFn(
    () => /* @__PURE__ */ new Date()
  ),
  updatedAt: timestamp('updated_at').$defaultFn(
    () => /* @__PURE__ */ new Date()
  ),
});

export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at').notNull(),
  metadata: text('metadata'),
  type: text('type'),
  // SS-3 (#640): served-domain bindings ("<network>/<domain>", e.g.
  // 'blue_dot/seeker') for which this org is the DEFAULT aggregator — the one
  // that inherits users arriving with no aggregator of their own.
  //
  // An array because one aggregator may be the default for several domains
  // (seeker AND provider is the expected launch shape). Postgres cannot
  // unique-index an array element, so "one org per binding" is enforced by the
  // `organization_default_binding_exclusive` trigger (migration 0014), which
  // rejects a nomination for a binding another org already holds.
  //
  // Deliberately NOT indexed for lookup: `organization` holds tens to hundreds
  // of rows, where a sequential scan beats GIN and GIN would tax every upsert.
  defaultForBindings: text('default_for_bindings').array(),
}, (table) => [
  // The flag grants PII-decrypt rights over the users it captures, so it must
  // never land on a `network_service` org — whose "unverified queue" nobody
  // would ever open. Approval state itself lives in aggregator-dpg and is not
  // visible here, so this constraint is the only enforceable half.
  check(
    'organization_default_requires_aggregator',
    sql`${table.defaultForBindings} IS NULL OR ${table.type} = 'aggregator'`,
  ),
  // NO global "one default per instance" index any more.
  //
  // There used to be a unique index on a constant expression here, allowing a
  // single default-holding org instance-wide. It was a stand-in for a rule the
  // write paths did not yet enforce: `user.onboarded_by_org_id` (which grants
  // PII-decrypt rights) is per ACCOUNT, while profiles are per DOMAIN, and
  // `participant_decrypt` scopes on the tag with no domain condition. A user
  // holding profiles in two domains therefore had one owner covering both, so a
  // second per-domain default could decrypt a participant it did not own.
  //
  // That ambiguity is now impossible at the source: `assertSingleDomain`
  // (`services/item_service.ts`) locks every account to one domain on its first
  // item create, at the shared choke point every path goes through — including
  // `admin/participant` and admin api-key callers, both of which skipped the
  // old route-level check. Migration 0015 backfills the historical rows the old
  // check never recorded. With one domain per account the tag is unambiguous,
  // so separate default aggregators per domain are safe and the index is gone
  // (migration 0016).
  //
  // Per-binding exclusivity — "no two orgs are the default for the SAME
  // binding" — is unaffected and still enforced, by the
  // `organization_default_binding_exclusive` trigger in migration 0014.
  // Postgres cannot unique-index an array element, which is why that one is a
  // trigger and not an index.
]);

export const member = pgTable('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').default('member').notNull(),
  teamId: text('team_id'),
  createdAt: timestamp('created_at').notNull(),
});

export const invitation = pgTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  teamId: text('team_id'),
  status: text('status').default('pending').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const team = pgTable('team', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at'),
});

export const teamMember = pgTable('team_member', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at'),
});

export const apikey = pgTable('apikey', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull().default('default'),
  name: text('name'),
  // First N raw-key chars (better-auth defaults to 6) — for UI display only.
  // The raw key itself is NEVER stored.
  start: text('start'),
  referenceId: text('reference_id').notNull(),
  prefix: text('prefix'),
  // Stores SHA-256(raw_key) base64url-encoded WITHOUT padding (43 chars).
  // Matches @better-auth/api-key's `defaultKeyHasher`. Mint via
  // `authInstance.api.createApiKey(...)` or, for standalone scripts,
  // hash with `createHash('sha256').update(raw).digest('base64url')`
  // before inserting — never store the raw key. See
  // apps/api/scripts/seed_service_users.ts for the reference pattern.
  key: text('key').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  refillInterval: integer('refill_interval'),
  refillAmount: integer('refill_amount'),
  lastRefillAt: timestamp('last_refill_at'),
  enabled: boolean('enabled').default(true),
  rateLimitEnabled: boolean('rate_limit_enabled').default(true),
  rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
  rateLimitMax: integer('rate_limit_max').default(10),
  requestCount: integer('request_count'),
  remaining: integer('remaining'),
  lastRequest: timestamp('last_request'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  permissions: text('permissions'),
  metadata: text('metadata'),
});
