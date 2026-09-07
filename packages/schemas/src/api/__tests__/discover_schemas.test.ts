import { describe, expect, it } from 'vitest';
import {
  DiscoverFacetFilterSchema,
  DiscoverFacetValueSchema,
  DiscoverItemsBodySchema,
  DiscoverResponseItemSchema,
  DiscoverResponseSchema,
  DiscoverSourceSchema,
} from '../discover_schemas';

const ITEM_ID = '2b1f9e7c-4a3d-4c9b-8f21-6d5e0a7c3b44';
const ANCHOR_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const base = { item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' };

describe('DiscoverFacetValueSchema', () => {
  it.each([
    ['string', 'welding'],
    ['number', 3],
    ['boolean', true],
  ])('accepts a %s facet value', (_label, value) => {
    expect(DiscoverFacetValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['null', null],
    ['object', { a: 1 }],
    ['array', ['a']],
  ])('rejects a %s facet value', (_label, value) => {
    expect(DiscoverFacetValueSchema.safeParse(value).success).toBe(false);
  });
});

describe('DiscoverFacetFilterSchema', () => {
  it('accepts a field with mixed scalar values', () => {
    const result = DiscoverFacetFilterSchema.safeParse({
      field: 'skills',
      values: ['welding', 2, false],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.values).toEqual(['welding', 2, false]);
    }
  });

  it('rejects an empty values array', () => {
    const result = DiscoverFacetFilterSchema.safeParse({ field: 'skills', values: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['values']);
    }
  });

  it('rejects an empty field name', () => {
    expect(DiscoverFacetFilterSchema.safeParse({ field: '', values: ['a'] }).success).toBe(false);
  });

  it('rejects a missing values array', () => {
    expect(DiscoverFacetFilterSchema.safeParse({ field: 'skills' }).success).toBe(false);
  });
});

describe('DiscoverItemsBodySchema — required keys and defaults', () => {
  it('applies limit/offset defaults', () => {
    const result = DiscoverItemsBodySchema.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it.each(['item_network', 'item_domain', 'item_type'])('rejects a missing %s', (field) => {
    const body: Record<string, unknown> = { ...base };
    delete body[field];

    expect(DiscoverItemsBodySchema.safeParse(body).success).toBe(false);
  });

  it.each(['item_network', 'item_domain', 'item_type'])('rejects an empty %s', (field) => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, [field]: '' }).success).toBe(false);
  });

  it('trims q before applying the min-length check', () => {
    const result = DiscoverItemsBodySchema.safeParse({ ...base, q: '  welder  ' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('welder');
    }
  });

  it('rejects a whitespace-only q (trim happens first)', () => {
    const result = DiscoverItemsBodySchema.safeParse({ ...base, q: '   ' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['q']);
    }
  });

  it('accepts limit 1 and 100 but rejects 0 and 101', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, limit: 1 }).success).toBe(true);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, limit: 100 }).success).toBe(true);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, limit: 101 }).success).toBe(false);
  });

  it('does NOT coerce a stringified limit (JSON body, not querystring)', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, limit: '20' }).success).toBe(false);
  });

  it('rejects a negative offset and a fractional offset', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, offset: -1 }).success).toBe(false);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, offset: 1.5 }).success).toBe(false);
  });

  it('accepts a uuid anchor_item_id and rejects a non-uuid one', () => {
    const result = DiscoverItemsBodySchema.safeParse({ ...base, anchor_item_id: ANCHOR_ID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anchor_item_id).toBe(ANCHOR_ID);
    }

    expect(DiscoverItemsBodySchema.safeParse({ ...base, anchor_item_id: 'itm_1' }).success).toBe(
      false,
    );
  });

  it('leaves anchor_item_id absent when omitted (no anchor, not a null anchor)', () => {
    const result = DiscoverItemsBodySchema.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anchor_item_id).toBeUndefined();
    }
  });

  it('accepts a filters array alongside q', () => {
    const result = DiscoverItemsBodySchema.safeParse({
      ...base,
      q: 'welder',
      filters: [{ field: 'skills', values: ['welding'] }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters).toHaveLength(1);
    }
  });

  it('rejects a malformed filter entry', () => {
    const result = DiscoverItemsBodySchema.safeParse({
      ...base,
      filters: [{ field: 'skills', values: [null] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe('filters');
    }
  });
});

describe('DiscoverItemsBodySchema — geo refinement', () => {
  it('accepts neither coordinate', () => {
    expect(DiscoverItemsBodySchema.safeParse(base).success).toBe(true);
  });

  it('accepts both coordinates together', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 18.52, item_longitude: 73.85 })
        .success,
    ).toBe(true);
  });

  it('rejects a lone latitude, reporting on item_longitude', () => {
    const result = DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 18.52 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_longitude']);
      expect(result.error.issues[0].message).toBe(
        'item_latitude and item_longitude must be provided together',
      );
    }
  });

  it('rejects a lone longitude', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, item_longitude: 73.85 }).success).toBe(
      false,
    );
  });

  it('accepts the coordinate extremes', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: -90, item_longitude: -180 })
        .success,
    ).toBe(true);
    expect(
      DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 90, item_longitude: 180 }).success,
    ).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 90.1, item_longitude: 0 }).success,
    ).toBe(false);
    expect(
      DiscoverItemsBodySchema.safeParse({ ...base, item_latitude: 0, item_longitude: 180.1 })
        .success,
    ).toBe(false);
  });

  it('accepts a positive distance_meters and rejects 0 / negative', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, distance_meters: 5000 }).success).toBe(true);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, distance_meters: 0 }).success).toBe(false);
    expect(DiscoverItemsBodySchema.safeParse({ ...base, distance_meters: -1 }).success).toBe(false);
  });

  it('allows distance_meters WITHOUT coordinates (radius alone is not refused here)', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...base, distance_meters: 5000 }).success).toBe(true);
  });
});

