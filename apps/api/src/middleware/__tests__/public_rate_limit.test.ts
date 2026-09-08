import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

// The limiter's only collaborator is the fixed-window counter. Each test drives
// the returned count (or makes it throw) to pick a branch.
const { rlState } = vi.hoisted(() => ({
  rlState: { count: 1, throw: false, keys: [] as string[], windows: [] as number[] },
}));
vi.mock('@/utils/rate_window', () => ({
  incrWithinWindow: vi.fn(async (key: string, windowSec: number) => {
    rlState.keys.push(key);
    rlState.windows.push(windowSec);
    if (rlState.throw) throw new Error('redis down');
    return rlState.count;
  }),
}));

import { public_rate_limit } from '../public_rate_limit.js';

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
  return reply as unknown as FastifyReply & {
    statusCode: number;
    body: unknown;
    code: ReturnType<typeof vi.fn>;
  };
};

const makeRequest = (ip = '203.0.113.7') =>
  ({ ip, log: { warn: vi.fn() } }) as unknown as FastifyRequest & {
    log: { warn: ReturnType<typeof vi.fn> };
  };

beforeEach(() => {
  rlState.count = 1;
  rlState.throw = false;
  rlState.keys.length = 0;
  rlState.windows.length = 0;
  vi.clearAllMocks();
});

describe('public_rate_limit', () => {
  it('allows a request under the cap and does not touch the reply', async () => {
    const reply = makeReply();

    await public_rate_limit('demo', 100)(makeRequest(), reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('429s once the count exceeds the cap', async () => {
    rlState.count = 101;
    const reply = makeReply();

    await public_rate_limit('demo', 100)(makeRequest(), reply);

    expect(reply.statusCode).toBe(429);
    expect((reply.body as { error: string }).error).toBe('RATE_LIMITED');
  });

  it('allows the request exactly at the cap — the cap is inclusive', async () => {
    rlState.count = 100;
    const reply = makeReply();

    await public_rate_limit('demo', 100)(makeRequest(), reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('buckets per name and per IP so two routes cannot drain each other', async () => {
    await public_rate_limit('route_a', 100)(makeRequest('198.51.100.1'), makeReply());
    await public_rate_limit('route_b', 100)(makeRequest('198.51.100.2'), makeReply());

    expect(rlState.keys).toEqual([
      'public:rl:route_a:198.51.100.1',
      'public:rl:route_b:198.51.100.2',
    ]);
  });

  it('defaults to a 60s window and honours an explicit one', async () => {
    await public_rate_limit('demo', 100)(makeRequest(), makeReply());
    await public_rate_limit('demo', 100, 15)(makeRequest(), makeReply());

    expect(rlState.windows).toEqual([60, 15]);
  });

  it('fails OPEN when the counter backend is unavailable', async () => {
    // These routes sit on pre-login and federation paths: a Redis outage must
    // degrade to "unlimited", never to "everyone is locked out".
    rlState.throw = true;
    const request = makeRequest();
    const reply = makeReply();

    await public_rate_limit('demo', 100)(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(request.log.warn).toHaveBeenCalledTimes(1);
  });
});
