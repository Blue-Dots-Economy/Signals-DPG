/// <reference types="google.maps" />
import * as React from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import {
  AdvancedMarker,
  APIProvider,
  ColorScheme,
  InfoWindow,
  Map,
  useAdvancedMarkerRef,
  useMap,
} from '@vis.gl/react-google-maps';
import type { AdvancedMarkerRef } from '@vis.gl/react-google-maps';
import { MarkerClusterer, type Renderer, type Cluster } from '@googlemaps/markerclusterer';
import type { MapMarker, MapProviderProps, MapViewport } from '@/engine/types';
import { registerMapProvider } from '@/engine/map/map-registry';
import { useIsMobile } from '@/hooks/use-mobile';
import { useThemeMode } from '@/theme/mode-provider';
import { getIconForDomain } from '../domain-icons';
import { tallyDomains } from '../cluster-breakdown';
import { MarkerPopupCard } from '../marker-popup-card';
import { SelfMarkerContent, SELF_MARKER_GOOGLE_OFFSET_Y } from '../self-marker';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { useViewportReportEmitter } from './use-viewport-report';

/**
 * Module-level WeakMap: AdvancedMarkerElement → domain string.
 * Populated by each ClusteredMarker when its underlying element becomes
 * available; read by the cluster renderer to tally per-domain counts.
 * WeakMap ensures entries are GC-eligible alongside the element object.
 */
const markerDomainMap = new WeakMap<object, string>();

// Marker stacking. The "You" self-marker is non-interactive decoration, so it
// must sit BELOW item pins: otherwise, when an item shares the exact same point
// as "You" (spreadCoLocatedMarkers fans it ~10m off, which is sub-pixel at low
// zoom), the self-marker (previously z 1000) rendered on top and swallowed the
// click — the item's card wouldn't open until fully zoomed in. Ordering:
// self (0) < item pins (500) < clusters (1000 + count). A co-located item pin
// now renders on top and is directly clickable.
const SELF_MARKER_Z_INDEX = 0;
const ITEM_MARKER_Z_INDEX = 500;

// Cluster-click zoom (see onClusterClick). One click smoothly zooms to the
// level that reveals the cluster's contents — the SAME target Google's default
// fitBounds would pick, but animated instead of snapping. For a cluster with no
// inner sub-clusters (near-identical/co-located points) that target is the max
// cap, so a single click drills straight to the item level — just smoothly.
const CLUSTER_CLICK_MAX_ZOOM = 20;
// Cluster-click zoom animation duration (ms). Runtime-env so the feel can be
// tuned per deploy (config.js) without a rebuild; default 2000, 0 = instant.
function resolveClusterZoomAnimMs(): number {
  const raw = getRuntimeEnv('VITE_MAP_CLUSTER_ZOOM_ANIM_MS');
  if (raw == null || String(raw).trim() === '') return 2000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}
const CLUSTER_ZOOM_ANIM_MS = resolveClusterZoomAnimMs();
// World tile size (px) used by the standard "zoom to fit bounds" math.
const WORLD_PX = 256;

/**
 * The (fractional) zoom at which `bounds` fills the given map pixel size — the
 * same result google.maps fitBounds targets. Degenerate/near-zero bounds (a
 * cluster of co-located points) yield the max cap, so clicking such a cluster
 * zooms all the way to the individual items.
 */
function getBoundsZoomLevel(
  bounds: google.maps.LatLngBounds,
  dim: { width: number; height: number },
): number {
  const latRad = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.log((1 + s) / (1 - s)) / 2;
  };
  const zoomFor = (px: number, fraction: number) => Math.log(px / WORLD_PX / fraction) / Math.LN2;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const latFraction = (latRad(ne.lat()) - latRad(sw.lat())) / Math.PI;
  const lngDiff = ne.lng() - sw.lng();
  const lngFraction = (lngDiff < 0 ? lngDiff + 360 : lngDiff) / 360;
  const latZoom = latFraction > 0 ? zoomFor(dim.height, latFraction) : CLUSTER_CLICK_MAX_ZOOM;
  const lngZoom = lngFraction > 0 ? zoomFor(dim.width, lngFraction) : CLUSTER_CLICK_MAX_ZOOM;
  return Math.min(latZoom, lngZoom, CLUSTER_CLICK_MAX_ZOOM);
}

