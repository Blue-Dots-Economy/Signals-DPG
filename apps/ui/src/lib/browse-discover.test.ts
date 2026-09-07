import { describe, it, expect } from 'vitest';
import {
  deriveBrowseParams,
  domainsInteract,
  anchorItemIdForTarget,
  buildFilteredCardsForDomain,
  excludeOwnItems,
  isDiscoverActive,
  resolveListNote,
  DEFAULT_BROWSE_AREA,
} from './browse-discover';
import type { BrowseArea } from './browse-discover';
import type { NetworkInteractionActions } from './browse-discover';
import type { EnumFilterField } from './enum-filters';
import type { Item } from './item-api';

function makeItem(id: string, state: Record<string, unknown>, domain = 'provider'): Item {
  return {
    item_id: id,
    item_network: 'purple_dot',
    item_domain: domain,
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: state,
    item_locations: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

// A minimal two-domain network mirroring the seeker/provider interaction
// matrix: seekers can `apply`/`connect` to providers (both directions
// represented across two actions), but there is no interaction that involves
// seeker→seeker or provider→provider.
const seekerProviderActions: NetworkInteractionActions = {
  apply: {
    interactions: [{ from_domain: 'seeker', to_domain: 'provider' }],
  },
  connect: {
    interactions: [{ from_domain: 'provider', to_domain: 'seeker' }],
  },
};

describe('domainsInteract (#394)', () => {
  it('true for an interacting pair in schema order (seeker -> provider)', () => {
    expect(domainsInteract(seekerProviderActions, 'seeker', 'provider')).toBe(true);
  });

  it('true for an interacting pair queried in reverse (provider, seeker)', () => {
    expect(domainsInteract(seekerProviderActions, 'provider', 'seeker')).toBe(true);
  });

  it('false for a same-domain pair with no defined self-interaction (seeker <-> seeker)', () => {
    expect(domainsInteract(seekerProviderActions, 'seeker', 'seeker')).toBe(false);
  });

  it('false for a domain unknown to the schema', () => {
    expect(domainsInteract(seekerProviderActions, 'seeker', 'ghost')).toBe(false);
  });

  it('false when there are no actions at all', () => {
    expect(domainsInteract({}, 'seeker', 'provider')).toBe(false);
  });
});

describe('anchorItemIdForTarget (#394)', () => {
  it('returns the profile id when a profile is selected and the domains interact', () => {
    expect(
      anchorItemIdForTarget({
        activeProfileId: 'profile-123',
        activeProfileDomain: 'seeker',
        targetDomain: 'provider',
        actions: seekerProviderActions,
      }),
    ).toBe('profile-123');
  });

  it('returns undefined when the domains do not interact (seeker browsing seekers)', () => {
    expect(
      anchorItemIdForTarget({
        activeProfileId: 'profile-123',
        activeProfileDomain: 'seeker',
        targetDomain: 'seeker',
        actions: seekerProviderActions,
      }),
    ).toBeUndefined();
  });

  it('returns undefined when there is no selected profile', () => {
    expect(
      anchorItemIdForTarget({
        activeProfileId: null,
        activeProfileDomain: null,
        targetDomain: 'provider',
        actions: seekerProviderActions,
      }),
    ).toBeUndefined();
  });
});

describe('deriveBrowseParams (#394: list always uses discover, no more Near me toggle)', () => {
  it('relevance is always true — there is no ranked/proximity mode split anymore', () => {
    const p = deriveBrowseParams({ search: '', activeFieldFilters: {} });
    expect(p.relevance).toBe(true);
  });

  it('has no useLocation field — location is now always forwarded by the caller, not gated here', () => {
    const p = deriveBrowseParams({ search: '', activeFieldFilters: {} });
    expect(p).not.toHaveProperty('useLocation');
  });

  it('trims search into q and maps activeFieldFilters to a DiscoverFacetFilter[]', () => {
    const p = deriveBrowseParams({
      search: '  teacher  ',
      activeFieldFilters: { subject: ['math', 'science'] },
    });
    expect(p.q).toBe('teacher');
    expect(p.filters).toEqual([{ field: 'subject', values: ['math', 'science'] }]);
  });

  it('empty inputs → no q and empty filters', () => {
    const p = deriveBrowseParams({ search: '   ', activeFieldFilters: {} });
    expect(p.q).toBeUndefined();
    expect(p.filters).toEqual([]);
  });
});

describe('isDiscoverActive', () => {
  it('true when relevance set, or q present, or filters present; false otherwise', () => {
    expect(isDiscoverActive({ relevance: true, filters: [] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, q: 'x', filters: [] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, filters: [{ field: 'a', values: ['b'] }] })).toBe(true);
    expect(isDiscoverActive({ relevance: false, filters: [] })).toBe(false);
  });
});

describe('buildFilteredCardsForDomain discover bypass', () => {
  const enumFields: EnumFilterField[] = [
    { key: 'subject', label: 'Subject', options: ['math', 'science'], isArray: false },
  ];
  // Item text has neither the search substring "welder" nor the selected enum
  // value "science" — a valid semantic-search hit that the client MUST NOT drop.
  const items = [makeItem('a', { subject: 'math', bio: 'loves algebra' })];
  const opts = (discover: boolean) => ({
    search: 'welder',
    activeFieldFilters: { subject: ['science'] },
    enumFilterFields: enumFields,
    discover,
  });

  it('native path drops a card that matches neither the text nor the enum filter', () => {
    expect(buildFilteredCardsForDomain('provider', items, opts(false))).toHaveLength(0);
  });

  it('discover path keeps that card (server already applied text + facet filtering)', () => {
    const cards = buildFilteredCardsForDomain('provider', items, opts(true));
    expect(cards.map((c) => c.id)).toEqual(['a']);
  });

  // #644: the map's domain multi-select no longer participates in the list's
  // card filter. It could previously blank the list entirely when it selected
  // a domain other than the browsed one — a map concern emptying the list.
  it('the map domain selection can no longer empty the list', () => {
    const cards = buildFilteredCardsForDomain('provider', items, opts(true));
    expect(cards.map((c) => c.id)).toEqual(['a']);
  });
});

describe('resolveListNote (#394: always-discover list note above the results)', () => {
  it('degraded takes priority over everything else, and carries no values (reuses home.list_ranking_unavailable)', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: true,
        hasLocation: true,
        degraded: true,
        distanceMeters: 12345,
        locationSource: 'profile',
      }),
    ).toEqual({ key: 'home.list_ranking_unavailable' });
  });

  it('anchor + location: rounds km and resolves the profile location source', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: true,
        hasLocation: true,
        degraded: false,
        distanceMeters: 12345,
        locationSource: 'profile',
      }),
    ).toEqual({
      key: 'home.list_note_anchor_location',
      values: { km: 12, locationSource: 'profile' },
    });
  });

  it('anchor + location: maps the browser preferred source to "current"', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: true,
        hasLocation: true,
        degraded: false,
        distanceMeters: 30000,
        locationSource: 'browser',
      }),
    ).toEqual({
      key: 'home.list_note_anchor_location',
      values: { km: 30, locationSource: 'current' },
    });
  });

  it('rounds km to the nearest whole number', () => {
    const note = resolveListNote({
      hasProfileAnchor: true,
      relevanceApplied: true,
      hasLocation: true,
      degraded: false,
      distanceMeters: 12499,
      locationSource: 'profile',
    });
    expect(note?.values).toEqual({ km: 12, locationSource: 'profile' });
  });

  // Found on the test cluster (#644 QA). An anchor was SENT, so
  // `hasProfileAnchor` is true, but signals-search could not use it — the BFF
  // retried anchor-less and reported `sort_applied: 'newest'` with
  // `degraded: false`, so the degraded branch above never fires. The note
  // claimed "Showing profiles relevant to your profile." over a list that was
  // ordered by date.
  it('does NOT claim profile-relevance when the server did not apply it', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: false,
        hasLocation: false,
        degraded: false,
        locationSource: 'profile',
      }),
    ).toBeNull();
  });

  it('keeps the location half of the note when relevance was refused', () => {
    // The radius WAS applied, so that half is still true and must survive —
    // only the relevance claim is dropped.
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: false,
        hasLocation: true,
        degraded: false,
        distanceMeters: 12345,
        locationSource: 'profile',
      }),
    ).toEqual({
      key: 'home.list_note_location_only',
      values: { km: 12, locationSource: 'profile' },
    });
  });

  it('anchor, no location → anchor-only note with no values', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: true,
        hasLocation: false,
        degraded: false,
        locationSource: 'profile',
      }),
    ).toEqual({ key: 'home.list_note_anchor_only' });
  });

  it('no anchor (signed out), location present → location-only note', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: false,
        relevanceApplied: true,
        hasLocation: true,
        degraded: false,
        distanceMeters: 5000,
        locationSource: 'browser',
      }),
    ).toEqual({
      key: 'home.list_note_location_only',
      values: { km: 5, locationSource: 'current' },
    });
  });

  it('no anchor, no location → no note at all', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: false,
        relevanceApplied: true,
        hasLocation: false,
        degraded: false,
        locationSource: 'profile',
      }),
    ).toBeNull();
  });

  it('hasLocation true but distanceMeters missing (defensive: cannot report a truthful km) → treated as no location', () => {
    expect(
      resolveListNote({
        hasProfileAnchor: false,
        relevanceApplied: true,
        hasLocation: true,
        degraded: false,
        locationSource: 'profile',
      }),
    ).toBeNull();
    expect(
      resolveListNote({
        hasProfileAnchor: true,
        relevanceApplied: true,
        hasLocation: true,
        degraded: false,
        locationSource: 'profile',
      }),
    ).toEqual({ key: 'home.list_note_anchor_only' });
  });
});

