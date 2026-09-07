/**
 * cluster-breakdown.ts
 *
 * Shared helper for tallying per-domain counts inside a cluster.
 * Kept pure so both map providers (Google Maps + Leaflet) can import it
 * without pulling in any provider-specific dependencies.
 */

export interface DomainCount {
  domain: string;
  count: number;
}

/** One clustered pin: which domain it belongs to, and which listing it is. */
export interface ClusterEntry {
  domain: string;
  /**
   * The LISTING's id, not the pin's. A marker id is `<item_id>#<locationIndex>`
   * because one listing with several locations draws several pins — so the two
   * differ exactly when a listing occupies more than one place.
   */
  itemId: string;
}

/**
 * Per-domain counts for a cluster, counting DISTINCT LISTINGS.
 *
 * Deliberately not pins. A service provider that serves two areas draws two
 * pins, so a network of 110 such listings drew 220 — and the cluster bubble
 * said 220 while the pill directly beneath it said 110 listings, with both
 * reading as "listings" to anyone looking at them. Counting listings makes
 * every number on the browse surface mean the same thing.
 *
 * The same listing only lands in one cluster twice when its own locations are
 * close enough to cluster together, and in that case counting it once is the
 * more useful answer anyway.
 *
 * Returns a de-duped, count-tallied array sorted by count descending (stable:
 * equal counts preserve insertion order).
 */
export function tallyDomains(entries: ClusterEntry[]): DomainCount[] {
  const seen = new Map<string, Set<string>>();
  for (const { domain, itemId } of entries) {
    let ids = seen.get(domain);
    if (!ids) {
      ids = new Set<string>();
      seen.set(domain, ids);
    }
    ids.add(itemId);
  }
  return Array.from(seen.entries())
    .map(([domain, ids]) => ({ domain, count: ids.size }))
    .sort((a, b) => b.count - a.count);
}

/** Distinct listings across every domain in a cluster. */
export function countDistinctListings(entries: ClusterEntry[]): number {
  return new Set(entries.map((e) => e.itemId)).size;
}

/** `<item_id>#<locationIndex>` → `<item_id>`. */
export function listingIdOfMarker(markerId: string): string {
  const hash = markerId.indexOf('#');
  return hash === -1 ? markerId : markerId.slice(0, hash);
}