/**
 * Smoothly animate the map camera (center + fractional zoom) to a target over
 * CLUSTER_ZOOM_ANIM_MS via requestAnimationFrame + moveCamera. We set a mapId
 * (vector map), so moveCamera renders fractional zoom crisply — this turns the
 * otherwise-instant large fitBounds jump into a smooth fly-in. `animRef` holds
 * the in-flight rAF handle so a new click (or unmount) cancels the previous
 * animation instead of fighting it.
 */
function animateMapCamera(
  map: google.maps.Map,
  target: { lat: number; lng: number; zoom: number },
  animRef: React.MutableRefObject<number | null>,
): void {
  if (animRef.current != null) cancelAnimationFrame(animRef.current);
  const startZoom = map.getZoom() ?? target.zoom;
  const c = map.getCenter();
  const startLat = c ? c.lat() : target.lat;
  const startLng = c ? c.lng() : target.lng;
  const start = performance.now();
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const frame = (now: number) => {
    const p = Math.min((now - start) / CLUSTER_ZOOM_ANIM_MS, 1);
    const e = easeOutCubic(p);
    map.moveCamera({
      center: {
        lat: startLat + (target.lat - startLat) * e,
        lng: startLng + (target.lng - startLng) * e,
      },
      zoom: startZoom + (target.zoom - startZoom) * e,
    });
    animRef.current = p < 1 ? requestAnimationFrame(frame) : null;
  };
  animRef.current = requestAnimationFrame(frame);
}

/**
 * Resolves a CSS custom property (e.g. --primary) to a concrete rgb/hex string.
 * The theme stores --primary as an `oklch(...)` value; an SVG data-URI `fill`
 * needs a rasterizable colour, so we round-trip it through a canvas which
 * normalizes any CSS colour to rgb/hex.
 */
function resolveThemeColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.style.color = `var(${varName})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  if (!computed) return fallback;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return computed;
  ctx.fillStyle = fallback;
  ctx.fillStyle = computed; // canvas normalizes oklch → rgb if supported
  return ctx.fillStyle;
}

/**
 * Builds the cluster bubble as an HTML element (for AdvancedMarkerElement
 * content). Rendering as real HTML — rather than an SVG data-URI — lets the
 * lucide icons keep their stroke styling and lets the mini badges tuck neatly
 * under the main circle via flexbox, matching the intended design.
 *
 * A main circle shows the total (themed --primary background, white text). When
 * the cluster spans more than one domain, a row of small white chips below it
 * shows each domain's icon + count (sorted by count desc).
 */
function buildClusterContent(
  total: number,
  breakdown: Array<{ domain: string; count: number }>,
  primary: string,
): HTMLElement {
  const wrap = document.createElement('div');
  // AdvancedMarkerElement anchors content bottom-centre to the point; shift down
  // so the bubble sits roughly centred over the cluster location.
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;transform:translateY(50%);';

  const size = total < 10 ? 38 : total < 100 ? 44 : 50;
  const circle = document.createElement('div');
  // Stable class hook for the mobile-only legibility rule in index.css — no
  // style is defined by this class name itself, so desktop rendering (which
  // has no matching media query) is byte-identical.
  circle.className = 'dpg-cluster-count';
  circle.style.cssText =
    `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;` +
    `background:${primary};color:#ffffff;border:2px solid #ffffff;border-radius:9999px;` +
    `box-shadow:0 1px 4px rgba(0,0,0,0.35);font:600 14px ui-sans-serif,system-ui,sans-serif;`;
  circle.textContent = String(total);
  wrap.appendChild(circle);

  if (breakdown.length > 1) {
    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:4px;margin-top:-8px;';
    for (const b of breakdown) {
      const Icon = getIconForDomain(b.domain);
      const iconSvg = renderToStaticMarkup(
        React.createElement(Icon, { size: 11, color: primary, strokeWidth: 2.4 }),
      );
      const chip = document.createElement('span');
      chip.style.cssText =
        'display:inline-flex;align-items:center;gap:3px;background:#ffffff;border:1px solid #e2e8f0;' +
        'border-radius:9999px;padding:2px 7px 2px 5px;font:600 11px ui-sans-serif,system-ui,sans-serif;' +
        'color:#1e293b;box-shadow:0 1px 2px rgba(0,0,0,0.18);line-height:1;';
      chip.innerHTML = `${iconSvg}<span>${b.count}</span>`;
      badges.appendChild(chip);
    }
    wrap.appendChild(badges);
  }

  return wrap;
}

