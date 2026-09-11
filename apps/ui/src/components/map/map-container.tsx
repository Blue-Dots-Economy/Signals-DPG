import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { MapMarker, MapViewport } from '@/engine/types';
import { getActiveMapProvider } from '@/engine/map/map-registry';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { Button } from '@/components/ui/button';
import { Maximize2, Minimize2 } from 'lucide-react';

interface MapViewProps {
  schema: RJSFSchema;
  /**
   * Items to render as markers. `domain` is the item's domain string (e.g.
   * "seeker", "provider") and is threaded to `MapMarker.domain` so each
   * provider can render a domain-specific icon. It is intentionally kept
   * outside of `data` so it never appears in the popup's data display.
   */
  items: Array<{ id: string; domain?: string; data: Record<string, unknown> }>;
  onMarkerClick?: (id: string) => void;
  center?: [number, number];
  zoom?: number;
  /**
   * The currently active/selected profile's coordinates. When present, the map
   * centers on this point (city-level zoom) instead of fitting all markers.
   * Driven by the active profile selected in the sidebar — switching profiles
   * re-centers the map. When null (no active profile, or it has no coords) the
   * map falls back to the default view and fits all markers.
   */
  focusPoint?: { lat: number; lng: number } | null;
  /**
   * Monotonic counter bumped on an explicit recenter intent (e.g. the user
   * picks a location source). Forwarded to the provider so the map snaps back
   * to `focusPoint` even when the coordinate is unchanged and the user panned.
   */
  focusNonce?: number;
  /**
   * Monotonic counter bumped to close any open marker popup (e.g. right
   * before an action like Connect/Apply opens a modal) — the marker popup is
   * a map overlay in a high stacking context, so on mobile it would otherwise
   * cover a bottom-sheet modal. Forwarded to the active provider, which clears
   * whatever "active marker" state it holds internally.
   */
  closePopupNonce?: number;
  /**
   * The user's own resolved location (profile OR browser geolocation). Forwarded
   * to the active provider, which renders a distinct "You are here" self-marker
   * at this point. Null/undefined → no self-marker. Kept separate from
   * `focusPoint` (a generic recenter anchor) so the two can diverge later.
   */
  selfLocation?: { lat: number; lng: number } | null;
  /**
   * The Filters control. Rendered inside the map overlay ONLY when the map is
   * maximized (in normal mode the page header hosts it, but that header is
   * covered when the map goes fullscreen, so we surface it here too).
   */
  filtersSlot?: React.ReactNode;
  /**
   * The location-source control. Same reason as `filtersSlot`: the page
   * header hosts it normally, but that header is covered when the map goes
   * fullscreen. Without this the map's one location control would vanish
   * exactly when the map is the whole screen.
   */
  locationSlot?: React.ReactNode;
  /** Optional custom popup renderer passed to the active provider. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  /**
   * Resolve a marker's display label per item — used to honour each domain's
   * `card.title_field` when items span multiple domains (the "All" view), where
   * a single `schema`-based heuristic can't pick the right title field. Returns
   * undefined to fall back to the schema heuristic.
   */
  resolveMarkerLabel?: (item: {
    id: string;
    domain?: string;
    data: Record<string, unknown>;
  }) => string | undefined;
  /**
   * Tailwind height classes for the (non-maximized) map wrapper. Defaults to
   * `h-[calc(100dvh-8rem)] min-h-[400px]` to suit the signals page chrome.
   * Callers with a different layout (e.g. the tourist app, whose header is
   * shorter) can pass `h-full` to fill their own flex container instead.
   */
  heightClassName?: string;
  /**
   * Optional per-marker icon resolver, forwarded to the active map provider.
   * Defaults (in the provider) to a domain-based icon; the tourist app passes
   * a category-based resolver. Unset for signals → unchanged behaviour.
   */
  resolveMarkerIcon?: (marker: MapMarker) => import('lucide-react').LucideIcon;
  /**
   * Optional per-marker image resolver, forwarded to the provider. When it
   * returns a URL the marker renders as that image (e.g. the RubiX favicon)
   * instead of the icon pin. Unset for signals → unchanged behaviour.
   */
  resolveMarkerImage?: (marker: MapMarker) => string | null | undefined;
  /**
   * Optional viewport-change callback, fed by the active provider on
   * debounced (~300ms) pan/zoom settle: `{lat, lng, radiusMeters}` where
   * `radiusMeters` is the half-diagonal (center → a bounds corner). Feeds the
   * home-page markers query with a viewport-scoped fetch (#203 §5.2). Unset
   * for the tourist app → no listener is attached and behavior is unchanged.
   */
  onViewportChange?: (viewport: MapViewport) => void;
  /**
   * Overrides the empty-state text. The portal map is viewport-scoped (it fetches
   * only the pins in view), so "no items" means "none in THIS area" — not that a
   * filter excluded them; the home page passes an area-oriented message. Unset
   * for the tourist app, which keeps the default `map.no_results` (it genuinely
   * filters by search + fields).
   */
  emptyMessage?: string;
}

