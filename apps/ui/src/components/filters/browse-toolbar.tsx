import { useTranslation } from 'react-i18next';
import { AppliedFilterChips } from './applied-filter-chips';
import { SortSelect } from './sort-select';
import * as React from 'react';
import { DomainControl } from './domain-control';
import { LocationSelect } from './location-select';
import type { AppliedChip } from './applied-filter-chips';
import type { DomainOption } from './domain-control';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import type { ViewMode } from '@/engine/types';

export interface BrowseToolbarProps {
  viewMode: ViewMode;
  /** Server-reported total for the active feed; omitted while loading. */
  count?: number;
  /**
   * Map view only: how many matching items the map cannot plot at ANY zoom —
   * no coordinate, or not yet in the geo read-model. Explains the part of the
   * gap between this count (all matches) and the map's viewport pill that
   * zooming out will never close. Omitted when zero.
   */
  notMappable?: number;
  sort: BrowseSort;
  /** `meta.sort_applied` — what the server actually did. */
  sortApplied?: BrowseSort;
  /** A response arrived reporting no order at all — see `SortSelect`. */
  sortUnreported?: boolean;
  nearestAvailable: boolean;
  /**
   * False when the server cannot rank by relevance for this request (no anchor
   * and no typed text, or the discover BFF degraded to its native path). The
   * option is then omitted from the sort menu — see `SortSelect`.
   */
  relevanceAvailable?: boolean;
  relevanceBasis: 'profile' | 'search' | null;
  onSortChange: (next: BrowseSort) => void;
  /**
   * The domains this viewer can browse, and the current selection. Back in
   * this bar: with "Search near" gone, the row it had moved to existed only
   * for this control, which made three chrome layers where the approved
   * design has two.
   */
  domainOptions: DomainOption[];
  selectedDomains: string[];
  onDomainsChange: (next: string[]) => void;
  /**
   * The facet-panel trigger. It sat beside the search box in the app bar; it
   * belongs with the other refine controls, and moving it lets the search box
   * take the width it freed.
   */
  filtersSlot?: React.ReactNode;
  area: BrowseArea;
  /**
   * Which location source is in force, and whether each can supply one. Lives
   * with the distance in ONE control (#644 QA redesign) — the standalone
   * "Search near" toggle asked the same question in a second place.
   */
  locationSource: PreferredLocationSource;
  onLocationSourceChange: (next: PreferredLocationSource) => void;
  profileLocationAvailable: boolean;
  browserLocationAvailable: boolean;
  /** Centre offered when the user picks a radius; null when none resolves. */
  defaultCenter: { lat: number; lng: number } | null;
  onAreaChange: (next: BrowseArea) => void;
  /**
   * Chips for constraints whose EDITOR is elsewhere — search text and facets.
   * `sort` and `area` are deliberately absent: their controls sit in this same
   * row already showing their value, so a chip repeating it renders as a
   * visible duplicate ("Area Within 25 km | Within 25 km ×").
   */
  chips: AppliedChip[];
  onRemoveChip: (chip: AppliedChip) => void;
  onClearAll: () => void;
  /**
   * Whether anything at all is non-default. Distinct from `chips.length > 0`,
   * because sort and area can be non-default while producing no chip — and
   * clear-all still has to be reachable then.
   */
  canClearAll: boolean;
}

/**
 * The browse state bar (#644/#645, spec §7.2).
 *
 * Division of labour (spec §7.1): the APP BAR owns the EDITORS — the search
 * box and the facet-panel trigger, neither of which moves here. This bar owns
 * the STATE read-out, plus the two controls that had no previous home, `sort`
 * and `area`. Nothing here becomes a second editor for something the app bar
 * already edits.
 *
 * ONE row: the domain control, then sort (list only), location, the facet-panel
 * trigger, the applied chips, clear-all, and the count. Actions that operate ON the
 * results (bulk-select) deliberately live over the content instead.
 *
 * It always renders — showing "no filters applied" when nothing is set — so
 * the bar keeps a stable height and the list below does not shift under the
 * user's thumb as chips come and go.
 *
 * It is NOT `sticky`: `PageShell` renders this as a sibling of the scrolling
 * `<main>`, so it is structurally pinned. See `toolbarSlot` there for why that
 * beats a sticky child with a hardcoded offset.
 */
