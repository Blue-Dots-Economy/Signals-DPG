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

/**
 * Given an array of domain strings (one per clustered marker), returns a
 * de-duped, count-tallied array sorted by count descending (stable: equal
 * counts preserve insertion order).
 */
export function tallyDomains(domains: string[]): DomainCount[] {
  const counts = new Map<string, number>();
  for (const d of domains) {
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);
}
