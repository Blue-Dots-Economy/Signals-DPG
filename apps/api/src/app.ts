import { createRequire } from 'node:module';
import fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createJsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import AuthRoutes from '@/routes/auth';
import {
  apiConfig,
  apiReferenceEnabled,
  authConfig,
  getCurrentApiBaseUrl,
  instance,
  uiHostBindings,
} from '@/config';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyQs from 'fastify-qs';
import fastifySwagger from '@fastify/swagger';
import {
  allowed_origins,
  getAllowedInstanceOriginsFromNetworkConfig,
  mergeAllowedOrigins,
  unknownBindingDomains,
} from '@dpg/config';
import v1_routes from '@/routes/v1/v1_routes';
import { requestIdOptions, registerRequestIdEcho } from '@/request_id';
import health_routes from '@/routes/health/health_route';
import { getNetworkConfigs } from '@/network_configs';
import {
  clearNetworkSchemaCache,
  refreshConsumedSchemas,
} from '@/network_schema_cache';
import { getEmailMessages } from '@/notifications/email/messages';
import { registerRawBodyCapture } from '@/plugins/raw_body';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

const baseJsonSchemaTransform = createJsonSchemaTransform({});

// Operations served WITHOUT user auth (no preHandler on the route and no
// group-level auth hook) — the spec-level default security is cleared for
// these. Derived from the actual route wiring; keep in sync when a route's
// preHandler changes (see apps/api/CLAUDE.md "Route auth wiring"). Failure
// direction is safe: a forgotten entry documents auth on a public route — it
// never hides auth on a protected one; runtime auth is untouched either way.
const PUBLIC_OPERATION_URLS = new Set([
  '/',
  '/health/live',
  '/health/ready',
  '/api/v1/auth/config',
  '/api/v1/auth/u18-precheck',
  '/api/v1/consent/status-by-identifier',
  '/api/v1/network/schemas',
  '/api/v1/network/item/fetch',
  // The BFF login flow. Unauthenticated by definition — they are how a browser
  // GETS a session — so the generated spec must not claim otherwise.
  '/api/v1/auth/session',
  '/api/v1/auth/session/login',
  '/api/v1/auth/session/callback',
  '/api/v1/auth/session/logout',
]);

// Operations guarded by peer_instance_guard (inter-instance HMAC) instead of
// user auth.
const PEER_OPERATION_URLS = new Set([
  '/api/v1/network/item/count_local',
  '/api/v1/network/item/fetch_local',
  '/api/v1/network/item/markers_local',
  // Moved off the public list (AUTH-VULN-05): it asserts identity in its body,
  // so it is peer-authenticated like the reads above.
  '/api/v1/network/action/perform',
]);

// Unauthenticated responses that still must not be cached (AUTH-VULN-02).
// `status-by-identifier` answers "is this identifier registered?", so a shared
// proxy holding that answer re-serves the enumeration oracle without the
// request ever reaching us; `auth/config` describes the instance's auth wiring.
// Both are public by design — it is the *caching* that is the finding, not the
// access. Every other public route keeps its own caching semantics.
import { setBrowserAllowedOrigins } from '@/services/auth/oidc_flow_state';

const NO_STORE_PUBLIC_URLS = new Set([
  '/api/v1/auth/config',
  '/api/v1/consent/status-by-identifier',
  // Carries `authenticated` and the per-session CSRF token, and resolves no
  // `request.user` (it reads the cookie itself), so the authenticated-response
  // branch of the no-store hook never fires for it. Without this a shared proxy
  // could hand one user's CSRF token to the next — the AUTH-VULN-07 class.
  '/api/v1/auth/session',
]);

/**
 * Wraps the zod json-schema transform to make the auth model machine-readable
 * in the generated OpenAPI document: applies the public/peer security
 * exceptions and documents the `x-acting-org-id` header on the route groups
 * whose acting-org preHandlers read it (required for admin/aggregator via
 * acting_org.ts, optional for action via acting_org_optional.ts).
 */