describe('DiscoverSourceSchema', () => {
  it.each(['signals_search', 'native_fallback'])('accepts source %s', (source) => {
    expect(DiscoverSourceSchema.safeParse(source).success).toBe(true);
  });

  it('rejects an unknown source', () => {
    expect(DiscoverSourceSchema.safeParse('elasticsearch').success).toBe(false);
  });
});

describe('DiscoverResponseItemSchema', () => {
  const item = {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: ITEM_ID,
    item_instance_url: 'https://api.test/item/1',
    item_schema_url: 'https://api.test/schema/profile_1.0',
    item_state: { name: 'Asha' },
    item_locations: [{ lat: 18.52, lng: 73.85 }],
    created_by: 'usr_1',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-02T10:00:00.000Z',
    lifecycle_status: 'live',
  };

  it('coerces the ISO date strings signals-search sends into Date instances', () => {
    const result = DiscoverResponseItemSchema.safeParse(item);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created_at).toBeInstanceOf(Date);
      expect(result.data.created_at.toISOString()).toBe('2026-08-01T10:00:00.000Z');
      expect(result.data.updated_at).toBeInstanceOf(Date);
    }
  });

  it('accepts a native Date for created_at/updated_at too', () => {
    const result = DiscoverResponseItemSchema.safeParse({
      ...item,
      created_at: new Date('2026-08-01T10:00:00.000Z'),
      updated_at: new Date('2026-08-02T10:00:00.000Z'),
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unparseable created_at', () => {
    const result = DiscoverResponseItemSchema.safeParse({ ...item, created_at: 'yesterday' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['created_at']);
    }
  });

  it('accepts nulls for the widened instance/schema/creator fields', () => {
    const result = DiscoverResponseItemSchema.safeParse({
      ...item,
      item_instance_url: null,
      item_schema_url: null,
      created_by: null,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_instance_url).toBeNull();
      expect(result.data.created_by).toBeNull();
    }
  });

  it('accepts an omitted lifecycle_status (never 5xx on the fallback path)', () => {
    const withoutLifecycle: Record<string, unknown> = { ...item };
    delete withoutLifecycle.lifecycle_status;

    expect(DiscoverResponseItemSchema.safeParse(withoutLifecycle).success).toBe(true);
  });

  it('widens lifecycle_status to a plain string — an off-ladder value is accepted here', () => {
    const result = DiscoverResponseItemSchema.safeParse({ ...item, lifecycle_status: 'archived' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_status).toBe('archived');
    }
  });

  it('accepts the optional score / distanceMeters annotations', () => {
    const result = DiscoverResponseItemSchema.safeParse({
      ...item,
      score: 0.93,
      distanceMeters: 1200,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.score).toBe(0.93);
      expect(result.data.distanceMeters).toBe(1200);
    }
  });

  it('rejects a non-numeric score', () => {
    expect(DiscoverResponseItemSchema.safeParse({ ...item, score: 'high' }).success).toBe(false);
  });

  it('rejects an item missing item_type', () => {
    const withoutType: Record<string, unknown> = { ...item };
    delete withoutType.item_type;

    expect(DiscoverResponseItemSchema.safeParse(withoutType).success).toBe(false);
  });

  it('rejects an out-of-range location', () => {
    const result = DiscoverResponseItemSchema.safeParse({
      ...item,
      item_locations: [{ lat: 18.52, lng: 200 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_locations', 0, 'lng']);
    }
  });

  it('does NOT expose item_private_state — it is stripped from the response shape', () => {
    const result = DiscoverResponseItemSchema.safeParse({
      ...item,
      item_private_state: 'ciphertext',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('item_private_state');
    }
  });
});

describe('DiscoverResponseSchema', () => {
  const meta = {
    total: 0,
    limit: 20,
    offset: 0,
    source: 'signals_search' as const,
    degraded: false,
    // #644: every 200 response now reports the order actually applied, so the
    // UI labels from what happened rather than from what it requested.
    sort_applied: 'newest' as const,
  };

  it('accepts an empty result set without distance_meters', () => {
    const result = DiscoverResponseSchema.safeParse({ meta, items: [] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta.distance_meters).toBeUndefined();
      expect(result.data.items).toEqual([]);
    }
  });

  it('accepts a degraded native-fallback response carrying distance_meters', () => {
    const result = DiscoverResponseSchema.safeParse({
      meta: { ...meta, source: 'native_fallback', degraded: true, distance_meters: 25000 },
      items: [],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.meta.source).toBe('native_fallback');
      expect(result.data.meta.degraded).toBe(true);
      expect(result.data.meta.distance_meters).toBe(25000);
    }
  });

  it('rejects a meta block missing the degraded flag', () => {
    const result = DiscoverResponseSchema.safeParse({
      meta: { total: 0, limit: 20, offset: 0, source: 'signals_search' },
      items: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['meta', 'degraded']);
    }
  });

  it('rejects an unknown source inside meta', () => {
    expect(
      DiscoverResponseSchema.safeParse({ meta: { ...meta, source: 'opensearch' }, items: [] })
        .success,
    ).toBe(false);
  });

  it('rejects a missing items array', () => {
    expect(DiscoverResponseSchema.safeParse({ meta }).success).toBe(false);
  });
});

// ─── #644: explicit sort + opt-in area filter ────────────────────────────────
//
// Contract: docs/superpowers/plans/2026-09-03-list-view-wire-contract.md §5-§6.
// The AREA FILTER (item_latitude/item_longitude/distance_meters) is now
// opt-in, and an ORDERING CENTRE (ordering_latitude/ordering_longitude) is a
// distinct concept that orders WITHOUT filtering.

const sortBase = {
  item_network: 'purple_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
};

describe('DiscoverItemsBodySchema — explicit sort (contract §5)', () => {
  it('accepts each sort value', () => {
    for (const sort of ['relevance', 'newest', 'nearest'] as const) {
      expect(DiscoverItemsBodySchema.safeParse({ ...sortBase, sort }).success).toBe(true);
    }
  });

  it('rejects an unknown sort', () => {
    expect(DiscoverItemsBodySchema.safeParse({ ...sortBase, sort: 'cheapest' }).success).toBe(false);
  });

  it('treats sort as optional — the BFF defaults it', () => {
    expect(DiscoverItemsBodySchema.safeParse(sortBase).success).toBe(true);
  });
});

describe('DiscoverItemsBodySchema — ordering centre is not an area filter', () => {
  it('accepts an ordering centre with NO area filter (nearest + anywhere)', () => {
    // The crux of #644: order by distance across the whole network, bounding
    // nothing. Sending only the ordering centre must be valid.
    const parsed = DiscoverItemsBodySchema.safeParse({
      ...sortBase,
      sort: 'nearest',
      ordering_latitude: 12.97,
      ordering_longitude: 77.59,
    });
    expect(parsed.success).toBe(true);
  });

  it('requires ordering lat/lng together', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({ ...sortBase, ordering_latitude: 12.97 }).success
    ).toBe(false);
    expect(
      DiscoverItemsBodySchema.safeParse({ ...sortBase, ordering_longitude: 77.59 }).success
    ).toBe(false);
  });

  it('still requires item lat/lng together (existing rule intact)', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({ ...sortBase, item_latitude: 12.97 }).success
    ).toBe(false);
  });

  it('accepts both centres at once — an area filter plus an ordering centre', () => {
    const parsed = DiscoverItemsBodySchema.safeParse({
      ...sortBase,
      sort: 'nearest',
      item_latitude: 12.97,
      item_longitude: 77.59,
      distance_meters: 25000,
      ordering_latitude: 12.97,
      ordering_longitude: 77.59,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects out-of-range ordering coordinates', () => {
    expect(
      DiscoverItemsBodySchema.safeParse({
        ...sortBase,
        ordering_latitude: 99,
        ordering_longitude: 0,
      }).success
    ).toBe(false);
    expect(
      DiscoverItemsBodySchema.safeParse({
        ...sortBase,
        ordering_latitude: 0,
        ordering_longitude: 200,
      }).success
    ).toBe(false);
  });

  it('accepts a body with no location of any kind — the new default', () => {
    const parsed = DiscoverItemsBodySchema.safeParse(sortBase);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.item_latitude).toBeUndefined();
      expect(parsed.data.ordering_latitude).toBeUndefined();
      expect(parsed.data.distance_meters).toBeUndefined();
    }
  });
});

