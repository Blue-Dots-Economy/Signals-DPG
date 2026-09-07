import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DivIcon, Point } from 'leaflet';
import type { LucideIcon } from 'lucide-react';
import type { MapMarker, MapViewport } from '@/engine/types';

/**
 * Provider-logic tests for the two map providers. Both wrap third-party SDKs
 * (react-leaflet + leaflet.markercluster, @vis.gl/react-google-maps +
 * @googlemaps/markerclusterer), so those modules are mocked wholesale and the
 * assertions target the code the providers actually own: marker/divIcon
 * construction, cluster badge + size thresholds, viewport reporting, the
 * recenter / close-popup nonce guards, popup wiring and registry registration.
 *
 * The mocks communicate with the tests through a bridge object hung off
 * `globalThis` — vi.mock factories are hoisted above every top-level
 * declaration in this file, so they must not close over module-scope bindings
 * (TDZ), only look the bridge up lazily at render time.
 */

interface RenderRecord {
  kind: string;
  props: Record<string, unknown>;
  /** The underlying "SDK object" the mock handed to a `ref` (L.Marker / AdvancedMarkerElement stand-in). */
  el?: object;
}

interface ClustererSpy {
  options: Record<string, unknown>;
  calls: Array<{ fn: string; arg?: unknown; noDraw?: boolean }>;
}

interface TestBridge {
  /** Fake L.Map returned by react-leaflet's useMap(). */
  map: unknown;
  /** Fake google.maps.Map returned by vis.gl's useMap(). */
  gmap: unknown;
  isMobile: boolean;
  themeMode: 'light' | 'dark';
  records: RenderRecord[];
  clusterers: ClustererSpy[];
}

type BridgeHost = { __dpgMapTestBridge: TestBridge };

const bridge = (): TestBridge => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;

(globalThis as unknown as BridgeHost).__dpgMapTestBridge = {
  map: null,
  gmap: null,
  isMobile: false,
  themeMode: 'light',
  records: [],
  clusterers: [],
};

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('@/theme/mode-provider', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  return {
    useThemeMode: () => ({
      mode: host().themeMode,
      resolved: host().themeMode,
      setMode: () => {},
    }),
  };
});

vi.mock('@/hooks/use-mobile', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  return { useIsMobile: () => host().isMobile };
});

vi.mock('react-leaflet', async () => {
  const React_ = await import('react');
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  const rec = (kind: string, props: Record<string, unknown>, el?: object) => {
    host().records.push({ kind, props, el });
  };

  const MapContainer = (props: Record<string, unknown>) => {
    rec('MapContainer', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'leaflet-map' },
      props.children as React.ReactNode,
    );
  };

  const TileLayer = (props: Record<string, unknown>) => {
    rec('TileLayer', props);
    return React_.createElement('div', {
      'data-testid': 'tile-layer',
      'data-url': String(props.url ?? ''),
      'data-attribution': String(props.attribution ?? ''),
    });
  };

  const Marker = (props: Record<string, unknown>) => {
    // One stable stand-in per mounted <Marker>, mirroring the single L.Marker
    // instance react-leaflet hands to a ref callback.
    const instanceRef = React_.useRef<{ leafletMarker: true } | null>(null);
    instanceRef.current ??= { leafletMarker: true };
    const instance = instanceRef.current;
    rec('Marker', props, instance);

    const refProp = props.ref;
    React_.useEffect(() => {
      if (typeof refProp === 'function') (refProp as (m: object) => void)(instance);
    }, [refProp, instance]);

    const handlers = props.eventHandlers as { click?: () => void } | undefined;
    return React_.createElement(
      'div',
      { 'data-testid': 'leaflet-marker', onClick: () => handlers?.click?.() },
      props.children as React.ReactNode,
    );
  };

  const Popup = (props: Record<string, unknown>) => {
    rec('Popup', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'leaflet-popup' },
      props.children as React.ReactNode,
    );
  };

  return { MapContainer, TileLayer, Marker, Popup, useMap: () => host().map };
});

vi.mock('react-leaflet-cluster', async () => {
  const React_ = await import('react');
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  const MarkerClusterGroup = (props: Record<string, unknown>) => {
    host().records.push({ kind: 'MarkerClusterGroup', props });
    return React_.createElement(
      'div',
      { 'data-testid': 'cluster-group' },
      props.children as React.ReactNode,
    );
  };
  return { default: MarkerClusterGroup };
});