/**
 * Custom cluster renderer so the cluster bubble uses the active network theme
 * colour (instead of the library's default blue) and shows a per-domain
 * breakdown. Returns an AdvancedMarkerElement with HTML content.
 */
const clusterRenderer: Renderer = {
  render(cluster: Cluster) {
    const { count, position, markers } = cluster;
    // Neutral gray fallback used only if --primary can't be resolved — must not
    // be a specific network's brand colour.
    const primary = resolveThemeColor('--primary', '#6b7280');

    // Tally domains from the clustered marker elements via the WeakMap. Only
    // markers with a known domain are counted in the breakdown; an unregistered
    // marker would otherwise fall back to '' and fabricate a phantom
    // empty-domain group, making a single-domain cluster look multi-domain.
    // The total bubble count is independent (cluster.count).
    const domains = (markers ?? [])
      .map((m) => markerDomainMap.get(m as object))
      .filter((d): d is string => Boolean(d));
    const breakdown = tallyDomains(domains);

    return new google.maps.marker.AdvancedMarkerElement({
      position,
      content: buildClusterContent(count, breakdown, primary),
      zIndex: 1000 + count,
    });
  },
};

// ─── Per-marker component ────────────────────────────────────────────────────
// Each ClusteredMarker calls useAdvancedMarkerRef() (legal — one hook per
// component instance) to obtain the underlying AdvancedMarkerElement, then
// reports it to the parent via onMarkerReady so the parent can register it
// with the MarkerClusterer instance.