export function BrowseToolbar(props: Readonly<BrowseToolbarProps>) {
  const { t } = useTranslation();
  const isMap = props.viewMode === 'map';

  return (
    // ONE row, holding everything that scopes or refines the browse: domain on
    // the left, then sort / location / filters / count on the right. With the
    // app bar above that is two chrome layers, which is the approved design —
    // the domain control had briefly moved to a row of its own to sit beside
    // "Search near", and once that toggle was absorbed into Location the row
    // existed for nothing else.
    <div data-testid="browse-toolbar" className="px-4 py-2 sm:px-6">
      <div
        data-testid="toolbar-row-2"
        className="flex flex-wrap items-center gap-2"
      >
        <DomainControl
          options={props.domainOptions}
          // The map is multi-domain and takes its own selection; the list is
          // single-select on the one domain driving its feed (spec D11).
          mode={isMap ? 'multi' : 'single'}
          selected={props.selectedDomains}
          onChange={props.onDomainsChange}
        />
        {/* Pushes the controls to the far right — from `sm` up only. On a
            phone the domain control already fills the row, so the spacer flung
            Sort to the right edge of row one while Location and Filters sat at
            the left of row two. */}
        <span className="hidden flex-1 sm:block" />
        {/* Sort, Location and Filters travel as ONE flex item, so when the
            domain control has taken the whole first row they wrap together as
            a single left-aligned cluster instead of Sort staying behind on its
            own. `sm:contents` hands them straight back to the parent row from
            `sm` up, so the desktop layout is unchanged. */}
        <span className="flex shrink-0 items-center gap-2 sm:contents">
        {/* Sort is ABSENT on the map (spec D26), not disabled: ordering is
            meaningless for a marker layer, and a disabled control invites the
            question rather than answering it. */}
        {!isMap && (
          <SortSelect
            value={props.sort}
            applied={props.sortApplied}
            appliedUnreported={props.sortUnreported}
            nearestAvailable={props.nearestAvailable}
            relevanceAvailable={props.relevanceAvailable}
            nearestFromLabel={t(
              props.locationSource === 'browser'
                ? 'browse.location_from_browser'
                : 'browse.location_from_profile',
            ).toLowerCase()}
            basis={props.relevanceBasis}
            onChange={props.onSortChange}
          />
        )}
        {/* Area is ABSENT on the map, for the same reason as Sort (spec D26).
            Two independent reasons:

            1. It was INERT. `useMapMarkers` is called with the viewport, not
               with `area` — the map's radius comes from the bounds it is
               showing — so the control changed nothing on the map at all.
            2. It would be redundant and contradictory if wired up. On the map
               the VIEWPORT *is* the spatial filter; layering a radius on top
               of a bbox lets "Within 5 km" sit over a 200 km-wide viewport and
               render an empty map with pins just off-screen.

            Area exists to give the LIST a location constraint, because the
            list is the escape hatch from a map too dense to show every pin
            (#644, "Why the list still needs an optional area filter"). */}
        {!isMap && (
          <LocationSelect
            value={props.area}
            sort={props.sort}
            source={props.locationSource}
            onSourceChange={props.onLocationSourceChange}
            profileAvailable={props.profileLocationAvailable}
            browserAvailable={props.browserLocationAvailable}
            center={props.defaultCenter}
            onChange={props.onAreaChange}
          />
        )}
        {props.filtersSlot}
        </span>
        {props.chips.length > 0 && (
          <AppliedFilterChips chips={props.chips} onRemove={props.onRemoveChip} />
        )}
        {props.canClearAll ? (
          <button
            type="button"
            onClick={props.onClearAll}
            className="inline-flex items-center text-xs font-bold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            {t('browse.clear_all')}
          </button>
        ) : (
          <span className="text-xs italic text-muted-foreground">
            {t('browse.no_filters')}
          </span>
        )}
        {props.count !== undefined && (
          /* The divider between the filter state and the result count is a
             BORDER on the count itself, not a separate element. They are
             adjacent runs of same-size inline text, so without it the row
             reads as one phrase ("No filters applied 2 listings") rather than
             two independent facts — but as its own element it wrapped
             independently, leaving a hairline dangling at the end of the
             previous line on a narrow screen while the count sat below it.
             Being part of the count, it cannot separate from it.

             `sm:` only: below that the count wraps onto its own line, and the
             line break already does the separating — a leading rule at the
             start of a line would just be noise. */
          <span
            data-testid="toolbar-count"
            className="flex flex-wrap items-baseline justify-end gap-x-1.5 text-xs sm:border-l sm:border-border sm:pl-2.5"
          >
            <span className="font-semibold text-muted-foreground">
              {t('browse.count_listings', { count: props.count })}
            </span>
            {props.notMappable !== undefined && props.notMappable > 0 && (
              <span data-testid="not-mappable-note" className="text-muted-foreground/80">
                {t('browse.count_not_mappable', { count: props.notMappable })}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
