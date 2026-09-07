import * as React from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
} from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import type { MapMarker, MapProviderProps, MapViewport } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { useThemeMode } from '@/theme/mode-provider';
import { getIconForDomain } from '../domain-icons';
import { tallyDomains } from '../cluster-breakdown';
import { FitBounds } from '../fit-bounds';
import { MarkerPopupCard } from '../marker-popup-card';
import { createSelfMarkerDivIcon } from '../self-marker';
import { useViewportReportEmitter } from './use-viewport-report';

import 'leaflet/dist/leaflet.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.Default.css';

/**
 * Module-level WeakMap: L.Marker instance → domain string.
 * Populated via a ref callback on each <Marker>; read by createClusterDivIcon
 * to tally per-domain counts when building the badge row.
 */
const markerDomainMap = new WeakMap<object, string>();

/**
 * Imperatively pans/zooms the Leaflet map whenever the `center` or `zoom`
 * props change. Used when the caller manages the viewport explicitly (e.g.
 * when the user picks a different own profile from the selector).
 * Renders nothing — pure side-effect component.
 */
function SetView({
  center,
  zoom,
  focusNonce,
}: {
  center: [number, number];
  zoom: number;
  focusNonce?: number;
}) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);
  const prevNonce = React.useRef<number | undefined>(focusNonce);

  React.useEffect(() => {
    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;
    // An explicit recenter intent (nonce bump) snaps back even if the
    // coordinate is unchanged and the user has since panned away.
    const nonceChanged = prevNonce.current !== focusNonce;

    if (nonceChanged || !sameCenter || !sameZoom) {
      map.setView(center, zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
    prevNonce.current = focusNonce;
  }, [center, zoom, focusNonce, map]);

  return null;
}

/**
 * Closes any open Leaflet popup when the caller bumps `closePopupNonce` (e.g.
 * right before Connect/Apply opens the consent modal, so it isn't hidden
 * behind the popup's high stacking context). Leaflet's `Map` tracks whichever
 * popup is currently open internally (react-leaflet doesn't lift that into
 * React state here), so `map.closePopup()` — which closes the open popup
 * regardless of which marker it belongs to — is the correct imperative
 * escape hatch. Guarded with a ref (mirrors `SetView`'s `focusNonce`
 * handling) so mount / an unchanged nonce never fires a spurious close.
 * Renders nothing — pure side-effect component, same shape as `SetView`.
 */
function ClosePopupOnNonce({ closePopupNonce }: { closePopupNonce?: number }) {
  const map = useMap();
  const prevNonce = React.useRef<number | undefined>(closePopupNonce);

  React.useEffect(() => {
    if (prevNonce.current !== closePopupNonce) {
      map.closePopup();
    }
    prevNonce.current = closePopupNonce;
  }, [closePopupNonce, map]);

  return null;
}

/**
 * Reports the map's viewport (center + half-diagonal radius, plus the raw
 * `map.getBounds()` corners — #203 map-serverside-search Task 4) to the
 * caller on debounced `moveend`. Only ever mounted when `onViewportChange` is provided
 * (see `LeafletMapProvider` below), so the tourist app — which never passes
 * it — attaches no `moveend` listener at all and is completely unaffected.
 * Renders nothing — pure side-effect component, same shape as `SetView`.
 *
 * Also emits the CURRENT viewport once on mount (bypassing the debounce).
 * Leaflet fires its own initial `moveend` during map construction — before
 * this effect attaches the listener — so the only viewport-driven consumer
 * (`useMapMarkers`, gated on a non-null viewport) would otherwise never see
 * one until `SetView` runs, which only happens when a `focusPoint` /
 * `userLocation` exists. A user with no location (denied/unavailable) would
 * be stuck on the "no results" overlay forever. The mount emit is skipped if
 * the map's bounds aren't valid yet (rare, only just-constructed); nothing is
 * lost in that case because `moveend` will still fire normally later.
 *
 * Every emit also carries `map.getZoom()` (#203 §7) so the home-page can gate
 * anonymous count-first browsing on the zoom level without a separate event.
 */
function ViewportReporter({ onViewportChange }: { onViewportChange: (viewport: MapViewport) => void }) {
  const map = useMap();
  const { emit, emitNow } = useViewportReportEmitter(onViewportChange);

  React.useEffect(() => {
    const handleMoveEnd = () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emit(
        { lat: center.lat, lng: center.lng },
        { ne: { lat: ne.lat, lng: ne.lng }, sw: { lat: sw.lat, lng: sw.lng } },
        map.getZoom(),
      );
    };
    map.on('moveend', handleMoveEnd);

    const bounds = map.getBounds();
    if (bounds.isValid()) {
      const center = map.getCenter();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emitNow(
        { lat: center.lat, lng: center.lng },
        { ne: { lat: ne.lat, lng: ne.lng }, sw: { lat: sw.lat, lng: sw.lng } },
        map.getZoom(),
      );
    }

    return () => {
      map.off('moveend', handleMoveEnd);
    };
  }, [map, emit, emitNow]);

  return null;
}

