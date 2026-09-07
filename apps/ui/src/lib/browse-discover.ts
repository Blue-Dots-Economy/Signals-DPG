import type { Item } from '@/lib/item-api';
import type { DiscoverFacetFilter } from '@/lib/network-api';
import type { EnumFilterField } from '@/lib/enum-filters';
import { itemPassesEnumFilters } from '@/lib/enum-filters';

// ─── Search box + facets → discover params ──────────────────────────────────
//
// Maps the LIST view's search box, facet selections, area choice and sort to
// the `useInfiniteBrowseItems` opts. #394: the list ALWAYS uses the discover
// BFF — there is no ranked-vs-proximity toggle. `relevance` stays a field
// (rather than being dropped) purely because `useInfiniteBrowseItems` /
// `isDiscoverActive` already key off it as one of three ways to activate
// discover; it is unconditionally `true` here.
//
// #644 — THE LIST IS NO LONGER LOCATION-BOUNDED BY DEFAULT. Previously the
// page forwarded the resolved viewer location on every request, and
// signals-search treats a spatial clause as a HARD `s_dwithin` filter, so
// every signed-in viewer with a location silently saw only items within ~30 km
// with no way to widen it. That inverted the list view's actual requirement:
// page through ALL items in the network in a defined order. The map owns
// location-based discovery. Now:
//
//   - `area` defaults to `{ mode: 'anywhere' }` and sends NO coordinates, so
//     the candidate set is the whole network.
//   - `radius` is opt-in and explicit. The viewer's location is merely the
//     default CENTRE OFFERED when they choose it, never an implicit filter.
//   - `sort: 'nearest'` orders by distance using a separate ORDERING CENTRE
//     that bounds nothing — location may sort without truncating.
//
// The list still needs an optional area filter because the map cannot be the
// only location-aware view: `map-caps.ts` caps markers per viewport, and in a
// dense cell at maximum zoom there is no further zoom to escape to. The list
// is that escape hatch — hence explicit and opt-in, never defaulted.
export type BrowseSort = 'relevance' | 'newest' | 'nearest';

export type BrowseArea =
  | { mode: 'anywhere' }
  | { mode: 'radius'; center: { lat: number; lng: number }; meters: number }
  /**
   * The exact rectangle the map is showing (#644 scope, restored). Spec D6
   * had dropped this mode because signals-search offered only a Point +
   * radius, so a viewport had to be approximated by its circumscribed circle
   * — always larger than the rectangle, so the list would have included items
   * that were off the edges of the map. signals-search now has a `bbox` op,
   * so this is exact and the "approximate" label #644 asked for is gone.
   */
  | {
      mode: 'viewport';
      bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
    };

/** Shared so the page, the hook and their tests agree on the default. */
export const DEFAULT_BROWSE_AREA: BrowseArea = { mode: 'anywhere' };

export interface DeriveBrowseParamsInput {
  search: string;
  activeFieldFilters: Record<string, string[]>;
  area?: BrowseArea;
  sort?: BrowseSort;
}

export interface DerivedBrowseParams {
  relevance: true;
  q?: string;
  filters: DiscoverFacetFilter[];
  area: BrowseArea;
  sort: BrowseSort;
}

export function deriveBrowseParams(input: DeriveBrowseParamsInput): DerivedBrowseParams {
  const q = input.search.trim();
  const filters: DiscoverFacetFilter[] = Object.entries(input.activeFieldFilters).map(
    ([field, values]) => ({ field, values }),
  );
  return {
    relevance: true,
    ...(q ? { q } : {}),
    filters,
    area: input.area ?? DEFAULT_BROWSE_AREA,
    // `relevance` is the UI's default ask. The BFF downgrades it to `newest`
    // when there is neither an anchor nor typed text to rank by, and reports
    // what it actually applied — so the UI never labels an order it didn't get.
    sort: input.sort ?? 'relevance',
  };
}

// Mirrors `useInfiniteBrowseItems`' own "discover" activation condition: q OR
// filters OR relevance. When true the feed is server-filtered (text + facets),
// so the client-side filtering below must be bypassed. Typed with a plain
// `boolean` for `relevance` (rather than picking it from `DerivedBrowseParams`,
// whose `relevance` is now the literal `true`) so this stays independently
// testable/usable with any relevance value.
export function isDiscoverActive(params: {
  relevance: boolean;
  filters: DiscoverFacetFilter[];
  q?: string;
}): boolean {
  return params.relevance || Boolean(params.q) || params.filters.length > 0;
}

