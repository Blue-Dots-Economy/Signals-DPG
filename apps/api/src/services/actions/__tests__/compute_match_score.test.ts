import { describe, it, expect, vi } from 'vitest';
import { computeActionMatchScore } from '../compute_match_score';

let mockClient: unknown;
vi.mock('@/utils/match_score_client', () => ({
  getMatchScoreClient: () => mockClient,
}));

const log = { warn: vi.fn(), error: vi.fn() } as any;

const baseSnapshot = {
  item_network: 'test_network',
  item_domain: 'test_domain',
  item_type: 'test_type_1.0',
  item_id: '550e8400-e29b-41d4-a716-446655440000',
  item_instance_url: 'https://instance.example.com',
  item_schema_url: 'https://schema.example.com/test_type_1.0.json',
};

describe('computeActionMatchScore', () => {
  // #646 §5.2: the provider now returns 0-100 (one display scale end to end),
  // while `item_actions.match_score` stays on its documented 0-10 so the
  // column keeps one meaning and needs no backfill. This asserts the
  // conversion happens at that storage boundary.
  it('converts the provider 0-100 score to the column 0-10 scale', async () => {
    mockClient = { calculate: vi.fn(async () => ({ provider: 'test', score: 74 })) };
    const s = await computeActionMatchScore(
      { ...baseSnapshot, item_state: { a: 1 }, item_locations: [{ lat: 12.9, lng: 77.6 }] },
      { ...baseSnapshot, item_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', item_state: { b: 2 }, item_locations: [] },
      log,
    );
    expect(s).toBe(7.4);
  });

  it('returns null when either snapshot is missing', async () => {
    mockClient = { calculate: vi.fn(async () => ({ provider: 'test', score: 7.4 })) };
    expect(await computeActionMatchScore(null as any, { ...baseSnapshot, item_state: {} }, log)).toBeNull();
  });

  it('returns null when the client is undefined', async () => {
    mockClient = undefined;
    const s = await computeActionMatchScore(
      { ...baseSnapshot, item_state: {} },
      { ...baseSnapshot, item_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', item_state: {} },
      log,
    );
    expect(s).toBeNull();
  });

  it('returns null and logs a warning when the client throws', async () => {
    mockClient = {
      calculate: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const s = await computeActionMatchScore(
      { ...baseSnapshot, item_state: {} },
      { ...baseSnapshot, item_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', item_state: {} },
      log,
    );
    expect(s).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns null when the client result has a non-numeric score', async () => {
    mockClient = { calculate: vi.fn(async () => ({ provider: 'test' })) };
    const s = await computeActionMatchScore(
      { ...baseSnapshot, item_state: {} },
      { ...baseSnapshot, item_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', item_state: {} },
      log,
    );
    expect(s).toBeNull();
  });
});
