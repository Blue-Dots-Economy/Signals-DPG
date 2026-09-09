import z from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomBytes } from 'node:crypto';
import { authConfig, getCurrentApiBaseUrl, instance } from '@/config';
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  idTokenNonce,
  newPkcePair,
  newStateValue,
  OidcExchangeError,
} from '@/services/auth/oidc_exchange';
import {
  consumeFlowState,
  safeAppOrigin,
  safeReturnTo,
  saveFlowState,
} from '@/services/auth/oidc_flow_state';
import {
  createSession,
  destroySession,
  newCsrfToken,
  newSessionId,
  readSession,
  SESSION_TTL_SECONDS,
} from '@/services/auth/browser_session';
import {
  clearSessionCookie,
  SESSION_COOKIE,
} from '@api/plugins/auth/resolve_browser_session';
import { public_rate_limit } from '@/middleware/public_rate_limit';

/**
 * Browser login, run server-side (AUTH-VULN-03/04).
 *
 * The SPA used to perform the OIDC code exchange itself and keep the resulting
 * access AND refresh tokens in `localStorage`, where any script on the origin
 * could read them — demonstrated end to end by a pentest, which replayed the
 * refresh token to mint fresh access tokens and called this API with no cookie.
 *
 * These four routes move the whole flow behind the API. The browser only ever
 * holds an opaque `sid` cookie (httpOnly, so script cannot read it at all);
 * tokens live in Redis. This is the model `aggregator-dpg` already runs.
 *
 * The API and the UI are not assumed to be the same origin: locally they are
 * :2742 and :3000, and a deployment may split them across hosts. The browser
 * origin is therefore carried through the flow and validated against the CORS
 * allowlist (`safeAppOrigin`) before anything is redirected to it. Keycloak has
 * to know the API's callback URL as a valid redirect URI for `signals-ui` —
 * already true for `http://localhost:2742/*` in the bundled realm, and covered
 * by `__PUBLIC_BASE_URL__/*` wherever the two share an origin.
 */

const SessionResponse = z.object({
  authenticated: z.boolean(),
  /** Present only when authenticated; the UI sends it back as `x-csrf-token`. */
  csrfToken: z.string().optional(),
});

const LogoutResponse = z.object({
  /** Where the UI should send the browser to end the Keycloak session too. */
  endSessionUrl: z.string(),
});

/**
 * The origin the browser actually reached this API on.
 *
 * `API_DOMAIN` names ONE canonical host, but a single instance is served under
 * several participant hostnames (the per-domain portals), and the whole flow
 * has to stay on the one the browser started from. Sending the callback to the
 * canonical host instead sets the `sid` cookie on THAT origin, and a cookie set
 * on `dev-signals.example` is simply never sent to `portal.example` — the user
 * completes a perfectly good login and lands back unauthenticated.
 *
 * `trustProxy` is enabled (`app.ts`), so `protocol`/`host` reflect the
 * `X-Forwarded-*` headers the edge sets. Those are influenced by the client, so
 * the result is run through the same CORS allowlist `appOrigin` uses and falls
 * back to `API_DOMAIN` when it does not match — an unrecognised Host can
 * therefore never become a redirect target. Keycloak's own registered-redirect
 * check is the second gate.
 */
function requestOrigin(request: FastifyRequest): string {
  return safeAppOrigin(
    `${request.protocol}://${request.host}`,
    getCurrentApiBaseUrl()
  );
}

/** Every BFF route is Keycloak-only; nothing here is meaningful otherwise. */
function notEnabled(reply: FastifyReply) {
  return reply.code(404).send({
    error: 'NOT_ENABLED',
    message: 'Browser sessions require AUTH_PROVIDER=keycloak',
  });
}