const documentAuthTransform: typeof baseJsonSchemaTransform = (data) => {
  const transformed = baseJsonSchemaTransform(data);
  const { url } = transformed;
  const schema = { ...(transformed.schema as Record<string, unknown> | undefined) };

  if (PUBLIC_OPERATION_URLS.has(url) || url.startsWith('/api/v1/network/schema/')) {
    schema.security = [];
  } else if (PEER_OPERATION_URLS.has(url)) {
    schema.security = [{ peerAuth: [] }];
  }

  const actingOrgRequired = url.startsWith('/api/v1/admin') || url.startsWith('/api/v1/aggregator');
  if (actingOrgRequired || url.startsWith('/api/v1/action')) {
    schema.headers = {
      type: 'object',
      properties: {
        'x-acting-org-id': {
          type: 'string',
          description: actingOrgRequired
            ? 'Organization this request acts on behalf of. Required for admin/aggregator operations.'
            : 'Organization this request acts on behalf of. Optional: a non-admin actor can perform an action without acting for an org.',
        },
      },
      ...(actingOrgRequired ? { required: ['x-acting-org-id'] } : {}),
    };
  }

  return { ...transformed, schema: schema as typeof transformed.schema };
};

/**
 * Builds the fully-wired Fastify app WITHOUT listening. Used by the server
 * entry (which listens), the OpenAPI dump script, and the openapi smoke test.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    trustProxy: true,
    // Correlation id: honour + length-cap an inbound `x-request-id`, mint one
    // when absent, log it as `reqId` (see @/request_id).
    ...requestIdOptions,
  });

  // Echo the resolved correlation id back on every response.
  registerRequestIdEcho(app);

  // UI_HOST_BINDINGS is parsed at module load, before a logger exists (#569),
  // so its warnings surface here. Malformed entries were already dropped; this
  // is the only signal an operator gets that a portal link is misconfigured.
  for (const warning of uiHostBindings.warnings) {
    app.log.warn(warning);
  }
  const unknown = unknownBindingDomains(
    uiHostBindings.byDomain,
    apiConfig.served_domains.map((b) => b.domain)
  );
  if (unknown.length > 0) {
    app.log.warn(
      { domains: unknown },
      'UI_HOST_BINDINGS names domains this instance does not serve — their emails will fall back to FRONTEND_BASE_URL'
    );
  }

  // The schema cache lives on disk under tmpdir() and outlives a restart. In
  // local mode the network is driven by NETWORK_CONFIG_LOCAL_FILE, so a stale
  // cache from a previous network keeps being served after a switch. Wipe and
  // rebuild on boot so local dev always reflects the configured network.
  // Remote mode keeps the cache (schemas there are expensive to refetch).
  // Rebuilding queries the `items` table (cacheReferencedItemSchemas), so it
  // needs a reachable Postgres; SCHEMA_CACHE_WARMUP_ENABLED=false (used by
  // the OpenAPI dump script) skips it — safe because route registration
  // below is fully static and never reads the schema cache itself.
  if (
    apiConfig.network_config_source === 'local' &&
    apiConfig.schema_cache_warmup_enabled
  ) {
    await clearNetworkSchemaCache();
    await refreshConsumedSchemas();
  }

  // Boot-time email-copy load (#529): the bundled defaults file is required,
  // so a build defect there throws here — crash-loud at startup rather than
  // surfacing lazily on the first attempted send. An ops override
  // (EMAIL_MESSAGES_PATH) is also read here so per-key fallback warnings land
  // in deploy logs immediately. Unlike the schema-cache warmup above this has
  // no DB/Redis dependency (fs only), so it runs unconditionally — including
  // in NETWORK_CONFIG_SOURCE=remote mode and in the OpenAPI dump, where
  // SCHEMA_CACHE_WARMUP_ENABLED=false only gates the DB-backed warmup.
  await getEmailMessages();

  const networkConfigs = await getNetworkConfigs();

  const networkAllowedOrigins = networkConfigs.flatMap((networkConfig) =>
    getAllowedInstanceOriginsFromNetworkConfig(
      networkConfig,
      apiConfig.served_domains
    )
  );

  const corsAllowedOrigins = mergeAllowedOrigins(
    allowed_origins,
    networkAllowedOrigins
  );

  // The BFF login validates `appOrigin` and the request Host against the same
  // list, so anywhere the browser may CALL from is somewhere it may be SENT to,
  // and the two cannot drift apart.
  setBrowserAllowedOrigins(corsAllowedOrigins);

  // Add schema validator and serializer
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Capture raw JSON bytes for peer_instance_guard (see plugins/raw_body.ts).
  registerRawBodyCapture(app);

  // No-store on authenticated responses (AUTH-VULN-07). Any response produced
  // for a request that resolved a user carries PII/session state, so it must not
  // be cached by browsers or shared proxies. Public/unauthenticated responses
  // (request.user unset) are left untouched so genuinely cacheable routes keep
  // their own caching semantics — except the two listed in
  // NO_STORE_PUBLIC_URLS below. A route that already set Cache-Control wins.
  app.addHook('onSend', async (request, reply, payload) => {
    const needsNoStore =
      request.user || NO_STORE_PUBLIC_URLS.has(request.url.split('?')[0]);
    if (needsNoStore && !reply.getHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  /**
   * Cookie parsing, for the BFF browser session (AUTH-VULN-03/04).
   *
   * Registered at the ROOT scope and before any route, because it decorates
   * `request.cookies` / `reply.setCookie`: registered later, or inside an
   * encapsulated scope, the session routes and the cookie auth channel silently
   * see no cookies at all rather than failing loudly.
   *
   * No `secret` is configured on purpose — the `sid` value is an opaque random
   * id with no meaning outside Redis, so signing it would add a key to manage
   * and prove nothing the session lookup does not already prove.
   */
  await app.register(cookie);

  // CORS
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || corsAllowedOrigins.includes(origin)) {
        return cb(null, true);
      } else {
        return cb(new Error('Not allowed'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  });

  // Query string parser - supports bracket notation (e.g. itemState[userId]=value)
  await app.register(fastifyQs, {});

  // Documentation. Gated: the always-available reference is the
  // bluedots-docs site, so this is a secure-by-default local/dev convenience
  // (see apiReferenceEnabled in @/config).
  if (apiReferenceEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Signals DPG API',
          description:
            'Network-aware Signals DPG API — items, actions, events, consent, network fetch, admin.\n\n' +
            'Unless marked otherwise, operations require authentication via either the `apiKeyAuth` ' +
            'or `sessionAuth` scheme (the spec default). Public operations carry no Authorizations ' +
            'section; the four inter-instance peer operations (the three `*_local` reads and `action/perform`) use the service-to-service ' +
            '`peerAuth` scheme instead. Admin and aggregator operations additionally require the ' +
            '`x-acting-org-id` header (optional on action operations). See ' +
            '`docs/operations/integrating-dpgs.md` for the full auth model.',
          version: pkg.version,
        },
        // Default for every operation; exceptions are applied per-route in
        // documentAuthTransform below.
        security: [{ apiKeyAuth: [] }, { sessionAuth: [] }],
        // Tag descriptions make starlight-openapi emit one overview page per
        // group in the published reference (tags without a description get
        // sidebar-group-only treatment).
        tags: [
          { name: 'health', description: 'Liveness and readiness probes for orchestrators (unauthenticated).' },
          { name: 'item', description: 'Create, fetch, update and delete items, and manage their lifecycle status.' },
          { name: 'action', description: 'Perform and track actions between items — single, bulk, and status updates.' },
          { name: 'event', description: 'Structured results of actions: store and fetch events.' },
          { name: 'match_score', description: 'Compatibility scoring between items.' },
          { name: 'network', description: 'Network-level schema discovery and cross-instance item reads.' },
          { name: 'admin', description: 'Administrative operations (aggregator upsert, participants). Requires the x-acting-org-id header.' },
          { name: 'aggregator', description: 'Aggregator-facing dashboard and export.' },
          { name: 'consent', description: 'Consent status and acceptance, including the under-18 guardian flows.' },
          { name: 'auth', description: 'Auth configuration and signup pre-checks.' },
          { name: 'user', description: 'Per-user domain preferences.' },
          { name: 'support', description: 'Contact-support form submission.' },
        ],
        // Deployments are per network instance, so the published spec carries a
        // substitute-your-host URL (from the dump env's API_DOMAIN) plus a
        // local-dev entry; at runtime servers[0] is this instance's own URL.
        servers: [
          {
            url: getCurrentApiBaseUrl(),
            description: "Your deployment's public host (set per network instance)",
          },
          ...(getCurrentApiBaseUrl() === 'http://localhost:2742'
            ? []
            : [{ url: 'http://localhost:2742', description: 'Local development' }]),
        ],
        components: {
          securitySchemes: {
            apiKeyAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'x-api-key',
              description:
                'Service API key used by integrating DPGs (aggregator-dpg, voice-dpg) and other ' +
                'machine clients (apps/api/plugins/auth/auth_middleware.ts). Takes priority over ' +
                'session auth: if present and invalid the request is rejected outright, with no ' +
                'fallback to a session. Routes under /api/v1/admin and /api/v1/aggregator ' +
                'additionally require an `x-acting-org-id` header identifying the organization the ' +
                'request acts on behalf of — see docs/operations/integrating-dpgs.md.',
            },
            sessionAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: 'better-auth.session_token',
              description:
                'Browser session cookie issued by better-auth after sign-in, used by the web UI ' +
                '(apps/api/plugins/auth/auth_middleware.ts). Checked as a fallback only when ' +
                'x-api-key is absent.',
            },
            peerAuth: {
              type: 'apiKey',
              in: 'header',
              name: 'x-instance-token',
              description:
                'Inter-instance HMAC token (paired with an `x-instance-timestamp` header), used ' +
                'only by peer Signals instances for the network `*_local` operations ' +
                '(src/middleware/peer_instance_guard.ts). Not for external callers.',
            },
          },
        },
      },
      transform: documentAuthTransform,
    });
    await app.register(import('@scalar/fastify-api-reference'), {
      routePrefix: '/api/reference',
    });
  }

  // Routes
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/',
    handler: (_, res) => {
      res.send({
        service: instance.INSTANCE_NAME,
        status: 'ok',
        served_domains: apiConfig.served_domains,
        network_config_source: apiConfig.network_config_source,
      });
    },
  });
  app.register(health_routes);

  /**
   * better-auth's own HTTP surface (`/api/auth/*`) — mounted only when
   * better-auth is the provider.
   *
   * Under `AUTH_PROVIDER=keycloak` this used to stay mounted, which meant
   * `unified_otp`'s `verifyOtp` was still reachable and **still created users**
   * (`packages/auth/plugins/unified_otp.ts`). Those users got a signals row with
   * no Keycloak identity, landing them in the `user_not_found` /
   * `already_registered` deadlock `services/auth/participant_identity.ts`
   * documents. Nothing legitimate calls this mount under Keycloak: the UI uses it
   * only for the OTP flow, sign-out and get-session (all replaced by the OIDC
   * screen), api keys are minted by `scripts/seed_service_users.ts` writing
   * directly, and `verifyApiKey` is an in-process call rather than a route — so
   * `x-api-key` auth is unaffected.
   *
   * Not mounting beats guarding inside the handler: an absent route cannot be
   * reached by a code path we failed to think of, whereas an in-handler check has
   * to be correct for every one of better-auth's endpoints.
   */
  if (authConfig.betterauth_enabled) {
    app.register(AuthRoutes);
  }

  app.register(v1_routes, { prefix: '/api/v1' });

  return app;
}