/**
 * Reads a CSS custom property from <html> (where the per-network theme sets
 * --primary / --primary-foreground). Falls back to a sensible default if the
 * variable is unset or we're in a non-DOM context.
 */
function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Builds a Leaflet divIcon for a given marker.  The icon is a 32 × 32 px
 * circle with the precision-based colour as background and the domain lucide
 * icon as a white SVG glyph in the centre.  A small drop-shadow triangle
 * anchors it visually to the map point.
 *
 * Icons are NOT cached globally because each marker may have a unique domain +
 * precision combination.  The overhead is minimal — renderToStaticMarkup on
 * a tiny SVG is fast and happens only once per marker on mount.
 */
function createMarkerDivIcon(
  marker: MapMarker,
  resolveIcon?: MapProviderProps['resolveIcon'],
): L.DivIcon {
  // Network-derived colours: same --primary / --primary-foreground the rest of
  // the UI is themed with (blue_dot → blue, purple_dot → purple, …).
  // Neutral gray fallback (not a specific network's brand colour) if unresolved.
  const bg = readCssVar('--primary', '#6b7280');
  const iconColor = readCssVar('--primary-foreground', '#ffffff');
  const IconComponent = resolveIcon ? resolveIcon(marker) : getIconForDomain(marker.domain);

  // Render lucide icon to a static SVG string (16 × 16).
  const svgString = renderToStaticMarkup(
    React.createElement(IconComponent, {
      size: 16,
      color: iconColor,
      strokeWidth: 2,
    })
  );

  // Outer div: circle + pointer triangle via border trick.
  const html = `
    <div style="
      position: relative;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${bg};
      border: 2px solid #ffffff;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    ">
      <div style="transform: rotate(45deg); line-height: 0;">
        ${svgString}
      </div>
    </div>
  `.trim();

  return L.divIcon({
    html,
    // The visual anchor point is the bottom-left corner of the rotated square
    // (which is the pointy tip of the teardrop shape).
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34],
    className: '', // Clear Leaflet's default white-box class
  });
}

/**
 * Builds the cluster bubble icon (shown when overlapping markers collapse into
 * a count). Uses the active network theme colours (--primary /
 * --primary-foreground) instead of leaflet.markercluster's default blue/green.
 *
 * When the cluster spans more than one distinct domain, a row of mini badge
 * chips is rendered below the main circle — one chip per domain, sorted by
 * count descending, each showing the domain's icon + count.
 */
