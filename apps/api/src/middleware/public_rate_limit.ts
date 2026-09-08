import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Per-IP fixed-window limiter for routes that are unauthenticated by design.
 *
 * These routes are reachable by anyone, so the only cost of abuse is ours. Kong
 * carries a per-route limit in cluster deployments, but not every instance is
 * fronted by Kong — a bare docker-compose or single-node deployment has no edge
 * limiter at all. This is the portable control that travels with the app; where
 * Kong is present the two stack, and Kong's is the spoof-proof one (it sees the
 * real socket IP, this sees `trustProxy`'s reading of X-Forwarded-For).
 *
 * Fail-open on purpose: these sit on pre-login and federation paths, so a Redis
 * outage must degrade to "unlimited" rather than "everyone is locked out".
 * Returns a reply, never throws (repo convention).
 *
 * @param name - Bucket name; also the log tag. Keep it route-shaped.
 * @param maxPerWindow - Requests allowed per IP per window.
 * @param windowSec - Window length in seconds.
 */
export function public_rate_limit(
  name: string,
  maxPerWindow: number,
  windowSec = 60
) {
  return async function public_rate_limit_preHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    try {
      // Imported lazily, not at module scope. `utils/rate_window` pulls in
      // `db/secondary/redis`, which constructs an ioredis client (and starts
      // connecting) as an import side effect. A static import would therefore
      // put a live Redis connection in the module graph of every route that
      // uses this guard, so each of their tests would have to mock the Redis
      // config just to import the route. The module cache makes this a
      // one-time cost on the first request.
      const { incrWithinWindow } = await import('@/utils/rate_window');
      const count = await incrWithinWindow(
        `public:rl:${name}:${request.ip}`,
        windowSec
      );
      if (count > maxPerWindow) {
        return reply.code(429).send({
          error: 'RATE_LIMITED',
          message: 'Too many requests; please try again later.',
        });
      }
    } catch (err) {
      request.log.warn(
        { err, limiter: name },
        'public rate-limit check unavailable; allowing request'
      );
    }
  };
}
