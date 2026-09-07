import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Item } from '@/lib/item-api';
import {
  calculateMatchScore,
  itemToSnapshot,
  type MatchScoreResult,
} from '@/lib/match-score-api';
import {
  getCachedMatchScore,
  setCachedMatchScore,
  clearMatchScoreCache,
} from '@/utils/match-score-cache';

interface UseMatchScoreOptions {
  localItem: Item | null;
  networkItem: Item;
  skipCache?: boolean;
}

interface UseMatchScoreReturn {
  score: MatchScoreResult | null;
  isLoading: boolean;
  error: Error | null;
  cached: boolean;
  calculate: () => Promise<void>;
  recalculate: () => Promise<void>;
  clearCache: () => void;
}

// #394: `/discover` already returns a per-item relevance score (the SAME
// cosine-similarity quantity `/v1/relevance` computes) on
// `networkItem.score` (see `item-api.ts`), already rescaled to 0-100 by
// `fetchDiscover`. Seed the badge with it so the card shows a % upfront
// instead of requiring a click. It has no `confidence`/`signals`/`reasoning`
// (those only come from `/v1/relevance`); `source: 'discover'` marks it as
// such so badge/modal know to hide the confidence line. Absent on native
// (non-discover) items, in which case this returns null and the current
// click-to-fetch flow (`calculate` → `/v1/relevance`) is unchanged.
function seedFromDiscoverScore(networkItem: Item): MatchScoreResult | null {
  if (networkItem.score == null) return null;
  return {
    provider: 'discover',
    // Already 0-100: `fetchDiscover` rescales the raw cosine at the wire
    // boundary (`toPercentScale`), so this seeds the badge unchanged.
    score: networkItem.score,
    source: 'discover',
  };
}

export function useMatchScore({
  localItem,
  networkItem,
  skipCache = false,
}: UseMatchScoreOptions): UseMatchScoreReturn {
  const [score, setScore] = useState<MatchScoreResult | null>(() =>
    seedFromDiscoverScore(networkItem)
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [cached, setCached] = useState(false);

  const cacheKey = useMemo(
    () => ({
      localItemId: localItem?.item_id ?? '',
      networkItemId: networkItem.item_id,
    }),
    [localItem?.item_id, networkItem.item_id]
  );

  // The score is specific to the (local profile, destination) pair. When the
  // pair changes — most commonly because the user switches their active profile
  // — a previously displayed score was computed against the OLD local profile
  // and is no longer valid, so clear it. The card falls back to the discover
  // seed (if `networkItem.score` is present) or "See Match Score", and the
  // user re-triggers a calculation for the new pair (which still hits the
  // per-pair localStorage cache on repeat). Without this, the stale score
  // badge lingers after a profile switch.
  useEffect(() => {
    setScore(seedFromDiscoverScore(networkItem));
    setError(null);
    setCached(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey.localItemId, cacheKey.networkItemId, networkItem.score]);

  const calculate = useCallback(async () => {
    if (!localItem) {
      setError(new Error('No local item selected'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Check cache first (unless skipCache is true)
      if (!skipCache) {
        const cachedResult = getCachedMatchScore(
          cacheKey.localItemId,
          cacheKey.networkItemId
        );
        if (cachedResult) {
          setScore(cachedResult.score);
          setCached(true);
          setIsLoading(false);
          return;
        }
      }

      // Fetch from API
      const payload = {
        itemA: itemToSnapshot(localItem),
        itemB: itemToSnapshot(networkItem),
      };

      const result = await calculateMatchScore(payload);
      
      // Cache the result
      setCachedMatchScore(cacheKey.localItemId, cacheKey.networkItemId, result);
      
      setScore(result);
      setCached(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to calculate match score';
      setError(new Error(errorMessage));
      setScore(null);
    } finally {
      setIsLoading(false);
    }
  }, [localItem, networkItem, cacheKey, skipCache]);

  const recalculate = useCallback(async () => {
    // Clear cache for this specific pair
    clearMatchScoreCache(cacheKey.localItemId, cacheKey.networkItemId);
    setCached(false);
    // Calculate fresh
    await calculate();
  }, [cacheKey.localItemId, cacheKey.networkItemId, calculate]);

  const clearCache = useCallback(() => {
    clearMatchScoreCache(cacheKey.localItemId, cacheKey.networkItemId);
    setScore(null);
    setCached(false);
  }, [cacheKey.localItemId, cacheKey.networkItemId]);

  return {
    score,
    isLoading,
    error,
    cached,
    calculate,
    recalculate,
    clearCache,
  };
}