interface ClusteredMarkerProps {
  marker: MapMarker;
  isActive: boolean;
  onClick: (marker: MapMarker) => void;
  onClose: () => void;
  onMarkerClick?: (id: string) => void;
  onMarkerReady: (id: string, el: NonNullable<AdvancedMarkerRef> | null) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

function ClusteredMarker({
  marker,
  isActive,
  onClick,
  onClose,
  onMarkerClick,
  onMarkerReady,
  renderPopup,
  resolveIcon,
  resolveMarkerImage,
}: ClusteredMarkerProps) {
  const [markerRef, markerEl] = useAdvancedMarkerRef();
  const { id } = marker;
  const map = useMap();
  const isMobile = useIsMobile();

  // Google auto-pans an InfoWindow into view when it OPENS, but not when its
  // content later resizes (e.g. the user taps "View more details" and the card
  // grows). Without this, a card anchored near a map edge gets its top/bottom
  // clipped after expanding. We observe the popup content's size and, whenever
  // it changes, nudge the map so the whole card stays visible.
  const popupObserverRef = React.useRef<ResizeObserver | null>(null);
  const popupPrevHeightRef = React.useRef<number | null>(null);

  const fitPopupInView = React.useCallback(
    (el: HTMLElement) => {
      if (!map) return;
      const mapDiv = map.getDiv();
      if (!mapDiv) return;
      const mapRect = mapDiv.getBoundingClientRect();
      const cardRect = el.getBoundingClientRect();
      const MARGIN = 16;
      const topOverflow = mapRect.top + MARGIN - cardRect.top;
      const bottomOverflow = cardRect.bottom - (mapRect.bottom - MARGIN);
      // Prefer revealing a clipped top (the header); otherwise a clipped bottom.
      const dy = topOverflow > 0 ? -topOverflow : bottomOverflow > 0 ? bottomOverflow : 0;
      if (Math.abs(dy) > 1) map.panBy(0, dy);
    },
    [map]
  );

  // Callback ref: (re)wire the observer when the popup content mounts/unmounts.
  const popupContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      popupObserverRef.current?.disconnect();
      popupPrevHeightRef.current = null;
      if (!node) return;
      const ro = new ResizeObserver(() => {
        const h = node.getBoundingClientRect().height;
        // Skip the first measurement (baseline); only react to real changes so
        // we don't fight Google's own open-time auto-pan.
        if (
          popupPrevHeightRef.current !== null &&
          Math.abs(h - popupPrevHeightRef.current) > 1
        ) {
          requestAnimationFrame(() => fitPopupInView(node));
        }
        popupPrevHeightRef.current = h;
      });
      ro.observe(node);
      popupObserverRef.current = ro;
    },
    [fitPopupInView]
  );

  React.useEffect(() => () => popupObserverRef.current?.disconnect(), []);

  // Resolve the marker icon once per render (cheap — just a lookup). Defaults
  // to a domain-based icon; callers may override (e.g. tourist app by category).
  const DomainIcon = resolveIcon ? resolveIcon(marker) : getIconForDomain(marker.domain);
  // When a marker image is provided (e.g. the RubiX favicon), the pin renders
  // that image in a white circle instead of the coloured icon pin.
  const markerImage = resolveMarkerImage?.(marker) ?? null;

  // Report the underlying element to the parent each time it changes.
  // Also register this element→domain mapping so the cluster renderer can
  // look up each marker's domain when building the badge row.
  React.useEffect(() => {
    if (markerEl) {
      markerDomainMap.set(markerEl, marker.domain ?? '');
    }
    onMarkerReady(id, markerEl);
    // Cleanup: remove from clusterer when this marker unmounts.
    // WeakMap cleanup is automatic (GC) when markerEl is released.
    return () => {
      onMarkerReady(id, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerEl, id]);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: marker.lat, lng: marker.lng }}
        title={marker.label}
        // Above the non-interactive "You" self-marker so a co-located item is
        // always clickable (see SELF_MARKER_Z_INDEX / ITEM_MARKER_Z_INDEX).
        zIndex={ITEM_MARKER_Z_INDEX}
        onClick={() => {
          // Toggle: clicking the already-open marker closes its popup.
          if (isActive) {
            onClose();
          } else {
            onClick(marker);
          }
          onMarkerClick?.(marker.id);
        }}
      >
        {/*
         * Render a custom circular marker as AdvancedMarker children rather
         * than using <Pin glyph={...}>. The vis.gl <Pin> glyph prop expects a
         * string/DOM element, so a React icon node silently fails to render
         * (showing a plain colored pin with no icon). A styled div child is
         * rendered reliably by vis.gl.
         *
         * Colour is network-derived: `bg-primary` / `text-primary-foreground`
         * resolve to the active network theme's --primary (blue_dot → blue,
         * purple_dot → purple, …) the same way the rest of the UI is themed.
         * The lucide icon inherits the foreground colour via currentColor.
         */}
        {markerImage ? (
          <div
            className="flex items-center justify-center overflow-hidden rounded-full border-2 border-white bg-white shadow-md"
            style={{ width: 30, height: 30 }}
          >
            <img src={markerImage} alt="" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div
            className="flex items-center justify-center rounded-full border-2 border-white bg-primary text-primary-foreground shadow-md"
            style={{ width: 30, height: 30 }}
          >
            <DomainIcon size={16} strokeWidth={2.5} />
          </div>
        )}
      </AdvancedMarker>
      {isActive &&
        (isMobile
          ? // Mobile: render the card as a centered overlay (portal to <body>)
            // with a tap-to-close backdrop instead of the Google InfoWindow.
            // Anchoring to the marker pushed tall cards partly off-screen and
            // the InfoWindow never gave the card a bounded height, so its scroll
            // didn't engage on touch. A fixed overlay is always fully on-screen
            // and the card's own scroll works normally. Card size is unchanged.
            createPortal(
              <div
                className="fixed inset-0 z-[2000] flex items-center justify-center p-3"
                role="dialog"
                aria-modal="true"
              >
                <button
                  type="button"
                  aria-label="Close"
                  className="absolute inset-0 bg-black/40"
                  onClick={onClose}
                />
                <div className="relative">
                  {renderPopup ? (
                    renderPopup(marker)
                  ) : (
                    <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                  )}
                </div>
              </div>,
              document.body,
            )
          : markerEl && (
              <InfoWindow anchor={markerEl} onCloseClick={onClose} headerDisabled>
                <div ref={popupContentRef}>
                  {renderPopup ? (
                    renderPopup(marker)
                  ) : (
                    <MarkerPopupCard marker={marker} onViewDetails={onMarkerClick} />
                  )}
                </div>
              </InfoWindow>
            ))}
    </>
  );
}

