import type { MatchScoreResult } from '@/lib/match-score-api';

/**
 * v2 (#646 §5.2): the wire scale became 0-100 end to end, matching what
 * /v1/relevance already emitted, and both conversion points were deleted.
 *
 * The bump is MANDATORY, not hygiene. A user who viewed a score in the 24
 * hours before the deploy has a 0-10 value cached; read by the new 0-100
 * formatter, a 62% match prints as "6%" — silently, with no error. Migrating
 * the values is impossible: nothing in the stored payload identifies which
 * scale a number is on, so the version prefix IS the marker.
 */
const CACHE_KEY_PREFIX = 'dpg:matchScore:v2';
const LEGACY_CACHE_KEY_PREFIXES = ['dpg:matchScore:v1'];
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface CachedMatchScore {
  score: MatchScoreResult;
  timestamp: number;
  localItemId: string;
  networkItemId: string;
}

export function generateCacheKey(localItemId: string, networkItemId: string): string {
  return `${CACHE_KEY_PREFIX}:${localItemId}:${networkItemId}`;
}

export function getCachedMatchScore(
  localItemId: string,
  networkItemId: string
): CachedMatchScore | null {
  try {
    const cacheKey = generateCacheKey(localItemId, networkItemId);
    const cached = localStorage.getItem(cacheKey);
    
    if (!cached) return null;
    
    const parsed: CachedMatchScore = JSON.parse(cached);
    const age = Date.now() - parsed.timestamp;
    
    // Check if cache is expired
    if (age > DEFAULT_CACHE_TTL_MS) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    
    return parsed;
  } catch {
    return null;
  }
}

export function setCachedMatchScore(
  localItemId: string,
  networkItemId: string,
  score: MatchScoreResult
): void {
  try {
    const cacheKey = generateCacheKey(localItemId, networkItemId);
    const cached: CachedMatchScore = {
      score,
      timestamp: Date.now(),
      localItemId,
      networkItemId,
    };
    localStorage.setItem(cacheKey, JSON.stringify(cached));
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

export function clearMatchScoreCache(
  localItemId?: string,
  networkItemId?: string
): void {
  try {
    if (localItemId && networkItemId) {
      // Clear specific entry
      const cacheKey = generateCacheKey(localItemId, networkItemId);
      localStorage.removeItem(cacheKey);
    } else if (localItemId) {
      // Clear all entries for a local item
      const prefix = `${CACHE_KEY_PREFIX}:${localItemId}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          localStorage.removeItem(key);
        }
      }
    } else {
      // Clear all match score cache
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_KEY_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    }
  } catch {
    // Silently fail
  }
}

/**
 * One-time cleanup of pre-v2 (0-10 scale) cached scores.
 *
 * Required because localStorage has no expiry of its own — the 24-hour TTL is
 * enforced in code, on read, and nothing will ever read a v1 key again.
 * `clearMatchScoreCache` only sweeps the CURRENT prefix, so without this the
 * old entries would sit in every user's browser forever; and
 * `setCachedMatchScore` already fails silently when storage is full, so
 * leaking quota is not free.
 *
 * Call once at app startup. Idempotent.
 */
export function sweepLegacyMatchScoreCache(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LEGACY_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage unavailable (private mode, quota) — nothing to clean up.
  }
}

/**
 * Scores are 0-100 on the wire and in the cache (#646 §5.2), so format
 * directly. The Excellent/Good/Moderate/Low bands that used to live here are
 * gone: their 0.85/0.70/0.50 thresholds implied a calibration BGE-M3
 * similarities do not have — profile-to-profile scores cluster in a narrow
 * range, so the band read as near-constant across a result set.
 */
export function formatScorePercentage(score: number): string {
  return `${Math.round(score)}%`;
}
