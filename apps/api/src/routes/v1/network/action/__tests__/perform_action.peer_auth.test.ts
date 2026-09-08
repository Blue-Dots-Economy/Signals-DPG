/**
 * AUTH-VULN-05 — the peer guard is wired onto POST /network/action/perform, and
 * the /action/perform proxy signs the call it makes to it.
 *
 * Both halves matter and they fail in opposite directions: without the guard the
 * route accepts forged `source_item_owner` from anyone who can reach the host;
 * without the sender signing, every legitimate action 401s. The other tests in
 * this directory stub the guard so they can exercise the handler, so this file is
 * the only place the wiring itself is asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, RouteOptions } from 'fastify';

const { peerConfig } = vi.hoisted(() => ({
  peerConfig: {
    shared_secret: 'p'.repeat(48),
    auth_mode: 'enforced' as 'permissive' | 'enforced',
    token_window_seconds: 300,
  },
}));
vi.mock('@/config', () => ({
  peerConfig,
  apiConfig: { allow_extra_schema_data: true },
  getCurrentApiBaseUrl: () => 'http://local.test',
  // Importing the route module pulls in drizzle_config, which builds a pg Pool
  // at import time; it never connects here because no test reaches the handler.
  databasesConfig: { pg_url: 'postgres://test/test', redis_url: 'redis://test' },
}));

import {
  peer_instance_guard,
  peer_instance_guard_strict,
} from '@/middleware/peer_instance_guard';
import {
  buildPeerHeaders,
  INSTANCE_TOKEN_HEADER,
  INSTANCE_TIMESTAMP_HEADER,
} from '@/utils/instance_token';
import { registerRawBodyCapture } from '@/plugins/raw_body';
import { perform_network_action } from '../perform_action';

/** Captures the route options the plugin registers, without booting Fastify. */
async function loadRoute(): Promise<RouteOptions> {
  let captured: RouteOptions | undefined;
  const fake = {
    route: (opts: RouteOptions) => {
      captured = opts;
    },
  } as unknown as FastifyInstance;
  await perform_network_action(fake, {});
  if (!captured) throw new Error('route was not registered');
  return captured;
}

const PATH = '/api/v1/network/action/perform';

const makeReply = () => {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    code: vi.fn(function (this: { statusCode: number }, c: number) {
      this.statusCode = c;
      return this;
    }),
    send: vi.fn(function (this: { body: unknown }, b: unknown) {
      this.body = b;
      return this;
    }),
  };
  return reply as unknown as Parameters<typeof peer_instance_guard>[1] & {
    statusCode: number;
    body: unknown;
  };
};

/** A request as Fastify presents it to a preHandler: raw bytes + parsed body. */
const makeRequest = (rawBody: string, headers: Record<string, string> = {}) =>
  ({
    url: PATH,
    headers,
    rawBody,
    body: JSON.parse(rawBody),
    log: { warn: vi.fn() },
  }) as unknown as Parameters<typeof peer_instance_guard>[0];

beforeEach(() => {
  peerConfig.auth_mode = 'enforced';
  vi.clearAllMocks();
});