describe('excludeOwnItems', () => {
  it('removes the viewer own item upstream, and the discover bypass does not reintroduce it', () => {
    const own = makeItem('me', { bio: 'x' });
    const other = makeItem('other', { bio: 'y' });
    const filtered = excludeOwnItems([own, other], new Set(['me']));
    const cards = buildFilteredCardsForDomain('provider', filtered, {
      search: '',
      activeFieldFilters: {},
      enumFilterFields: [],
      discover: true,
    });
    expect(cards.map((c) => c.id)).toEqual(['other']);
  });
});


// ─── #644: area defaults to anywhere, sort becomes explicit ─────────────────

describe('deriveBrowseParams — area is opt-in (#644)', () => {
  it('defaults to anywhere when no area is given', () => {
    const p = deriveBrowseParams({ search: '', activeFieldFilters: {} });
    expect(p.area).toEqual({ mode: 'anywhere' });
  });

  it('exports the default so the page and its tests share one source of truth', () => {
    expect(DEFAULT_BROWSE_AREA).toEqual({ mode: 'anywhere' });
  });

  it('passes a radius area through unchanged', () => {
    const area: BrowseArea = {
      mode: 'radius',
      center: { lat: 12.97, lng: 77.59 },
      meters: 25000,
    };
    expect(deriveBrowseParams({ search: '', activeFieldFilters: {}, area }).area).toEqual(area);
  });

  it('defaults sort to relevance — the BFF downgrades it when there is nothing to rank by', () => {
    expect(deriveBrowseParams({ search: '', activeFieldFilters: {} }).sort).toBe('relevance');
  });

  it('passes an explicit sort through', () => {
    expect(
      deriveBrowseParams({ search: '', activeFieldFilters: {}, sort: 'newest' }).sort,
    ).toBe('newest');
  });

  it('still maps search text and facets as before', () => {
    const p = deriveBrowseParams({
      search: '  solar  ',
      activeFieldFilters: { sector: ['energy'] },
    });
    expect(p.q).toBe('solar');
    expect(p.filters).toEqual([{ field: 'sector', values: ['energy'] }]);
    expect(p.relevance).toBe(true);
  });
});
