import type { FastifyReply, FastifyRequest } from 'fastify';
import { peerConfig } from '@/config';
import {
  INSTANCE_TOKEN_HEADER,
  INSTANCE_TIMESTAMP_HEADER,
  verifyInstanceToken,
} from '@/utils/instance_token';

/**
 * preHandler for the peer-only *_local routes. Verifies the HMAC instance
 * token (bound to path + body) so only legitimate network peers can reach the
 * raw local item data. Returns a reply, never throws (repo convention).
 *
 * PEER_AUTH_MODE=permissive (default): a *missing* token is allowed (for peers
 * not yet upgraded) but a present-but-invalid one is rejected. 'enforced'
 * requires a valid token on every peer call.
 */
export async function peer_instance_guard(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return verifyPeerRequest(request, reply, { allowUnsigned: peerConfig.auth_mode === 'permissive' });
}

/**
 * Peer guard that NEVER accepts an unsigned request, whatever `PEER_AUTH_MODE`
 * says.
 *
 * `permissive` exists so peers predating inter-instance auth keep working during
 * rollout on the READ routes. `/network/action/perform` has no such peer: it has
 * never had a legitimate unsigned caller inside this repo, and its body asserts
 * identity (`source_item_owner`, `performed_by_*`) rather than merely selecting
 * rows. Inheriting the rollout affordance there would hand an attacker the
 * allowance that exists for a legacy peer — which is the finding this guard was
 * added to close, left open by configuration.
 */
export async function peer_instance_guard_strict(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return verifyPeerRequest(request, reply, { allowUnsigned: false });
}

async function verifyPeerRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { allowUnsigned: boolean }
) {
  const token = request.headers[INSTANCE_TOKEN_HEADER];
  const timestamp = request.headers[INSTANCE_TIMESTAMP_HEADER];
  const targetPath = request.url.split('?')[0];
  // Verify against the RAW request bytes (captured by the JSON content-type
  // parser in app.ts), never a re-serialization of `request.body`. The parsed
  // body has been through Zod by the time a preHandler runs, so undeclared keys
  // are gone and defaults have been added — either changes the hash and rejects
  // a legitimate peer. Falls back to re-serializing only when no raw body was
  // captured (a non-JSON content type), which the peer routes never use.
  const body =
    (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});

  const result = verifyInstanceToken({
    targetPath,
    body,
    token: typeof token === 'string' ? token : undefined,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
  });

  if (result.ok) {
    return;
  }

  // Permissive rollout: allow a *missing* token (peer not yet upgraded), but
  // still reject anything that tried to authenticate and failed — including a
  // half-formed attempt (`incomplete`), which is why that is a distinct reason
  // from `missing`.
  if (opts.allowUnsigned && result.reason === 'missing') {
    request.log.warn(
      { path: targetPath },
      'Peer request without instance token allowed (PEER_AUTH_MODE=permissive)'
    );
    return;
  }

  request.log.warn(
    { path: targetPath, reason: result.reason },
    'Rejected peer request: invalid instance token'
  );
  return reply.code(401).send({
    code: 'PEER_AUTH_FAILED',
    error: 'Unauthorized',
    message: 'Invalid or missing instance token',
  });
}