function cookieOptions() {
  return {
    httpOnly: true,
    // `secure` is not hardcoded: local dev is plain http, and a Secure cookie
    // is silently dropped there, which presents as "login does nothing".
    secure: instance.INSTANCE_ENV !== 'development',
    // Lax, not Strict: the login flow RETURNS from Keycloak via a top-level
    // cross-site GET, and Strict would withhold the cookie on that navigation —
    // the user would land back on the app still logged out. Lax sends it on
    // top-level navigations while still withholding it from cross-site POSTs,
    // which is the case that matters. The CSRF token covers the rest.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export const auth_session: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Starts a login. Redirects to Keycloak; the PKCE verifier stays server-side.
   */
  fastify.route({
    url: '/session/login',
    method: 'GET',
    // Unauthenticated by nature, and each call writes a flow-state key with a
    // 5-minute TTL into the shared Redis that also holds sessions and schema
    // caches. Generous enough that a human retrying a login never notices.
    preHandler: public_rate_limit('auth_session_login', 60),
    schema: {
      tags: ['auth'],
      querystring: z.object({
        returnTo: z.string().optional(),
        consentAttempt: z.string().optional(),
        /** The UI's own `window.location.origin`; allowlisted, never trusted. */
        appOrigin: z.string().optional(),
      }),
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);

      const state = newStateValue();
      const nonce = randomBytes(16).toString('base64url');
      const { verifier, challenge } = newPkcePair();
      // Same host the browser is already talking to: it reached this route
      // there, so it serves the callback there too, and the cookie the callback
      // sets will be same-origin with the app.
      const self = requestOrigin(request);
      const redirectUri = `${self}/api/v1/auth/session/callback`;

      await saveFlowState(state, {
        verifier,
        nonce,
        returnTo: safeReturnTo(request.query.returnTo),
        consentAttempt: request.query.consentAttempt,
        redirectUri,
        appOrigin: safeAppOrigin(request.query.appOrigin, self),
      });

      return reply.redirect(
        buildAuthorizeUrl({ redirectUri, state, nonce, challenge })
      );
    },
  });

  /**
   * Keycloak sends the browser back here. Exchanges the code, opens a session,
   * and redirects to the app — the browser never sees a token.
   */
  fastify.route({
    url: '/session/callback',
    method: 'GET',
    schema: {
      tags: ['auth'],
      querystring: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);
      const { code, state, error } = request.query;
      /**
       * Where to send a failed login.
       *
       * Before the flow is loaded there is no validated app origin to use, so
       * these two fall back to the API's own — which is the right answer
       * wherever the UI and API share an origin, and a visible 404 rather than
       * a silent redirect to somewhere unvetted where they do not. Never
       * derived from the request: this is a redirect target on a URL an
       * attacker can craft.
       */
      // `/auth/login`, not `/`: a failed or cancelled sign-in belongs on the
      // sign-in screen, which surfaces `auth_error`. Landing on the logged-out
      // home page said nothing at all, so a user who cancelled at Keycloak — or
      // whose 5-minute flow expired — got no explanation.
      const authError = (origin: string) =>
        reply.redirect(`${origin}/auth/login?auth_error=1`);

      // Keycloak reports failures on the redirect rather than as a status, so
      // this is the normal "user cancelled" path, not an exception.
      if (error || !code || !state) {
        request.log.warn({ oidcError: error ?? 'missing code/state' }, 'OIDC callback rejected');
        return authError(requestOrigin(request));
      }

      const flow = await consumeFlowState(state);
      if (!flow) {
        // Unknown or already-used state: an expired flow, or a replayed
        // callback trying to mint a second session from one authorization.
        request.log.warn('OIDC callback with unknown or replayed state');
        return authError(requestOrigin(request));
      }

      let tokens;
      try {
        tokens = await exchangeCode({
          code,
          redirectUri: flow.redirectUri,
          verifier: flow.verifier,
        });
      } catch (err) {
        request.log.error(
          { err: err instanceof OidcExchangeError ? err.message : 'exchange failed' },
          'OIDC code exchange failed'
        );
        return authError(flow.appOrigin);
      }

      /**
       * The nonce binds this id token to the authorize request we made. PKCE
       * plus a single-use `state` already carry most of the weight, but the
       * nonce is minted and sent, so it is checked — a stored field that
       * nothing compares is worse than no field at all, because it reads as a
       * control that exists.
       */
      const returnedNonce = idTokenNonce(tokens.idToken);
      if (returnedNonce !== null && returnedNonce !== flow.nonce) {
        request.log.error('OIDC callback: id token nonce did not match the flow');
        return authError(flow.appOrigin);
      }

      const sessionId = newSessionId();
      await createSession(sessionId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExp: tokens.accessTokenExp,
        refreshTokenExp: tokens.refreshTokenExp,
        idToken: tokens.idToken,
        csrfToken: newCsrfToken(),
        appOrigin: flow.appOrigin,
        createdAt: Date.now(),
      });

      reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions());

      // Hand the flow's parameters back to the UI's callback page, which still
      // owns everything that happens AFTER a session exists — consent resume,
      // wrong-portal detection, first-login landing. Only the code exchange
      // moved to the server; that page's behaviour is unchanged.
      const landing = new URL('/auth/callback', flow.appOrigin);
      landing.searchParams.set('returnTo', flow.returnTo);
      if (flow.consentAttempt) {
        landing.searchParams.set('consentAttempt', flow.consentAttempt);
      }
      return reply.redirect(landing.toString());
    },
  });

  /**
   * "Am I logged in, and what CSRF token should I send?" — the UI's replacement
   * for reading a token out of storage.
   */
  fastify.route({
    url: '/session',
    method: 'GET',
    schema: {
      tags: ['auth'],
      response: { 200: SessionResponse },
    },
    handler: async (request, reply) => {
      const sessionId = request.cookies?.[SESSION_COOKIE];
      if (!sessionId) return reply.send({ authenticated: false });

      const session = await readSession(sessionId);
      if (!session) {
        clearSessionCookie(reply);
        return reply.send({ authenticated: false });
      }

      return reply.send({ authenticated: true, csrfToken: session.csrfToken });
    },
  });

  /**
   * Ends the local session and hands back the Keycloak end-session URL, so the
   * SSO session goes too rather than silently logging the user back in.
   */
  fastify.route({
    url: '/session/logout',
    method: 'POST',
    schema: {
      tags: ['auth'],
      response: { 200: LogoutResponse },
    },
    handler: async (request, reply) => {
      // Guarded like the other three: under `betterauth` `keycloakConfig` has
      // no base URL, so `buildEndSessionUrl` would construct a URL from an
      // empty string and throw — an unhandled 500 on a public route.
      if (!authConfig.keycloak_enabled) return notEnabled(reply);
      const sessionId = request.cookies?.[SESSION_COOKIE];
      // Read before destroying: the session records which app origin opened it,
      // and that is where Keycloak has to send the user afterwards.
      const session = sessionId ? await readSession(sessionId) : null;
      if (sessionId) await destroySession(sessionId);
      clearSessionCookie(reply);

      return reply.send({
        endSessionUrl: buildEndSessionUrl({
          // Names the session being ended, so Keycloak logs the user out
          // straight away instead of asking them to confirm.
          idToken: session?.idToken,
          // `/auth/login`, not `/`: it is the app's signed-out landing page and
          // one of the post-logout URLs the realm registers for `signals-ui`.
          // Keycloak matches these exactly and silently refuses anything else.
          postLogoutRedirectUri: `${session?.appOrigin ?? requestOrigin(request)}/auth/login`,
        }),
      });
    },
  });
};
