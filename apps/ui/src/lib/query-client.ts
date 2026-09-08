import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client factory for the app. Both entry points
 * (`main.tsx`, `tourist/main.tourist.tsx`) use this so their defaults can't
 * drift. `refetchOnWindowFocus` is off (freshness comes from per-query
 * staleTime tiers and, for actions, refetchInterval — never from focus). No
 * global `staleTime` is set: React Query defaults to 0, and per-query tiers
 * (Plan 2b-ii) set it where caching is wanted.
 *
 * Caching rule (spec §5) — pick the tier when adding a query:
 *  - Config-like, rarely-changing (network config/list, consent config,
 *    profile-consent status, resolved schemas): staleTime 5 min; invalidate on
 *    the event that changes it.
 *  - Feeds of others' data (browse `/network/item/fetch`): staleTime ~90s; the
 *    server cache (~5 min) absorbs the rest; pass `cache_ttl_seconds`.
 *  - The user's own data (my items): staleTime 60s + invalidate-on-write.
 *  - Polled / near-real-time (actions): `refetchInterval` + invalidate-on-write.
 *  - Expensive external lookups keyed by immutable input (geocode): dedicated
 *    cache (Redis server-side; in-memory session client-side), not React Query.
 * Never rely on `refetchOnWindowFocus` for freshness. One QueryClient config,
 * one key factory (`lib/query-keys.ts`).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // Never retry an auth failure. A 401/403 cannot succeed on a second
        // attempt without new credentials, so `retry: 2` turned every one into
        // THREE requests — measured on an expired session, four polling queries
        // produced bursts of nine 401s per cycle, two thirds of them pure
        // waste. Everything else keeps the two retries.
        //
        // Axios reports the status on `error.response.status`; checking only
        // `error.status` would never match and would silently keep retrying,
        // which is the shape of bug this is meant to remove.
        retry: (failureCount, error) => {
          const status =
            (error as { response?: { status?: number }; status?: number })?.response?.status ??
            (error as { status?: number })?.status;
          if (status === 401 || status === 403) return false;
          return failureCount < 2;
        },
      },
    },
  });
}
