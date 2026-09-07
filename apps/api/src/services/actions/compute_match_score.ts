import { getMatchScoreClient } from '@/utils/match_score_client';
import type { MatchScoreItem } from '@dpg/match_score';
import type { FastifyBaseLogger } from 'fastify';

export interface ItemSnapshotLike {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_instance_url: string;
  item_schema_url: string;
  item_state: Record<string, unknown>;
  item_locations?: Array<{ lat: number; lng: number }> | null;
}

function toMatchScoreItem(s: ItemSnapshotLike): MatchScoreItem {
  const primary = s.item_locations?.[0] ?? null;
  return {
    item_network: s.item_network,
    item_domain: s.item_domain,
    item_type: s.item_type,
    item_id: s.item_id,
    item_instance_url: s.item_instance_url,
    item_schema_url: s.item_schema_url,
    item_state: s.item_state ?? {},
    item_latitude: primary ? primary.lat : null,
    item_longitude: primary ? primary.lng : null,
  };
}

/**
 * Computes the item-to-item relevance score for an action at create time.
 * Returns the numeric score, or null when a snapshot is missing (e.g.
 * cross-instance source) or the relevance service errors — never throws.
 */
export async function computeActionMatchScore(
  source: ItemSnapshotLike | null,
  target: ItemSnapshotLike | null,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number | null> {
  if (!source || !target) return null;
  try {
    const client = getMatchScoreClient();
    if (!client) return null;
    const result = await client.calculate({
      itemA: toMatchScoreItem(source),
      itemB: toMatchScoreItem(target),
    });
    // #646 §5.2 converts the DISPLAY path to a single 0-100 scale, so the
    // provider now returns 0-100. `item_actions.match_score` is a different
    // artifact: a persisted REAL column, documented 0-10, already holding
    // rows on that scale and sortable in SQL (fetch_actions.ts orders by it).
    //
    // Converting here keeps that column's meaning stable and needs no
    // backfill. Writing 0-100 into it instead would leave the table holding
    // BOTH scales with nothing in a row to say which — every pre-existing My
    // Actions score would then render 10x too small. One conversion at a
    // storage boundary is the cheaper correct answer than a migration.
    return typeof result.score === 'number' ? result.score / 10 : null;
  } catch (err) {
    log.warn({ err }, 'action match-score compute failed — storing null');
    return null;
  }
}
