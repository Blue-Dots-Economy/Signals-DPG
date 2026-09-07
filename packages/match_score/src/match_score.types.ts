export interface MatchScoreItem {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_instance_url: string;
  item_schema_url: string;
  item_state: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
}

export interface MatchScoreRequest {
  itemA: MatchScoreItem;
  itemB: MatchScoreItem;
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
  /** 0-100 (#646 §5.2 — one scale end to end). */
  score?: number;
  version?: string;
  /** Why no score is available, for the two expected non-outage states. */
  unavailable_reason?: 'not_indexed' | 'not_comparable';
  raw_response: unknown;
}

export interface MatchScoreClient {
  calculate(input: MatchScoreRequest): Promise<MatchScoreResult>;
}

export type MatchScoreProvider = 'signals_search';

// signals-search's in-network relevance API (POST /v1/relevance). Authenticated
// with a single x-api-key (validated against Signals' own apikey store).
// `path` overrides the default 'v1/relevance'.
export interface SignalsSearchClientConfig {
  baseUrl: string;
  apiKey: string;
  path?: string;
}

export type MatchScoreClientConfig = {
  provider: 'signals_search';
} & SignalsSearchClientConfig;
