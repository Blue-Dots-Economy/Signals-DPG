/**
 * Keycloak → local `user` mirror provisioning.
 *
 * This is the app-side home of the business logic that `unified_otp` married to
 * authentication (§4 of docs/superpowers/plans/2026-07-23-keycloak-migration-design.md).
 * Keycloak's OTP flow owns the *credential* half; everything below is the half
 * that has to keep happening when a human's token first reaches signals:
 *
 *   - the channel gate (LOGIN_CHANNELS)
 *   - the self-signup gate (SELF_SIGNUP_MODE) — see the R2 note below
 *   - the local `user` row (the mirror, keyed on the Keycloak `sub`)
 *   - the `member` / org-join row
 *   - guardian materialization for a U18 self-signup
 *
 * **The mirror is keyed on `sub`, and `sub` == `user.id` by design** (§6.1).
 * That equality is the whole reason domain data never moves: `items.created_by`
 * and every `*_owner` text column keep pointing at the same UUIDs. Nothing here
 * may ever mint a fresh id for a user that already exists.
 *
 * **R2 — the gated-signup gate must not reopen here.** Under
 * SELF_SIGNUP_MODE=gated, participants are created by an admin
 * (POST /api/v1/admin/participant), so a valid Keycloak token whose `sub` has
 * no local row means someone got an account another way. Provisioning refuses
 * to create the mirror for them. `unified_otp` enforced this at two call sites
 * as defence-in-depth; here there is exactly one place a user row can be born
 * from a login, and this is it.
 *
 * Nothing in this module throws for an expected failure — callers get a
 * discriminated result and map it to a status code, per the repo's
 * "routes never throw" convention.
 */

import { and, eq, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import {
  member as memberTable,
  organization as organizationTable,
  user as userTable,
} from '@api/db/postgres/schema/auth';
import { authConfig } from '@/config';
import { materializeSignupGuardian } from '@/services/signup_guardian';
import { sendWelcomeNotifications } from '@/notifications/welcome';
import { takeSignupExtras } from '@/services/auth/signup_extras';
import { insertLocalUser } from '@/services/auth/user_writer';
import { tagUserForDomain } from '@/services/aggregator/default_aggregator';
import { actingOrgGrant, grantIsWildcard } from '@/utils/keycloak_token';
import type { KeycloakClaims } from '@/utils/keycloak_token';
import { randomUUID } from 'node:crypto';

/** The shape the auth middleware puts on `request.user`. Unchanged contract. */
export interface ProvisionedUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
}

export type ProvisioningErrorCode =
  /** The identifier channel in the token is not enabled on this instance. */
  | 'LOGIN_CHANNEL_DISABLED'
  /** Gated instance, and this subject has no local row to log into (R2). */
  | 'SELF_SIGNUP_DISABLED'
  /** The local mirror says this user is banned (R8). */
  | 'USER_BANNED'
  /** A different local user already owns this token's email/phone. */
  | 'IDENTITY_CONFLICT'
  /** The token carries no usable identifier at all. */
  | 'NO_IDENTIFIER'
  /** Unexpected database failure. */
  | 'PROVISIONING_FAILED';

export type ProvisioningResult =
  | { ok: true; user: ProvisionedUser; created: boolean }
  | { ok: false; code: ProvisioningErrorCode; message: string };

/**
 * Resolve the organization a human token says its subject belongs to.
 *
 * **This reads the `signals_acting_orgs` grant, not a `signalstack_org_id`
 * claim.** It used to read the latter, which no client ever emits: the
 * `signals-ui` mapper takes the `signalstack_org_id` *user attribute* and emits
 * it under the claim name `signals_acting_orgs` (verified against the
 * `bluedots` realm). So `orgId` was always null and `ensureOrgMembership` was
 * dead code that looked live — gap G5 of
 * `docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`.
 *
 * Reusing the grant is correct rather than a conflation, for the human path
 * specifically: per design §5.1 a human's grant *is* "the single org from their
 * user attribute". Service tokens never reach here — `resolve_session.ts` forks
 * them to `resolveServiceAccount` first.
 *
 * Adopted only when the grant names exactly **one concrete** org. A wildcard
 * (`['*']`, the platform service grant) or a multi-org grant says what a caller
 * may *act for*, which is not the same as what they are a *member of*, and
 * guessing one from the other would silently join people to orgs.
 */
function orgIdFromGrant(claims: KeycloakClaims): string | null {
  const grant = actingOrgGrant(claims);
  if (grant?.length !== 1 || grantIsWildcard(grant)) return null;
  return grant[0];
}

/** Postgres unique-violation. Provisioning races surface as this. */
const PG_UNIQUE_VIOLATION = '23505';

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Keycloak sends email/phone as claims; normalise the way signals stores them. */
function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

