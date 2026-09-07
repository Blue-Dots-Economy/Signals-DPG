import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { GoLiveGate } from '@dpg/schemas';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type {
  DotNetworkSchema,
  DotNetworkDomain,
  DotActionSchema,
  DotCardConfig,
  MapMarker,
  MapViewport,
  ViewMode,
} from '@/engine/types';
import { PageShell } from '@/components/layout/page-shell';
import { ContentHeader } from '@/components/layout/content-header';
import { GuestHero } from '@/components/layout/guest-hero';
import { CardGrid } from '@/components/cards/card-grid';
import { useActions } from '@/hooks/use-actions';
import { DomainCard } from '@/components/cards/domain-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ActionHandler } from '@/components/actions/action-handler';
import { MapView } from '@/components/map/map-container';
import { MapFiltersPanel } from '@/components/map/map-filters-panel';
import { MarkerPopupCard } from '@/components/map/marker-popup-card';
import { MapCountPill } from '@/components/map/map-count-pill';
import { MatchScoreCard } from '@/components/match-score';
import { shouldRenderMatchScoreCard } from '@/lib/match-score-config';
import '@/components/map/providers';
import { performAction, performActionsBulk, type Item } from '@/lib/item-api';
import { bulkFailureIndices, firstBulkError, BulkSingleError } from '@/lib/bulk';
import { useCardSelection } from '@/hooks/use-card-selection';
import { useEqualRowHeights } from '@/hooks/use-equal-row-heights';
import { useNetworkConfigs, useResolvedNetwork, useNetworkConfig } from '@/hooks/use-network-config';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import { ActionModal } from '@/components/actions/action-modal';
import { CheckSquare } from 'lucide-react';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { formatDomainLabel } from '@/lib/domain-icons';
import { ACTION_CONSENT_SENTINEL, guardianOtpErrorOf, type PerformActionPayload } from '@/lib/action-api';
import { ActionAbortedError } from '@/lib/action-abort';
import { EmptyState } from '@/components/empty-state';
import { useAuth } from '@/contexts/auth-context';
import { apiConfig } from '@/lib/api-config';
import {
  getActionsForDomain as flattenInteractionActions,
  resolveTargetInstanceUrl,
  computeOpenActionItemIds,
} from '@/lib/profile-actions';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import {
  deriveBrowseParams,
  anchorItemIdForTarget,
  domainsInteract,
  isDiscoverActive,
  resolveListNote,
  excludeOwnItems,
  buildFilteredCardsForDomain,
} from '@/lib/browse-discover';
import type { DerivedBrowseParams } from '@/lib/browse-discover';
import { getServedScope } from '@/lib/served-binding';
import { computeVisibleDomains } from '@/lib/visible-domains';
import { useUserLocation } from '@/hooks/use-user-location';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import { useGeolocationPermission } from '@/hooks/use-geolocation-permission';
import { LocationSourceToggle } from '@/components/location/location-source-toggle';
import { EnableLocationBanner } from '@/components/location/enable-location-banner';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import {
  getU18Status,
  type U18StatusResponse,
} from '@/lib/consent-api';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useConsentGate } from '@/hooks/use-consent-gate';
import { useProfileConsentAccept } from '@/hooks/use-profile-consent-accept';
import { useNetworkTheme } from '@/theme/theme-provider';
import { ProfileConsentModal } from '@/components/consent/profile-consent-modal';
import { useMyItems } from '@/hooks/use-my-items';
import {
  getStoredActiveProfileId,
  setStoredActiveProfileId,
  clearStoredActiveProfileId,
} from '@/lib/active-profile';
import { useInfiniteBrowseItems } from '@/hooks/use-infinite-browse-items';
import { useProfileConsentStatus } from '@/hooks/use-profile-consent-status';
import { useMapMarkers } from '@/hooks/use-map-markers';
import { useItemDetail } from '@/hooks/use-item-detail';
import type { Marker as NetworkMarker, DiscoverFacetFilter } from '@/lib/network-api';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { GuardianOtpDialog } from '@/components/actions/guardian-otp-dialog';
import { GuardianOtpPurpose } from '@/components/consent/u18/guardian-otp-purpose';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';

/**
 * True when the map covers so much longitude that "zoom out" is not a usable
 * instruction any more. 120° is roughly a continental view — well before the
 * whole-world zoom, and comfortably inside the 180° span that used to break
 * the server-side bbox query.
 */
const WIDE_VIEWPORT_LNG_SPAN_DEGREES = 120;

export function isWideViewport(viewport: MapViewport | null): boolean {
  if (viewport?.minLng === undefined || viewport?.maxLng === undefined) return false;
  return viewport.maxLng - viewport.minLng >= WIDE_VIEWPORT_LNG_SPAN_DEGREES;
}

/**
 * Which empty-map message to show. Three distinct situations that used to
 * share one string: a FAILED load is not an empty area, and at a world-scale
 * viewport "zoom out to find results" is advice the user cannot act on —
 * they are already as far out as it goes, and zooming out is what emptied the
 * map.
 */
export function mapEmptyMessageKey(opts: { isError: boolean; wideViewport: boolean }): string {
  if (opts.isError) return 'home.map_load_failed';
  if (opts.wideViewport) return 'home.map_no_items_wide';
  return 'home.map_no_items_in_area';
}

function getItemLocations(
  data: Record<string, unknown>,
): Array<{ lat: number; lng: number; label?: string }> | undefined {
  const raw = data.item_locations;
  if (!Array.isArray(raw)) return undefined;
  return raw as Array<{ lat: number; lng: number; label?: string }>;
}

function sortItemsByNearest<T>(
  items: T[],
  userLocation: LatLng | null,
  getLocations: (item: T) => ReadonlyArray<{ lat: number; lng: number; label?: string }> | undefined,
): T[] {
  if (!userLocation) return items;
  return [...items].sort(
    (a, b) =>
      nearestDistanceMeters(userLocation, getLocations(a)) -
      nearestDistanceMeters(userLocation, getLocations(b)),
  );
}

// Bottom-sentinel scroll observer: fires `onIntersect` when the sentinel node
// scrolls into view. Disconnects on cleanup / when disabled. Shared by the
// single-domain list and the "All" tab merged list (Task 5 §5.1 paging).
//
// `onIntersect` is read through a ref (kept fresh every render) rather than
// placed in the effect's dependency array — the hooks this drives
// (`useInfiniteBrowseItems`) hand back a new closure identity on every render,
// so depending on it directly would tear down and recreate the
// IntersectionObserver (and re-fire its callback) on every unrelated
// re-render instead of only on real intersection changes.
function useLoadMoreSentinel(
  onIntersect: () => void,
  enabled: boolean,
): (node: HTMLDivElement | null) => void {
  const onIntersectRef = React.useRef(onIntersect);
  onIntersectRef.current = onIntersect;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  // Callback ref (stable, empty deps → runs only when the sentinel node itself
  // mounts/unmounts, not every render). This re-attaches the observer to the
  // *current* node: the "All" tab renders the sentinel in more than one branch,
  // so the live node can swap without `enabled` changing — a useEffect([enabled])
  // kept observing a stale, unmounted node and never fired (needed a tab switch
  // to remount). rootMargin pre-triggers 200px before the 1px sentinel reaches
  // the fold, so firing no longer depends on that exact pixel crossing the edge
  // (flaky under max-scroll clamping / momentum scrolling).
  return React.useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (enabledRef.current && entries.some((entry) => entry.isIntersecting)) {
          onIntersectRef.current();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);
}

interface DomainPageState {
  items: Item[];
  hasMore: boolean;
  total: number;
  // Task 7 (#203 §5.2 cleanup): lifted so the "All" tab's loading gate can
  // read the paged hooks directly instead of the removed full `useBrowseItems`
  // fetch (resolves the P3-deferred loading-flash minor).
  isLoading: boolean;
  fetchNext: () => void;
  // P5 (#203 §6): lifted from `useInfiniteBrowseItems`' `partial` so the "All"
  // tab can show the same federation-degradation banner as the single-domain
  // list and the map (P4's `mapMarkers.partial`).
  partial: boolean;
  // Task 6 (#203 §6): lifted from `useInfiniteBrowseItems`' `degraded` — true
  // when the discover BFF fell back to native (signals-search unreachable/
  // unconfigured/timed out) for this domain's page. Threaded through
  // IDENTICALLY to `partial` above so the "All" tab can show the same
  // degraded-search UX as the single-domain list.
  degraded: boolean;
  // #394: lifted from `useInfiniteBrowseItems`' `distanceMeters` (the discover
  // BFF's `meta.distance_meters`) so the "All" tab's list note can show the
  // same "within X km" wording as the single-domain list.
  distanceMeters?: number;
}

// Headless per-domain paged fetch for the "All" tab (Task 5 §5.1). React hooks
// cannot be called in a loop, so each visible domain gets its own instance of
// this component (one `useInfiniteBrowseItems` call each — legal), and lifts
// its loaded page state up to the parent via `onItems` so the parent can
// render ONE merged, nearest-first-sorted grid across all domains. Renders
// nothing itself.
function DomainPagedFetch({
  network,
  domain,
  coords,
  browseOpts,
  onItems,
}: {
  network: DotNetworkSchema;
  domain: DotNetworkDomain;
  coords: { lat: number; lng: number } | null;
  // #394: the discover params (q/filters/relevance) derived from the search
  // box and facet panel. Passed identically for every visible domain so the
  // whole "All" feed shares one discover mode — the list always uses discover
  // now, there is no more "Near me" toggle. Omitted by the map-view
  // count-only fetchers, which stay on the native browse path (unaffected by
  // list-view discover concerns per spec §5.3). `anchorItemId` (#394) is NOT
  // shared across domains like the rest of this object — the caller computes
  // it per-domain (`anchorFor(domain.id)`) since whether it's safe to send
  // depends on the schema's interaction matrix between the anchor's own
  // domain and each individual browsed domain (e.g. a seeker's anchor is sent
  // for the provider slice of "All" but withheld for the seeker slice).
  browseOpts?: {
    q?: string;
    filters: DiscoverFacetFilter[];
    relevance: boolean;
    anchorItemId?: string;
  };
  onItems: (
    domainId: string,
    items: Item[],
    hasMore: boolean,
    total: number,
    isLoading: boolean,
    fetchNext: () => void,
    partial: boolean,
    degraded: boolean,
    distanceMeters: number | undefined,
  ) => void;
}): null {
  const list = useInfiniteBrowseItems(network, domain, coords, browseOpts);
  // `list.items` is a fresh array on every render (the hook doesn't memoize
  // it), so this effect refires on every plain re-render too. That's fine:
  // `onItems` (`handleDomainItems`) is idempotent — it bails out of its
  // `setState` when the lifted data is unchanged (element-wise reference
  // equality on `items`, plus `hasMore`/`total`/`isLoading`/`partial`/
  // `degraded`/`distanceMeters`), so a plain re-render never causes a further
  // re-render here. This is what lets a same-length refetch (new item object
  // refs, edited `item_state`) still get lifted — gating on `items.length`
  // would silently drop that update.
  React.useEffect(() => {
    onItems(
      domain.id,
      list.items,
      list.hasNextPage,
      list.total,
      list.isLoading,
      list.fetchNextPage,
      list.partial,
      list.degraded,
      list.distanceMeters,
    );
  }, [
    domain.id,
    list.items,
    list.hasNextPage,
    list.total,
    list.isLoading,
    list.fetchNextPage,
    list.partial,
    list.degraded,
    list.distanceMeters,
    onItems,
  ]);
  return null;
}

