import { createApiClient } from './api-client';
import type { Item } from './item-api';

const apiClient = createApiClient();

export interface ItemSnapshot {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url: string | null;
  item_schema_url: string | null;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
}

export interface MatchScoreSignal {
  name: string;
  impact: string;
  summary: string;
}

/**
 * #646 §5.5: `band`, `confidence`, `reasoning`, `signals`, `prompt_version`,
 * `model_provider` and `model` are gone. They are dpg-scoring-era fields that
 * the `signals_search` provider never populates, so the detail modal offered
 * affordances that could never fill — a confidence line and a reasoning
 * paragraph that were always absent in practice.
 *
 * The one real signal they were carrying is preserved as
 * `unavailable_reason`: /v1/relevance answers 404 (one side not indexed yet —
 * common, since indexing is async) and 409 (embedded with different model
 * versions, so not comparable), and both are expected states rather than
 * outages. That used to be smuggled through `reasoning`.
 */
export interface MatchScoreResult {
  provider: string;
  /** 0-100 (#646 §5.2). */
  score?: number;
  version?: string;
  unavailable_reason?: 'not_indexed' | 'not_comparable';
  raw_response?: unknown;
  // #394: set only on the value `useMatchScore` seeds from the discover
  // response's `Item.score` (see `item-api.ts`), before any click hits
  // `/api/v1/match-score/calculate` — distinguishes an upfront seeded score
  // from a real `/v1/relevance` result, which never sets this field.
  source?: 'discover';
}

export interface CalculateMatchScorePayload {
  itemA: ItemSnapshot;
  itemB: ItemSnapshot;
}

export interface MatchScoreError {
  error: string;
  message: string;
}

export function itemToSnapshot(item: Item): ItemSnapshot {
  const primary = item.item_locations?.[0] ?? null;
  return {
    item_id: item.item_id,
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_instance_url: item.item_instance_url,
    item_schema_url: item.item_schema_url,
    item_state: item.item_state,
    item_latitude: primary ? primary.lat : null,
    item_longitude: primary ? primary.lng : null,
  };
}

export async function calculateMatchScore(
  payload: CalculateMatchScorePayload
): Promise<MatchScoreResult> {
  const response = await apiClient.post<MatchScoreResult>(
    '/api/v1/match-score/calculate',
    payload
  );
  return response.data;
}
