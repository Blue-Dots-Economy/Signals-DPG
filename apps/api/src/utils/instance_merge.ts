// Pure cross-instance merge core for scatter-gather top-K (#203 §4.4).
// Each domain instance returns its own top rows; this merges the union on
// the requesting (Node) instance and slices the requested page. No DB, no
// Fastify, no side effects.

import { nearestLocationMeters, type LatLng } from './geo_distance.js';

export interface MergeableRow {
  item_locations: Array<{ lat: number; lng: number }>;
  created_at?: Date | string;
}

export interface MergeSortAndSliceOptions {
  /** Reference point for geo ordering, or `null` for recency-only ordering. */
  center: LatLng | null;
  offset: number;
  limit: number;
}

/** Epoch ms for a row's created_at, or -Infinity when missing (sorts oldest). */
function createdAtMillis(createdAt: Date | string | undefined): number {
  if (createdAt === undefined) return -Infinity;
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Merge the union of per-instance rows into a single ordered page.
 *
 * - `opts.center` set AND the order is distance: ascending nearest-distance
 *   (no-location rows last via `Infinity`), tie-broken by `created_at`
 *   descending (newer first).
 * - otherwise: `created_at` descending only.
 *
 * `opts.orderBy` exists because a centre is present for a RADIUS FILTER too,
 * not just for a distance sort. Keying the merge off `center` alone meant a
 * federated `sort: 'newest'` request that also carried a radius came back
 * distance-ordered — the same infer-from-coordinates bug `order_by` was added
 * to kill on the SQL side (#644 P3), reappearing in the merge. Omitted means
 * "infer from `center`", which is what every pre-sort caller expects.
 *
 * Ties that are fully equal on the sort key(s) preserve original relative
 * order (stable), by decorating each row with its original index and using
 * that index as the final tie-break — this keeps ordering well-defined even
 * on engines that don't guarantee a stable Array.sort.
 *
 * Does not mutate `rows`. Returns `rows.slice(offset, offset + limit)` after
 * sorting.
 */
export function mergeSortAndSlice<T extends MergeableRow>(
  rows: T[],
  opts: {
    center: LatLng | null;
    offset: number;
    limit: number;
    orderBy?: 'distance' | 'created_at';
  }
): T[] {
  const { center, offset, limit } = opts;
  const byDistance = center !== null && opts.orderBy !== 'created_at';

  const decorated = rows.map((row, index) => ({ row, index }));

  decorated.sort((x, y) => {
    if (byDistance && center) {
      const dx = nearestLocationMeters(center, x.row.item_locations);
      const dy = nearestLocationMeters(center, y.row.item_locations);
      if (dx !== dy) return dx - dy;
    }

    const tx = createdAtMillis(x.row.created_at);
    const ty = createdAtMillis(y.row.created_at);
    if (tx !== ty) return ty - tx; // descending: newer first

    return x.index - y.index; // stable tie-break
  });

  return decorated.slice(offset, offset + limit).map((d) => d.row);
}