// Task 6 (#203 §5.2): a map marker's popup lazily fetches the full item only
// once the popup is actually shown — the active `MapProvider` only invokes
// `renderPopup(marker)` while a marker is selected/open (see
// `google-maps-provider.tsx` / `leaflet-provider.tsx`), so this component's
// `useItemDetail` call only fires for the marker the user clicked, not for
// every viewport marker. Hooks can't be called inside the `renderPopup`
// callback itself, hence a standalone component (mirrors the
// `DomainPagedFetch` pattern above) rather than an inline hook call.
function MarkerDetailPopup({
  networkId,
  marker,
  sourceMarker,
  itemType,
  schema,
  cardConfig,
  localItem,
  connectAction,
  onConnect,
  connectDisabled,
  connectDisabledReason,
  onItemResolved,
}: Readonly<{
  networkId: string | null;
  marker: MapMarker;
  // The `Marker` (network-api) this popup's marker was derived from — carries
  // `item_instance_url` for routed fetches, which the lightweight `MapMarker`
  // shape does not.
  sourceMarker: NetworkMarker | undefined;
  // The clicked marker's domain item type (e.g. `job_posting_1.0`), derived by
  // the parent from the network config — the by-id detail fetch filters on it.
  itemType?: string;
  schema?: RJSFSchema;
  cardConfig?: DotCardConfig | null;
  localItem: Item | null;
  connectAction?: DotActionSchema;
  onConnect?: (baseItemId: string) => void;
  // Disable the connect CTA when an action is already open for this pair
  // (#370/#422) — parity with the list cards.
  connectDisabled?: boolean;
  connectDisabledReason?: string;
  // Task 7 (#203 §5.2 cleanup): lifts this popup's already-fetched full item
  // up to the parent. Home-page's `onActionSubmit` needs the full `Item`
  // (network/domain/type/instance_url) to build a connect-action's
  // `target_item`, but a map-only item (one loaded via viewport markers, never
  // paged into the list feeds) has no other source now that the full
  // `useBrowseItems` fetch is gone — this reuses the popup's own
  // `useItemDetail` result instead of re-fetching or reintroducing a full
  // browse feed.
  onItemResolved?: (item: Item) => void;
}>) {
  const { t } = useTranslation();
  const { data: popupNetworkConfig } = useNetworkConfig(networkId ?? null);
  // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
  const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
  // Fetch from the clicked marker's OWN id + domain (always present on the map
  // marker) — do NOT gate on finding `sourceMarker` in the live markers array,
  // which churns as the viewport refetches and would otherwise leave the popup
  // stuck on "Loading…" with no request ever firing. `sourceMarker` (when
  // present) only supplies the optional owning-instance URL for a routed fetch;
  // its absence just means the network fetch discovers the item by id.
  const itemDomain = marker.domain ?? sourceMarker?.item_domain;

  const { item, isLoading } = useItemDetail(
    networkId,
    itemDomain
      ? {
          item_id: baseItemId,
          item_domain: itemDomain,
          // The domain's item type (e.g. `profile_1.0` / `job_posting_1.0`).
          // Slim markers don't carry it, so the parent derives it from the
          // domain config and passes it in — without it the by-id fetch would
          // filter on the wrong (default) type and match nothing.
          item_type: itemType,
          item_instance_url: sourceMarker?.item_instance_url,
        }
      : null,
  );

  React.useEffect(() => {
    if (item) onItemResolved?.(item);
  }, [item, onItemResolved]);

  if (isLoading) {
    return (
      <div className="p-3 text-sm text-muted-foreground">{t('map.loading_detail')}</div>
    );
  }
  if (!item) {
    return (
      <div className="p-3 text-sm text-muted-foreground">{t('map.detail_unavailable')}</div>
    );
  }

  // The slim map marker carries no item_state (its `data` is just
  // `{ item_locations }`) and only a generic `label`, so the popup card would
  // render empty fields and an "Item — <place>" title. Enrich it with the
  // fetched full item's state + real title so the card shows the actual profile
  // / posting details. Keep the clicked marker's location/precision/domain.
  const resolvedTitle = cardConfig?.title_field
    ? String((item.item_state as Record<string, unknown>)[cardConfig.title_field] ?? '').trim()
    : '';
  const enrichedMarker: MapMarker = {
    ...marker,
    data: item.item_state,
    label: resolvedTitle || marker.label,
  };

  return (
    <MarkerPopupCard
      marker={enrichedMarker}
      schema={schema}
      cardConfig={cardConfig}
      actions={localItem && connectAction ? [connectAction] : []}
      onConnect={localItem && connectAction ? () => onConnect?.(baseItemId) : undefined}
      connectDisabled={connectDisabled}
      connectDisabledReason={connectDisabledReason}
      localItem={localItem}
      networkItem={item}
      domains={popupNetworkConfig?.domains}
    />
  );
}

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

/**
 * Resolve the instance URL for a target item
 * Priority:
 * 1. Item's own item_instance_url (if available and not localhost)
 * 2. Network config instances lookup by domain
 * 3. Current API base URL as fallback
 */
// Resolves the landing-page default view mode from VITE_DEFAULT_VIEW_MODE.
// Falls back to 'map' when the env var is missing or holds an unrecognised
// value, so a fresh install ships with the map-first experience.
function resolveDefaultViewMode(): ViewMode {
  const raw = getRuntimeEnv('VITE_DEFAULT_VIEW_MODE');
  if (raw === 'list' || raw === 'map') return raw;
  return 'map';
}


/**
 * Whether the active profile's domain still requires profile_creation consent
 * before go-live, from its `go_live_required` gates (mirrors network.json). A
 * domain that goes live on completeness alone (`["schema_required"]`) never
 * prompts. Absent config ⇒ require (safe default, matches the login gate).
 */
function domainNeedsProfileConsent(
  domains:
    | ReadonlyArray<{ id: string; go_live_required?: GoLiveGate[] }>
    | undefined,
  domainId: string | undefined,
): boolean {
  const gates = domains?.find((d) => d.id === domainId)?.go_live_required;
  return gates ? gates.includes('consent_required') : true;
}

/** The parsed served-domain scope, or null when the deployment serves all domains. */
type HomeServedScope = ReturnType<typeof getServedScope>;

/** The single served domain when exactly one is bound (the single-domain portal), else null. */
function resolveBoundDomain(servedScope: HomeServedScope): string | null {
  return servedScope?.domains.length === 1 ? servedScope.domains[0] : null;
}

/**
 * Resolve the initial selected-network id: a served scope pins it, else a valid
 * `?network=` URL param, else the first configured network id.
 */
function resolveInitialNetworkId(
  servedScope: HomeServedScope,
  networkFromUrl: string | null,
  configuredNetworkIds: string[],
): string | null {
  if (servedScope?.network) return servedScope.network;
  if (networkFromUrl && configuredNetworkIds.includes(networkFromUrl)) return networkFromUrl;
  return configuredNetworkIds[0] || null;
}

/** Whether the location-source toggle applies (a profile location exists AND the browser can provide one). */
function computeCanToggleLocation(profileLocation: LatLng | null, browserSupported: boolean): boolean {
  return Boolean(profileLocation) && browserSupported;
}

/** Whether to offer the "enable location" banner (toggle applies, browser source picked, but it errored). */
function computeShowLocationBanner(
  canToggle: boolean,
  preferredSource: PreferredLocationSource,
  browserStatus: string,
): boolean {
  return canToggle && preferredSource === 'browser' && browserStatus === 'error';
}

/** Whether the active profile's domain gates go-live on profile_creation consent (absent config ⇒ require). */
function computeProfileConsentRequired(
  profileStatement: string,
  domains: Parameters<typeof domainNeedsProfileConsent>[0],
  itemDomain: string | undefined,
): boolean {
  return Boolean(profileStatement) && domainNeedsProfileConsent(domains, itemDomain);
}

/** Whether the ward's domain requires the U18 guardian gate (needs an authenticated user on a gated domain). */
function computeRequiresGuardianGate(
  user: unknown,
  network: DotNetworkSchema | null | undefined,
  wardDomain: string | null,
): boolean {
  return Boolean(user && network && wardDomain && isGuardianConsentRequiredDomain(network, wardDomain));
}

/**
 * Derive the U18 guardian-flow display state from the stored status + gate signals.
 *
 * @returns The resolved-adult short-circuit, the DOB-vs-guardian entry step, the
 *   birth/minor-guardian sub-flags, and whether the guardian flow should show.
 */
function deriveU18GuardianState(p: {
  status: U18StatusResponse | null;
  statusLoading: boolean;
  gateLoading: boolean;
  dismissed: boolean;
  requiresGate: boolean;
  neededConsentCount: number;
}): {
  resolvedAdult: boolean;
  initialStep: 'dob' | 'guardian';
  birthUnresolved: boolean;
  minorNeedsGuardian: boolean;
  showFlow: boolean;
} {
  const resolvedAdult = p.status?.hasBirthData === true && p.status.isMinor === false;
  const initialStep: 'dob' | 'guardian' = p.status?.hasBirthData ? 'guardian' : 'dob';
  const birthUnresolved = !p.statusLoading && p.status?.hasBirthData !== true;
  const minorNeedsGuardian = p.status?.isMinor === true && p.status?.guardianVerified !== true;
  const showFlow =
    p.requiresGate &&
    !p.gateLoading &&
    !p.dismissed &&
    !p.statusLoading &&
    !resolvedAdult &&
    (p.neededConsentCount > 0 || birthUnresolved || minorNeedsGuardian);
  return { resolvedAdult, initialStep, birthUnresolved, minorNeedsGuardian, showFlow };
}

/** Pick the single-domain value on a specific domain tab, else the "All"-tab aggregate. */
function selectByDomainScope<T>(selectedDomain: string | null, single: T, all: T): T {
  return selectedDomain !== null ? single : all;
}

/** Whether the single-domain list's load-more sentinel is active. */
function singleDomainSentinelEnabled(selectedDomain: string | null, hasNextPage: boolean): boolean {
  return selectedDomain !== null && hasNextPage;
}

/** Whether the "All"-tab merged list's load-more sentinel is active. */
function allDomainsSentinelEnabled(selectedDomain: string | null, anyHasMore: boolean): boolean {
  return selectedDomain === null && anyHasMore;
}

/** The per-target discover anchor for the single-domain feed (undefined on the "All" tab). */
function resolveSingleDomainAnchor(
  selectedDomain: string | null,
  anchorFor: (targetDomain: string) => string | undefined,
): string | undefined {
  return selectedDomain ? anchorFor(selectedDomain) : undefined;
}

/**
 * Whether a profile anchor is actually being sent for the browsed domain(s) —
 * gated by the schema interaction matrix, not merely "signed in with a profile".
 */
function computeHasProfileAnchor(p: {
  selectedDomain: string | null;
  anchorFor: (targetDomain: string) => string | undefined;
  activeProfileId: string | null;
  activeProfileDomain: string | null;
  visibleDomains: DotNetworkDomain[];
  networkActions: Parameters<typeof domainsInteract>[0];
}): boolean {
  if (p.selectedDomain !== null) return p.anchorFor(p.selectedDomain) !== undefined;
  const { activeProfileDomain } = p;
  return Boolean(
    p.activeProfileId &&
      activeProfileDomain &&
      p.visibleDomains.some((domain) => domainsInteract(p.networkActions, activeProfileDomain, domain.id)),
  );
}

/** The effective location source for the list note wording ('none' maps to 'profile' harmlessly). */
function noteLocationSource(resolvedLocationSource: string): 'browser' | 'profile' {
  return resolvedLocationSource === 'browser' ? 'browser' : 'profile';
}

/** Whether the network selector should render (no served scope, more than one network). */
function computeShowNetworkSelector(servedScope: HomeServedScope, networkCount: number): boolean {
  return !servedScope && networkCount > 1;
}

/** The dynamic actions to surface: the selected domain's, else the legacy single active action, else none. */
function resolveDomainActions(
  selectedDomain: string | null,
  getActionsForDomain: (targetDomain: string) => DotActionSchema[],
  activeAction: DotActionSchema | null,
): DotActionSchema[] {
  if (selectedDomain) return getActionsForDomain(selectedDomain);
  return activeAction ? [activeAction] : [];
}

/** The header's display domain: the selected domain, else the sole visible domain, else null (the "All" header). */
function resolveHeaderDomain(selectedDomain: string | null, visibleDomains: DotNetworkDomain[]): string | null {
  return selectedDomain ?? (visibleDomains.length === 1 ? visibleDomains[0].id : null);
}

/** The header description for the display domain (undefined on the "All" header). */
function resolveHeaderDescription(
  headerDomain: string | null,
  visibleDomains: DotNetworkDomain[],
): string | undefined {
  return headerDomain ? visibleDomains.find((d) => d.id === headerDomain)?.description : undefined;
}

/** Normalise a guardian-flow action type to the OTP-purpose kind ('connect' or 'apply'). */
function guardianActionKind(actionType: string | undefined): 'connect' | 'apply' {
  return actionType === 'connect' ? 'connect' : 'apply';
}

/** The network list the PageShell selector renders (empty unless the selector should show). */
function pickNetworksForShell(
  showNetworkSelector: boolean,
  allNetworks: DotNetworkSchema[],
): DotNetworkSchema[] {
  return showNetworkSelector ? allNetworks : [];
}