// Default map view when there is no user location / no profile location.
// Per-DEPLOYMENT (not per-network): the same network can run as separate
// instances for different regions (e.g. blue_dot UP vs blue_dot Karnataka),
// so the default is an env var set per deployment, not network config.
//   VITE_MAP_DEFAULT_CENTER = "lat,lng"  (e.g. "29.4727,77.7085" for Muzaffarnagar)
//   VITE_MAP_DEFAULT_ZOOM   = number     (e.g. 12 for city-level)
// Falls back to a whole-India view when unset/invalid.
//
// Both go through `getRuntimeEnv`: the chart's runtime config
// (window.__DPG_UI_CONFIG__ via /config.js) first, then the build-time value.
// `import.meta.env` alone could not deliver a per-deployment default at all —
// Vite inlines it at build time and CI publishes the UI image with no VITE_
// build args, so every deployed instance silently got the whole-India fallback
// regardless of what the chart set.
export const FALLBACK_CENTER: [number, number] = [20.5937, 78.9629];
export const FALLBACK_ZOOM = 5;

export function parseDefaultCenter(raw: string | undefined): [number, number] {
  const parts = (raw ?? '').split(',').map((s) => Number(s.trim()));
  const [lat, lng] = parts;
  const valid =
    parts.length === 2 &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;
  return valid ? [lat, lng] : FALLBACK_CENTER;
}

export function parseDefaultZoom(raw: string | undefined): number {
  const z = Number(raw);
  return Number.isFinite(z) && z > 0 && z <= 22 ? z : FALLBACK_ZOOM;
}

export const DEFAULT_CENTER: [number, number] = parseDefaultCenter(
  getRuntimeEnv('VITE_MAP_DEFAULT_CENTER'),
);
// The default zoom the map opens at before its first `onViewportChange`
// report has landed (overridable via VITE_MAP_DEFAULT_ZOOM).
export const DEFAULT_ZOOM = parseDefaultZoom(getRuntimeEnv('VITE_MAP_DEFAULT_ZOOM'));
const PROFILE_ZOOM = 12;