function normalizePhone(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

/** The identity a token asserts, reduced to what the mirror stores. */
interface TokenIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  name: string;
  orgId: string | null;
}

function readIdentity(claims: KeycloakClaims): TokenIdentity {
  const email = normalizeEmail(claims.email);
  const phoneNumber = normalizePhone(claims.phone_number);

  // Keycloak splits the name; signals stores one column. `name` is populated
  // when a full-name mapper is configured, so prefer it and fall back to the
  // parts. 'user' matches what unified_otp defaulted to on create.
  const joined = [claims.given_name, claims.family_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();
  const name = claims.name?.trim() || joined || 'user';

  return {
    sub: claims.sub,
    email,
    emailVerified: claims.email_verified === true,
    phoneNumber,
    // Keycloak stores this as a user attribute, so it can arrive as a string.
    phoneNumberVerified:
      claims.phone_number_verified === true || claims.phone_number_verified === 'true',
    name,
    orgId: orgIdFromGrant(claims),
  };
}

/**
 * Channel gate, relocated from `assertChannelAllowed`.
 *
 * Semantics differ slightly from the OTP version by necessity: there, the
 * caller named the channel it wanted to use, so a disabled channel could be
 * rejected outright. A token just carries whichever identifiers Keycloak knows
 * about, so the rule is "at least one identifier on an enabled channel" — a
 * user with both an email and a phone on an email-only instance is fine.
 *
 * This is what keeps open question 9(b) from biting silently: on an instance
 * with no SMS provider and LOGIN_CHANNELS=email, a phone-only user is refused
 * here with a clear code rather than half-provisioned.
 */
function channelAllowed(identity: TokenIdentity): boolean {
  const channels = authConfig.login_channels;
  if (identity.email && channels.includes('email')) return true;
  if (identity.phoneNumber && channels.includes('phone')) return true;
  return false;
}

/**
 * Resolve a Keycloak token's subject to a local `user` row, creating the mirror
 * on first login. Returns the row shaped for `request.user`.
 *
 * Callers pass a logger so the side-effecting steps (org join, guardian
 * materialization) can report failures without being able to fail the login.
 */
export async function provisionUserFromClaims(
  claims: KeycloakClaims,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  const identity = readIdentity(claims);

  if (!identity.email && !identity.phoneNumber) {
    return {
      ok: false,
      code: 'NO_IDENTIFIER',
      message: 'Token carries neither an email nor a phone number',
    };
  }

  if (!channelAllowed(identity)) {
    return {
      ok: false,
      code: 'LOGIN_CHANNEL_DISABLED',
      message:
        'None of this account’s login identifiers use a channel enabled on this instance.',
    };
  }

  let existing;
  try {
    [existing] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, identity.sub))
      .limit(1);
  } catch (err) {
    log.error({ err, sub: identity.sub }, 'provisioning: failed to read user mirror');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not resolve the local user record',
    };
  }

  if (existing) {
    if (existing.banned) {
      return {
        ok: false,
        code: 'USER_BANNED',
        message: existing.banReason?.trim() || 'This account has been suspended.',
      };
    }

    const refreshed = await refreshMirror(existing, identity, log);
    if (!refreshed.ok) return refreshed;

    // Membership can be granted after the account exists, so this is checked
    // on every login, not just the first.
    await ensureOrgMembership(refreshed.user.id, identity, log);
    return refreshed;
  }

  return createMirror(identity, log);
}

/**
 * Bring an existing mirror row in line with the token.
 *
 * Keycloak is authoritative for email / phone / verified flags / name (§6.1),
 * so a change there propagates down. Signals-local columns (`domains`,
 * `date_of_birth`, onboarding attribution, `tags`) are never touched here —
 * that is the whole point of the ownership split.
 *
 * `role` is deliberately NOT synced from realm roles yet: today's `user.role`
 * still comes from the better-auth admin plugin, and overwriting it from a
 * token before the realm roles are actually assigned would silently demote
 * every existing admin.
 */
