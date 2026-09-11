/**
 * One-shot "the session is really gone" signal.
 *
 * ## Why an emitter rather than a direct call
 *
 * The two places that DETECT a dead session are plain modules with no React
 * context — `api-client.ts` (an axios instance) and `oidc-client.ts` (a
 * UserManager). The place that must REACT to it is `auth-context.tsx`, which
 * owns the `user` state and holds the QueryClient. `createQueryClient()` is
 * instantiated in `main.tsx`, not exported as a singleton, so the detectors
 * cannot reach it. This decouples the two sides without either importing the
 * other, and without turning the query client into a module global.
 *
 * ## Why the fire-once guard is load-bearing
 *
 * Four queries poll `/api/v1/action/fetch` (`use-actions.ts`), and until the
 * retry predicate landed, React Query's `retry: 2` turned each into three
 * requests. A measured expiry produced bursts of NINE simultaneous 401s. Every
 * one of them detects the same dead session, so without this guard a single
 * expiry fires nine logouts and nine navigations. The aggregator's client has
 * the same guard for the same reason (`apps/web/src/services/http.ts`'s
 * `redirecting` flag).
 *
 * Never reset within a page lifetime: the handler navigates away, so a second
 * emit could only ever be a duplicate of the one already in flight.
 */

type Handler = () => void;

const handlers = new Set<Handler>();
let fired = false;

/**
 * Subscribe to the session-expired signal.
 *
 * @returns an unsubscribe function, for effect cleanup.
 */
export function onSessionExpired(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Announce that the session is unrecoverable — the access token was rejected
 * and renewal cannot fix it (or renewal itself failed).
 *
 * Idempotent for the lifetime of the page. Safe to call from any number of
 * concurrent failed requests.
 */
export function emitSessionExpired(): void {
  if (fired) return;
  fired = true;
  for (const handler of handlers) handler();
}

/** Test-only: undo the fire-once latch between cases. */
export function resetSessionExpiredForTests(): void {
  fired = false;
  handlers.clear();
}