vi.mock('@vis.gl/react-google-maps', async () => {
  const React_ = await import('react');
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  const rec = (kind: string, props: Record<string, unknown>, el?: object) => {
    host().records.push({ kind, props, el });
  };

  const APIProvider = (props: Record<string, unknown>) => {
    rec('APIProvider', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'api-provider', 'data-api-key': String(props.apiKey ?? '') },
      props.children as React.ReactNode,
    );
  };

  const Map_ = (props: Record<string, unknown>) => {
    rec('GMap', props);
    return React_.createElement(
      'div',
      {
        'data-testid': 'google-map',
        onClick: props.onClick as (() => void) | undefined,
      },
      props.children as React.ReactNode,
    );
  };

  const AdvancedMarker = (props: Record<string, unknown>) => {
    const elRef = React_.useRef<HTMLElement | null>(null);
    if (elRef.current === null) {
      const el = document.createElement('div');
      el.setAttribute('data-advanced-marker', String(props.title ?? ''));
      elRef.current = el;
    }
    const el = elRef.current;
    rec('AdvancedMarker', props, el);

    const refProp = props.ref;
    React_.useEffect(() => {
      if (typeof refProp === 'function') (refProp as (m: object | null) => void)(el);
    }, [refProp, el]);

    // Non-clickable markers (the "You are here" self-marker) are decoration:
    // they are not focusable and never receive a click, matching the real
    // `clickable={false}` + pointer-events:none wiring.
    if (props.clickable === false) {
      return React_.createElement(
        'div',
        { 'data-testid': 'gmap-self-marker', 'aria-label': String(props.title ?? '') },
        props.children as React.ReactNode,
      );
    }

    return React_.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'gmap-marker',
        'aria-label': String(props.title ?? ''),
        onClick: (e: React.MouseEvent) => {
          // Google Maps marker clicks do not bubble to the map's own click
          // handler; emulate that so the provider's "click empty map closes the
          // popup" path can be exercised without a marker click undoing itself.
          e.stopPropagation();
          (props.onClick as (() => void) | undefined)?.();
        },
      },
      props.children as React.ReactNode,
    );
  };

  const InfoWindow = (props: Record<string, unknown>) => {
    rec('InfoWindow', props);
    return React_.createElement(
      'div',
      { 'data-testid': 'info-window' },
      React_.createElement('button', {
        type: 'button',
        'aria-label': 'Close info window',
        onClick: props.onCloseClick as (() => void) | undefined,
      }),
      props.children as React.ReactNode,
    );
  };

  const useAdvancedMarkerRef = () => {
    const [el, setEl] = React_.useState<HTMLElement | null>(null);
    const ref = React_.useCallback((node: HTMLElement | null) => setEl(node), []);
    return [ref, el] as const;
  };

  return {
    APIProvider,
    Map: Map_,
    AdvancedMarker,
    InfoWindow,
    ColorScheme: { DARK: 'DARK', LIGHT: 'LIGHT' },
    useAdvancedMarkerRef,
    useMap: () => host().gmap,
  };
});

vi.mock('@googlemaps/markerclusterer', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapTestBridge;
  class MarkerClusterer {
    options: Record<string, unknown>;
    calls: Array<{ fn: string; arg?: unknown; noDraw?: boolean }> = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      host().clusterers.push(this as unknown as ClustererSpy);
    }
    addMarker(marker: unknown, noDraw?: boolean) {
      this.calls.push({ fn: 'addMarker', arg: marker, noDraw });
    }
    removeMarker(marker: unknown, noDraw?: boolean) {
      this.calls.push({ fn: 'removeMarker', arg: marker, noDraw });
    }
    render() {
      this.calls.push({ fn: 'render' });
    }
    clearMarkers() {
      this.calls.push({ fn: 'clearMarkers' });
    }
    setMap(map: unknown) {
      this.calls.push({ fn: 'setMap', arg: map });
    }
  }
  return { MarkerClusterer };
});

// Imported AFTER the mocks are declared; importing each provider is also what
// self-registers it with the map registry.
import { LeafletMapProvider } from '../leaflet-provider';
import { GoogleMapProvider } from '../google-maps-provider';
import {
  getRegisteredProviders,
  getActiveMapProvider,
  setActiveMapProvider,
} from '@/engine/map/map-registry';

// ─── Fixtures & fakes ────────────────────────────────────────────────────────

const ALPHA: MapMarker = {
  id: 'alpha',
  lat: 19.1,
  lng: 72.9,
  label: 'Alpha Academy',
  // Deliberately does NOT repeat the label: the popup card's heading comes from
  // `label`, while `data` drives the field rows, so tests can tell them apart.
  data: { headline: 'Alpha headline' },
  precision: 'exact',
  domain: 'seeker',
};

const BETA: MapMarker = {
  id: 'beta',
  lat: 19.2,
  lng: 72.8,
  label: 'Beta Institute',
  data: { headline: 'Beta headline' },
  precision: 'geocoded_full_address',
  domain: 'provider',
};

const GAMMA: MapMarker = {
  id: 'gamma',
  lat: 19.3,
  lng: 72.7,
  label: 'Gamma Learners',
  data: { headline: 'Gamma headline' },
  precision: 'exact',
  domain: 'seeker',
};

/** Fake L.Map: only the surface the Leaflet provider actually calls. */
function createFakeLeafletMap(opts?: { boundsValid?: boolean; zoom?: number }) {
  const listeners = new Map<string, Set<() => void>>();
  const bounds = {
    isValid: () => opts?.boundsValid ?? true,
    getNorthEast: () => ({ lat: 19.5, lng: 73.5 }),
    getSouthWest: () => ({ lat: 18.5, lng: 71.5 }),
  };
  return {
    setView: vi.fn((_center: [number, number], _zoom: number) => {}),
    fitBounds: vi.fn((_bounds: Array<[number, number]>, _options?: unknown) => {}),
    closePopup: vi.fn(() => {}),
    getCenter: () => ({ lat: 19, lng: 72.5 }),
    getBounds: () => bounds,
    getZoom: () => opts?.zoom ?? 11,
    on: vi.fn((event: string, handler: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(handler);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    }),
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    fire: (event: string) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
  };
}