// ─── MapView controller component ────────────────────────────────────────────
// Lives inside <Map> so it can call useMap() from @vis.gl/react-google-maps.
// Imperatively pans/zooms the Google map when the caller provides an explicit
// viewport (e.g. when the user picks a different own profile from the selector).
// Only fires when `initialViewSet` is true; when false the map is in "fit all"
// mode and we leave it alone so it doesn't fight FitBounds or user panning.

interface MapViewControllerProps {
  center: [number, number];
  zoom: number;
  initialViewSet: boolean;
  focusNonce?: number;
}

function MapViewController({ center, zoom, initialViewSet, focusNonce }: MapViewControllerProps) {
  const map = useMap();
  const prevCenter = React.useRef<[number, number] | null>(null);
  const prevZoom = React.useRef<number | null>(null);
  const prevNonce = React.useRef<number | undefined>(focusNonce);

  React.useEffect(() => {
    // Only drive the viewport when a specific profile is selected.
    if (!map || !initialViewSet) return;

    const sameCenter =
      prevCenter.current !== null &&
      prevCenter.current[0] === center[0] &&
      prevCenter.current[1] === center[1];
    const sameZoom = prevZoom.current === zoom;
    // An explicit recenter intent (nonce bump) snaps back even if the
    // coordinate is unchanged and the user has since panned away.
    const nonceChanged = prevNonce.current !== focusNonce;

    if (nonceChanged || !sameCenter || !sameZoom) {
      map.panTo({ lat: center[0], lng: center[1] });
      map.setZoom(zoom);
    }

    prevCenter.current = center;
    prevZoom.current = zoom;
    prevNonce.current = focusNonce;
  }, [center, zoom, initialViewSet, focusNonce, map]);

  return null;
}

// ─── Viewport reporter component ─────────────────────────────────────────────
// Lives inside <Map> so it can call useMap(). Reports the map's viewport
// (center + half-diagonal radius, plus the raw `map.getBounds()` corners —
// #203 map-serverside-search Task 4) to the caller on debounced `idle`
// (Google's settle event, fired after pan/zoom/resize finish). Only ever mounted when
// `onViewportChange` is provided (see `GoogleMapProvider` below), so the
// tourist app — which never passes it — attaches no `idle` listener at all.
//
// Also emits the CURRENT viewport once on mount (bypassing the debounce), for
// parity with the Leaflet provider's mount emit. Google's own `idle` normally
// fires shortly after load regardless of a location fix, so this is a
// fast-path here rather than a fix for a stuck-forever case — but it is
// skipped if center/bounds aren't ready yet, since the first `idle` will
// cover it in that case.
//
// Every emit also carries `map.getZoom()` (#203 §7, optional on Google's own
// types) so the home-page can gate anonymous count-first browsing on the
// zoom level without a separate event.

function ViewportReporter({ onViewportChange }: { onViewportChange: (viewport: MapViewport) => void }) {
  const map = useMap();
  const { emit, emitNow } = useViewportReportEmitter(onViewportChange);

  React.useEffect(() => {
    if (!map) return;
    const listener = map.addListener('idle', () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      if (!center || !bounds) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emit(
        { lat: center.lat(), lng: center.lng() },
        { ne: { lat: ne.lat(), lng: ne.lng() }, sw: { lat: sw.lat(), lng: sw.lng() } },
        map.getZoom(),
      );
    });

    const center = map.getCenter();
    const bounds = map.getBounds();
    if (center && bounds) {
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      emitNow(
        { lat: center.lat(), lng: center.lng() },
        { ne: { lat: ne.lat(), lng: ne.lng() }, sw: { lat: sw.lat(), lng: sw.lng() } },
        map.getZoom(),
      );
    }

    return () => listener.remove();
  }, [map, emit, emitNow]);

  return null;
}