// ─── List note above the results (#394) ─────────────────────────────────────
//
// Now that the list ALWAYS calls discover with the profile anchor (when one
// interacts with the browsed domain) and the resolved viewer location (when
// available), the page shows one short explanatory note above the grid so
// "why am I seeing these results, in this order" is never a mystery. Exactly
// one of five variants applies at a time:
//
//   1. `degraded` (signals-search down, native fallback in play): reuses the
//      existing "basic matches — ranking unavailable" copy and nothing else —
//      the relevance/location wording below would be misleading since no
//      ranking actually happened.
//   2. profile anchor + location: "relevant to your profile, within X km".
//   3. profile anchor, no location: "relevant to your profile" only.
//   4. no anchor (signed out / no interacting profile) + location: "within X
//      km" only.
//   5. no anchor, no location: nothing to say — no note.
//
// `locationSource` mirrors `PreferredLocationSource`
// value ('profile' | 'browser'), translated here to the word the copy uses
// ('profile' | 'current'); the i18n VALUE itself is resolved by the caller
// (home-page) via `home.location_source_${locationSource}` so the word stays
// localized rather than hardcoded English inside an interpolation value.
export type ListNoteLocationSource = 'profile' | 'browser';

export interface ResolveListNoteInput {
  // Whether the viewer has an active profile that interacts with the browsed
  // domain and its item id is actually being sent as the discover anchor —
  // see `anchorItemIdForTarget`. For a signed-in viewer this is true for
  // every domain `computeVisibleDomains` shows them (their own interacting
  // `to_domains`), so in practice it reduces to "signed in with an active
  // profile", but the caller wires it from the real anchor-sent condition
  // rather than re-deriving that rule here.
  hasProfileAnchor: boolean;
  // Whether a location is being sent as the discover spatial filter (i.e. the
  // source-resolved coordinate resolved to something, not
  // null). Combined with `distanceMeters` below to decide whether a truthful
  // "within X km" can be shown.
  hasLocation: boolean;
  degraded: boolean;
  // The discover response's `meta.distance_meters` (the effective radius
  // actually applied) — undefined on a non-geo search. Required (alongside
  // `hasLocation`) to show a km figure; if location is on but this hasn't
  // arrived yet, the note degrades to the no-location variant rather than
  // showing a fabricated distance.
  distanceMeters?: number;
  locationSource: ListNoteLocationSource;
}

export interface ListNoteResult {
  key: string;
  values?: { km: number; locationSource: 'profile' | 'current' };
}

export function resolveListNote(input: ResolveListNoteInput): ListNoteResult | null {
  if (input.degraded) return { key: 'home.list_ranking_unavailable' };

  const hasKm = input.hasLocation && input.distanceMeters !== undefined;
  if (hasKm) {
    const km = Math.round(input.distanceMeters! / 1000);
    const locationSource = input.locationSource === 'browser' ? 'current' : 'profile';
    return {
      key: input.hasProfileAnchor ? 'home.list_note_anchor_location' : 'home.list_note_location_only',
      values: { km, locationSource },
    };
  }

  if (input.hasProfileAnchor) return { key: 'home.list_note_anchor_only' };

  return null;
}

// ─── Selected profile → discover anchor (#394) ──────────────────────────────
//
// The viewer's selected own-profile item id doubles as the discover "anchor"
// (`useInfiniteBrowseItems`'s `opts.anchorItemId`, threaded to signals-search's
// `intent.item.id`). But signals-search enforces the network's interaction
// matrix (`network.actions[].interactions`, each with `from_domain`/
// `to_domain`) and 403s with `INTERACTION_NOT_ALLOWED` when the anchor's
// domain has no defined interaction with the browsed (target) domain — e.g. a
// seeker browsing seekers. So the anchor must only be sent when the viewer's
// domain and the browsed domain actually interact per the schema.

/** Minimal shape of `DotNetworkSchema['actions']` this module needs — kept
 * narrow (rather than importing the full engine type) so it stays
 * unit-testable without pulling in RJSF/engine types. */
export type NetworkInteractionActions = Record<
  string,
  { interactions: ReadonlyArray<{ from_domain: string; to_domain: string }> }