/** Fake google.maps.Map: only the surface the Google provider actually calls. */
function createFakeGoogleMap(opts?: { zoom?: number; hasBounds?: boolean }) {
  const listeners: Record<string, Array<() => void>> = {};
  const removed: string[] = [];
  const camera = { lat: 19, lng: 72.5, zoom: opts?.zoom ?? 11 };
  const div = document.createElement('div');
  return {
    camera,
    listeners,
    removed,
    div,
    getDiv: () => div,
    getCenter: () => ({ lat: () => camera.lat, lng: () => camera.lng }),
    getZoom: () => camera.zoom,
    getBounds: () =>
      opts?.hasBounds === false
        ? null
        : {
            getNorthEast: () => ({ lat: () => 19.5, lng: () => 73.5 }),
            getSouthWest: () => ({ lat: () => 18.5, lng: () => 71.5 }),
          },
    panTo: vi.fn((_point: { lat: number; lng: number }) => {}),
    setZoom: vi.fn((_zoom: number) => {}),
    panBy: vi.fn((_x: number, _y: number) => {}),
    moveCamera: vi.fn((_camera: { center: { lat: number; lng: number }; zoom: number }) => {}),
    addListener: vi.fn((event: string, handler: () => void) => {
      (listeners[event] ??= []).push(handler);
      return { remove: () => removed.push(event) };
    }),
    fire: (event: string) => {
      for (const handler of [...(listeners[event] ?? [])]) handler();
    },
  };
}

/** Controllable ResizeObserver so the Google InfoWindow's fit-in-view path is testable. */
interface ObserverSpy {
  callback: () => void;
  node: Element | null;
}
const resizeObservers: ObserverSpy[] = [];
class StubResizeObserver {
  private readonly spy: ObserverSpy;
  constructor(callback: () => void) {
    this.spy = { callback, node: null };
    resizeObservers.push(this.spy);
  }
  observe(node: Element) {
    this.spy.node = node;
  }
  unobserve() {}
  disconnect() {}
}

/**
 * Pins an element's client rect (happy-dom reports all zeroes) and returns the
 * live rect object so a test can grow/shrink the element afterwards.
 */
function stubRect(node: Element, initial: { top: number; bottom: number; height: number }) {
  const rect = { ...initial };
  vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...rect,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return rect;
}

/** Stand-in for google.maps.marker.AdvancedMarkerElement (used by the cluster renderer). */
class FakeAdvancedMarkerElement {
  opts: Record<string, unknown>;
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recordsOf(kind: string): RenderRecord[] {
  return bridge().records.filter((r) => r.kind === kind);
}

function lastProps(kind: string): Record<string, unknown> {
  const list = recordsOf(kind);
  if (list.length === 0) throw new Error(`no ${kind} was rendered`);
  return list[list.length - 1].props;
}

/** De-duplicated SDK objects handed to refs, in mount order. */
function sdkObjects(kind: string): object[] {
  const seen: object[] = [];
  for (const record of recordsOf(kind)) {
    if (record.el && !seen.includes(record.el)) seen.push(record.el);
  }
  return seen;
}

function setRuntimeConfig(config: Record<string, string> | undefined): void {
  const host = window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> };
  if (config === undefined) delete host.__DPG_UI_CONFIG__;
  else host.__DPG_UI_CONFIG__ = config;
}

let originalResizeObserver: unknown;

beforeEach(() => {
  const b = bridge();
  b.map = null;
  b.gmap = null;
  b.isMobile = false;
  b.themeMode = 'light';
  b.records = [];
  b.clusterers = [];
  resizeObservers.length = 0;

  const host = globalThis as unknown as {
    ResizeObserver?: unknown;
    google?: unknown;
  };
  originalResizeObserver = host.ResizeObserver;
  host.ResizeObserver = StubResizeObserver;
  host.google = { maps: { marker: { AdvancedMarkerElement: FakeAdvancedMarkerElement } } };

  setRuntimeConfig(undefined);
});

