import { describe, it, expect } from 'vitest';
import { ItemSnapshotSchema } from '../api/item_schemas';
import { MatchScoreRequestSchema, MatchScoreResponseSchema } from '../api/match_score_schemas';

const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

/**
 * Minimal item snapshot shaped like what the UI's itemToSnapshot() sends —
 * scalar item_latitude / item_longitude, NO item_locations array.
 */
const uiShapedSnapshot = {
  item_id: UUID_A,
  item_network: 'yellow_dot',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_instance_url: 'https://instance.example.com',
  item_schema_url: 'https://schema.example.com/profile_1.0.json',
  item_state: { name: 'Alice', grade: 'Class XI' },
  item_latitude: 12.9716,
  item_longitude: 77.5946,
};

const uiShapedSnapshotNullCoords = {
  ...uiShapedSnapshot,
  item_id: UUID_B,
  item_latitude: null,
  item_longitude: null,
};

describe('ItemSnapshotSchema', () => {
  it('accepts a UI-shaped snapshot with scalar coords and no item_locations', () => {
    const result = ItemSnapshotSchema.safeParse(uiShapedSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_latitude).toBe(12.9716);
      expect(result.data.item_longitude).toBe(77.5946);
    }
  });

  it('accepts null scalar coords (item with no location)', () => {
    const result = ItemSnapshotSchema.safeParse(uiShapedSnapshotNullCoords);
    expect(result.success).toBe(true);
  });

  it('accepts a snapshot with no coord fields at all (both optional)', () => {
    const { item_latitude, item_longitude, ...withoutCoords } = uiShapedSnapshot;
    void item_latitude;
    void item_longitude;
    const result = ItemSnapshotSchema.safeParse(withoutCoords);
    expect(result.success).toBe(true);
  });

  it('does NOT require item_locations', () => {
    // The old shape had item_locations: z.array(...) required via ItemResponseSchema.
    // After the fix it must be absent from ItemSnapshotSchema.
    const result = ItemSnapshotSchema.safeParse(uiShapedSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      // item_locations should not be a key in the parsed output
      expect(Object.prototype.hasOwnProperty.call(result.data, 'item_locations')).toBe(false);
    }
  });

  it('rejects item_latitude out of range', () => {
    const bad = { ...uiShapedSnapshot, item_latitude: 91 };
    expect(ItemSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects item_longitude out of range', () => {
    const bad = { ...uiShapedSnapshot, item_longitude: -181 };
    expect(ItemSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe('MatchScoreRequestSchema', () => {
  it('accepts a UI-shaped payload with scalar coords on both items', () => {
    const result = MatchScoreRequestSchema.safeParse({
      itemA: uiShapedSnapshot,
      itemB: uiShapedSnapshotNullCoords,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a payload with no coord fields (both optional on snapshot)', () => {
    const { item_latitude: _latA, item_longitude: _lngA, ...snapA } = uiShapedSnapshot;
    const { item_latitude: _latB, item_longitude: _lngB, ...snapB } = uiShapedSnapshotNullCoords;
    void _latA; void _lngA; void _latB; void _lngB;
    const result = MatchScoreRequestSchema.safeParse({ itemA: snapA, itemB: snapB });
    expect(result.success).toBe(true);
  });

  it('rejects a payload that is missing required item fields', () => {
    const incomplete = { item_id: UUID_A };
    const result = MatchScoreRequestSchema.safeParse({ itemA: incomplete, itemB: incomplete });
    expect(result.success).toBe(false);
  });
});

describe('MatchScoreResponseSchema — what survives serialization', () => {
  it('keeps unavailable_reason, which the UI depends on to explain a missing score', () => {
    // This schema is the RESPONSE serializer (calculate_match_score.ts:30), and
    // Zod strips unnamed keys — so a field the provider sets and the UI
    // declares still never arrives unless it is listed here.
    const parsed = MatchScoreResponseSchema.parse({
      provider: 'signals_search',
      unavailable_reason: 'not_indexed',
      raw_response: {},
    });
    expect(parsed.unavailable_reason).toBe('not_indexed');
  });

  it('rejects an unavailable_reason outside the two the provider can emit', () => {
    expect(() =>
      MatchScoreResponseSchema.parse({
        provider: 'signals_search',
        unavailable_reason: 'because_reasons',
        raw_response: {},
      }),
    ).toThrow();
  });

  it('still allows a normal scored response with no reason', () => {
    const parsed = MatchScoreResponseSchema.parse({
      provider: 'signals_search',
      score: 62,
      raw_response: {},
    });
    expect(parsed.score).toBe(62);
    expect(parsed.unavailable_reason).toBeUndefined();
  });
});