async function refreshMirror(
  existing: typeof userTable.$inferSelect,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  const updates: Partial<typeof userTable.$inferInsert> = {};

  if (identity.email && identity.email !== existing.email) {
    updates.email = identity.email;
  }
  if (identity.emailVerified && !existing.emailVerified) {
    updates.emailVerified = true;
  }
  if (identity.phoneNumber && identity.phoneNumber !== existing.phoneNumber) {
    updates.phoneNumber = identity.phoneNumber;
  }
  if (identity.phoneNumberVerified && !existing.phoneNumberVerified) {
    updates.phoneNumberVerified = true;
  }
  // Only fill a placeholder name — a name edited locally shouldn't be stomped
  // by Keycloak's 'user' default on every request.
  if (identity.name !== 'user' && (!existing.name || existing.name === 'user')) {
    updates.name = identity.name;
  }

  const user: ProvisionedUser = {
    id: existing.id,
    email: updates.email ?? existing.email ?? '',
    name: updates.name ?? existing.name,
    role: existing.role,
  };

  if (Object.keys(updates).length === 0) {
    return { ok: true, user, created: false };
  }

  try {
    updates.updatedAt = new Date();
    await db.update(userTable).set(updates).where(eq(userTable.id, existing.id));
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      // Keycloak moved this subject onto an email/phone another local user
      // already holds. Refusing is the only safe move — merging two users
      // would repoint domain data, which this design exists to avoid (§2.3).
      log.error(
        { err, sub: identity.sub },
        'provisioning: token identifiers collide with another local user',
      );
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This account’s email or phone number is already registered to a different user.',
      };
    }
    log.error({ err, sub: identity.sub }, 'provisioning: failed to refresh user mirror');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not update the local user record',
    };
  }

  return { ok: true, user, created: false };
}

/**
 * First login for this subject: create the local mirror.
 *
 * Two gates run before anything is written — the self-signup gate (R2) and a
 * check that no *other* local row already owns these identifiers.
 */