afterEach(() => {
  const host = globalThis as unknown as { ResizeObserver?: unknown; google?: unknown };
  host.ResizeObserver = originalResizeObserver;
  delete host.google;
  setRuntimeConfig(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The registry is module-global state; leave it on the documented default so
  // the ordering of these tests can never leak into another file's expectations.
  setActiveMapProvider('leaflet');
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe('map provider registry', () => {
  it('self-registers both providers under their documented names on import', () => {
    expect(getRegisteredProviders()).toEqual(
      expect.arrayContaining(['leaflet', 'google-maps']),
    );
  });

  it('returns the component for whichever provider name is active', () => {
    setActiveMapProvider('google-maps');
    expect(getActiveMapProvider()).toBe(GoogleMapProvider);

    setActiveMapProvider('leaflet');
    expect(getActiveMapProvider()).toBe(LeafletMapProvider);
  });

  it('refuses an unregistered provider name and keeps the previous active provider', () => {
    setActiveMapProvider('leaflet');

    expect(() => setActiveMapProvider('mapbox')).toThrow(/"mapbox" is not registered/);
    expect(getActiveMapProvider()).toBe(LeafletMapProvider);
  });
});

// ─── Leaflet provider ────────────────────────────────────────────────────────

type LeafletProps = React.ComponentProps<typeof LeafletMapProvider>;

const leafletElement = (overrides: Partial<LeafletProps> = {}) => (
  <LeafletMapProvider center={[19, 72.5]} zoom={11} markers={[ALPHA]} {...overrides} />
);

type ClusterStub = {
  getChildCount: () => number;
  getAllChildMarkers?: () => object[];
};

function clusterIconFactory(): (cluster: ClusterStub) => DivIcon {
  return lastProps('MarkerClusterGroup').iconCreateFunction as (c: ClusterStub) => DivIcon;
}

describe('LeafletMapProvider', () => {
  it('renders one clustered marker per item, each with a popup card for that item', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, BETA], onMarkerClick: vi.fn() }));

    const group = screen.getByTestId('cluster-group');
    expect(within(group).getAllByTestId('leaflet-marker')).toHaveLength(2);
    expect(screen.getByText('Alpha Academy')).toBeInTheDocument();
    expect(screen.getByText('Beta Institute')).toBeInTheDocument();
  });

  it('wires the default popup card back to onMarkerClick as its "View details" action', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA], onMarkerClick }));

    await userEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(onMarkerClick).toHaveBeenCalledWith('alpha');
  });

  it('uses a custom renderPopup instead of the default card when provided', () => {
    bridge().map = createFakeLeafletMap();
    render(
      leafletElement({
        markers: [ALPHA],
        onMarkerClick: vi.fn(),
        renderPopup: (marker) => <p>custom for {marker.label}</p>,
      }),
    );

    expect(screen.getByText('custom for Alpha Academy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View details' })).not.toBeInTheDocument();
  });

  it('reports the clicked marker id to onMarkerClick', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, BETA], onMarkerClick }));

    await userEvent.click(screen.getAllByTestId('leaflet-marker')[1]);
    expect(onMarkerClick).toHaveBeenCalledWith('beta');
  });

  it('serves the light OSM basemap in light mode', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    const tiles = screen.getByTestId('tile-layer');
    expect(tiles).toHaveAttribute(
      'data-url',
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    );
    expect(tiles.getAttribute('data-attribution')).not.toContain('carto.com');
  });

  it('swaps to the CARTO dark basemap (and its attribution) in dark mode', () => {
    bridge().themeMode = 'dark';
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    const tiles = screen.getByTestId('tile-layer');
    expect(tiles).toHaveAttribute(
      'data-url',
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    );
    expect(tiles.getAttribute('data-attribution')).toContain('carto.com');
  });

  it('builds a teardrop divIcon anchored on the geo point with the domain glyph inside', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA] }));

    const icon = recordsOf('Marker')[0].props.icon as DivIcon;
    expect(icon.options.iconSize).toEqual([32, 32]);
    expect(icon.options.iconAnchor).toEqual([16, 32]);
    expect(icon.options.popupAnchor).toEqual([0, -34]);
    // Leaflet's default white-box class is cleared so only our HTML shows.
    expect(icon.options.className).toBe('');
    expect(String(icon.options.html)).toContain('<svg');
  });

  it('renders the caller-supplied resolveIcon glyph instead of the domain icon', () => {
    const CustomGlyph = () => <svg data-glyph="custom" />;
    bridge().map = createFakeLeafletMap();
    render(
      leafletElement({
        markers: [ALPHA],
        resolveIcon: () => CustomGlyph as unknown as LucideIcon,
      }),
    );

    const icon = recordsOf('Marker')[0].props.icon as DivIcon;
    expect(String(icon.options.html)).toContain('data-glyph="custom"');
  });

  it('renders the non-interactive "You are here" marker OUTSIDE the cluster group', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA], selfLocation: { lat: 19, lng: 72.5 } }));

    // Only the item pin is inside the cluster group; the self-marker is a sibling
    // so it can never be folded into a cluster.
    const group = screen.getByTestId('cluster-group');
    expect(within(group).getAllByTestId('leaflet-marker')).toHaveLength(1);
    expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(2);

    const selfProps =
      recordsOf('Marker').find((r) => r.props.interactive === false)?.props ?? {};
    expect(selfProps.interactive).toBe(false);
    expect(selfProps.keyboard).toBe(false);
    expect(selfProps.zIndexOffset).toBe(1000);
    expect(String((selfProps.icon as DivIcon).options.html)).toContain('You');
  });

  it('renders no self-marker when the user has no resolved location', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA], selfLocation: null }));

    expect(screen.getAllByTestId('leaflet-marker')).toHaveLength(1);
  });

  it('configures the cluster group with the documented clustering options', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement());

    const props = lastProps('MarkerClusterGroup');
    expect(props.chunkedLoading).toBe(true);
    expect(props.spiderfyOnMaxZoom).toBe(true);
    expect(props.zoomToBoundsOnClick).toBe(true);
    expect(props.maxClusterRadius).toBe(80);
  });

  it('sizes the cluster bubble by count band and shows the total', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement());
    const iconFor = clusterIconFactory();

    const small = String(iconFor({ getChildCount: () => 4 }).options.html);
    expect(small).toContain('width: 34px');
    expect(small).toContain('>4</div>');

    expect(String(iconFor({ getChildCount: () => 42 }).options.html)).toContain('width: 40px');
    expect(String(iconFor({ getChildCount: () => 150 }).options.html)).toContain('width: 46px');
  });

  it('adds a per-domain badge row (and widens the icon) for a multi-domain cluster', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, BETA, GAMMA] }));

    const icon = clusterIconFactory()({
      getChildCount: () => 3,
      getAllChildMarkers: () => sdkObjects('Marker'),
    });

    const html = String(icon.options.html);
    expect(html).toContain('>3</div>');
    // Two distinct domains → exactly two chips (seeker ×2 first, provider ×1).
    const chips = html.match(/<span/g) ?? [];
    expect(chips).toHaveLength(2);
    // The dominant domain's chip carries its own count (seeker ×2).
    expect(html).toMatch(/>\s*2\s*<\/span>/);

    // Width grows to fit the chips; height grows by the badge row.
    const size = icon.options.iconSize as Point;
    expect(size.x).toBe(2 * 38 + 3);
    expect(size.y).toBe(34 + 22);
    const anchor = icon.options.iconAnchor as Point;
    expect(anchor.x).toBe(size.x / 2);
    expect(anchor.y).toBe(17);
  });

  it('never fabricates an empty-domain group for markers with no known domain', () => {
    const noDomain: MapMarker = {
      id: 'delta',
      lat: 19.4,
      lng: 72.6,
      label: 'Delta',
      data: {},
      precision: 'exact',
    };
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA, GAMMA, noDomain] }));

    const icon = clusterIconFactory()({
      getChildCount: () => 3,
      getAllChildMarkers: () => sdkObjects('Marker'),
    });

    const html = String(icon.options.html);
    // One real domain (seeker) → single-domain cluster: no badge chips at all…
    expect(html).not.toContain('<span');
    // …though the domain-less pin is still part of the headline total.
    expect(html).toContain('>3</div>');
    const size = icon.options.iconSize as Point;
    expect(size.x).toBe(34);
    expect(size.y).toBe(34);
  });

  it('drives the camera to the caller viewport when a specific profile is selected', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { rerender } = render(leafletElement({ initialViewSet: true, focusNonce: 1 }));

    expect(map.setView).toHaveBeenCalledWith([19, 72.5], 11);

    // Same center/zoom/nonce → no second setView (never fights user panning).
    rerender(leafletElement({ initialViewSet: true, focusNonce: 1 }));
    expect(map.setView).toHaveBeenCalledTimes(1);

    // A nonce bump is an explicit recenter intent even for an unchanged point.
    rerender(leafletElement({ initialViewSet: true, focusNonce: 2 }));
    expect(map.setView).toHaveBeenCalledTimes(2);

    // A changed center recenters too.
    rerender(leafletElement({ initialViewSet: true, focusNonce: 2, center: [20, 73] }));
    expect(map.setView).toHaveBeenLastCalledWith([20, 73], 11);
  });

  it('fits all markers when no explicit viewport is set', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [ALPHA, BETA] }));

    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [19.1, 72.9],
        [19.2, 72.8],
      ],
      { padding: [50, 50] },
    );
    expect(map.setView).not.toHaveBeenCalled();
  });

  it('skips bounds-fitting in viewport-markers mode so fit and fetch cannot loop', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement({ markers: [ALPHA, BETA], onViewportChange: vi.fn() }));

    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.setView).not.toHaveBeenCalled();
  });

  it('emits the current viewport (bbox + zoom) once on mount', () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap({ zoom: 13 });
    bridge().map = map;
    render(leafletElement({ onViewportChange }));

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const viewport = onViewportChange.mock.calls[0][0];
    expect(viewport).toEqual(
      expect.objectContaining({
        lat: 19,
        lng: 72.5,
        minLat: 18.5,
        minLng: 71.5,
        maxLat: 19.5,
        maxLng: 73.5,
        zoom: 13,
      }),
    );
    expect(viewport.radiusMeters).toBeGreaterThan(0);
  });

  it('re-emits on debounced moveend and detaches the listener on unmount', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { unmount } = render(leafletElement({ onViewportChange }));

    expect(map.listenerCount('moveend')).toBe(1);
    onViewportChange.mockClear();

    act(() => map.fire('moveend'));
    // Debounced — nothing yet.
    expect(onViewportChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));

    unmount();
    expect(map.listenerCount('moveend')).toBe(0);
  });

  it('skips the mount emit while the map bounds are not yet valid, but still emits on moveend', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    const map = createFakeLeafletMap({ boundsValid: false });
    bridge().map = map;
    render(leafletElement({ onViewportChange }));

    expect(onViewportChange).not.toHaveBeenCalled();

    act(() => map.fire('moveend'));
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));
  });

  it('attaches no moveend listener at all when the caller wants no viewport reports', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    render(leafletElement());

    expect(map.listenerCount('moveend')).toBe(0);
    expect(map.on).not.toHaveBeenCalled();
  });

  it('closes the open popup only when closePopupNonce actually changes', () => {
    const map = createFakeLeafletMap();
    bridge().map = map;
    const { rerender } = render(leafletElement({ closePopupNonce: 3 }));

    // Mounting with a nonce already set must not fire a spurious close.
    expect(map.closePopup).not.toHaveBeenCalled();

    rerender(leafletElement({ closePopupNonce: 3 }));
    expect(map.closePopup).not.toHaveBeenCalled();

    rerender(leafletElement({ closePopupNonce: 4 }));
    expect(map.closePopup).toHaveBeenCalledTimes(1);
  });

  it('gives the popup a fixed 300px width and no Leaflet close button', () => {
    bridge().map = createFakeLeafletMap();
    render(leafletElement({ markers: [ALPHA] }));

    const popup = lastProps('Popup');
    expect(popup.closeButton).toBe(false);
    expect(popup.minWidth).toBe(300);
    expect(popup.maxWidth).toBe(300);
  });
});

