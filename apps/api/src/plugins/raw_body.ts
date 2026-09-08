import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Keeps the exact JSON bytes of a request alongside the parsed body.
 *
 * `peer_instance_guard` verifies an HMAC the sender computed over the wire body.
 * It used to re-derive that string with `JSON.stringify(request.body)` — the body
 * AFTER Zod validation, which strips undeclared keys and injects defaults. Any
 * such difference changes the hash and 401s a legitimate peer.
 *
 * That has bitten twice (`lifecycle_filter`, then `order_by`) and each time it
 * read as an unrelated feature bug, because the symptom is a signature mismatch
 * that names no field. Hashing the raw bytes removes the whole class: what the
 * sender signed is what the receiver checks, so adding a field to a peer request
 * can no longer silently break federation.
 *
 * Registered on the app rather than inlined so the peer-auth tests can exercise
 * the shipped parser instead of a copy of it.
 */
export function registerRawBodyCapture(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    // `parseAs: 'string'` means `raw` is always a string — no Buffer branch.
    (request, raw: string, done) => {
      (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
      // An empty body parses to `undefined` and is left to the route's schema to
      // reject, which every POST/PUT/PATCH in this API declares.
      if (raw.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        // Preserve Fastify's own 400 for malformed JSON.
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );
}
