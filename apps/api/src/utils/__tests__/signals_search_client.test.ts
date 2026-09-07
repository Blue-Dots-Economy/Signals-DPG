import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalsSearchClient } from '../../../../../packages/match_score/src/providers/signals_search/client';
import type { MatchScoreRequest } from '../../../../../packages/match_score/src/match_score.types';

const item = (id: string) => ({
  item_network: 'blue_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
  item_id: id,
  item_instance_url: 'https://instance/item',
  item_schema_url: 'https://instance/schema',
  item_state: { headline: 'plumber' },
  item_latitude: 12.9,
  item_longitude: 77.6,
});
const req: MatchScoreRequest = { itemA: item('a'), itemB: item('b') };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SignalsSearchClient', () => {
  it('POSTs item PKs to /v1/relevance with x-api-key and passes the 0-100 score through', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ score: 87.34 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    const result = await client.calculate(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe('http://search:3100/v1/relevance');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['x-api-key']).toBe('sk_test');
    // Only the composite PK is sent (item_ prefix dropped) as source/target —
    // no item_state / coordinates.
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      source: { network: 'blue_dot', domain: 'provider', type: 'profile_1.0', id: 'a' },
      target: { network: 'blue_dot', domain: 'provider', type: 'profile_1.0', id: 'b' },
    });

    expect(result.provider).toBe('signals_search');
    // #646 §5.2: one scale end to end — the provider no longer divides by 10.
    expect(result.score).toBeCloseTo(87.34, 5);
    expect(result.raw_response).toEqual({ score: 87.34 });
  });

  it('returns a scoreless result (not a throw) on 404 not-indexed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"RELEVANCE_ITEMS_NOT_INDEXED"}', { status: 404 })));
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    const result = await client.calculate(req);
    expect(result.provider).toBe('signals_search');
    expect(result.score).toBeUndefined();
    expect(result.unavailable_reason).toBe('not_indexed');
  });

  it('returns a scoreless result (not a throw) on 409 not-comparable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"RELEVANCE_NOT_COMPARABLE"}', { status: 409 })));
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    const result = await client.calculate(req);
    expect(result.score).toBeUndefined();
    expect(result.unavailable_reason).toBe('not_comparable');
  });

  it('throws on a genuine (non-404/409) failure so the handler maps it to 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream boom', { status: 503 })));
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'sk_test' });
    await expect(client.calculate(req)).rejects.toThrow(/Match score service error 503/);
  });

  it('honors a custom path override', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ score: 50 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SignalsSearchClient({ baseUrl: 'http://search:3100', apiKey: 'k', path: 'v2/relevance' });
    await client.calculate(req);
    expect(capturedUrl).toBe('http://search:3100/v2/relevance');
  });
});