export function HomePage() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const allCardsGridRef = useEqualRowHeights<HTMLDivElement>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>(
    (searchParams.get('view') as ViewMode) ?? resolveDefaultViewMode()
  );
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    searchParams.get('domain')
  );
  // Map filter: multi-select domain filter (URL param: ?map_domains=seeker,provider)
  const [mapSelectedDomains, setMapSelectedDomains] = React.useState<string[]>(() => {
    const raw = searchParams.get('map_domains');
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  });
  // Map filter: enum-field filters (URL params: ?f_<key>=value1,value2)
  // Each active field gets its own param namespaced with the "f_" prefix.
  const [mapSelectedFields, setMapSelectedFields] = React.useState<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {};
    for (const [param, value] of searchParams.entries()) {
      if (!param.startsWith('f_')) continue;
      const fieldKey = param.slice(2); // strip "f_" prefix
      if (!fieldKey) continue;
      const values = value.split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
      if (values.length > 0) result[fieldKey] = values;
    }
    return result;
  });
  // Map viewport (Task 6, #203 §5.2): null until the map reports its first
  // `onViewportChange` (debounced pan/zoom settle). The map's own initial
  // center/zoom comes from the existing `focusPoint`/`userLocation`/default
  // logic below — this state only tracks what the map has told us it's
  // actually showing, so `useMapMarkers` stays disabled (no markers query)
  // until that first report lands.
  const [mapViewport, setMapViewport] = React.useState<MapViewport | null>(null);
  // The full `Item` most recently resolved by an open marker popup's
  // `useItemDetail` fetch (Task 7, #203 §5.2 cleanup) — see
  // `MarkerDetailPopup`'s `onItemResolved` doc comment for why this exists.
  const [mapDetailItem, setMapDetailItem] = React.useState<Item | null>(null);
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  // The set of domains this deployment serves (VITE_SERVED_BINDINGS), or null
  // when unset (serve all domains). When exactly ONE domain is served, that is
  // the forced acting/browse domain (the single-domain portal); with multiple,
  // the acting domain is derived from the logged-in user (whitelisted combined
  // UI). Memoised — runtime config is fixed for the session's lifetime.
  const servedScope = React.useMemo(() => getServedScope(), []);
  const boundDomain = resolveBoundDomain(servedScope);

  // Network: the served scope pins it; otherwise URL param, then env config.
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId = resolveInitialNetworkId(servedScope, networkFromUrl, configuredNetworkIds);

  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [pendingConsentProfileId, setPendingConsentProfileId] = React.useState<string | null>(null);
  const browseSelection = useCardSelection();
  const [bulkConnectOpen, setBulkConnectOpen] = React.useState(false);
  const [bulkConnectBusy, setBulkConnectBusy] = React.useState(false);
  // Minor ward doing a bulk action (#393/#453): the gated items come back
  // GUARDIAN_OTP_REQUIRED after one OTP is sent to the guardian. Stash the
  // payloads to resubmit with the code — one guardian OTP dialog for the batch,
  // mirroring the single-action flow (no raw error).
  const [bulkGuardianChallenge, setBulkGuardianChallenge] = React.useState<{
    payloads: PerformActionPayload[];
    sourceInstanceUrl?: string;
    actionType: string;
    // Non-guardian failures from a mixed batch, carried through so they can be
    // reselected once the guardian OTP dialog resolves (they still need a retry).
    otherFailedIds?: string[];
  } | null>(null);
  // Minor ward: the "a code will be sent to your guardian — proceed?" confirm
  // shown BEFORE a bulk action dispatches the OTP (mirrors the single-action
  // confirm). Holds the deferred bulk submit + its action type (for the panel).
  const [bulkGuardianConfirm, setBulkGuardianConfirm] = React.useState<
    { run: () => void; actionType: string } | null
  >(null);

  // Networks list + resolved selected network (config tier). Replaces the raw
  // mount-fetch + resolve effects; `allNetworks`/`network` are now query-derived.
  const { data: networksData } = useNetworkConfigs();
  const allNetworks = React.useMemo<DotNetworkSchema[]>(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);

  const { data: resolvedNetwork } = useResolvedNetwork(selectedNetworkId);
  const network = resolvedNetwork;

  // My profiles across domains (own-data tier) + profile-consent status
  // (config tier). Replace the coordinated raw fetch; the gate reads both.
  const { data: myItems, isFetched: myItemsFetched } = useMyItems(network);
  const consentQuery = useProfileConsentStatus(network);
  const consentedProfileIds = consentQuery.data ?? new Set<string>();
  // Settled = query resolved either way (fail-open: an error yields an empty set
  // and still marks loaded, so the gate can prompt). Signed-out users have no
  // profiles/consent to wait for — resolved immediately.
  const profilesResolved = !user || myItemsFetched;
  const consentLoaded = !user || consentQuery.isSuccess || consentQuery.isError;
  const queryClient = useQueryClient();

  // Default the selected network to the first available once the list loads
  // (only when nothing is selected yet) — previously done in the mount fetch.
  React.useEffect(() => {
    if (selectedNetworkId) return;
    const first = allNetworks[0]?.id;
    if (first) setSelectedNetworkId(first);
  }, [allNetworks, selectedNetworkId]);

  React.useEffect(() => {
    if (!selectedNetworkId) {
      setActiveProfileId(null);
      return;
    }
    setActiveProfileId(getStoredActiveProfileId(selectedNetworkId));
  }, [selectedNetworkId]);

  // Resolve a map marker's label from its domain's card.title_field so titles
  // are correct even in the "All" view where markers span multiple domains.
  const resolveMarkerLabel = React.useCallback(
    (item: { id: string; domain?: string; data: Record<string, unknown> }) => {
      const domain = item.domain
        ? network?.domains.find((d) => d.id === item.domain)
        : undefined;
      const titleField = domain?.card?.title_field;
      const value = titleField ? item.data[titleField] : undefined;
      return value != null && String(value).trim() ? String(value) : undefined;
    },
    [network]
  );

  // Restore or auto-select the active profile once per network, when my-profiles
  // have settled. A ref guards against re-running on a background refetch
  // (which must not reset the user's manual selection).
  const restoredForNetwork = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!user) {
      // Signed out: clear selection + any open consent gate, and allow
      // restoration to re-run on next sign-in.
      setActiveProfileId(null);
      setPendingConsentProfileId(null);
      restoredForNetwork.current = null;
      return;
    }
    if (!network || !myItemsFetched) return;
    if (restoredForNetwork.current === network.id) return;
    restoredForNetwork.current = network.id;

    const storedId = getStoredActiveProfileId(network.id);
    if (storedId && myItems.some((p) => p.item_id === storedId)) {
      setActiveProfileId(storedId);
    } else if (myItems.length > 0) {
      setActiveProfileId(myItems[0].item_id);
      setStoredActiveProfileId(network.id, myItems[0].item_id);
    } else {
      setActiveProfileId(null);
      clearStoredActiveProfileId(network.id);
    }
  }, [user, network, myItemsFetched, myItems]);

  // Derive the active profile from myItems
  const myItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

  // Item ids the active profile already has an OPEN action with — either
  // direction (I initiated to them, or they to me). Their Connect/Apply CTA is
  // disabled: at most one open action per pair (#370/#422). The server cap is
  // the real guard; this just pre-empts the click. "Open" = not a terminal
  // status; the same terminal set the backend frees a pair on.
  const { data: myActionsData } = useActions('all', { enabled: !!user, limit: 100 });
  const openActionItemIds = React.useMemo(
    () => computeOpenActionItemIds(myActionsData?.actions ?? [], activeProfileId),
    [myActionsData, activeProfileId],
  );

  // A draft (incomplete) profile can't apply/connect — the API rejects it with
  // PROFILE_NOT_LIVE. Prompt the user to finish their profile (with a shortcut
  // to the edit form) instead of surfacing that error. Returns true when the
  // profile is draft (caller should abort the action).
  const promptCompleteDraftProfile = React.useCallback(
    (profile: Item): boolean => {
      if (profile.lifecycle_status !== 'draft') return false;
      toast.warning(t('home.toast_profile_draft'), {
        description: t('home.toast_profile_draft_desc'),
        action: {
          label: t('home.toast_profile_draft_cta'),
          onClick: () =>
            navigate(
              `/profile/${profile.item_id}/edit?network=${encodeURIComponent(profile.item_network)}`,
            ),
        },
      });
      return true;
    },
    [navigate, t],
  );

  // Derive the active profile's first location (profile-first), or null to trigger browser-geo fallback
  const profileLocation = React.useMemo(
    () =>
      myItem?.item_locations?.[0]
        ? { lat: myItem.item_locations[0].lat, lng: myItem.item_locations[0].lng }
        : null,
    [myItem],
  );

  // Resolve: profile location → browser geo → null. Gate the browser auto-prompt
  // on profilesResolved so a logged-in user with a profile location isn't prompted
  // during the async profile-load window.
  const [preferredSource, setPreferredSource] =
    React.useState<PreferredLocationSource>('profile');

  const {
    location: userLocation,
    source: resolvedLocationSource,
    browser: browserLocation,
  } = useUserLocation(profileLocation, profilesResolved, preferredSource);
  const geoPermission = useGeolocationPermission();

  // The toggle only makes sense when there's a profile location to switch away
  // from and the browser can actually provide the alternative.
  const canToggleLocation = computeCanToggleLocation(profileLocation, browserLocation.isSupported);

  // When the user picked "current location" but the browser request errored
  // (denied / unavailable), offer to enable it. Gated on canToggleLocation so
  // the banner only appears while a profile location exists — i.e. results are
  // still sorted by the profile fallback, which the banner copy reflects.
  const showLocationBanner = computeShowLocationBanner(
    canToggleLocation,
    preferredSource,
    browserLocation.status,
  );

  // Bumped whenever the user switches source so the map recenters on the chosen
  // anchor even when the resolved coordinate is unchanged — e.g. switching back
  // to "My profile" after a "Current location" attempt that was denied and fell
  // back to the same profile coordinate, so panning-away is undone. (Re-picking
  // the already-active source can't happen: radix single-toggle deselects to ''
  // and handleLocationSourceChange ignores it.)
  const [recenterNonce, setRecenterNonce] = React.useState(0);

  // Bumped right before a marker popup's Connect/Apply action opens the
  // consent modal, so the map provider closes the popup first — otherwise the
  // popup (a map overlay in a high stacking context) sits on top of the
  // modal's bottom-sheet Drawer on mobile, making the consent checkbox +
  // Confirm unreachable (Issue #1).
  const [closePopupNonce, setClosePopupNonce] = React.useState(0);

  const handleLocationSourceChange = React.useCallback(
    (next: PreferredLocationSource) => {
      setPreferredSource(next);
      setRecenterNonce((n) => n + 1);
      // An explicit "Current location" click always retries the geolocation
      // request. The auto-request effect only fires from an `idle` state, so
      // without this a second click after a dismiss/error would do nothing —
      // whereas the browser will re-prompt on a fresh request while the
      // permission is still promptable (i.e. not a real block).
      if (next === 'browser' && browserLocation.status !== 'loading') {
        void browserLocation.request();
      }
    },
    [browserLocation],
  );

  // Profile-creation consent gate. Profiles created via the aggregator channel
  // have no profile_creation consent recorded; selecting one must first prompt.
  const { config: consentConfig } = useConsentConfig();
  const { brand } = useNetworkTheme();
  const profileDoc = consentConfig?.documents.profile_creation;
  const profileVersion = profileDoc?.versions.find(
    (v) => v.version === profileDoc.current_version,
  );
  const profileStatement = profileVersion?.statement ?? '';
  // Whether the active profile's DOMAIN gates go-live on `consent_required`
  // (mirrors `go_live_required` in network.json). A domain that goes live on
  // completeness alone (e.g. a provider configured `["schema_required"]`) never
  // prompts for profile_creation consent. Absent config ⇒ require (safe default,
  // matches the login-gate behaviour).
  const profileConsentRequired = computeProfileConsentRequired(
    profileStatement,
    network?.domains,
    myItem?.item_domain,
  );

  // Shared profile_creation-consent accept flow (adult self-accept OR minor
  // guardian-OTP), extracted into a hook so it isn't duplicated with
  // profile-form-page. `dialogs` hosts the guardian OTP/capture dialogs;
  // `guardianActive` is true while one is open, so the ProfileConsentModal below
  // hides itself instead of stacking.
  const {
    accept: acceptProfileConsentFlow,
    dialogs: consentAcceptDialogs,
    guardianActive,
  } = useProfileConsentAccept();

  // Gate the auto-selected profile: if it lacks profile_creation consent, prompt.
  React.useEffect(() => {
    if (
      // Never gate a signed-out user. `activeProfileId` can briefly hold a
      // stale localStorage value (from a prior session) after sign-out or when
      // a different/no-profile user signs in — before the restore effect nulls
      // it. Requiring `user` + that the id is a real OWNED profile in myItems
      // stops the consent modal flashing for logged-out or profile-less users.
      !user ||
      !myItems.some((p) => p.item_id === activeProfileId) ||
      !profilesResolved ||
      !consentLoaded ||
      !profileConsentRequired ||
      !activeProfileId ||
      pendingConsentProfileId !== null ||
      consentedProfileIds.has(activeProfileId)
    ) {
      return;
    }
    setPendingConsentProfileId(activeProfileId);
  }, [
    user,
    myItems,
    profilesResolved,
    consentLoaded,
    profileConsentRequired,
    activeProfileId,
    consentedProfileIds,
    pendingConsentProfileId,
  ]);

  // U18 guardian consent gate (Phase 6). Domain is derived from the ward's
  // own existing profile item — never a registration dropdown. Only wards
  // whose profile domain is `guardian_consent_required` AND who still need
  // the adult-equivalent terms/privacy consent (the same signal the ordinary
  // flow uses; the guardian-OTP-verify endpoint records those categories on
  // success) are routed through the guardian flow — everyone else (adults,
  // ungated domains, users with no profile yet) is unaffected.
  const wardDomain = myItem?.item_domain ?? null;
  const requiresGuardianGate = computeRequiresGuardianGate(user, network, wardDomain);
  const {
    needed: u18NeededConsent,
    isLoading: u18GateLoading,
    refetch: refetchU18Gate,
  } = useConsentGate();
  const [guardianFlowDismissed, setGuardianFlowDismissed] = React.useState(false);

  // Re-evaluate from scratch if the acting network or ward domain changes
  // (e.g. switching networks, or the active profile changing) instead of
  // staying dismissed forever.
  React.useEffect(() => {
    setGuardianFlowDismissed(false);
  }, [network?.id, wardDomain]);

  // Stored U18 status (birth month/year captured ONCE at login). We read it
  // instead of re-asking the DOB at profile-creation time: if birth data is
  // already stored we skip the DOB step entirely, and a stored ADULT is never
  // routed through the guardian flow at all.
  const [u18Status, setU18Status] = React.useState<U18StatusResponse | null>(null);
  const [u18StatusLoading, setU18StatusLoading] = React.useState(false);
  // Bumped after the guardian flow completes so the stored status (birth data +
  // guardianVerified) is re-read — otherwise it stays stale and a later profile
  // creation re-triggers the DOB step even though the ward already finished it.
  const [u18StatusReload, setU18StatusReload] = React.useState(0);
  React.useEffect(() => {
    // Fetch whenever authenticated + on a network — NOT only when a profile
    // already exists. Otherwise the very first profile creation can't tell the
    // ward is a minor (no prior profile → no fetch) and skips the guardian gate.
    if (!user || !network) {
      setU18Status(null);
      return;
    }
    let cancelled = false;
    setU18StatusLoading(true);
    getU18Status(network.id)
      .then((s) => { if (!cancelled) setU18Status(s); })
      // On failure fall back to the DOB-capture path (u18Status stays null →
      // initialStep 'dob'); never leave a minor ungated on a transient error.
      .catch(() => { if (!cancelled) setU18Status(null); })
      .finally(() => { if (!cancelled) setU18StatusLoading(false); });
    return () => { cancelled = true; };
  }, [user, network, network?.id, u18StatusReload]);

  // U18 guardian-flow display state, derived from the stored status + gate
  // signals. See `deriveU18GuardianState` for the per-flag rationale:
  //  - resolvedAdult: stored data resolves the ward as an adult → no guardian
  //    gate; the ordinary consent flow (ProfileConsentModal) handles T&P.
  //  - initialStep: DOB is captured ONCE and reused — skip the DOB step when
  //    birth data is already stored; capture it here only when nothing is stored.
  //  - birthUnresolved: minor status not yet resolved (no birth captured) — must
  //    run the flow (DOB step) even when T&P is already satisfied, else a
  //    bulk/form ward who self-accepted T&P at login is never asked for DOB and
  //    the server can't detect a minor, bypassing the gate.
  //  - minorNeedsGuardian: a resolved minor who isn't guardian-verified yet must
  //    be gated even when T&P happens to be satisfied, else they land in the app
  //    un-gated with no way to attach a guardian.
  const {
    initialStep: u18InitialStep,
    showFlow: showU18GuardianFlow,
  } = deriveU18GuardianState({
    status: u18Status,
    statusLoading: u18StatusLoading,
    gateLoading: u18GateLoading,
    dismissed: guardianFlowDismissed,
    requiresGate: requiresGuardianGate,
    neededConsentCount: u18NeededConsent.length,
  });

  // Acting domain: ?as= test override → served binding → active profile →
  // network default. Drives the connect-action source (from_domain).
  const currentDomain =
    searchParams.get('as') ??
    boundDomain ??
    myItem?.item_domain ??
    network?.domains[0]?.id ??
    'student_profile';

  // Viewer domain for Browse scoping: ?as= → the single served domain (when
  // exactly one is served) → the logged-in user's own profile domain → null.
  // A signed-in viewer only browses the domains their domain can initiate
  // toward (e.g. a seeker sees providers, not other seekers) in bound portals
  // and the combined UI alike. Null (only a signed-out / no-profile visitor)
  // means network-wide browse — all to_domains (computeVisibleDomains).
  const viewerDomain =
    searchParams.get('as') ?? boundDomain ?? myItem?.item_domain ?? null;

  const visibleDomains = React.useMemo(
    () => (network ? computeVisibleDomains(network, viewerDomain) : []),
    [network, viewerDomain],
  );

  // Domains whose fields drive the browse filters, keyed on the sidebar Browse
  // selection: a specific domain → only that domain's fields (a provider
  // viewing "Seekers" filters by seeker fields, viewing "Providers" by provider
  // fields). "All" (null) → the counterpart domains (visible minus the viewer's
  // own) so a provider's default view filters seekers, not the provider fields
  // pulled in by a provider→provider "connect" self-edge; falls back to all
  // visible domains when that would leave nothing (self-only interaction, or a
  // signed-out viewer with no domain identity).
  const filterFieldDomains = React.useMemo(() => {
    if (selectedDomain) {
      const selected = visibleDomains.filter((d) => d.id === selectedDomain);
      if (selected.length > 0) return selected;
    }
    const counterparts = visibleDomains.filter((d) => d.id !== viewerDomain);
    return counterparts.length > 0 ? counterparts : visibleDomains;
  }, [visibleDomains, viewerDomain, selectedDomain]);

  React.useEffect(() => {
    if (!network) return;
    if (selectedDomain === null) return;
    if (!visibleDomains.some((d) => d.id === selectedDomain)) {
      setSelectedDomain(null);
      setSearchParams((prev) => {
        prev.delete('domain');
        return prev;
      });
    }
  }, [network, selectedDomain, visibleDomains, setSearchParams]);

  // #203 Task 7: the enum-field facet filters (`mapSelectedFields`, driven by
  // `MapFiltersPanel`) now reach the server on the MAP path — sent as
  // `item_state.<field>` markers params (`network-api.ts`'s `fetchNetworkMarkers`
  // serializes each field's selected values as REPEATED query params, which
  // the server's `qs`-based parser auto-arrays into `string[]`, matching
  // `buildWhereClause`'s `= ANY(...)` facet filter — see Task 3). Computed
  // here (not down at `singleDomainCards`/`filteredAllDomainItems` below, its
  // other consumer) so it's available before `useMapMarkers` needs it.
  const activeFieldFilters = React.useMemo(
    () => Object.fromEntries(Object.entries(mapSelectedFields).filter(([, vals]) => vals.length > 0)),
    [mapSelectedFields],
  );

  // Task 6 (#203 §5.2): the map view is now sourced from viewport-scoped
  // markers rather than a full per-domain browse feed (that full fetch was
  // removed from this page entirely in Task 7 of the caching epic). The
  // top-bar free-text `search` now ALSO filters the map (map-native-text-search,
  // #394): it's forwarded to `useMapMarkers` below, which sends it to the
  // server as `/markers?q=` — a value-match against public (non-private)
  // `item_state` fields, viewport-scoped, same as the list's search. The list
  // still applies `search` itself via `buildFilteredCardsForDomain` below;
  // the two are independent filters over the same query, not one deriving
  // from the other. `MapFiltersPanel`'s enum-field facets, by contrast,
  // drive the map server-side directly via `activeFieldFilters` — #394
  // removed the `filterable: true` gate that used to additionally restrict
  // this to a network.json-marked subset; every declared, non-private enum
  // field the panel offers (the same full set the list uses,
  // `getEnumFilterFieldsForDomains`) is now sent and applied by the server's
  // facet guard (`resolveAllowedFacetFields`). See #360 for the proper
  // long-term schema-driven search/filter declaration. The domain
  // multi-select below (a client-side array-membership check on the
  // already-fetched markers) remains client/list-only; free-text search, per
  // the comment above, is sent to the server for both the map and the list.
  //
  // Even at low zoom for an anonymous / no-location visitor we now fetch the
  // slim viewport markers (coords only, capped at MAP_FETCH_LIMIT) and cluster
  // them, rather than the old count-only pull that showed just aggregate text.
  // Clustering already bounds on-screen density, and a visitor needs to SEE
  // where items are to know where to zoom — "N results, zoom in" gave no clue
  // where. A small non-blocking count pill (below) keeps the aggregate visible.
  // `meta.total` still reports the true match count regardless of the fetch cap.
  // Scope the map to the active Browse tab: a single-domain tab (Seeker /
  // Provider) fetches + shows only that domain's pins; the "All" tab shows every
  // visible domain (further narrowed by the Filters-panel domain toggle below).
  // Keeps the map consistent with the list + header count, which are already
  // scoped to `selectedDomain` — previously the tab only filtered the list and
  // the map kept showing all domains.
  const mapDomains = React.useMemo(
    () => (selectedDomain ? visibleDomains.filter((d) => d.id === selectedDomain) : visibleDomains),
    [selectedDomain, visibleDomains],
  );
  const mapMarkers = useMapMarkers(network, mapDomains, mapViewport, activeFieldFilters, search);

  // On the "All" tab the Filters-panel domain multi-select narrows which pins
  // show (client-side membership check — every `Marker` carries `item_domain`).
  // On a single-domain tab the fetch above is already scoped to that domain, so
  // that multi-select (an "All"-tab control) does not apply.
  // The viewer's own item ids across every domain — the map must never render
  // the viewer's own pins. The list feed already drops them (`excludeOwnItems`),
  // but the `/markers` path had no such filter, so an own profile showed on the
  // map with a Connect button (you can't act on yourself). All domains, not just
  // `currentDomain`, because the "All" map view spans domains.
  const ownMapItemIds = React.useMemo(
    () => new Set((myItems ?? []).map((it) => it.item_id)),
    [myItems],
  );

  const mapItems = React.useMemo(
    () =>
      mapMarkers.markers
        .filter((m) => !ownMapItemIds.has(m.item_id))
        .filter(
          (m) =>
            selectedDomain != null ||
            mapSelectedDomains.length === 0 ||
            mapSelectedDomains.includes(m.item_domain),
        )
        .map((m) => ({
          id: m.item_id,
          domain: m.item_domain,
          data: { item_locations: m.item_locations },
        })),
    [selectedDomain, mapMarkers.markers, mapSelectedDomains, ownMapItemIds],
  );

  const localProfileItemIds = React.useMemo(
    () => new Set(myItems.filter((item) => item.item_domain === currentDomain).map((item) => item.item_id)),
    [myItems, currentDomain]
  );

  // --- Task 5 (#203 §5.1): paged infinite-scroll list view ------------------
  // The selected domain's full schema object (needed by the paged hook), and
  // the coords used to drive server-side nearest ordering. Coords are omitted
  // (null) when there is no known location — the hook then fetches unordered.
  const selectedDomainObj = React.useMemo(
    () => (selectedDomain ? (network?.domains.find((d) => d.id === selectedDomain) ?? null) : null),
    [network, selectedDomain],
  );
  const browseCoords = React.useMemo(
    () => (userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null),
    [userLocation],
  );

  // #394: the list ALWAYS uses the discover BFF now — map the search box +
  // facet selections to the shared discover params (see `deriveBrowseParams`;
  // `relevance` is unconditionally true, there is no more ranked/proximity
  // split). The resolved viewer location (`browseCoords`, from
  // `LocationSourceToggle`/`preferredSource`) is ALWAYS forwarded too — it's
  // `null` when none is available (no profile location AND browser location
  // denied/unsupported), in which case discover just runs anchor-only (or
  // fully unranked-by-location for a signed-out viewer).
  const browseParams = React.useMemo<DerivedBrowseParams>(
    () => deriveBrowseParams({ search, activeFieldFilters }),
    [search, activeFieldFilters],
  );
  const browseLocation = browseCoords;
  // #394: shared discover params for both list paths — q/filters/relevance are
  // the same regardless of which domain is being browsed. `anchorItemId` is
  // deliberately NOT included here: signals-search enforces the network's
  // interaction matrix and 403s (`INTERACTION_NOT_ALLOWED`) when the anchor's
  // domain has no defined interaction with the browsed domain (e.g. a seeker
  // browsing seekers), so the anchor must be computed PER target domain (see
  // `anchorFor` below) rather than shared.
  const browseHookOpts = React.useMemo(
    () => ({
      q: browseParams.q,
      filters: browseParams.filters,
      relevance: browseParams.relevance,
    }),
    [browseParams],
  );
  // True when the active feed is served by the discover BFF (q OR filters OR
  // relevance) — the server has already applied text + facet filtering, so the
  // client-side filters in `buildFilteredCardsForDomain` must be bypassed.
  const listDiscover = isDiscoverActive(browseParams);

  // #394: per-target-domain anchor. `myItem` (the resolved active profile,
  // defined above) supplies the anchor's own domain; `anchorItemIdForTarget`
  // consults the schema's interaction matrix (`network.actions[].interactions`)
  // to decide whether that domain may anchor discover calls for `targetDomain`.
  const anchorFor = React.useCallback(
    (targetDomain: string): string | undefined =>
      anchorItemIdForTarget({
        activeProfileId,
        activeProfileDomain: myItem?.item_domain ?? null,
        targetDomain,
        actions: network?.actions ?? {},
      }),
    [activeProfileId, myItem, network],
  );

  // Single-domain paged fetch. Enabled only while a specific domain tab is
  // selected; disabled (and thus inert) on the "All" tab.
  const singleDomainList = useInfiniteBrowseItems(
    network,
    selectedDomainObj,
    browseLocation,
    {
      enabled: selectedDomain !== null,
      ...browseHookOpts,
      anchorItemId: resolveSingleDomainAnchor(selectedDomain, anchorFor),
    },
  );

  // Own-item filtering is a view concern (mirrored below by
  // `allDomainItemsFiltered` for the "All" tab) — apply the same rule to the
  // paged feed so a viewer never sees their own profile in their own browse
  // list. Runs UPSTREAM of the discover bypass so it applies in both modes.
  const singleDomainItems = React.useMemo(
    () => excludeOwnItems(singleDomainList.items, localProfileItemIds),
    [singleDomainList.items, localProfileItemIds],
  );

  // Single-domain: bottom sentinel advances the paged fetch. Server already
  // orders nearest-first (§4.1), so no client `sortByNearest` for this path.
  // (`useLoadMoreSentinel` reads the callback through a ref, so passing the
  // hook's non-memoized `fetchNextPage` directly is safe — see its comment.)
  const singleDomainSentinelRef = useLoadMoreSentinel(
    singleDomainList.fetchNextPage,
    singleDomainSentinelEnabled(selectedDomain, singleDomainList.hasNextPage),
  );

  // "All" tab: each visible domain's paged state, lifted up from its headless
  // <DomainPagedFetch> child (one hook call per child — legal; hooks can't be
  // called in a loop). Keyed by domain id.
  const [allDomainPages, setAllDomainPages] = React.useState<Record<string, DomainPageState>>({});

  // `DomainPagedFetch` re-invokes this on every one of its renders (its
  // `list.items` array is never referentially stable — see its effect), so
  // this lift must be idempotent itself: bail out of the `setState` when the
  // domain's data hasn't actually changed, so React skips the re-render and
  // the loop terminates. "Unchanged" is element-wise reference equality on
  // `items` (individual item object refs ARE stable across a plain
  // re-render, and only change when React Query actually refetches), plus
  // `hasMore`/`total`/`isLoading`/`partial`. `fetchNext`'s identity always
  // changes and is intentionally excluded from the comparison — we still
  // store the latest one, just don't gate on it.
  const handleDomainItems = React.useCallback(
    (
      domainId: string,
      items: Item[],
      hasMore: boolean,
      total: number,
      isLoading: boolean,
      fetchNext: () => void,
      partial: boolean,
      degraded: boolean,
      distanceMeters: number | undefined,
    ) => {
      setAllDomainPages((prev) => {
        const existing = prev[domainId];
        const itemsUnchanged =
          existing !== undefined &&
          existing.items.length === items.length &&
          existing.items.every((it, i) => it === items[i]);
        if (
          itemsUnchanged &&
          existing.hasMore === hasMore &&
          existing.total === total &&
          existing.isLoading === isLoading &&
          existing.partial === partial &&
          existing.degraded === degraded &&
          existing.distanceMeters === distanceMeters
        ) {
          // Same data (plain re-render): bail so React doesn't re-render → no loop.
          return prev;
        }
        return {
          ...prev,
          [domainId]: { items, hasMore, total, isLoading, fetchNext, partial, degraded, distanceMeters },
        };
      });
    },
    [],
  );

  // Own-item-filtered accumulated union across all "All"-tab domains (mirrors
  // `singleDomainItems` above). The merged grid and its `fullItem` lookups
  // read this.
  const allDomainItemsFiltered = React.useMemo(() => {
    const result: Record<string, Item[]> = {};
    for (const [domainId, state] of Object.entries(allDomainPages)) {
      result[domainId] = excludeOwnItems(state.items, localProfileItemIds);
    }
    return result;
  }, [allDomainPages, localProfileItemIds]);

  const fetchNextAllDomainPages = React.useCallback(() => {
    for (const state of Object.values(allDomainPages)) {
      if (state.hasMore) state.fetchNext();
    }
  }, [allDomainPages]);
  // Iterate `visibleDomains` (not all of `allDomainPages`) so a domain that
  // scrolled out of view (e.g. a domain-tab/served-scope change) doesn't keep
  // inflating this via a stale entry that's no longer rendered (Fix C).
  const anyAllDomainHasMore = visibleDomains.some((domain) => allDomainPages[domain.id]?.hasMore ?? false);
  const allDomainsSentinelRef = useLoadMoreSentinel(
    fetchNextAllDomainPages,
    allDomainsSentinelEnabled(selectedDomain, anyAllDomainHasMore),
  );
  // --- end Task 5 -------------------------------------------------------------

  // Task 6 (#203 §6): "All" tab total for the X-of-Y indicator is the sum of
  // each visible domain's server-reported total (no single server call spans
  // domains, so there's no one `meta.total` to read). P3 surfaces meta.total
  // only — the federation-degradation banner (meta.partial/unavailable_instances)
  // lands in P5 below.
  // Sum only over `visibleDomains` — `allDomainPages` entries are never pruned
  // when `visibleDomains` shrinks, so a no-longer-visible domain would keep
  // inflating the "X of Y" if we reduced over all of `allDomainPages` instead.
  const allDomainsTotalCount = React.useMemo(
    () =>
      visibleDomains.reduce((sum, domain) => {
        const state = allDomainPages[domain.id];
        return state ? sum + state.total : sum;
      }, 0),
    [visibleDomains, allDomainPages],
  );
  // Raw loaded count (mirrors the single-domain path's raw `items.length`):
  // sums the unfiltered per-domain page items, NOT `allFlatItems.length`
  // (which is post search/enum-filter). The indicator must reflect pagination
  // truncation only, not client-side filtering.
  const allDomainsLoadedCount = React.useMemo(
    () =>
      visibleDomains.reduce((sum, domain) => {
        const state = allDomainPages[domain.id];
        return state ? sum + state.items.length : sum;
      }, 0),
    [visibleDomains, allDomainPages],
  );
  // Task 7 (#203 §5.2 cleanup): the "All" tab's loading gate, re-sourced from
  // the paged hooks (`allDomainPages`, lifted per-domain from
  // `useInfiniteBrowseItems` via `DomainPagedFetch`) instead of the removed
  // full `useBrowseItems` fetch's single `isLoading`. A domain missing from
  // `allDomainPages` (its `DomainPagedFetch` child hasn't committed its first
  // effect yet) counts as still loading, so the skeleton doesn't flash empty
  // before every visible domain has reported in.
  const allDomainsLoading = visibleDomains.some(
    (domain) => allDomainPages[domain.id]?.isLoading ?? true,
  );

  // P5 (#203 §6): "All" tab is partial if ANY visible domain's paged feed is
  // partial — mirrors `allDomainsTotalCount`'s "sum over `visibleDomains` only"
  // rule so a domain that scrolled out of view can't keep the banner up.
  const allDomainsListPartial = visibleDomains.some(
    (domain) => allDomainPages[domain.id]?.partial ?? false,
  );
  // Single source of truth for the list federation-degradation banner
  // (mirrors the map's `mapMarkers.partial` from P4): single-domain tab reads
  // the one paged feed directly, "All" tab is the OR above.
  const listPartial = selectByDomainScope(selectedDomain, singleDomainList.partial, allDomainsListPartial);

  // Task 6 (#203 §6): mirrors `allDomainsListPartial`/`listPartial` exactly,
  // but for the discover BFF's native-fallback signal instead of federation
  // partiality — "All" tab is degraded if ANY visible domain's paged feed
  // fell back to native.
  const allDomainsListDegraded = visibleDomains.some(
    (domain) => allDomainPages[domain.id]?.degraded ?? false,
  );
  // Single source of truth for the degraded-search UX: single-domain tab reads
  // the one paged feed directly, "All" tab is the OR above.
  const listDegraded = selectByDomainScope(selectedDomain, singleDomainList.degraded, allDomainsListDegraded);

  // #394: the effective spatial radius (`meta.distance_meters`), same
  // single-domain-vs-"All" split as `listPartial`/`listDegraded` above. On the
  // "All" tab every visible domain shares the same location + radius config,
  // so the first domain to report one is representative of all of them.
  const allDomainsDistanceMeters = visibleDomains
    .map((domain) => allDomainPages[domain.id]?.distanceMeters)
    .find((value) => value !== undefined);
  const listDistanceMeters = selectByDomainScope(
    selectedDomain,
    singleDomainList.distanceMeters,
    allDomainsDistanceMeters,
  );

  // #394 (review fix): whether the viewer actually has a profile anchor being
  // sent for the browsed domain(s) — derived from the SAME rule that gates
  // the anchor itself (`anchorFor`/`anchorItemIdForTarget`, both built on
  // `domainsInteract`), not the looser "signed in with an active profile"
  // check this used to be. A directory-style network can have a selected (or,
  // on "All", every visible) domain with NO interaction edge to the viewer's
  // own profile domain — no anchor is sent for that view at all, and the note
  // must not claim profile-relevance when nothing was actually anchored.
  // Single-domain tab: gate on that one target domain via `anchorFor` (the
  // exact function `singleDomainList` calls above). "All"/no-selection view:
  // true iff the viewer's profile domain interacts with at least one visible
  // domain (mirrors `computeVisibleDomains`' own per-domain anchor gating).
  const activeProfileDomain = myItem?.item_domain ?? null;
  const hasProfileAnchor = computeHasProfileAnchor({
    selectedDomain,
    anchorFor,
    activeProfileId,
    activeProfileDomain,
    visibleDomains,
    networkActions: network?.actions ?? {},
  });
  // Whether a location is actually being sent as the discover spatial filter.
  const hasLocation = browseLocation !== null;
  const listNote = resolveListNote({
    hasProfileAnchor,
    hasLocation,
    degraded: listDegraded,
    distanceMeters: listDistanceMeters,
    // The EFFECTIVE source of the coordinate actually sent (not the toggle
    // preference): logged out / no profile → useUserLocation falls back to the
    // browser coordinate, so the note must say "current location", not "your
    // profile location". `preferredSource` stays 'profile' by default even when
    // no profile exists, which produced the wrong wording. 'none' can't reach
    // the km-bearing note branch (hasLocation would be false), so map it to the
    // 'profile' default harmlessly.
    locationSource: noteLocationSource(resolvedLocationSource),
  });

  // Active schema: from the selected browsing domain, or first visible domain
  const activeSchema = React.useMemo(() => {
    if (!network) return undefined;
    const domainId = selectedDomain ?? visibleDomains[0]?.id;
    const domain = network.domains.find((d) => d.id === domainId) ?? network.domains[0];
    if (!domain) return undefined;
    return domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
  }, [network, selectedDomain, visibleDomains]);

  // Build domain → schema map for sidebar profile title resolution
  const userSchemas = React.useMemo(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // Get all available actions for a given target domain
  // Browse requires an active profile (myItem) as the source; the shared helper
  // flattens the interaction matrix for currentDomain -> targetDomain.
  const getActionsForDomain = React.useCallback(
    (targetDomainId: string): DotActionSchema[] =>
      myItem ? flattenInteractionActions(network, currentDomain, targetDomainId) : [],
    [network, currentDomain, myItem]
  );

  const handleBulkConnect = React.useCallback(
    async (actionType: string, formData: Record<string, unknown>, confirmed = false) => {
      if (!myItem || !network) return;
      // Draft source profile can't act — prompt to complete it, don't submit.
      if (promptCompleteDraftProfile(myItem)) {
        setBulkConnectOpen(false);
        return;
      }
      // Minor ward: confirm before the guardian OTP is dispatched (the bulk
      // perform below is what sends it) — same "proceed?" step as single actions.
      if (
        !confirmed &&
        u18Status?.isMinor === true &&
        !!wardDomain &&
        isGuardianConsentRequiredDomain(network, wardDomain)
      ) {
        setBulkConnectOpen(false);
        setBulkGuardianConfirm({
          actionType,
          run: () => { void handleBulkConnect(actionType, formData, true); },
        });
        return;
      }
      setBulkConnectBusy(true);
      try {
        // Task 7 (#203 §5.2 cleanup): bulk-select only renders in the LIST
        // view (see `browseSelection.selectMode` below), so its candidates are
        // always sourced from whichever paged list feed is currently active —
        // never from the map/markers, so no `mapDetailItem` fallback is needed
        // here (contrast `onActionSubmit` below).
        const allItems =
          selectedDomain === null ? Object.values(allDomainItemsFiltered).flat() : singleDomainItems;
        const ids = Array.from(browseSelection.selected);
        const targets = ids
          .map((id) => allItems.find((i) => i.item_id === id))
          .filter((t): t is Item => !!t);

        // Guard: nothing valid to send (e.g. selection went stale after a reload)
        if (targets.length === 0) {
          setBulkConnectOpen(false);
          browseSelection.exitSelect();
          return;
        }

        const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
        const consent =
          consentRaw &&
          typeof consentRaw === 'object' &&
          (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
          typeof (consentRaw as { version?: unknown }).version === 'number'
            ? {
                acknowledged: true as const,
                version: (consentRaw as { version: number }).version,
                brand: (consentRaw as { brand?: string | null }).brand,
              }
            : undefined;

        const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
          ? apiConfig.getUrl()
          : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl());

        const payloads = targets.map((targetItem) => {
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl());
            return {
              action_type: actionType,
              source_item: {
                item_network: myItem.item_network,
                item_domain: myItem.item_domain,
                item_type: myItem.item_type,
                item_id: myItem.item_id,
              },
              target_item: {
                item_network: targetItem.item_network,
                item_domain: targetItem.item_domain,
                item_type: targetItem.item_type,
                item_id: targetItem.item_id,
                item_instance_url: targetItemInstanceUrl,
              },
              requirements_snapshot: requirementsSnapshot,
              ...(consent ? { consent } : {}),
            };
          });

        const env = await performActionsBulk(payloads, sourceItemInstanceUrl);
        // New actions must surface without waiting for the 60s poll (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
        setBulkConnectOpen(false);

        if (env.summary.failed === 0) {
          toast.success(t('home.bulk_connected_all', { count: env.summary.succeeded }));
          browseSelection.exitSelect();
        } else {
          // Minor ward: if the failures are the guardian-OTP challenge, don't
          // surface the raw message — open ONE guardian OTP dialog for the batch
          // and resubmit those payloads with the code (mirrors single actions).
          const failedResults = env.results.filter((r) => r.status === 'error');
          const guardianResults = failedResults.filter(
            (r) => guardianOtpErrorOf(r) === 'GUARDIAN_OTP_REQUIRED',
          );
          // Any GUARDIAN_OTP_REQUIRED failure means a code was already sent to the
          // guardian — open the dialog for those items even in a mixed batch, so
          // the sent OTP isn't wasted on the generic error path. Non-guardian
          // failures ride along and are reselected once the dialog resolves.
          if (guardianResults.length > 0) {
            setBulkConnectOpen(false);
            const otherFailedIds = failedResults
              .filter((r) => guardianOtpErrorOf(r) !== 'GUARDIAN_OTP_REQUIRED')
              .map((r) => targets[r.index].item_id);
            setBulkGuardianChallenge({
              payloads: guardianResults.map((r) => payloads[r.index]),
              sourceInstanceUrl: sourceItemInstanceUrl,
              actionType,
              otherFailedIds: otherFailedIds.length > 0 ? otherFailedIds : undefined,
            });
            return; // the guardian OTP dialog owns the resubmit
          }
          const failedIdxs = bulkFailureIndices(env);
          const failedIds = failedIdxs.map((i) => targets[i].item_id);
          const firstErr = firstBulkError(env);
          toast.warning(
            t('home.bulk_connected_partial', {
              succeeded: env.summary.succeeded,
              total: env.summary.total,
            }),
            {
              description: firstErr
                ? t('home.bulk_connect_first_error', { message: firstErr })
                : undefined,
            },
          );
          browseSelection.setSelected(failedIds);
        }
      } catch (err) {
        toast.error(t('home.bulk_connect_failed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBulkConnectBusy(false);
      }
    },
    [
      myItem,
      network,
      selectedDomain,
      allDomainItemsFiltered,
      singleDomainItems,
      browseSelection.selected,
      browseSelection.exitSelect,
      browseSelection.setSelected,
      promptCompleteDraftProfile,
      u18Status,
      wardDomain,
      t,
    ],
  );

  // Legacy: single active action for the selected domain (for CardGrid)
  const activeAction = React.useMemo<DotActionSchema | null>(() => {
    const toDomain = selectedDomain ?? visibleDomains[0]?.id;
    if (!toDomain) return null;
    const actions = getActionsForDomain(toDomain);
    return actions[0] ?? null;
  }, [getActionsForDomain, selectedDomain, visibleDomains]);

  // Build per-domain card items filtered by search, domain, and status, for
  // the LIST view (the map view reads viewport markers instead — decoupled
  // in Task 6/7, #203 §5.2).
  // Derive enum filter field metadata once (used in the memos below and in MapView)
  const enumFilterFields = React.useMemo(
    () => (network ? getEnumFilterFieldsForDomains(network.domains) : []),
    [network],
  );

  // Task 5 (#203 §5.1): the search/enum/map-domain filter, applied to the
  // paged feeds (the full-fetch `domainItems` snapshot this used to read from
  // was removed in Task 7). Single-domain list cards (server already orders
  // nearest-first — no client `sortByNearest`).
  const singleDomainCards = React.useMemo(
    () =>
      selectedDomain
        ? buildFilteredCardsForDomain(selectedDomain, singleDomainItems, {
            search,
            mapSelectedDomains,
            activeFieldFilters,
            enumFilterFields,
            discover: listDiscover,
          })
        : [],
    [selectedDomain, singleDomainItems, search, mapSelectedDomains, activeFieldFilters, enumFilterFields, listDiscover],
  );

  // "All" tab: same filter applied per-domain to the accumulated paged union.
  const filteredAllDomainItems = React.useMemo(() => {
    const result: Record<string, { id: string; domain: string; data: Record<string, unknown> }[]> = {};
    for (const domain of visibleDomains) {
      result[domain.id] = buildFilteredCardsForDomain(domain.id, allDomainItemsFiltered[domain.id] ?? [], {
        search,
        mapSelectedDomains,
        activeFieldFilters,
        enumFilterFields,
        discover: listDiscover,
      });
    }
    return result;
  }, [visibleDomains, allDomainItemsFiltered, search, mapSelectedDomains, activeFieldFilters, enumFilterFields, listDiscover]);

  const handleDomainSelect = (domainId: string | null) => {
    setSelectedDomain(domainId);
    // Switching the browse domain changes the available filter fields, so reset
    // the map domain + enum-field selections: a leftover domain chip from
    // another scope would otherwise hide every item, and stale field chips would
    // show as active even though their group is no longer rendered.
    setMapSelectedDomains([]);
    setMapSelectedFields({});
    setSearchParams((prev) => {
      if (domainId) {
        prev.set('domain', domainId);
      } else {
        prev.delete('domain');
      }
      prev.delete('map_domains');
      for (const key of [...prev.keys()]) {
        if (key.startsWith('f_')) prev.delete(key);
      }
      return prev;
    });
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setSearchParams((prev) => {
      prev.set('view', mode);
      return prev;
    });
  };

  const handleActiveProfileChange = (profileId: string) => {
    if (profileConsentRequired && !consentedProfileIds.has(profileId)) {
      setPendingConsentProfileId(profileId);
      return;
    }
    setActiveProfileId(profileId);
    if (network?.id) {
      setStoredActiveProfileId(network.id, profileId);
    }
  };

  const handleNetworkSelect = (networkId: string) => {
    setSelectedNetworkId(networkId);
    setSelectedDomain(null);
    setSearchParams((prev) => {
      prev.set('network', networkId);
      prev.delete('domain'); // Remove domain since it's network-specific
      return prev;
    });
  };

  const handleMapDomainsChange = (domains: string[]) => {
    setMapSelectedDomains(domains);
    setSearchParams((prev) => {
      if (domains.length > 0) {
        prev.set('map_domains', domains.join(','));
      } else {
        prev.delete('map_domains');
      }
      return prev;
    });
  };

  const handleMapFieldsChange = (fields: Record<string, string[]>) => {
    setMapSelectedFields(fields);
    setSearchParams((prev) => {
      // Remove all existing f_* params before re-writing
      const keysToDelete: string[] = [];
      for (const key of prev.keys()) {
        if (key.startsWith('f_')) keysToDelete.push(key);
      }
      for (const key of keysToDelete) prev.delete(key);
      // Write active field selections as ?f_<key>=value1,value2
      for (const [fieldKey, values] of Object.entries(fields)) {
        if (values.length > 0) {
          prev.set(`f_${fieldKey}`, values.map(encodeURIComponent).join(','));
        }
      }
      return prev;
    });
  };

  const showNetworkSelector = computeShowNetworkSelector(servedScope, allNetworks.length);

  // `|| undefined` preserves the "absent → undefined" contract the downstream
  // `?? 'items'` / prop defaults rely on (the shared resolver returns '').
  const currentDomainLabel = formatDomainLabel(selectedDomain, network?.domains) || undefined;

  // Get dynamic actions for the selected domain
  const actions = resolveDomainActions(selectedDomain, getActionsForDomain, activeAction);

  // Label the pending profile so the user knows which profile the (repeating)
  // consent popup is for — reuses the sidebar's title-field candidates.
  const pendingProfileLabel = React.useMemo(() => {
    if (!pendingConsentProfileId) return undefined;
    const profile = myItems.find((p) => p.item_id === pendingConsentProfileId);
    if (!profile) return undefined;
    const schema = userSchemas[profile.item_domain] as
      | { properties?: Record<string, unknown> }
      | undefined;
    const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
    const titleKey = candidates.find((c) => schema?.properties?.[c] !== undefined);
    const value = titleKey ? profile.item_state[titleKey] : undefined;
    return value ? String(value) : profile.item_domain;
  }, [pendingConsentProfileId, myItems, userSchemas]);

  // Nested render fn (not a const element) so the guardian-gate + brand
  // conditionals live inside a function, keeping HomePage's cognitive complexity
  // within bounds (SonarCloud S3776); called from both return branches below.
  const renderU18GuardianFlowModal = () =>
    showU18GuardianFlow && network ? (
      <U18GuardianFlow
        network={network.id}
        brand={brand === 'standard' ? null : brand}
        purpose={{ kind: 'profile' }}
        // Skip the DOB step when birth data is already stored (captured at
        // login) — we never re-ask the date of birth at profile-creation time.
        initialStep={u18InitialStep}
        onComplete={() => {
          setGuardianFlowDismissed(true);
          // Re-read stored U18 status so guardianVerified/birth data are fresh —
          // stops a later profile creation from re-asking the DOB.
          setU18StatusReload((n) => n + 1);
          void refetchU18Gate();
        }}
        onNotMinor={() => {
          setGuardianFlowDismissed(true);
          setU18StatusReload((n) => n + 1);
        }}
        onLogout={() => { void signOut(); }}
      />
    ) : null;

  const profileConsentModal = (
    <ProfileConsentModal
      // The U18 first-login gate takes priority; and `guardianActive` hides this
      // while the shared hook's guardian OTP/capture dialog is open (don't stack).
      open={Boolean(pendingConsentProfileId) && !showU18GuardianFlow && !guardianActive}
      statement={profileStatement}
      profileLabel={pendingProfileLabel}
      minor={u18Status?.isMinor === true}
      onAccept={async () => {
        const pending = pendingConsentProfileId;
        if (!pending || !network?.id || !profileDoc) return;
        const profile = myItems.find((p) => p.item_id === pending);
        if (!profile) {
          setPendingConsentProfileId(null);
          return;
        }
        // Adult self-accept OR a minor's guardian-OTP flow — the shared hook
        // handles the branch, records consent, promotes draft→live, updates the
        // profileConsent + my-items caches, and toasts once. For a minor, onDone
        // runs only after the guardian OTP verifies. On failure the hook toasts
        // and does NOT call onDone, so the prompt stays open for a retry.
        await acceptProfileConsentFlow({
          network: network.id,
          brand: brand === 'standard' ? null : brand,
          item: {
            item_id: profile.item_id,
            item_domain: profile.item_domain,
            item_type: profile.item_type,
          },
          version: profileDoc.current_version,
          isMinor: u18Status?.isMinor === true,
          // Guardian capture may reclassify the ward (or capture a guardian);
          // re-sync U18 status so a retry runs with the corrected status.
          onGuardianStatusChanged: () => setU18StatusReload((n) => n + 1),
          onDone: () => {
            setActiveProfileId(pending);
            setStoredActiveProfileId(network.id, pending);
            setPendingConsentProfileId(null);
          },
        });
      }}
    />
  );

  // Guardian OTP challenge for a MINOR's BULK action (#453). One dialog for the
  // whole batch; the code resubmits the stashed payloads via performActionsBulk.
  // "A code will be sent to your guardian — proceed?" confirm before a minor's
  // bulk action dispatches the OTP (mirrors the single-action confirm).
  const bulkGuardianConfirmModal = (
    <Dialog
      open={!!bulkGuardianConfirm}
      onOpenChange={(open) => { if (!open) setBulkGuardianConfirm(null); }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('actions.guardian_confirm_title')}</DialogTitle>
          <DialogDescription>{t('actions.guardian_confirm_desc')}</DialogDescription>
        </DialogHeader>
        <GuardianOtpPurpose
          purpose={{
            kind: 'bulk',
            action: guardianActionKind(bulkGuardianConfirm?.actionType),
            count: browseSelection.selected.size,
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setBulkGuardianConfirm(null)}>
            {t('actions.guardian_confirm_cancel')}
          </Button>
          <Button
            onClick={() => {
              const run = bulkGuardianConfirm?.run;
              setBulkGuardianConfirm(null);
              run?.();
            }}
          >
            {t('actions.guardian_confirm_proceed')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const bulkGuardianOtpModal = (
    <GuardianOtpDialog
      open={!!bulkGuardianChallenge}
      onOpenChange={(open) => { if (!open) setBulkGuardianChallenge(null); }}
      purpose={{
        kind: 'bulk',
        action: guardianActionKind(bulkGuardianChallenge?.actionType),
        count: bulkGuardianChallenge?.payloads.length ?? 0,
      }}
      onLogout={() => { void signOut(); }}
      onSubmitOtp={async (otp) => {
        const ch = bulkGuardianChallenge;
        if (!ch) return;
        const env2 = await performActionsBulk(ch.payloads, ch.sourceInstanceUrl, otp);
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
        if (env2.summary.failed === 0) {
          const otherFailedIds = ch.otherFailedIds ?? [];
          setBulkGuardianChallenge(null);
          if (otherFailedIds.length > 0) {
            // Mixed batch: the guardian-gated items went through, but other
            // items failed for a non-guardian reason — keep those selected so
            // the ward can retry them, and say so rather than claim "all done".
            toast.warning(
              t('home.bulk_connected_partial', {
                succeeded: env2.summary.succeeded,
                total: env2.summary.succeeded + otherFailedIds.length,
              }),
            );
            browseSelection.setSelected(otherFailedIds);
          } else {
            toast.success(t('home.bulk_connected_all', { count: env2.summary.succeeded }));
            browseSelection.exitSelect();
          }
          return;
        }
        // Still failing (wrong/expired code, throttled …) — throw a classified
        // error so GuardianOtpDialog shows the inline message and stays open.
        const firstFail = env2.results.find((r) => r.status === 'error');
        const code = guardianOtpErrorOf(firstFail) ?? 'GUARDIAN_OTP_INVALID';
        throw new BulkSingleError(code, firstFail?.message ?? 'Guardian confirmation failed', 422);
      }}
    />
  );

  if (!network) {
    return (
      <>
        <div className="flex h-svh flex-col">
        <div className="h-14 border-b bg-gradient-to-r from-background to-primary/5" />
        <div className="flex flex-1 overflow-hidden">
          <div className="hidden md:block w-64 shrink-0 border-r p-4 space-y-3">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="flex-1 p-6 space-y-4">
            <Skeleton className="h-7 w-40" />
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-40 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
        </div>
        {renderU18GuardianFlowModal()}
        {profileConsentModal}
        {consentAcceptDialogs}
        {bulkGuardianConfirmModal}
        {bulkGuardianOtpModal}
      </>
    );
  }

  // With a single browseable domain there's no "All" — the header names that
  // one domain (derived from visibleDomains, so it's generic, not per-network).
  const headerDomain = resolveHeaderDomain(selectedDomain, visibleDomains);
  const contentTitle = formatDomainLabel(headerDomain, visibleDomains) || t('home.browse_all');
  const contentDescription = resolveHeaderDescription(headerDomain, visibleDomains);
  // Task 7 (#203 §5.2 cleanup): re-sourced from the list totals — keyed on
  // `selectedDomain` (which paged feed is actually driving the list), not
  // `headerDomain` (a display-only label that can be non-null even on the
  // "All" tab when exactly one domain is visible). This also resolves the
  // P3-deferred header-count-vs-list-total mismatch: the header now reports
  // the same server-side total the "Showing X of Y" list indicator uses,
  // instead of a client-filtered card count.
  const contentCount = selectByDomainScope(selectedDomain, singleDomainList.total, allDomainsTotalCount);
  const contentLoading = selectByDomainScope(selectedDomain, singleDomainList.isLoading, allDomainsLoading);

  function buildEmptyState(domainLabel: string) {
    if (search) return <EmptyState message={t('home.no_search_results', { search })} />;
    // GuestHero already shows the sign-in CTA — keep this message simple
    if (!user) return <EmptyState message={t('home.no_listings_yet')} />;
    if (!myItem) {
      return (
        <EmptyState
          heading={t('home.empty_create_heading')}
          message={t('home.empty_create_message')}
          action={
            <Button asChild size="sm">
              <Link to={`/profile/new?network=${selectedNetworkId ?? ''}`}>{t('nav.create_profile')}</Link>
            </Button>
          }
        />
      );
    }
    // Location-bounded discover returned nothing: the network may well have
    // listings — just none within the (hard) radius. Say THAT, not "none in
    // this network" (false) or nothing at all. Mirrors the map's area-scoped
    // empty message; the "Search near" toggle makes trying another location
    // actionable.
    if (hasLocation && listDistanceMeters !== undefined) {
      const km = Math.round(listDistanceMeters / 1000);
      const locationSource = resolvedLocationSource === 'browser' ? 'current' : 'profile';
      return (
        <EmptyState
          heading={t('home.nothing_here_heading')}
          message={t('home.no_listings_in_radius', {
            km,
            locationSource: t(`home.location_source_${locationSource}`),
          })}
        />
      );
    }
    return (
      <EmptyState
        heading={t('home.nothing_here_heading')}
        message={t('home.no_domain_listings', { domain: domainLabel.toLowerCase() })}
      />
    );
  }

  // Single filters element surfaced in the top bar (next to search) and, when
  // the map is maximized, in the map overlay (the top bar is hidden in
  // fullscreen). Each location instantiates its own popover state; the filter
  // selection itself is controlled via the shared props below.
  // Nested render fn (not const elements) so the select-button / header-actions /
  // guest-vs-signed-in conditionals live inside a function, keeping HomePage's
  // cognitive complexity within bounds (SonarCloud S3776). Called each render, so
  // no memo dependency array to keep in sync.
  const renderPageHeader = () => {
    const selectButton =
      myItem && viewMode === 'list' ? (
        <Button
          type="button"
          variant={browseSelection.selectMode ? 'default' : 'outline'}
          size="sm"
          onClick={() =>
            browseSelection.selectMode
              ? browseSelection.exitSelect()
              : browseSelection.enterSelect()
          }
        >
          <CheckSquare className="mr-1.5 h-4 w-4" />
          {browseSelection.selectMode ? t('selection.done') : t('selection.select')}
        </Button>
      ) : null;

    const headerActions =
      canToggleLocation || selectButton ? (
        <div className="flex items-center gap-2">
          {canToggleLocation && (
            <LocationSourceToggle
              value={preferredSource}
              onChange={handleLocationSourceChange}
            />
          )}
          {selectButton}
        </div>
      ) : undefined;

    return !user ? (
      <GuestHero />
    ) : (
      <ContentHeader
        title={contentTitle}
        description={contentDescription}
        count={contentLoading ? undefined : contentCount}
        noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
        actions={headerActions}
      />
    );
  };

  const filtersPanel = (
    <MapFiltersPanel
      domains={visibleDomains}
      filterFieldDomains={filterFieldDomains}
      selectedDomains={mapSelectedDomains}
      onDomainsChange={handleMapDomainsChange}
      selectedFields={mapSelectedFields}
      onFieldsChange={handleMapFieldsChange}
      // A specific sidebar domain already scopes browse + the enum groups to
      // that domain, so the domain chip toggle is redundant there.
      showDomainToggle={selectedDomain === null}
      viewMode={viewMode}
    />
  );

  // Task 6 (#203 §6): the page-header mount of the filters panel (passed to
  // `PageShell` below) — as opposed to `filtersPanel` above, which is also
  // reused as MapView's OWN copy rendered only while the map is maximized
  // (the header is covered in fullscreen; see `MapView`'s `filtersSlot` doc).
  // #394: previously this mount marked the selected facet chips
  // paused/not-applied when the discover BFF fell back to native — since the
  // fallback now applies facet filters natively, that pausing no longer
  // applies and this is identical to `filtersPanel` above.
  const listFiltersPanel = (
    <MapFiltersPanel
      domains={visibleDomains}
      filterFieldDomains={filterFieldDomains}
      selectedDomains={mapSelectedDomains}
      onDomainsChange={handleMapDomainsChange}
      selectedFields={mapSelectedFields}
      onFieldsChange={handleMapFieldsChange}
      showDomainToggle={selectedDomain === null}
      viewMode={viewMode}
    />
  );

  return (
    <>
    <PageShell
      networks={pickNetworksForShell(showNetworkSelector, allNetworks)}
      selectedNetwork={selectedNetworkId}
      onNetworkSelect={handleNetworkSelect}
      domains={visibleDomains}
      selectedDomain={selectedDomain}
      onDomainSelect={handleDomainSelect}
      currentDomainLabel={currentDomainLabel}
      myItems={myItems}
      activeProfileId={activeProfileId}
      onActiveProfileChange={handleActiveProfileChange}
      onProfilesChanged={() => {
        if (network) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
      }}
      userSchemas={userSchemas}
      search={search}
      onSearchChange={setSearch}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      filtersSlot={listFiltersPanel}
    >
      {renderPageHeader()}
      {/* All-tab header count ("X listings") is summed from each visible
          domain's server-reported total, lifted by these headless
          DomainPagedFetch children. In list view the grid below mounts its own
          set; without this, map view never fetches those totals so the count
          stays hidden until the user visits the list once. Gated to map view
          (viewMode !== 'list') so the two sets never double-mount.

          These count-only fetchers stay on the NATIVE browse path (no discover
          opts, raw proximity coords) regardless of the list's own always-on
          discover mode: those are list-view concerns and must not route this
          count through discover — doing so would make it diverge from the map's
          own marker total whenever the search index lags the live DB. (The map
          view itself DOES honor facet filters and free-text search via its own
          `/markers` fetch — see `useMapMarkers`; this note is only about the
          header-count fetchers, which are a separate native path.) */}
      {user && network && selectedDomain === null && viewMode !== 'list' &&
        visibleDomains.map((domain) => (
          <DomainPagedFetch
            key={`count-${domain.id}`}
            network={network}
            domain={domain}
            coords={browseCoords}
            onItems={handleDomainItems}
          />
        ))}
      {showLocationBanner && (
        <EnableLocationBanner
          onEnable={() => void browserLocation.request()}
          blocked={geoPermission === 'denied'}
          title={t('home.location_off_title')}
          body={t('home.location_off_body')}
          blockedBody={t('home.location_blocked_body')}
          cta={t('home.location_enable_cta')}
        />
      )}
      <ActionHandler
          // Minor on a guardian-gated domain → confirm before the guardian OTP
          // is dispatched (server issues it on the first submit).
          guardianConfirmRequired={
            u18Status?.isMinor === true &&
            !!network &&
            !!wardDomain &&
            isGuardianConsentRequiredDomain(network, wardDomain)
          }
          onActionSubmit={async (actionType, _actionSchema, formData, targetItemId, guardianOtp) => {
            if (!myItem) {
              toast.error(t('home.toast_profile_required'), {
                description: t('home.toast_profile_required_desc'),
              });
              throw new Error('No source item');
            }
            // Draft source profile can't act — prompt to complete it. Throw an
            // ActionAbortedError so ActionHandler suppresses its generic toast.
            if (promptCompleteDraftProfile(myItem)) {
              throw new ActionAbortedError('source profile is draft');
            }
            if (!user) {
              toast.error(t('nav.sign_in_to_connect'), {
                description: t('home.toast_sign_in_desc'),
              });
              throw new Error('No user');
            }
            // Task 7 (#203 §5.2 cleanup): this handler serves BOTH the list
            // view (card actions) and the map view (a popup's connect button),
            // so the target lookup must cover both. List-driven targets are
            // always in one of the paged feeds; a map-driven target may be a
            // viewport marker never paged into either list feed, so fall back
            // to `mapDetailItem` — the full `Item` the open popup already
            // resolved via `useItemDetail` (see `MarkerDetailPopup`).
            const listItems =
              selectedDomain === null ? Object.values(allDomainItemsFiltered).flat() : singleDomainItems;
            const targetItem =
              listItems.find((i) => i.item_id === targetItemId) ??
              (mapDetailItem?.item_id === targetItemId ? mapDetailItem : undefined);
            if (!targetItem) {
              toast.error(t('home.toast_profile_not_found'), {
                description: t('home.toast_profile_not_found_desc'),
              });
              throw new Error('Target item not found');
            }

            // Extract consent sentinel placed by ConsentCheckbox inside ActionModal.
            // Must not appear in requirements_snapshot sent to the server.
            const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
            const consent =
              consentRaw &&
              typeof consentRaw === 'object' &&
              (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
              typeof (consentRaw as { version?: unknown }).version === 'number'
                ? ({
                    acknowledged: true as const,
                    version: (consentRaw as { version: number }).version,
                    brand: (consentRaw as { brand?: string | null }).brand,
                  })
                : undefined;

            // Resolve source item instance URL (where my profile is stored)
            // IMPORTANT: If the source item has localhost as instance_url,
            // it means it was created on the current API instance
            const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually created
              : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl());

            // Resolve target item instance URL dynamically
            // IMPORTANT: If target item has localhost, use current API as fallback
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually fetched from
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl());

            await performAction(
              {
                action_type: actionType,
                source_item: {
                  item_network: myItem.item_network,
                  item_domain: myItem.item_domain,
                  item_type: myItem.item_type,
                  item_id: myItem.item_id,
                },
                target_item: {
                  item_network: targetItem.item_network,
                  item_domain: targetItem.item_domain,
                  item_type: targetItem.item_type,
                  item_id: targetItem.item_id,
                  item_instance_url: targetItemInstanceUrl,
                },
                requirements_snapshot: requirementsSnapshot,
                ...(consent ? { consent } : {}),
              },
              sourceItemInstanceUrl, // Call the SOURCE instance (where myItem exists)
              guardianOtp
            );
            // New actions must surface without waiting for the 60s poll (§C5).
            queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
            toast.success(t('home.toast_action_sent', { action: actionType.charAt(0).toUpperCase() + actionType.slice(1) }), {
              description: t('home.toast_action_sent_desc'),
            });
          }}
        >
          {(triggerAction) =>
            viewMode === 'list' ? (
              <>
                {/* Federation-degradation indicator (#203 §6): some peer instances
                    didn't answer in time on at least one loaded page, so the list
                    feed (single-domain or, on the "All" tab, at least one visible
                    domain) is known-partial. Mirrors the map's `mapMarkers.partial`
                    banner (P4) — same styling, in-flow above the grid instead of
                    `fixed` (the list has no maximize overlay to sit above). */}
                {listPartial && (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                    {t('home.list_partial')}
                  </p>
                )}
                {/* List note (#394): the list always calls discover now (profile
                    anchor + resolved viewer location when available), so this
                    explains what's driving the results — relevance-to-profile,
                    proximity, both, or (when the discover BFF fell back to
                    native — signals-search unreachable/unconfigured/timed out)
                    that ranking itself is temporarily unavailable. Exactly one
                    variant renders at a time; see `resolveListNote`. */}
                {/* Suppress the "Showing profiles within X km…" note when the
                    list is empty — it would falsely imply results are shown.
                    The radius-aware empty state (buildEmptyState) carries the
                    explanation in that case instead. Kept during loading
                    (contentCount 0) is fine — the skeleton shows, no note. */}
                {listNote && contentCount > 0 && (
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t(
                      listNote.key,
                      listNote.values
                        ? {
                            km: listNote.values.km,
                            locationSource: t(`home.location_source_${listNote.values.locationSource}`),
                          }
                        : undefined,
                    )}
                  </p>
                )}
                {selectedDomain === null ? (
              // All tab: flat grid across all domains, each card uses its own schema.
              // Each visible domain gets a headless <DomainPagedFetch> that fetches
              // its own pages server-ordered (nearest-first, §4.1) and lifts the
              // loaded items up; the union is then merge-sorted client-side across
              // domains (§5.1) since no single server call spans domains.
              (() => {
                const pagedFetchers = (
                  <>
                    {visibleDomains.map((domain) => (
                      <DomainPagedFetch
                        key={domain.id}
                        network={network}
                        domain={domain}
                        coords={browseLocation}
                        browseOpts={{ ...browseHookOpts, anchorItemId: anchorFor(domain.id) }}
                        onItems={handleDomainItems}
                      />
                    ))}
                  </>
                );

                const allFlatItemsUnsorted = visibleDomains.flatMap((domain) => {
                  const domainSchema = domain.item_schemas
                    ? (Object.values(domain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                    : undefined;
                  const domainActions = getActionsForDomain(domain.id);
                  const domainLabel = formatDomainLabel(domain.id, [domain]);
                  return (filteredAllDomainItems[domain.id] ?? []).map((item) => ({
                    item,
                    schema: domainSchema,
                    domainActions,
                    domainDescription: domain.description,
                    domainLabel,
                    cardConfig: domain.card,
                  }));
                });
                const allFlatItems = sortItemsByNearest(allFlatItemsUnsorted, userLocation, (x) => getItemLocations(x.item.data));

                if (allDomainsLoading) {
                  return (
                    <>
                      {pagedFetchers}
                      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {Array.from({ length: 6 }).map((_, i) => (
                          <DomainCard key={i} schema={{}} data={{}} loading />
                        ))}
                      </div>
                    </>
                  );
                }

                if (allFlatItems.length === 0) {
                  return (
                    <>
                      {pagedFetchers}
                      {buildEmptyState('All')}
                      {/* Client search/enum filtering covers only loaded pages until
                          server-side search (§9/#117) lands — keep the sentinel
                          mounted here too so a filtered-to-empty grid with more
                          server pages still auto-loads instead of dead-ending. */}
                      {anyAllDomainHasMore && (
                        <div ref={allDomainsSentinelRef} aria-hidden="true" className="h-px w-full" />
                      )}
                    </>
                  );
                }

                return (
                  <>
                    {pagedFetchers}
                    {allDomainsTotalCount > 0 && (
                      <p className="mb-2 text-xs text-muted-foreground">
                        {t('home.showing_x_of_y', {
                          shown: allDomainsLoadedCount,
                          total: allDomainsTotalCount,
                        })}
                      </p>
                    )}
                    <div ref={allCardsGridRef} className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {allFlatItems.map(({ item, schema, domainActions, domainDescription, domainLabel, cardConfig }) => {
                        const fullItem = Object.values(allDomainItemsFiltered)
                          .flat()
                          .find((i) => i.item_id === item.id);
                        const networkItem: Item = fullItem || {
                          item_id: item.id,
                          item_network: network?.id || '',
                          item_domain: selectedDomain || '',
                          item_type: 'profile',
                          item_instance_url: null,
                          item_schema_url: null,
                          item_state: item.data,
                          item_locations: [],
                          created_at: new Date().toISOString(),
                          updated_at: new Date().toISOString(),
                        };

                        return (
                          <SelectableCard
                            key={item.id}
                            id={item.id}
                            selectMode={browseSelection.selectMode}
                            selected={browseSelection.isSelected(item.id)}
                            // Not selectable if an action is already open for this
                            // pair (one-open-per-pair, #370/#422) — mirrors the CTA.
                            selectable={browseSelection.canSelect(item.domain ?? '') && !openActionItemIds.has(item.id)}
                            onToggle={(id) => browseSelection.toggle(id, item.domain ?? '')}
                          >
                            {/* #394: same rule as the single-domain CardGrid so all
                                three tabs behave identically — profile-to-profile
                                match always shows; the free-text (no-profile) score
                                is gated by the runtime-env flag. */}
                            {shouldRenderMatchScoreCard(myItem, networkItem) ? (
                              <MatchScoreCard
                                schema={schema!}
                                schemaDescription={domainDescription}
                                domainLabel={domainLabel}
                                cardConfig={cardConfig}
                                data={item.data}
                                actions={domainActions}
                                selectionMode={browseSelection.selectMode}
                                onAction={(type, actionSchema) =>
                                  triggerAction(type, actionSchema, item.id)
                                }
                                localItem={myItem}
                                networkItem={networkItem}
                                actionsDisabled={openActionItemIds.has(item.id)}
                                actionsDisabledReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                              />
                            ) : (
                              <DomainCard
                                schema={schema!}
                                schemaDescription={domainDescription}
                                domainLabel={domainLabel}
                                cardConfig={cardConfig}
                                data={item.data}
                                actions={domainActions}
                                selectionMode={browseSelection.selectMode}
                                onAction={(type, actionSchema) =>
                                  triggerAction(type, actionSchema, item.id)
                                }
                                localItem={myItem}
                                networkItem={networkItem}
                                shareItem={networkItem}
                                actionsDisabled={openActionItemIds.has(item.id)}
                                actionsDisabledReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                              />
                            )}
                          </SelectableCard>
                        );
                      })}
                    </div>
                    {anyAllDomainHasMore && (
                      <div ref={allDomainsSentinelRef} aria-hidden="true" className="h-px w-full" />
                    )}
                  </>
                );
              })()
            ) : (
              // Single domain tab: paged infinite scroll (§5.1). Server already
              // orders nearest-first when coords are known, so no client sort here.
              <>
                {singleDomainList.total > 0 && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t('home.showing_x_of_y', {
                      shown: singleDomainList.items.length,
                      total: singleDomainList.total,
                    })}
                  </p>
                )}
                <CardGrid
                  schema={activeSchema!}
                  schemaName={selectedDomain}
                  schemaDescription={currentDomainLabel}
                  cardConfig={network?.domains.find((d) => d.id === selectedDomain)?.card}
                  items={singleDomainCards}
                  fullItems={singleDomainItems}
                  actions={actions}
                  onAction={(itemId, _type, actionSchema) => {
                    triggerAction(_type, actionSchema, itemId);
                  }}
                  loading={singleDomainList.isLoading}
                  emptyState={buildEmptyState(currentDomainLabel ?? 'items')}
                  localItem={myItem}
                  networkId={network?.id}
                  selectedDomain={selectedDomain}
                  openActionItemIds={openActionItemIds}
                  openActionReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                  selection={browseSelection}
                />
                <div ref={singleDomainSentinelRef} aria-hidden="true" className="h-px w-full" />
              </>
                )}
                {browseSelection.selectMode && (() => {
                  const lockDomain = browseSelection.lockKey ?? selectedDomain ?? '';
                  const connectAction = lockDomain ? getActionsForDomain(lockDomain)[0] : undefined;
                  return (
                    <>
                      <BulkActionBar
                        count={browseSelection.selected.size}
                        onClear={browseSelection.clear}
                      >
                        <button
                          type="button"
                          disabled={!connectAction || bulkConnectBusy}
                          onClick={() => setBulkConnectOpen(true)}
                          className="rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                        >
                          {t('home.bulk_connect_all', { count: browseSelection.selected.size })}
                        </button>
                      </BulkActionBar>
                      {connectAction && (
                        <ActionModal
                          open={bulkConnectOpen}
                          onOpenChange={(open) => !open && setBulkConnectOpen(false)}
                          actionSchema={connectAction}
                          loading={bulkConnectBusy}
                          onSubmit={(fd) => handleBulkConnect(connectAction.action_type, fd)}
                        />
                      )}
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="relative h-full">
                <MapView
                  schema={activeSchema!}
                  resolveMarkerLabel={resolveMarkerLabel}
                  items={mapItems}
                  focusPoint={userLocation}
                  focusNonce={recenterNonce}
                  closePopupNonce={closePopupNonce}
                  selfLocation={userLocation}
                  filtersSlot={filtersPanel}
                  onViewportChange={setMapViewport}
                  emptyMessage={t(
                    mapEmptyMessageKey({
                      isError: mapMarkers.isError,
                      wideViewport: isWideViewport(mapViewport),
                    }),
                  )}
                  renderPopup={(marker) => {
                    // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
                    const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
                    const sourceMarker = mapMarkers.markers.find(
                      (m) =>
                        m.item_id === baseItemId &&
                        (!marker.domain || m.item_domain === marker.domain),
                    );
                    const domainActions = marker.domain ? getActionsForDomain(marker.domain) : [];
                    const connectAction = domainActions[0];
                    const markerDomain = marker.domain
                      ? network?.domains.find((d) => d.id === marker.domain)
                      : undefined;
                    const markerSchema = markerDomain?.item_schemas
                      ? (Object.values(markerDomain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                      : activeSchema;
                    // Domain's item type (e.g. `job_posting_1.0`) for the by-id
                    // detail fetch — slim markers don't carry it.
                    const markerItemType = markerDomain?.item_schemas
                      ? Object.keys(markerDomain.item_schemas)[0]
                      : undefined;
                    return (
                      <MarkerDetailPopup
                        networkId={network?.id ?? null}
                        marker={marker}
                        sourceMarker={sourceMarker}
                        itemType={markerItemType}
                        schema={markerSchema}
                        cardConfig={markerDomain?.card}
                        localItem={myItem}
                        connectAction={connectAction}
                        connectDisabled={openActionItemIds.has(baseItemId)}
                        connectDisabledReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                        onConnect={(itemId) => {
                          // Close the marker popup first so it doesn't cover
                          // the consent modal the action is about to open.
                          setClosePopupNonce((n) => n + 1);
                          if (connectAction) triggerAction(connectAction.action_type, connectAction, itemId);
                        }}
                        onItemResolved={setMapDetailItem}
                      />
                    );
                  }}
                />
                {/* Map count pill (#203 §7, revised; extended by Task 6):
                    logged-out map view has no header count badge (that's a
                    logged-in ContentHeader), so this small non-blocking pill
                    surfaces the result count for the current view at all
                    zooms. Task 6 adds an over-dense "N+ in this area — zoom
                    in" variant that shows for BOTH anon and signed-in
                    visitors whenever the true total exceeds the active
                    zoom-band marker cap (`mapMarkers.truncated`) — see
                    `MapCountPill` for the two-variant logic. `fixed` + high
                    z-index so it stays above the map's own maximize overlay
                    (z-[2000]). */}
                <MapCountPill
                  total={mapMarkers.total}
                  shown={mapItems.length}
                  truncated={mapMarkers.truncated}
                  signedIn={!!user}
                />
                {/* Federation-degradation indicator (#203 §6): some peer instances
                    didn't answer in time, so the viewport marker set is known-partial.
                    `fixed` (not `absolute`) so it stays visible above the map's own
                    maximize overlay (z-[1000]) in both normal and maximized mode. */}
                {mapMarkers.partial && (
                  <div className="pointer-events-none fixed left-1/2 top-20 z-[2100] w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 px-4">
                    <p className="pointer-events-auto mx-auto w-fit max-w-full rounded-md bg-amber-50 px-3 py-1.5 text-center text-xs font-medium text-amber-900 shadow-md ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                      {t('home.map_partial')}
                    </p>
                  </div>
                )}
              </div>
            )
          }
        </ActionHandler>
    </PageShell>
    {renderU18GuardianFlowModal()}
    {profileConsentModal}
    {consentAcceptDialogs}
        {bulkGuardianConfirmModal}
        {bulkGuardianOtpModal}
    </>
  );
}