async function createMirror(
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<ProvisioningResult> {
  // R2. A gated instance creates participants through the admin path, which
  // writes the local row itself; reaching here with no row means this subject
  // was not onboarded by signals.
  if (!authConfig.allow_self_signup) {
    log.warn(
      { sub: identity.sub },
      'provisioning: refused to create a user mirror — self-signup is gated',
    );
    return {
      ok: false,
      code: 'SELF_SIGNUP_DISABLED',
      message:
        'Self sign-up is disabled on this instance. Please contact your administrator to get onboarded.',
    };
  }

  // A local row holding these identifiers under a *different* id means the
  // Keycloak subject and the signals user have diverged — the §6.3 spike-2
  // collision case. Never create a second row; never rewrite the first one's
  // id (domain data points at it).
  const identifierFilters = [
    identity.email ? eq(userTable.email, identity.email) : undefined,
    identity.phoneNumber ? eq(userTable.phoneNumber, identity.phoneNumber) : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  try {
    const [clash] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(identifierFilters.length === 1 ? identifierFilters[0] : or(...identifierFilters))
      .limit(1);

    if (clash) {
      log.error(
        { sub: identity.sub, existing_user_id: clash.id },
        'provisioning: token subject does not match the local user holding its identifiers',
      );
      return {
        ok: false,
        code: 'IDENTITY_CONFLICT',
        message:
          'This email or phone number is already registered under a different account.',
      };
    }
  } catch (err) {
    log.error({ err, sub: identity.sub }, 'provisioning: identifier pre-check failed');
    return {
      ok: false,
      code: 'PROVISIONING_FAILED',
      message: 'Could not verify the local user record',
    };
  }

  // The insert itself lives in `user_writer.ts`, shared with admin onboarding so
  // the two cannot drift. The linchpin — this row's primary key IS the Keycloak
  // subject — is enforced there (it rejects anything that is not a bare UUID).
  const written = await insertLocalUser(
    {
      id: identity.sub,
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      phoneNumber: identity.phoneNumber,
      phoneNumberVerified: identity.phoneNumberVerified,
      extra: {
        // Parity with unified_otp's create: reaching a completed login means the
        // consent screens were passed. Age stays null here — it is captured
        // post-login, or written by guardian materialization below.
        termsAccepted: true,
        privacyAccepted: true,
      },
    },
    log
  );

  if (!written.ok) {
    return {
      ok: false,
      code: written.code === 'IDENTITY_CONFLICT' ? 'IDENTITY_CONFLICT' : 'PROVISIONING_FAILED',
      message: written.message,
    };
  }

  if (!written.created) {
    // Two concurrent first logins; the other one won. Still ensure the org join,
    // because that is checked on every login rather than only on create.
    const row = written.existing;
    await ensureOrgMembership(row.id, identity, log);
    return {
      ok: true,
      user: { id: row.id, email: row.email ?? '', name: row.name, role: row.role },
      created: false,
    };
  }

  const user: ProvisionedUser = {
    id: identity.sub,
    email: identity.email ?? '',
    name: identity.name,
    role: 'user',
  };

  // Apply anything the self-signup form parked for this identifier (§ the
  // Keycloak signup path creates the identity before the local row exists, so
  // `domains` and DOB have nowhere to go until now — see signup_extras.ts).
  //
  // Runs BEFORE guardian materialization on purpose: for a gated minor the
  // guardian capture is the OTP-verified record and must win on DOB.
  //
  // Captures the domain this account signed up into so the welcome mail can
  // link to that portal (#569); previously this value was applied and dropped.
  const signupDomain = await applySignupExtras(user.id, identity, log);

  await ensureOrgMembership(user.id, identity, log);

  // Guardian materialization, relocated from the better-auth `afterUserCreate`
  // hook (create_auth.ts:38-44). Same contract as there: genuinely-new users
  // only, and a failure is logged but never blocks the login — a half-captured
  // guardian record must not lock a ward out of their own account.
  try {
    await materializeSignupGuardian({
      id: user.id,
      email: identity.email,
      phoneNumber: identity.phoneNumber,
    });
  } catch (err) {
    log.error({ err, user_id: user.id }, 'materializeSignupGuardian failed');
  }

  // The other half of that same hook. Without this a Keycloak-provisioned user
  // silently received no welcome message, where every better-auth signup did.
  // It swallows each channel's failure internally; the try/catch is defence in
  // depth, matching the guardian call above — a welcome message must never be
  // the reason a login fails.
  try {
    await sendWelcomeNotifications(
      {
        name: user.name,
        email: identity.email,
        phoneNumber: identity.phoneNumber,
      },
      log,
      signupDomain
    );
  } catch (err) {
    log.error({ err, user_id: user.id }, 'sendWelcomeNotifications failed');
  }

  return { ok: true, user, created: true };
}

/**
 * Write the `member` row for a token that names an organization, relocated
 * from `verifyOtp`'s `joinOrg` branch.
 *
 * Best-effort by design, exactly as it was there: an org that doesn't exist or
 * a failed insert is logged and skipped, never surfaced as a login failure.
 * Where `unified_otp` took an org *slug* from the request body, the token
 * carries an org *id* claim — there is no request body at token-validation
 * time.
 */
async function ensureOrgMembership(
  userId: string,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<void> {
  if (!identity.orgId) return;

  try {
    const [org] = await db
      .select({ id: organizationTable.id })
      .from(organizationTable)
      .where(eq(organizationTable.id, identity.orgId))
      .limit(1);

    if (!org) {
      log.warn(
        { user_id: userId, org_id: identity.orgId },
        'provisioning: token names an organization that does not exist locally',
      );
      return;
    }

    // Scoped to (org, user) exactly as unified_otp did — a user may belong to
    // more than one org, so checking by user alone would skip the second join.
    const [already] = await db
      .select({ id: memberTable.id })
      .from(memberTable)
      .where(and(eq(memberTable.organizationId, org.id), eq(memberTable.userId, userId)))
      .limit(1);

    if (already) return;

    await db.insert(memberTable).values({
      id: randomUUID(),
      organizationId: org.id,
      userId,
      role: 'member',
      teamId: null,
      createdAt: new Date(),
    });
  } catch (err) {
    log.error(
      { err, user_id: userId, org_id: identity.orgId },
      'provisioning: failed to create org membership',
    );
  }
}

/**
 * Move the parked signup fields onto the freshly-created mirror row.
 *
 * Best-effort: these are recoverable through the normal UI (`setUserDomains`,
 * the DOB step), so a Redis outage must not fail a login that has already
 * succeeded. A user with no stash — migrated, or admin-onboarded — is the
 * common case and costs one Redis read.
 *
 * Returns the applied domain (or `null` when there is none / nothing was
 * applied / the lookup failed) so the caller can hand it to the welcome mail,
 * which needs to know which portal to link (#569).
 */
async function applySignupExtras(
  userId: string,
  identity: TokenIdentity,
  log: FastifyBaseLogger
): Promise<string | null> {
  try {
    const extras = await takeSignupExtras({
      email: identity.email,
      phoneNumber: identity.phoneNumber,
    });
    if (!extras) return null;

    const updates: Partial<typeof userTable.$inferInsert> = {};
    if (extras.domain) updates.domains = [extras.domain];
    if (typeof extras.age === 'number') updates.age = extras.age;
    if (Object.keys(updates).length === 0) return null;

    updates.updatedAt = new Date();
    await db.update(userTable).set(updates).where(eq(userTable.id, userId));

    // SS-3 (#640): the domain the user picked at signup has just landed on
    // their row, so this is the first moment a per-(network, domain) default
    // aggregator can own them. No-op when they already have an owner or no
    // default is nominated. Inside the same best-effort try/catch as the rest
    // of this function — a login that already succeeded must not fail here.
    if (extras.domain) {
      await tagUserForDomain(db, userId, extras.domain);
    }
    log.info(
      { user_id: userId, domain: extras.domain ?? null, age: extras.age ?? null },
      'provisioning: applied parked signup details',
    );
    return extras.domain ?? null;
  } catch (err) {
    log.error({ err, user_id: userId }, 'provisioning: could not apply parked signup details');
    return null;
  }
}