describe('POST /network/action/perform — peer auth wiring', () => {
  it('registers the peer guard ahead of the rate limiter', async () => {
    const route = await loadRoute();
    const preHandlers = route.preHandler as unknown[];

    expect(Array.isArray(preHandlers)).toBe(true);
    // Order is load-bearing: an unsigned caller must be rejected before it can
    // consume anyone else's rate-limit budget.
    // Specifically the strict variant: the plain guard would honour
    // PEER_AUTH_MODE=permissive and leave the route open in every deployment
    // that has not flipped the flag.
    expect(preHandlers[0]).toBe(peer_instance_guard_strict);
    expect(preHandlers[0]).not.toBe(peer_instance_guard);
    expect(preHandlers).toHaveLength(2);
  });

  it('rejects a request carrying no instance token', async () => {
    const reply = makeReply();

    await peer_instance_guard(makeRequest('{"action_type":"apply"}'), reply);

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { code: string }).code).toBe('PEER_AUTH_FAILED');
  });

  it('accepts a request signed the way the proxy signs it', async () => {
    // Exactly what routes/v1/action/perform_action.ts does: hash the same bytes
    // it puts on the wire.
    const rawBody = JSON.stringify({
      action_type: 'apply',
      source_item_owner: 'user-1',
      performed_by_org_id: null,
    });
    const reply = makeReply();

    await peer_instance_guard(
      makeRequest(rawBody, buildPeerHeaders(PATH, rawBody)),
      reply
    );

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('rejects a body tampered with after signing — identity fields cannot be swapped in flight', async () => {
    const signed = JSON.stringify({ action_type: 'apply', source_item_owner: 'user-1' });
    const headers = buildPeerHeaders(PATH, signed);
    const tampered = JSON.stringify({ action_type: 'apply', source_item_owner: 'victim' });
    const reply = makeReply();

    await peer_instance_guard(makeRequest(tampered, headers), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('verifies the RAW bytes, so a field the route schema would strip does not break the signature', async () => {
    // The regression this guards: the guard used to re-serialize the POST-Zod
    // body, so any key the schema did not declare was dropped before re-hashing
    // and every legitimate peer call 401'd. Here `future_field` survives in
    // `rawBody` but is absent from the parsed body, exactly as Zod would leave it.
    const rawBody = JSON.stringify({ action_type: 'apply', future_field: 'x' });
    const headers = buildPeerHeaders(PATH, rawBody);
    const request = {
      url: PATH,
      headers,
      rawBody,
      body: { action_type: 'apply' }, // stripped by validation
      log: { warn: vi.fn() },
    } as unknown as Parameters<typeof peer_instance_guard>[0];
    const reply = makeReply();

    await peer_instance_guard(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  // The cases above hand the guard a `rawBody` directly. These two boot a real
  // Fastify instance with the SHIPPED parser so the capture itself is exercised —
  // if `registerRawBodyCapture` ever stops populating `rawBody`, the guard
  // silently falls back to re-serializing and the stripped-field bug returns.
  describe('end to end through a real Fastify instance', () => {
    const buildPeerApp = async () => {
      const app = Fastify();
      registerRawBodyCapture(app);
      app.route({
        url: PATH,
        method: 'POST',
        preHandler: peer_instance_guard,
        handler: async (_req, reply) => reply.code(201).send({ ok: true }),
      });
      await app.ready();
      return app;
    };

    it('accepts a genuinely signed request over the wire', async () => {
      const app = await buildPeerApp();
      const payload = JSON.stringify({ action_type: 'apply', source_item_owner: 'u1' });

      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'content-type': 'application/json', ...buildPeerHeaders(PATH, payload) },
        payload,
      });

      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it('rejects the same request unsigned', async () => {
      const app = await buildPeerApp();

      const res = await app.inject({
        method: 'POST',
        url: PATH,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ action_type: 'apply', source_item_owner: 'u1' }),
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  it('rejects an UNSIGNED request even under permissive — this route does not inherit the rollout affordance', async () => {
    // The whole point of the strict guard. If someone swaps
    // peer_instance_guard_strict back to peer_instance_guard, this fails.
    peerConfig.auth_mode = 'permissive';
    const reply = makeReply();

    await peer_instance_guard_strict(makeRequest('{"action_type":"apply"}'), reply);

    expect(reply.statusCode).toBe(401);
  });

  it('rejects a token sent WITHOUT its timestamp under permissive — a half-formed attempt is not "unsigned"', async () => {
    // `missing` (neither header) is forgiven under permissive; `incomplete` is
    // not. Collapsing the two would let a caller opt out by dropping a header.
    peerConfig.auth_mode = 'permissive';
    const reply = makeReply();

    await peer_instance_guard(
      makeRequest('{"action_type":"apply"}', { [INSTANCE_TOKEN_HEADER]: 'deadbeef' }),
      reply
    );

    expect(reply.statusCode).toBe(401);
  });

  it('still rejects a bad signature under permissive — permissive only forgives a MISSING token', async () => {
    peerConfig.auth_mode = 'permissive';
    const reply = makeReply();

    await peer_instance_guard(
      makeRequest('{"action_type":"apply"}', {
        [INSTANCE_TOKEN_HEADER]: 'deadbeef',
        [INSTANCE_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      }),
      reply
    );

    expect(reply.statusCode).toBe(401);
  });
});
