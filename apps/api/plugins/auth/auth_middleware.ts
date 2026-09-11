import { authInstance } from '../../src/routes/auth/create_auth';
import { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import { db } from '../../db/postgres/drizzle_config';
import { user as userTable } from '../../db/postgres/schema/auth';
import { eq } from 'drizzle-orm';
import { resolveKeycloakSession, sendAuthFailure } from './resolve_session';
import { resolveBrowserSession } from './resolve_browser_session';

/**
 * Populates `request.user` from whichever credential the caller presented.
 *
 * There are four ways in, tried in this order:
 *
 *   1. `x-api-key` — integrating DPGs, today's service auth.
 *   2. the `sid` cookie — a human who logged in through the BFF. This is the
 *      only channel a browser has; the tokens behind it live in Redis.
 *   3. `Authorization: Bearer <keycloak jwt>` — an integrating DPG's
 *      client-credentials token (the replacement for #1), and ONLY that. A
 *      human token here is refused (AUTH-VULN-03/04); see `resolve_session.ts`.
 *   4. better-auth session — the UI under `AUTH_PROVIDER=betterauth`.
 *
 * #2–#4 are gated by `AUTH_PROVIDER`; under the default `betterauth` this
 * behaves exactly as it did before the Keycloak work started.
 *
 * **Both service credentials are accepted at once, on purpose.** That is the
 * compatibility window (§5): aggregator-dpg and voice-dpg live in other repos
 * and cannot cut over in the same deploy as this one. `x-api-key` is removed
 * only at Build 5 / R8, once both confirm zero traffic on the old path.
 */
export async function auth_middleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  /**
   * API KEY AUTH (highest priority)
   *
   * Still first, and still no fallback on failure: a caller that sends an
   * invalid `x-api-key` gets 403 rather than a second chance via bearer. That
   * precedence is unchanged from before the dual-accept window so a partner
   * mid-migration sees identical behaviour on the old path.
   */
  const apiKey = request.headers['x-api-key'];

  if (typeof apiKey === 'string') {
    const verified = await authInstance.api.verifyApiKey({
      body: {
        key: apiKey,
        permissions: request.permissions || undefined,
      },
    });

    if (verified.error || !verified.valid) {
      return reply.status(403).send({
        code: 'INVALID_API_KEY',
        error: 'Forbidden',
        message: 'Invalid API key provided',
      });
    }

    const key = verified.key as
      | { userId?: string | null; referenceId?: string | null }
      | null;
    const keyUserId = key?.userId ?? key?.referenceId;

    if (keyUserId) {
      const [owner] = await db
        .select({
          id: userTable.id,
          email: userTable.email,
          name: userTable.name,
          role: userTable.role,
        })
        .from(userTable)
        .where(eq(userTable.id, keyUserId))
        .limit(1);

      request.user = owner
        ? {
            id: owner.id,
            email: owner.email ?? '',
            name: owner.name,
            role: owner.role,
          }
        : ({ id: keyUserId } as typeof request.user);
    }

    return;
  }

  /**
   * BROWSER SESSION (cookie) — tried before the bearer path.
   *
   * A `sid` cookie means a human logged in through the BFF, so the token lives
   * in Redis rather than in the page. `fallthrough` means no cookie was sent,
   * which is not an error: service callers and anonymous requests take the
   * paths below.
   */
  const browser = await resolveBrowserSession(request, reply);
  if (browser.ok) return;
  if ('failure' in browser) return sendAuthFailure(reply, browser.failure);

  /**
   * SERVICE BEARER, then better-auth.
   *
   * A `fallthrough` from the Keycloak path means AUTH_PROVIDER=betterauth, so
   * better-auth handles the request exactly as it did before the Keycloak work
   * started — which is why merging that work changed nothing in production.
   */
  const keycloak = await resolveKeycloakSession(request);
  if (keycloak.ok) return;
  if ('failure' in keycloak) return sendAuthFailure(reply, keycloak.failure);

  const session = await authInstance.api.getSession({
    headers: new Headers(request.headers as Record<string, string>),
  });

  if (!session?.user) {
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
      message: 'Missing or invalid authentication',
    });
  }

  request.user = session.user;
}

export async function auth_middleware_if_enabled(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!authConfig.middleware_enabled) {
    return;
  }

  return auth_middleware(request, reply);
}