// ─── Clusterer manager component ─────────────────────────────────────────────
// Lives inside <Map> so it can call useMap() from @vis.gl/react-google-maps.
// Maintains a MarkerClusterer instance and keeps it in sync with the set of
// AdvancedMarkerElements reported by ClusteredMarker children.

interface ClustererManagerProps {
  markers: MapMarker[];
  activeMarkerId: string | null;
  onMarkerActivate: (marker: MapMarker) => void;
  onMarkerDeactivate: () => void;
  onMarkerClick?: (id: string) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  resolveIcon?: MapProviderProps['resolveIcon'];
  resolveMarkerImage?: MapProviderProps['resolveMarkerImage'];
}

function ClustererManager({
  markers,
  activeMarkerId,
  onMarkerActivate,
  onMarkerDeactivate,
  onMarkerClick,
  renderPopup,
  resolveIcon,
  resolveMarkerImage,
}: ClustererManagerProps) {
  const map = useMap();

  // Map from marker id → AdvancedMarkerElement
  const markerElsRef = React.useRef<globalThis.Map<string, NonNullable<AdvancedMarkerRef>>>(new globalThis.Map());

  // Stable ref to the MarkerClusterer instance
  const clustererRef = React.useRef<MarkerClusterer | null>(null);

  // Pending handle for the rAF-batched clusterer render (see scheduleRender).
  const renderRafRef = React.useRef<number | null>(null);
  // Pending handle for the smooth cluster-click zoom animation (onClusterClick).
  const cameraAnimRef = React.useRef<number | null>(null);

  // Create the clusterer once the map is ready.
  React.useEffect(() => {
    if (!map) return;

    const clusterer = new MarkerClusterer({
      map,
      renderer: clusterRenderer,
      // One click smoothly zooms to reveal the cluster's contents. We compute
      // the SAME target zoom Google's default `fitBounds(cluster.bounds)` would
      // pick (via getBoundsZoomLevel) — for a cluster with no inner sub-clusters
      // (co-located points) that's the max cap, i.e. straight to the item level
      // — then ANIMATE the camera there (animateMapCamera) instead of the
      // default's instant snap. This restores the original one-click-reveal
      // behaviour, just smooth.
      onClusterClick: (_event, cluster, clusterMap) => {
        const div = clusterMap.getDiv();
        const dim = { width: div?.offsetWidth || 800, height: div?.offsetHeight || 600 };
        const current = clusterMap.getZoom() ?? 12;
        const fit = cluster.bounds ? getBoundsZoomLevel(cluster.bounds, dim) : current + 3;
        // Always zoom IN at least one level; never past the cap.
        const targetZoom = Math.min(Math.max(fit, current + 1), CLUSTER_CLICK_MAX_ZOOM);
        const pos = cluster.position;
        animateMapCamera(
          clusterMap,
          { lat: pos.lat(), lng: pos.lng(), zoom: targetZoom },
          cameraAnimRef,
        );
      },
    });
    clustererRef.current = clusterer;

    return () => {
      // Cancel any pending batched render + cluster-zoom animation so neither
      // fires against a torn-down clusterer/map.
      if (renderRafRef.current != null) {
        cancelAnimationFrame(renderRafRef.current);
        renderRafRef.current = null;
      }
      if (cameraAnimRef.current != null) {
        cancelAnimationFrame(cameraAnimRef.current);
        cameraAnimRef.current = null;
      }
      // clearMarkers() removes all pins from the clusterer, then setMap(null)
      // detaches the OverlayView from the map — the correct teardown sequence.
      // onRemove() is an internal OverlayView lifecycle callback and must NOT
      // be called directly as it can throw on unmount.
      // MarkerClusterer inherits setMap() at runtime through OverlayViewSafe
      // but the TypeScript class declaration doesn't surface it; cast to access
      // it without triggering the TS2339 "does not exist" error.
      clusterer.clearMarkers();
      (clusterer as unknown as { setMap: (map: null) => void }).setMap(null);
      clustererRef.current = null;
    };
  }, [map]);

  // Coalesce re-clustering into ONE render per frame. Each ClusteredMarker
  // registers its element separately as it mounts, and MarkerClusterer's
  // addMarker/removeMarker re-cluster + redraw the ENTIRE set by default on
  // every call. With N markers registering one-by-one that is O(n²) (~125k
  // clustering passes for 500 pins) — the multi-second freeze where the map is
  // blank even though the /markers response already landed. So every add/remove
  // is done with noDraw=true and a single requestAnimationFrame-batched
  // render() draws the final set once the burst settles → O(n).
  const scheduleRender = React.useCallback(() => {
    if (renderRafRef.current != null) return; // already scheduled this frame
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      clustererRef.current?.render();
    });
  }, []);

  // Callback for each ClusteredMarker to register / deregister its element.
  const handleMarkerReady = React.useCallback(
    (id: string, el: NonNullable<AdvancedMarkerRef> | null) => {
      const clusterer = clustererRef.current;
      if (!clusterer) return;

      const prev = markerElsRef.current.get(id);

      if (el === null) {
        // Marker unmounted — remove from clusterer (noDraw; batched render below).
        if (prev) {
          clusterer.removeMarker(prev, true);
          markerElsRef.current.delete(id);
          scheduleRender();
        }
        return;
      }

      if (prev === el) return; // No change.

      // Remove stale entry if element reference changed.
      if (prev) {
        clusterer.removeMarker(prev, true);
      }

      markerElsRef.current.set(id, el);
      clusterer.addMarker(el, true);
      scheduleRender();
    },
    [scheduleRender],
  );

  return (
    <>
      {markers.map((marker) => (
        <ClusteredMarker
          key={marker.id}
          marker={marker}
          isActive={activeMarkerId === marker.id}
          onClick={onMarkerActivate}
          onClose={onMarkerDeactivate}
          onMarkerClick={onMarkerClick}
          onMarkerReady={handleMarkerReady}
          renderPopup={renderPopup}
          resolveIcon={resolveIcon}
          resolveMarkerImage={resolveMarkerImage}
        />
      ))}
    </>
  );
}

