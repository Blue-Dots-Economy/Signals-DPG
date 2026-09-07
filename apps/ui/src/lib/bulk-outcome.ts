import { bulkFailureIndices, firstBulkError, type BulkEnvelope } from './bulk';
import { guardianOtpErrorOf, type PerformActionPayload } from './action-api';

/**
 * What a completed bulk action means, as one value.
 *
 * Lives here rather than inside `HomePage`'s submit handler because the
 * decision is three-way and was expressed as nested `if`/`else` inside a `try`
 * inside a callback — the densest thing in that file, and enough on its own to
 * push it over the cognitive-complexity limit. Being pure, it is also worth
 * testing directly instead of only through a rendered page.
 *
 * Its own module rather than `bulk.ts`: it needs `guardianOtpErrorOf` from
 * `action-api`, and `action-api` already imports `bulk` — putting it there
 * would close an import cycle.
 */
export type BulkOutcome =
  | { kind: 'all'; succeeded: number }
  | { kind: 'guardian'; payloads: PerformActionPayload[]; otherFailedIds?: string[] }
  | {
      kind: 'partial';
      failedIds: string[];
      firstError?: string;
      succeeded: number;
      total: number;
    };

/**
 * `targets` and `payloads` must be index-aligned with the batch that produced
 * `env` — the envelope identifies each result only by its `index`.
 *
 * The `guardian` case takes priority over `partial` on purpose: ANY
 * `GUARDIAN_OTP_REQUIRED` failure means a code has already been sent to the
 * guardian, so a MIXED batch must still open the OTP dialog rather than fall
 * through to the generic error toast and waste it. The non-guardian failures
 * ride along in `otherFailedIds` and are reselected once that dialog resolves.
 */
export function resolveBulkOutcome<T>(
  env: BulkEnvelope<T>,
  targets: readonly { item_id: string }[],
  payloads: readonly PerformActionPayload[],
): BulkOutcome {
  if (env.summary.failed === 0) return { kind: 'all', succeeded: env.summary.succeeded };

  const failedResults = env.results.filter((r) => r.status === 'error');
  const guardianResults = failedResults.filter(
    (r) => guardianOtpErrorOf(r) === 'GUARDIAN_OTP_REQUIRED',
  );

  if (guardianResults.length > 0) {
    const otherFailedIds = failedResults
      .filter((r) => guardianOtpErrorOf(r) !== 'GUARDIAN_OTP_REQUIRED')
      .map((r) => targets[r.index].item_id);
    return {
      kind: 'guardian',
      payloads: guardianResults.map((r) => payloads[r.index]),
      otherFailedIds: otherFailedIds.length > 0 ? otherFailedIds : undefined,
    };
  }

  return {
    kind: 'partial',
    failedIds: bulkFailureIndices(env).map((i) => targets[i].item_id),
    firstError: firstBulkError(env) ?? undefined,
    succeeded: env.summary.succeeded,
    total: env.summary.total,
  };
}
