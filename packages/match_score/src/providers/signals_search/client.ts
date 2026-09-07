import type {
  MatchScoreClient,
  MatchScoreItem,
  MatchScoreRequest,
  MatchScoreResult,
  SignalsSearchClientConfig,
} from '../../match_score.types';

const DEFAULT_RELEVANCE_PATH = 'v1/relevance';

// signals-search's /v1/relevance identifies each item by its composite primary
// key only (with the item_ prefix dropped), and looks the stored embeddings up
// itself — item_state / coordinates from the snapshot are not sent (the score
// comes from the indexed vectors).
function toRef(item: MatchScoreItem) {
  return {
    network: item.item_network,
    domain: item.item_domain,
    type: item.item_type,
    id: item.item_id,
  };
}

export class SignalsSearchClient implements MatchScoreClient {
  constructor(private readonly config: SignalsSearchClientConfig) {}

  async calculate(input: MatchScoreRequest): Promise<MatchScoreResult> {
    const path = this.config.path ?? DEFAULT_RELEVANCE_PATH;
    const url = new URL(path, this.config.baseUrl);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        source: toRef(input.itemA),
        target: toRef(input.itemB),
      }),
    });

    const rawText = await response.text();
    const rawResponse = tryParseJson(rawText);

    if (!response.ok) {
      // /v1/relevance returns two EXPECTED, non-exceptional states that must NOT
      // read as an upstream outage: 404 (one/both items not live+indexed yet —
      // signals-search indexes asynchronously, so this is common right after an
      // item is created) and 409 (items embedded with different model versions →
      // not comparable). Surface these as a scoreless result so this
      // display-only endpoint shows "score unavailable" rather than a 502. Any
      // other status (400/401/403/5xx) or a network error is a genuine failure
      // and still throws → the handler maps it to 502.
      if (response.status === 404 || response.status === 409) {
        return {
          provider: 'signals_search',
          score: undefined,
          unavailable_reason: response.status === 404 ? 'not_indexed' : 'not_comparable',
          raw_response: rawResponse,
        };
      }
      throw new Error(
        `Match score service error ${response.status}: ${rawText || response.statusText}`
      );
    }

    const percentage = extractNumeric(rawResponse, ['score']);

    return {
      provider: 'signals_search',
      // #646 §5.2: one scale end to end. signals-search already emits 0-100,
      // so this passes it through — the divide-by-10 here and the multiply-by-10
      // in the /discover seed together meant three scales for one quantity.
      score: percentage,
      raw_response: rawResponse,
    };
  }
}

function tryParseJson(input: string): unknown {
  if (!input) {
    return null;
  }

  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function extractNumeric(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