function createClusterDivIcon(cluster: { getChildCount: () => number; getAllChildMarkers?: () => L.Marker[] }): L.DivIcon {
  const count = cluster.getChildCount();
  // Neutral gray fallback (not a specific network's brand colour) if unresolved.
  const bg = readCssVar('--primary', '#6b7280');
  const fg = readCssVar('--primary-foreground', '#ffffff');
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;

  // Tally per-domain counts using the WeakMap populated on each marker's ref.
  const childMarkers: L.Marker[] = cluster.getAllChildMarkers?.() ?? [];
  // Only tally markers whose domain is actually known. A marker whose ref has
  // not registered in the WeakMap yet would otherwise fall back to '' and
  // fabricate a phantom empty-domain group — making a single-domain cluster
  // (e.g. all `practitioner`) look multi-domain. Unknown ones are still counted
  // in the total (getChildCount), just not in the per-domain breakdown.
  const domains = childMarkers
    .map((m) => markerDomainMap.get(m as object))
    .filter((d): d is string => Boolean(d));
  const breakdown = tallyDomains(domains);
  const multiDomain = breakdown.length > 1;

  // Build badge chips HTML (only when there are multiple distinct domains).
  let badgesHtml = '';
  if (multiDomain) {
    const chips = breakdown.map(({ domain, count: dc }) => {
      const Icon = getIconForDomain(domain);
      const iconSvg = renderToStaticMarkup(
        React.createElement(Icon, { size: 12, color: bg, strokeWidth: 2 }),
      );
      return `
        <span style="
          display: inline-flex;
          align-items: center;
          gap: 3px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 9999px;
          padding: 1px 5px;
          font-size: 10px;
          font-weight: 600;
          color: #1e293b;
          line-height: 1;
          white-space: nowrap;
        ">
          ${iconSvg}
          ${dc}
        </span>`;
    });

    badgesHtml = `
      <div style="
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 3px;
        margin-top: 4px;
        flex-wrap: nowrap;
      ">
        ${chips.join('')}
      </div>`;
  }

  const html = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      /* no width constraint — let badge row set the width */
    ">
      <div class="dpg-cluster-count" style="
        display: flex;
        align-items: center;
        justify-content: center;
        width: ${size}px;
        height: ${size}px;
        background: ${bg};
        color: ${fg};
        border: 2px solid #ffffff;
        border-radius: 9999px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        font-size: 13px;
        font-weight: 600;
        flex-shrink: 0;
      ">${count}</div>
      ${badgesHtml}
    </div>
  `.trim();

  // iconSize: make the height tall enough to include badges. The width is set
  // generously so chips are never clipped; Leaflet clips the div icon's
  // overflow, so we ensure the container is wide enough.
  const badgeRowH = multiDomain ? 22 : 0; // 18px chip + 4px margin
  const totalH = size + badgeRowH;
  // Estimate badge row width: each chip ~(12 icon + 3 gap + ~10 text + 10 padding) ≈ 35px; gap 3px between chips
  const estimatedBadgeW = multiDomain ? breakdown.length * 38 + (breakdown.length - 1) * 3 : size;
  const totalW = Math.max(size, estimatedBadgeW);

  return L.divIcon({
    html,
    className: '',
    // Centre the anchor on the main circle (top half of the icon).
    iconSize: L.point(totalW, totalH),
    iconAnchor: L.point(totalW / 2, size / 2),
  });
}



export function LeafletMapProvider({
  center,
  zoom,
  markers,
  onMarkerClick,
  initialViewSet = false,
  focusNonce,
  closePopupNonce,
  selfLocation,
  renderPopup,
  resolveIcon,
  onViewportChange,
}: MapProviderProps) {
  const { t } = useTranslation();
  const { resolved: themeMode } = useThemeMode();
  const isDark = themeMode === 'dark';
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className="h-full w-full rounded-lg"
      scrollWheelZoom
    >
      {/* Dark basemap (CARTO dark_all) in dark mode, light OSM otherwise. `key`
          forces a clean tile-layer swap on theme change. */}
      <TileLayer
        key={isDark ? 'dark' : 'light'}
        attribution={
          isDark
            ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
        url={
          isDark
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
        }
      />
      {/*
       * In viewport-markers mode (onViewportChange provided) the query itself
       * drives what's shown for the current pan/zoom, so auto-fitting bounds
       * on every `markers` change would fight it: fitBounds() fires moveend →
       * onViewportChange → useMapMarkers refetches a tighter radius → new
       * (fewer) markers → FitBounds fits tighter again — a jumpy, redundant
       * fit↔fetch loop. Skip it whenever onViewportChange is set; the tourist
       * app (no onViewportChange) keeps fitting bounds exactly as before.
       */}
      <FitBounds markers={markers} skip={initialViewSet || Boolean(onViewportChange)} />
      {initialViewSet && <SetView center={center} zoom={zoom} focusNonce={focusNonce} />}
      {onViewportChange && <ViewportReporter onViewportChange={onViewportChange} />}
      <ClosePopupOnNonce closePopupNonce={closePopupNonce} />
      {/*
       * MarkerClusterGroup wraps all markers so that:
       *  - at low zoom levels, nearby markers collapse into a cluster badge
       *    showing the count (handled by leaflet.markercluster internals).
       *  - at maximum zoom (or when all overlapping markers share the exact
       *    same coordinate), the group spiderfies them so every pin is
       *    individually clickable.
       * spiderfyOnMaxZoom + zoomToBoundsOnClick are both true by default in
       * leaflet.markercluster; we set them explicitly for clarity.
       */}
      <MarkerClusterGroup
        chunkedLoading
        spiderfyOnMaxZoom
        zoomToBoundsOnClick
        maxClusterRadius={80}
        iconCreateFunction={createClusterDivIcon}
      >
        {markers.map((marker) => {
          const icon = createMarkerDivIcon(marker, resolveIcon);
          const domain = marker.domain ?? '';

          return (
            <Marker
              key={marker.id}
              position={[marker.lat, marker.lng]}
              icon={icon}
              ref={(leafletMarker) => {
                // Populate the WeakMap so createClusterDivIcon can look up the
                // domain for this marker when building the badge row. react-leaflet
                // passes the underlying L.Marker instance to `ref` callbacks.
                if (leafletMarker) {
                  markerDomainMap.set(leafletMarker as object, domain);
                }
              }}
              eventHandlers={{
                click: () => onMarkerClick?.(marker.id),
              }}
            >
              <Popup closeButton={false} className="dpg-marker-popup" minWidth={300} maxWidth={300}>
                {renderPopup ? (
                  renderPopup(marker)
                ) : (
                  <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                )}
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>
      {/*
       * "You are here" self-marker: the user's own resolved location (profile
       * or browser geolocation). Rendered OUTSIDE MarkerClusterGroup so it is
       * never folded into an item cluster, and `interactive={false}` so it has
       * no popup and never intercepts clicks on the pins beneath it. A high
       * zIndexOffset keeps it above item pins.
       */}
      {selfLocation && (
        <Marker
          position={[selfLocation.lat, selfLocation.lng]}
          icon={createSelfMarkerDivIcon(t('map.you_are_here_short'))}
          interactive={false}
          keyboard={false}
          zIndexOffset={1000}
        />
      )}
    </MapContainer>
  );
}

// Self-register on import
registerMapProvider({ name: 'leaflet', component: LeafletMapProvider });