// ─── Main provider ───────────────────────────────────────────────────────────

// Lives inside <Map> so it can call useMap(). Records the live camera
// (center + zoom) on every 'idle' into a ref owned by GoogleMapProvider.
// `colorScheme` is a construction-time Google Maps option, so switching
// light/dark remounts <Map> (via its `key`); this lets the remounted map
// restore the user's current view through defaultCenter/defaultZoom instead
// of snapping back to the initial center.
function CameraTracker({
  cameraRef,
}: {
  cameraRef: React.RefObject<{ center: { lat: number; lng: number }; zoom: number } | null>;
}) {
  const map = useMap();
  React.useEffect(() => {
    if (!map) return;
    const update = () => {
      const c = map.getCenter();
      const z = map.getZoom();
      if (c && z != null) cameraRef.current = { center: { lat: c.lat(), lng: c.lng() }, zoom: z };
    };
    const listener = map.addListener('idle', update);
    return () => listener.remove();
  }, [map, cameraRef]);
  return null;
}

export function GoogleMapProvider({
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
  resolveMarkerImage,
  onViewportChange,
}: MapProviderProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { resolved: themeMode } = useThemeMode();
  const [activeMarker, setActiveMarker] = React.useState<MapMarker | null>(null);
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  // Last live camera, so a colorScheme-driven <Map> remount (see below) keeps
  // the user's current view instead of resetting to the initial center.
  const liveCameraRef = React.useRef<{ center: { lat: number; lng: number }; zoom: number } | null>(null);

  // Closes the open marker popup (both the mobile portal overlay and the
  // desktop InfoWindow key off `activeMarker`) when the caller bumps
  // `closePopupNonce` — e.g. right before Connect/Apply opens the consent
  // modal, so it isn't hidden behind the popup's high stacking context.
  // Guarded with a ref (mirrors `focusNonce`'s handling in
  // `MapViewController`/`SetView`) so mount / an unchanged nonce never fires a
  // spurious close.
  const prevClosePopupNonce = React.useRef<number | undefined>(closePopupNonce);
  React.useEffect(() => {
    if (prevClosePopupNonce.current !== closePopupNonce) {
      setActiveMarker(null);
    }
    prevClosePopupNonce.current = closePopupNonce;
  }, [closePopupNonce]);

  if (!apiKey) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed">
        <div className="text-center">
          <p className="text-muted-foreground">{t('map.google_not_configured')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('map.google_set_key')}</p>
        </div>
      </div>
    );
  }

  return (
    <APIProvider apiKey={apiKey}>
      <Map
        // colorScheme is a construction-time option, so a light↔dark switch
        // remounts <Map> via this key; reuseMaps' cache key already includes
        // colorScheme, so the correctly-coloured instance is created/reused.
        // CameraTracker + liveCameraRef preserve the view across the remount.
        key={`gmap-${themeMode}`}
        colorScheme={themeMode === 'dark' ? ColorScheme.DARK : ColorScheme.LIGHT}
        defaultCenter={liveCameraRef.current?.center ?? { lat: center[0], lng: center[1] }}
        defaultZoom={liveCameraRef.current?.zoom ?? zoom}
        gestureHandling="greedy"
        mapId="dpg-items-map"
        reuseMaps
        // On mobile, render the Map/Satellite toggle as a compact dropdown
        // (MapTypeControlStyle.DROPDOWN_MENU = 2) instead of the wide
        // horizontal bar, which crowds a small screen. Desktop keeps Google's
        // default bar.
        mapTypeControlOptions={
          isMobile
            ? { style: 2 as google.maps.MapTypeControlStyle }
            : undefined
        }
        // Native fullscreen only maximizes the map's own element, which would
        // hide our overlay (filters / maximize button). We provide our own
        // maximize control on the wrapper instead — see MapView.
        fullscreenControl={false}
        // Clicking empty map area closes any open marker popup. Marker clicks
        // do not bubble to this handler in the Google Maps API, so opening a
        // popup is not immediately undone.
        onClick={() => setActiveMarker(null)}
        className="h-full w-full rounded-lg"
      >
        {/*
         * MapViewController imperatively pans/zooms the Google map when the
         * user picks a specific own-profile from the selector. Only active
         * when initialViewSet=true so it never fights the user during normal
         * panning or when "All items" / fit-all mode is active.
         */}
        <MapViewController center={center} zoom={zoom} initialViewSet={initialViewSet} focusNonce={focusNonce} />
        {onViewportChange && <ViewportReporter onViewportChange={onViewportChange} />}
        <CameraTracker cameraRef={liveCameraRef} />
        <ClustererManager
          markers={markers}
          activeMarkerId={activeMarker?.id ?? null}
          onMarkerActivate={setActiveMarker}
          onMarkerDeactivate={() => setActiveMarker(null)}
          onMarkerClick={onMarkerClick}
          renderPopup={renderPopup}
          resolveIcon={resolveIcon}
          resolveMarkerImage={resolveMarkerImage}
        />
        {/*
         * "You are here" self-marker: the user's own resolved location (profile
         * or browser geolocation). Rendered OUTSIDE ClustererManager so it is
         * never registered with the MarkerClusterer (hence never clustered) and
         * `clickable={false}` so it opens no InfoWindow and never swallows a
         * click meant for an item pin. The content is shifted down by
         * SELF_MARKER_GOOGLE_OFFSET_Y so AdvancedMarker's bottom-centre
         * anchoring lands the dot's CENTRE on the point.
         */}
        {selfLocation && (
          <AdvancedMarker
            position={{ lat: selfLocation.lat, lng: selfLocation.lng }}
            clickable={false}
            // `clickable={false}` disables the library's own click handling,
            // but its wrapper div's pointer-events behavior when non-clickable
            // is an unverified library default. Setting this explicitly
            // guarantees the self-marker never intercepts a click meant for a
            // co-located item pin underneath it (#394).
            style={{ pointerEvents: 'none' }}
            zIndex={SELF_MARKER_Z_INDEX}
            title={t('map.you_are_here_short')}
          >
            <div style={{ transform: `translateY(${SELF_MARKER_GOOGLE_OFFSET_Y}px)`, pointerEvents: 'none' }}>
              <SelfMarkerContent label={t('map.you_are_here_short')} />
            </div>
          </AdvancedMarker>
        )}
      </Map>
    </APIProvider>
  );
}

registerMapProvider({ name: 'google-maps', component: GoogleMapProvider });
