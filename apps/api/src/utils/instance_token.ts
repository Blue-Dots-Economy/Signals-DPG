import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { peerConfig } from '@/config';

export const INSTANCE_TOKEN_HEADER = 'x-instance-token';
export const INSTANCE_TIMESTAMP_HEADER = 'x-instance-timestamp';

export type VerifyFailureReason =
  /** Neither header sent — an unsigned caller. The only reason permissive forgives. */
  | 'missing'
  /** One header sent without the other — a failed attempt, never forgiven. */
  | 'incomplete'
  | 'malformed_timestamp'
  | 'expired'
  | 'bad_signature';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

// The token binds timestamp + path + a hash of the exact request body, so a
// captured token cannot be replayed against a different path OR a different
// body (REVIEW.md M2). Body is the exact wire string on both sides.
function computeToken(
  secret: string,
  timestamp: number,
  targetPath: string,
  body: string
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${targetPath}.${hashBody(body)}`)
    .digest('hex');
}

/** Sender side. Returns the HMAC token + unix-second timestamp to send. */
export function signInstanceToken(input: {
  targetPath: string;
  body: string;
  secret?: string;
  nowSeconds?: number;
}): { token: string; timestamp: number } {
  const secret = input.secret ?? peerConfig.shared_secret;
  const timestamp = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    token: computeToken(secret, timestamp, input.targetPath, input.body),
    timestamp,
  };
}

/** Convenience for outbound peer fetches: the two headers to spread in. */
export function buildPeerHeaders(
  targetPath: string,
  body: string
): Record<string, string> {
  const { token, timestamp } = signInstanceToken({ targetPath, body });
  return {
    [INSTANCE_TOKEN_HEADER]: token,
    [INSTANCE_TIMESTAMP_HEADER]: String(timestamp),
  };
}

/** Receiver side. Constant-time verify within `windowSeconds` (default 300). */
export function verifyInstanceToken(input: {
  targetPath: string;
  body: string;
  token: string | undefined;
  timestamp: string | number | undefined;
  secret?: string;
  nowSeconds?: number;
  windowSeconds?: number;
}): VerifyResult {
  const secret = input.secret ?? peerConfig.shared_secret;
  const windowSeconds = input.windowSeconds ?? peerConfig.token_window_seconds;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  // `missing` means NEITHER header was sent — an unsigned caller. It is the one
  // reason `PEER_AUTH_MODE=permissive` forgives, so it must not cover a request
  // that tried to authenticate and got it wrong: a token with no timestamp (or
  // the reverse) is a half-formed attempt, and treating it as "unsigned" let it
  // through under permissive while the guard's own comment promised that a
  // present-but-invalid token is always rejected.
  if (!input.token && input.timestamp === undefined) {
    return { ok: false, reason: 'missing' };
  }
  if (!input.token || input.timestamp === undefined) {
    return { ok: false, reason: 'incomplete' };
  }

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // Reject stale AND future-dated tokens (replay + clock-skew guard).
  if (Math.abs(now - ts) > windowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  const expected = computeToken(secret, ts, input.targetPath, input.body);
  const provided = input.token;

  // Length check first (length is not secret); timingSafeEqual throws on
  // mismatched lengths. Both are 64-char sha256 hex when well-formed.
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }

  const equal = timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
  return equal ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