>;

// Schema-driven: true iff ANY action defines an interaction between `a` and
// `b` in either direction. Same-domain pairs are `false` unless the schema
// explicitly defines a self-interaction (none of today's networks do).
export function domainsInteract(actions: NetworkInteractionActions, a: string, b: string): boolean {
  return Object.values(actions).some((action) =>
    action.interactions.some(
      (interaction) =>
        (interaction.from_domain === a && interaction.to_domain === b) ||
        (interaction.from_domain === b && interaction.to_domain === a),
    ),
  );
}

export interface AnchorItemIdForTargetInput {
  activeProfileId: string | null;
  activeProfileDomain: string | null;
  targetDomain: string;
  actions: NetworkInteractionActions;
}

// The anchor to send for a given browsed (target) domain: the viewer's
// selected profile id, but ONLY when they have one AND its domain is
// schema-permitted to interact with the target domain. Otherwise `undefined`
// (plain ranked/recency, no anchor — avoids the 403 round-trip entirely).
export function anchorItemIdForTarget(input: AnchorItemIdForTargetInput): string | undefined {
  if (!input.activeProfileId || !input.activeProfileDomain) return undefined;
  if (!domainsInteract(input.actions, input.activeProfileDomain, input.targetDomain)) return undefined;
  return input.activeProfileId;
}

// ─── Own-item filtering (runs UPSTREAM of buildFilteredCardsForDomain) ────────
//
// Hides the viewer's own profile from their own browse list. Kept as a distinct
// pure step so it applies in BOTH native and discover modes — it must NOT be
// bypassed by the discover path (contrast the text/enum filtering below, which
// the server has already applied on the discover path).
export function excludeOwnItems(items: Item[], ownItemIds: ReadonlySet<string>): Item[] {
  return items.filter((it) => !ownItemIds.has(it.item_id));
}

interface CardItem {
  id: string;
  domain: string;
  data: Record<string, unknown>;
}

export function itemToCardItem(item: Item): CardItem {
  return {
    id: item.item_id,
    domain: item.item_domain,
    data: { ...item.item_state, item_locations: item.item_locations },
  };
}

export interface BuildFilteredCardsOpts {
  search: string;
  activeFieldFilters: Record<string, string[]>;
  enumFilterFields: EnumFilterField[];
  // #203 List PR Task 5 (correctness): when the feed was served by the discover
  // BFF, the SERVER already applied text + facet filtering — and signals-search
  // matches text semantically (embeddings), so a valid result may NOT contain
  // the literal `search` substring anywhere in `item_state`. Re-running the
  // client text/enum filters would WRONGLY drop such results, so both are
  // skipped when `discover` is true. The map-domain skip is kept (it needs no
  // server support), and own-item filtering already ran upstream.
  discover: boolean;
}

// Card filter for the LIST view: on the native path only, free-text search +
// enum-field filters.
//
// #644: the map's domain multi-select no longer takes part. It used to blank
// the list entirely when it selected a domain other than the browsed one — a
// coupling that made sense while the "All" tab existed and the panel's toggle
// narrowed that union. The map is now the only consumer of that selection
// (spec D12), and the list has its own single-select domain control, so a map
// concern must not be able to empty the list.
export function buildFilteredCardsForDomain(
  _domainId: string,
  items: Item[],
  opts: BuildFilteredCardsOpts,
): CardItem[] {
  const cards = items.map(itemToCardItem);

  // Discover path: the server already applied text + facet filtering. Bypass
  // the client text-search AND enum-field filters (keeping only the map-domain
  // skip above) so semantic matches lacking the literal substring survive.
  if (opts.discover) {
    return cards;
  }

  let filtered = cards;

  // Text search filter (native path only)
  if (opts.search) {
    filtered = filtered.filter((item) =>
      Object.values(item.data).some((val) =>
        String(val).toLowerCase().includes(opts.search.toLowerCase()),
      ),
    );
  }

  // Enum-field filters (native path only): AND across different fields, OR
  // within a field's selected values. Absent fields on an item always pass.
  if (Object.keys(opts.activeFieldFilters).length > 0) {
    filtered = filtered.filter((item) =>
      itemPassesEnumFilters(item.data, opts.activeFieldFilters, opts.enumFilterFields),
    );
  }

  return filtered;
}