// ─── Google provider ─────────────────────────────────────────────────────────

type GoogleProps = React.ComponentProps<typeof GoogleMapProvider>;

const googleElement = (overrides: Partial<GoogleProps> = {}) => (
  <GoogleMapProvider center={[19, 72.5]} zoom={11} markers={[ALPHA]} {...overrides} />
);

/** Configures the API key the way a deployment does — through /config.js. */
function configureApiKey(): void {
  setRuntimeConfig({ VITE_GOOGLE_MAPS_API_KEY: 'test-key' });
}

function firstClusterer(): ClustererSpy {
  const clusterer = bridge().clusterers[0];
  if (!clusterer) throw new Error('no MarkerClusterer was created');
  return clusterer;
}

function clustererCalls(fn: string): Array<{ fn: string; arg?: unknown; noDraw?: boolean }> {
  return firstClusterer().calls.filter((c) => c.fn === fn);
}

/** google.maps.LatLng stand-in (lat()/lng() accessors). */
const latLng = (lat: number, lng: number) => ({ lat: () => lat, lng: () => lng });

describe('GoogleMapProvider', () => {
  it('renders a configuration hint instead of a map when no API key is available', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    setRuntimeConfig(undefined);

    render(googleElement());

    expect(screen.getByText('Google Maps provider not configured.')).toBeInTheDocument();
    expect(screen.getByText(/VITE_GOOGLE_MAPS_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByTestId('google-map')).not.toBeInTheDocument();
  });

  it('boots the map from the runtime-config API key with the vector map + custom controls', () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(screen.getByTestId('api-provider')).toHaveAttribute('data-api-key', 'test-key');
    const props = lastProps('GMap');
    expect(props.defaultCenter).toEqual({ lat: 19, lng: 72.5 });
    expect(props.defaultZoom).toBe(11);
    expect(props.mapId).toBe('dpg-items-map');
    // Native fullscreen would hide the app's own map overlay controls.
    expect(props.fullscreenControl).toBe(false);
    expect(props.colorScheme).toBe('LIGHT');
  });

  it('constructs a dark-scheme map when the app theme is dark', () => {
    configureApiKey();
    bridge().themeMode = 'dark';
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').colorScheme).toBe('DARK');
  });

  it('collapses the Map/Satellite control into a dropdown on mobile', () => {
    configureApiKey();
    bridge().isMobile = true;
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').mapTypeControlOptions).toEqual({ style: 2 });
  });

  it("keeps Google's default Map/Satellite bar on desktop", () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement());

    expect(lastProps('GMap').mapTypeControlOptions).toBeUndefined();
  });

  it('registers every pin with the clusterer without drawing, batching the redraw', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const many: MapMarker[] = Array.from({ length: 6 }, (_, i) => ({
      ...ALPHA,
      id: `pin-${i}`,
      label: `Pin ${i}`,
      lat: 19 + i / 100,
    }));

    render(googleElement({ markers: many }));

    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(6));
    // Every add is noDraw:true …
    expect(clustererCalls('addMarker').every((c) => c.noDraw === true)).toBe(true);
    // … and the redraws are coalesced per frame rather than one per marker (O(n), not O(n²)).
    expect(clustererCalls('render').length).toBeGreaterThanOrEqual(1);
    expect(clustererCalls('render').length).toBeLessThan(6);

    expect(screen.getAllByTestId('gmap-marker')).toHaveLength(6);
    expect(recordsOf('AdvancedMarker')[0].props.zIndex).toBe(500);
  });

  it('deregisters a pin that drops out of the marker set', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(2));
    const betaEl = recordsOf('AdvancedMarker').find(
      (r) => r.props.title === 'Beta Institute',
    )?.el;

    rerender(googleElement({ markers: [ALPHA] }));

    expect(clustererCalls('removeMarker')).toEqual([
      { fn: 'removeMarker', arg: betaEl, noDraw: true },
    ]);
    expect(screen.getAllByTestId('gmap-marker')).toHaveLength(1);
  });

  it('tears the clusterer overlay down on unmount', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { unmount } = render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(2));

    unmount();

    // The manager's cleanup runs before its children's, so the per-marker
    // removals are skipped (clustererRef is already null) — clearMarkers() drops
    // all pins and setMap(null) detaches the OverlayView, which is the whole
    // teardown. onRemove() must never be called directly (it can throw).
    expect(clustererCalls('clearMarkers')).toHaveLength(1);
    expect(clustererCalls('setMap')).toEqual([{ fn: 'setMap', arg: null }]);
    expect(clustererCalls('removeMarker')).toHaveLength(0);
  });

  it('opens an InfoWindow anchored to the clicked pin, and toggles it shut on a second click', async () => {
    const onMarkerClick = vi.fn((_id: string) => {});
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA], onMarkerClick }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    expect(screen.getByTestId('info-window')).toBeInTheDocument();
    expect(screen.getByText('Alpha headline')).toBeInTheDocument();
    expect(onMarkerClick).toHaveBeenCalledWith('alpha');
    const info = lastProps('InfoWindow');
    expect(info.headerDisabled).toBe(true);
    expect(info.anchor).toBe(
      recordsOf('AdvancedMarker').find((r) => r.props.clickable !== false)?.el,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it("closes the InfoWindow from Google's own close affordance", async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close info window' }));

    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('shows a centered modal card (not an InfoWindow) on mobile, dismissable by its backdrop', async () => {
    configureApiKey();
    bridge().isMobile = true;
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Alpha headline')).toBeInTheDocument();
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the open popup when the user clicks empty map area', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    expect(screen.getByTestId('info-window')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('google-map'));

    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('closes the open popup when closePopupNonce is bumped, but not on mount', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    const { rerender } = render(googleElement({ markers: [ALPHA], closePopupNonce: 1 }));

    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));
    rerender(googleElement({ markers: [ALPHA], closePopupNonce: 1 }));
    expect(screen.getByTestId('info-window')).toBeInTheDocument();

    rerender(googleElement({ markers: [ALPHA], closePopupNonce: 2 }));
    expect(screen.queryByTestId('info-window')).not.toBeInTheDocument();
  });

  it('re-centres the camera on an explicit viewport, and again on a focusNonce bump', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;
    const { rerender } = render(googleElement({ initialViewSet: true, focusNonce: 1 }));

    expect(gmap.panTo).toHaveBeenCalledWith({ lat: 19, lng: 72.5 });
    expect(gmap.setZoom).toHaveBeenCalledWith(11);

    rerender(googleElement({ initialViewSet: true, focusNonce: 1 }));
    expect(gmap.panTo).toHaveBeenCalledTimes(1);

    rerender(googleElement({ initialViewSet: true, focusNonce: 2 }));
    expect(gmap.panTo).toHaveBeenCalledTimes(2);
  });

  it('leaves the camera alone in fit-all mode (no explicit viewport)', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;

    render(googleElement({ initialViewSet: false }));

    expect(gmap.panTo).not.toHaveBeenCalled();
    expect(gmap.setZoom).not.toHaveBeenCalled();
  });

  it('emits the viewport on mount and on debounced idle, listening only when asked to', async () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 14 });
    bridge().gmap = gmap;

    render(googleElement({ onViewportChange }));

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    expect(onViewportChange.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        lat: 19,
        lng: 72.5,
        minLat: 18.5,
        minLng: 71.5,
        maxLat: 19.5,
        maxLng: 73.5,
        zoom: 14,
      }),
    );
    // Viewport reporter + camera tracker.
    expect(gmap.listeners.idle).toHaveLength(2);

    onViewportChange.mockClear();
    act(() => gmap.fire('idle'));
    expect(onViewportChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));
  });

  it('attaches no viewport listener at all when the caller wants no reports', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;

    render(googleElement());

    // Only the camera tracker — the tourist app attaches no reporter.
    expect(gmap.listeners.idle).toHaveLength(1);
  });

  it('reports nothing while the map has no bounds yet', () => {
    const onViewportChange = vi.fn((_viewport: MapViewport) => {});
    configureApiKey();
    const gmap = createFakeGoogleMap({ hasBounds: false });
    bridge().gmap = gmap;

    render(googleElement({ onViewportChange }));
    expect(onViewportChange).not.toHaveBeenCalled();

    act(() => gmap.fire('idle'));
    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('renders the self-marker below the pins, non-clickable and outside the clusterer', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();

    render(googleElement({ markers: [ALPHA], selfLocation: { lat: 19, lng: 72.5 } }));
    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(1));

    const selfRecord = recordsOf('AdvancedMarker').find((r) => r.props.clickable === false);
    const itemRecord = recordsOf('AdvancedMarker').find((r) => r.props.clickable !== false);
    expect(selfRecord?.props.zIndex).toBe(0);
    expect(itemRecord?.props.zIndex).toBe(500);
    // Never intercepts a click meant for a co-located item pin (#394).
    expect(selfRecord?.props.style).toEqual({ pointerEvents: 'none' });

    const selfMarker = screen.getByTestId('gmap-self-marker');
    expect(selfMarker).toHaveAttribute('aria-label', 'You');
    expect(within(selfMarker).getByText('You')).toBeInTheDocument();

    // Exactly one element was clustered — and it is the item pin, not the self-marker.
    expect(clustererCalls('addMarker')[0].arg).toBe(itemRecord?.el);
  });

  it('themes the cluster bubble with the total, sized by count band', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(2));

    const renderer = firstClusterer().options.renderer as {
      render: (cluster: unknown) => FakeAdvancedMarkerElement;
    };
    const els = sdkObjects('AdvancedMarker');

    const bubble = renderer.render({ count: 7, position: { lat: 19, lng: 72.5 }, markers: els });
    expect(bubble.opts.zIndex).toBe(1007);
    const content = bubble.opts.content as HTMLElement;
    const circle = content.querySelector('.dpg-cluster-count') as HTMLElement;
    expect(circle.textContent).toBe('7');
    expect(circle.style.width).toBe('38px');

    const medium = renderer.render({ count: 50, position: { lat: 19, lng: 72.5 }, markers: [] });
    const large = renderer.render({ count: 200, position: { lat: 19, lng: 72.5 }, markers: [] });
    expect(
      ((medium.opts.content as HTMLElement).querySelector('.dpg-cluster-count') as HTMLElement)
        .style.width,
    ).toBe('44px');
    expect(
      ((large.opts.content as HTMLElement).querySelector('.dpg-cluster-count') as HTMLElement).style
        .width,
    ).toBe('50px');
  });

  it('adds one chip per domain to a multi-domain cluster bubble and none to a single-domain one', async () => {
    configureApiKey();
    bridge().gmap = createFakeGoogleMap();
    render(googleElement({ markers: [ALPHA, BETA] }));
    await waitFor(() => expect(clustererCalls('addMarker')).toHaveLength(2));

    const renderer = firstClusterer().options.renderer as {
      render: (cluster: unknown) => FakeAdvancedMarkerElement;
    };
    const els = sdkObjects('AdvancedMarker');

    const multi = renderer.render({ count: 2, position: { lat: 19, lng: 72.5 }, markers: els });
    const multiContent = multi.opts.content as HTMLElement;
    expect(multiContent.children).toHaveLength(2);
    expect(multiContent.lastElementChild?.children).toHaveLength(2);
    expect(multiContent.lastElementChild?.textContent).toContain('1');

    const single = renderer.render({
      count: 1,
      position: { lat: 19, lng: 72.5 },
      markers: [els[0]],
    });
    expect((single.opts.content as HTMLElement).children).toHaveLength(1);
  });

  it('animates a co-located cluster click all the way to the item-level zoom cap', async () => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 12 });
    bridge().gmap = gmap;
    render(googleElement());

    const onClusterClick = firstClusterer().options.onClusterClick as (
      event: unknown,
      cluster: unknown,
      map: unknown,
    ) => void;
    const corner = latLng(19.5, 72.25);
    onClusterClick(
      null,
      {
        position: latLng(19.5, 72.25),
        bounds: { getNorthEast: () => corner, getSouthWest: () => corner },
      },
      gmap,
    );

    await waitFor(
      () => expect(gmap.moveCamera.mock.calls.at(-1)?.[0].zoom).toBeCloseTo(20, 5),
      { timeout: 4500 },
    );
    // Animated, not an instant fitBounds snap: many frames, starting near the
    // current zoom and landing on the cluster's own position.
    expect(gmap.moveCamera.mock.calls.length).toBeGreaterThan(2);
    expect(gmap.moveCamera.mock.calls[0][0].zoom).toBeLessThan(20);
    // Interpolated per rAF frame, so the final centre is only as exact as the
    // last frame's easing value. Under a loaded box (the full suite running in
    // parallel) the animation can settle a few nanodegrees short, which an
    // exact toEqual turns into a flake. Match the toBeCloseTo already used for
    // zoom above: 6 decimal places is ~0.1 m, far tighter than any real
    // camera-positioning requirement.
    const finalCenter = gmap.moveCamera.mock.calls.at(-1)?.[0].center;
    expect(finalCenter?.lat).toBeCloseTo(19.5, 6);
    expect(finalCenter?.lng).toBeCloseTo(72.25, 6);
  });

  it('still zooms in one level when the cluster already fills the viewport', async () => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 12 });
    bridge().gmap = gmap;
    render(googleElement());

    const onClusterClick = firstClusterer().options.onClusterClick as (
      event: unknown,
      cluster: unknown,
      map: unknown,
    ) => void;
    onClusterClick(
      null,
      {
        position: latLng(0, 0),
        bounds: {
          getNorthEast: () => latLng(85, 180),
          getSouthWest: () => latLng(-85, -180),
        },
      },
      gmap,
    );

    await waitFor(
      () => expect(gmap.moveCamera.mock.calls.at(-1)?.[0].zoom).toBeCloseTo(13, 5),
      { timeout: 4500 },
    );
  });

  it('preserves the live camera across the light/dark remount of the map', () => {
    configureApiKey();
    const gmap = createFakeGoogleMap({ zoom: 9 });
    gmap.camera.lat = 30;
    gmap.camera.lng = 40;
    bridge().gmap = gmap;
    const { rerender } = render(googleElement());

    // The camera tracker records wherever the user has panned to.
    act(() => gmap.fire('idle'));

    bridge().themeMode = 'dark';
    rerender(googleElement());

    const props = lastProps('GMap');
    expect(props.colorScheme).toBe('DARK');
    expect(props.defaultCenter).toEqual({ lat: 30, lng: 40 });
    expect(props.defaultZoom).toBe(9);
  });

  it('nudges the map so an expanding popup card stays fully visible', async () => {
    configureApiKey();
    const gmap = createFakeGoogleMap();
    bridge().gmap = gmap;
    render(googleElement({ markers: [ALPHA] }));
    await userEvent.click(screen.getByRole('button', { name: 'Alpha Academy' }));

    const observer = resizeObservers.at(-1);
    const node = observer?.node as HTMLElement;
    expect(node).toBeTruthy();

    stubRect(gmap.div, { top: 0, bottom: 500, height: 500 });
    const cardRect = stubRect(node, { top: -50, bottom: 250, height: 300 });

    // First measurement is only the baseline — Google's own open-time auto-pan
    // must not be fought.
    observer?.callback();
    expect(gmap.panBy).not.toHaveBeenCalled();

    // The card grows (e.g. "View more details") → pan to reveal its clipped top.
    cardRect.height = 420;
    observer?.callback();

    await waitFor(() => expect(gmap.panBy).toHaveBeenCalledWith(0, -66));
  });
});