describe('DiscoverResponseSchema — sort_applied (#644 contract §6)', () => {
  const meta = {
    total: 0,
    limit: 20,
    offset: 0,
    source: 'signals_search' as const,
    degraded: false,
  };

  it('allows sort_applied to be ABSENT, because absence means "unknown"', () => {
    // It used to be required. Review of #665: a signals-search predating the
    // explicit sort omits the field AND ignores `intent.sort`, so the BFF
    // cannot reconstruct the order — and substituting its own request claimed
    // an order it never got (distance metrics over a recency-ordered list for
    // `nearest`; a recency label over a cosine order for `newest` + anchor).
    // The field is optional so that absence can travel to the UI as unknown.
    expect(DiscoverResponseSchema.safeParse({ meta, items: [] }).success).toBe(true);
    expect(
      DiscoverResponseSchema.safeParse({
        meta: { ...meta, sort_applied: 'newest' },
        items: [],
      }).success
    ).toBe(true);
  });

  it('still rejects a sort_applied outside the three known orders', () => {
    // Optional must not mean "anything goes" — an unrecognised order would
    // reach the card-metric switch and silently render nothing.
    expect(
      DiscoverResponseSchema.safeParse({
        meta: { ...meta, sort_applied: 'whatever' },
        items: [],
      }).success
    ).toBe(false);
  });

  it('rejects an unknown sort_applied', () => {
    expect(
      DiscoverResponseSchema.safeParse({
        meta: { ...meta, sort_applied: 'cheapest' },
        items: [],
      }).success
    ).toBe(false);
  });

  it('keeps distance_meters optional — absent for a non-area search', () => {
    // An ordering centre bounds nothing, so reporting a radius would be a lie.
    const parsed = DiscoverResponseSchema.safeParse({
      meta: { ...meta, sort_applied: 'nearest' },
      items: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.meta.distance_meters).toBeUndefined();
  });

  it('still carries distance_meters when an area filter was applied', () => {
    const parsed = DiscoverResponseSchema.safeParse({
      meta: { ...meta, sort_applied: 'nearest', distance_meters: 25000 },
      items: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.meta.distance_meters).toBe(25000);
  });
});