export function MapView({
  schema,
  items,
  onMarkerClick,
  center = DEFAULT_CENTER,
  zoom = DEFAULT_ZOOM,
  focusPoint,
  focusNonce,
  closePopupNonce,
  selfLocation,
  filtersSlot,
  locationSlot,
  renderPopup,
  resolveMarkerLabel,
  heightClassName = 'h-[calc(100dvh-8rem)] min-h-[400px]',
  resolveMarkerIcon,
  resolveMarkerImage,
  onViewportChange,
  emptyMessage,
}: MapViewProps) {
  const { t } = useTranslation();
  const MapProviderComponent = getActiveMapProvider();
  const [markers, setMarkers] = React.useState<MapMarker[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [isMaximized, setIsMaximized] = React.useState(false);

  // When toggling maximize, the map container changes size. Both Leaflet and
  // Google Maps listen for window 'resize' to re-fit their canvas, so dispatch
  // one after the DOM updates.
  React.useEffect(() => {
    const id = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => window.clearTimeout(id);
  }, [isMaximized]);

  // Allow Esc to exit maximized mode.
  React.useEffect(() => {
    if (!isMaximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMaximized]);

  // ── Effective center / zoom / initialViewSet ──────────────────────────────
  // When an active profile with coordinates is selected, center on it at
  // city-level zoom. Otherwise fall back to the caller-supplied center/zoom
  // (DEFAULT_CENTER from env / whole-India fallback) and let FitBounds fit all markers.
  const { effectiveCenter, effectiveZoom, initialViewSet } = React.useMemo(() => {
    if (!focusPoint) {
      return { effectiveCenter: center, effectiveZoom: zoom, initialViewSet: false };
    }
    return {
      effectiveCenter: [focusPoint.lat, focusPoint.lng] as [number, number],
      effectiveZoom: PROFILE_ZOOM,
      initialViewSet: true,
    };
  }, [focusPoint, center, zoom]);

  // ── Marker resolution ─────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;

    async function resolveMarkers() {
      setLoading(true);
      const titleField = findTitleField(schema);

      const resolved = await Promise.all(
        items.map((item) => {
          // Primary: use stored item_locations array (one marker per entry).
          const locs = Array.isArray(
            (item.data as Record<string, unknown>).item_locations
          )
            ? (
                item.data as {
                  item_locations?: Array<{ lat: number; lng: number; label?: string }>;
                }
              ).item_locations ?? []
            : [];

          // Locations are resolved server-side (item_locations); the browser no
          // longer geocodes (its Maps key is scoped to Maps JS + Places only).
          // Items with no stored location simply produce no marker.
          const points: Array<{ lat: number; lng: number; label?: string }> = locs;

          // Skip items with no resolvable location.
          if (points.length === 0) return [];

          // Prefer the per-domain card.title_field (works across domains in the
          // "All" view); fall back to the single-schema heuristic, then 'Item'.
          const resolvedLabel = resolveMarkerLabel?.(item)?.trim();
          const baseLabel =
            resolvedLabel ||
            (titleField ? String(item.data[titleField] ?? 'Item') : 'Item');

          // All coordinates come from server-resolved item_locations → exact.
          const precision: MapMarker['precision'] = 'exact';

          return points.map(
            (p, i) =>
              ({
                id: `${item.id}#${i}`,
                lat: p.lat,
                lng: p.lng,
                label: p.label ? `${baseLabel} — ${p.label}` : baseLabel,
                data: item.data,
                precision,
                geocodedFrom: undefined,
                domain: item.domain,
              }) satisfies MapMarker
          );
        })
      );

      if (!cancelled) {
        const valid: MapMarker[] = resolved.flat();
        setMarkers(spreadCoLocatedMarkers(valid, selfLocation ?? null));
        setLoading(false);
      }
    }

    resolveMarkers();
    return () => { cancelled = true; };
  }, [items, schema, resolveMarkerLabel, selfLocation]);

  // The map and the maximize button always render. Loading and empty states are
  // shown as overlays ON TOP of the map rather than replacing it — otherwise a
  // filter that yields zero markers would remove the map, leaving the user with
  // nothing. The overlay lives in the same wrapper that gets maximized, so the
  // control stays visible in maximized mode (unlike the provider's native
  // fullscreen). The Filters control lives in the page header, not here.
  return (
    <div
      className={
        isMaximized
          ? 'fixed inset-0 z-[2000] bg-background'
          : // `isolate` creates a stacking context so Leaflet's internal panes
            // (z-index 200–700) stay contained and can't paint above app-level
            // overlays like the Radix dialog (z-50). Without it, an open modal
            // (e.g. the post-login profile-consent dialog) is covered by the map
            // and every non-map control becomes unclickable.
            `relative isolate ${heightClassName}`
      }
    >
      <MapProviderComponent
        center={effectiveCenter}
        zoom={effectiveZoom}
        markers={markers}
        onMarkerClick={onMarkerClick}
        initialViewSet={initialViewSet}
        focusNonce={focusNonce}
        closePopupNonce={closePopupNonce}
        selfLocation={selfLocation ?? null}
        renderPopup={renderPopup}
        resolveIcon={resolveMarkerIcon}
        resolveMarkerImage={resolveMarkerImage}
        onViewportChange={onViewportChange}
      />
      {/* Top-right overlay: Filters and the location source (only while
          maximized — the page header hosts them normally but is hidden in
          fullscreen) + maximize toggle. Placed top-right to avoid the
          providers' top-left controls. */}
      <div className="absolute right-2 top-2 z-[1000] flex items-center gap-2">
        {isMaximized && locationSlot}
        {isMaximized && filtersSlot}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 bg-background/95 shadow-md backdrop-blur-sm"
          onClick={() => setIsMaximized((v) => !v)}
          aria-label={isMaximized ? t('map.minimize') : t('map.maximize')}
          title={isMaximized ? t('map.minimize') : t('map.maximize')}
        >
          {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
      {/* Loading / empty-state overlays (non-blocking, centered) */}
      {(loading || markers.length === 0) && (
        <div className="pointer-events-none absolute inset-0 z-[900] flex items-center justify-center">
          <p className="rounded-md bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-md backdrop-blur-sm">
            {loading
              ? t('map.loading')
              : (emptyMessage ?? t('map.no_results'))}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Many items geocode to the EXACT same coordinate (e.g. every "Bengaluru"
 * profile lands on the city centroid). Markers stacked on one pixel can't be
 * told apart or individually clicked once a cluster is expanded — and the
 * Google Maps clusterer (unlike Leaflet) has no spiderfy. To make every item
 * reachable on both providers, we deterministically fan out any group of
 * markers that share identical coordinates onto a small circle (~15m radius).
 *
 * This is effectively a permanent, provider-agnostic spiderfy: zoomed out the
 * points are close enough to still cluster into a count; zoomed in they
 * separate into individually-clickable pins. The offset is tiny relative to a
 * city-centroid's inherent imprecision, so it does not misrepresent location.
 *
 * The viewer's own "You are here" self-marker (`selfLocation`) is rendered
 * separately from `markers` (see `MapView`'s `selfLocation` prop) and is
 * otherwise invisible to this grouping — an item sitting exactly on the
 * viewer's own coordinate would be a "group of 1" and never get nudged,
 * landing on the same pixel as the self-marker and becoming unclickable
 * (#394). To fix that, `selfLocation` is treated as a virtual co-location
 * member: any item group that sits on it is fanned out even when it has only
 * one member, so it always ends up offset from "You". The self-marker itself
 * is never moved — only item markers are.
 */
/**
 * Stable hash of a string to a unit float in [0, 1) (FNV-1a, 32-bit). Used to
 * derive a marker's fan-out angle from its item id so the offset is a pure
 * function of the item — never of the surrounding group.
 */
function hashToUnit(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function spreadCoLocatedMarkers(
  markers: MapMarker[],
  selfLocation?: { lat: number; lng: number } | null,
): MapMarker[] {
  // ~10 metres expressed in degrees of latitude (1° lat ≈ 111_320 m).
  const RADIUS_DEG = 10 / 111_320;

  const groups = new Map<string, MapMarker[]>();
  for (const marker of markers) {
    const key = `${marker.lat.toFixed(6)},${marker.lng.toFixed(6)}`;
    const group = groups.get(key);
    if (group) group.push(marker);
    else groups.set(key, [marker]);
  }

  // The coordinate key for the viewer's own "You" marker, if any — used below
  // to treat it as a virtual co-location member (see the function doc comment
  // above for why).
  const selfKey = selfLocation
    ? `${selfLocation.lat.toFixed(6)},${selfLocation.lng.toFixed(6)}`
    : null;

  const result: MapMarker[] = [];
  for (const [key, group] of groups) {
    // A group needs fanning out when 2+ items share a coordinate (existing
    // behavior), OR when a single item sits exactly on the self-marker's
    // point — that item would otherwise render on top of "You" and be
    // unclickable (#394).
    const isAtSelfLocation = selfKey !== null && key === selfKey;
    if (group.length === 1 && !isAtSelfLocation) {
      result.push(group[0]);
      continue;
    }
    // Fan the group onto a small circle centered on the shared coordinate.
    // The angle is a deterministic function of each marker's id, so the same
    // item always lands at the same offset regardless of which other markers
    // are present — switching filters (All vs a single domain) no longer moves
    // a pin. Longitude offset is scaled by cos(lat) to stay circular on ground.
    const latRad = (group[0].lat * Math.PI) / 180;
    const lngScale = Math.max(Math.cos(latRad), 0.01);
    for (const marker of group) {
      const angle = hashToUnit(marker.id) * 2 * Math.PI;
      result.push({
        ...marker,
        lat: marker.lat + RADIUS_DEG * Math.cos(angle),
        lng: marker.lng + (RADIUS_DEG * Math.sin(angle)) / lngScale,
      });
    }
  }

  return result;
}


function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;

  // Prefer the schema's own declared display field (network configs set
  // `display_name_field` per item schema, e.g. "jobProviderName", "Full Name").
  // This is the generic, network-agnostic source of truth.
  const declared = (schema as Record<string, unknown>)['display_name_field'];
  if (typeof declared === 'string' && declared in schema.properties) {
    return declared;
  }

  // Fall back to common generic title field names (no domain-specific names).
  const candidates = ['name', 'full_name', 'display_name', 'title', 'label'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}
