import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Star } from 'lucide-react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain, MapMarker, MapProviderProps, MapViewport } from '@/engine/types';
import {
  registerMapProvider,
  setActiveMapProvider,
  getRegisteredProviders,
} from '@/engine/map/map-registry';
import { FALLBACK_CENTER, FALLBACK_ZOOM, MapView } from '../map-container';
import { BrowseFiltersPanel } from '@/components/filters/browse-filters-panel';

/**
 * Component-level tests for the two remaining uncovered halves of the map UI:
 *
 *  - `MapView` (`map-container.tsx`) — provider resolution through the runtime
 *    registry, the focus-point vs default center/zoom decision, the
 *    schema-driven marker/label resolution pipeline (including the
 *    `item_locations` fan-out), and the maximize / loading / empty overlays.
 *    The real Leaflet + Google providers are never imported here; a tiny fake
 *    provider is registered instead and renders every prop it receives as text
 *    so assertions stay DOM-level rather than mock-level.
 *
 *  - `BrowseFiltersPanel` (`browse-filters-panel.tsx`) — the interactive branches the
 *    existing `browse-filters-panel.test.tsx` deliberately does not touch (it only
 *    asserts the trigger's presence): domain chips, enum chip toggling, the
 *    >8-option searchable dropdown, clear-all, close, the help-text variants
 *    and the mobile bottom-sheet chrome.
 *
 * `use-mobile` is mocked through a `globalThis` bridge because `vi.mock`
 * factories are hoisted above every top-level declaration in this file and so
 * must not close over module-scope bindings.
 */

interface TestBridge {
  isMobile: boolean;
}
type BridgeHost = { __dpgMapPanelTestBridge: TestBridge };

(globalThis as unknown as BridgeHost).__dpgMapPanelTestBridge = { isMobile: false };

const bridge = (): TestBridge => (globalThis as unknown as BridgeHost).__dpgMapPanelTestBridge;

vi.mock('@/hooks/use-mobile', () => {
  const host = () => (globalThis as unknown as BridgeHost).__dpgMapPanelTestBridge;
  return { useIsMobile: () => host().isMobile };
});

// ─── Fake map provider ───────────────────────────────────────────────────────

/**
 * Renders everything `MapView` hands the active provider as user-visible text,
 * plus a button per marker (so `onMarkerClick` wiring is exercised by a real
 * click) and a button that emits a viewport (so `onViewportChange` is too).
 */
function makeFakeProvider(name: string) {
  return function FakeProvider({
    center,
    zoom,
    markers,
    onMarkerClick,
    initialViewSet,
    focusNonce,
    closePopupNonce,
    selfLocation,
    renderPopup,
    resolveIcon,
    resolveMarkerImage,
    onViewportChange,
  }: MapProviderProps) {
    return (
      <div>
        <p>{`provider: ${name}`}</p>
        <p>{`center: ${center[0]},${center[1]}`}</p>
        <p>{`zoom: ${zoom}`}</p>
        <p>{`initialViewSet: ${String(initialViewSet === true)}`}</p>
        <p>{`focusNonce: ${focusNonce ?? 'none'}`}</p>
        <p>{`closePopupNonce: ${closePopupNonce ?? 'none'}`}</p>
        <p>{`self: ${selfLocation ? `${selfLocation.lat},${selfLocation.lng}` : 'none'}`}</p>
        <p>{`viewport listener: ${onViewportChange ? 'yes' : 'no'}`}</p>
        <p>{`icon resolver: ${resolveIcon ? 'custom' : 'default'}`}</p>
        <button type="button" onClick={() => onViewportChange?.(EMITTED_VIEWPORT)}>
          emit viewport
        </button>
        <ul>
          {markers.map((marker) => {
            const image = resolveMarkerImage?.(marker);
            return (
              <li key={marker.id}>
                <button type="button" onClick={() => onMarkerClick?.(marker.id)}>
                  {marker.label}
                </button>
                <span>{`${marker.id} @ ${marker.lat.toFixed(5)},${marker.lng.toFixed(5)}`}</span>
                {image ? <img src={image} alt={`badge for ${marker.label}`} /> : null}
                {resolveIcon
                  ? React.createElement(resolveIcon(marker), {
                      'aria-label': `icon for ${marker.label}`,
                    })
                  : null}
                {renderPopup ? renderPopup(marker) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
}

const EMITTED_VIEWPORT: MapViewport = {
  lat: 12.9,
  lng: 77.6,
  radiusMeters: 4000,
  zoom: 13,
  minLat: 12.8,
  minLng: 77.5,
  maxLat: 13.0,
  maxLng: 77.7,
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BLR = { lat: 12.9716, lng: 77.5946 };

function schemaWith(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'object', properties, ...extra } as RJSFSchema;
}

const NAME_SCHEMA = schemaWith({ name: { type: 'string' } });

function itemAt(
  id: string,
  locations: Array<{ lat: number; lng: number; label?: string }>,
  extra: Record<string, unknown> = {},
) {
  return { id, data: { item_locations: locations, ...extra } };
}

/** Swallows a render error and shows its message, so the registry's misconfiguration message is assertable. */
class Boundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { message: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }
  render() {
    if (this.state.message !== null) return <p>caught: {this.state.message}</p>;
    return this.props.children;
  }
}

// ─── MapView: provider resolution ────────────────────────────────────────────

describe('MapView — active map provider resolution', () => {
  // NOTE: this block must stay FIRST in the file. It asserts the behaviour when
  // NOTHING is registered yet (the registry is module-level state, and the real
  // leaflet/google provider modules are deliberately never imported here), so
  // it has to run before the fakes below are registered.
  it('surfaces the registry misconfiguration error when the active provider name is unregistered', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(getRegisteredProviders()).toEqual([]);

      render(
        <Boundary>
          <MapView schema={NAME_SCHEMA} items={[]} />
        </Boundary>,
      );

      // The active name comes from VITE_MAP_PROVIDER, so it is NOT hardcoded
      // here: a developer with `VITE_MAP_PROVIDER=google-maps` in their local
      // .env would otherwise see this fail for a reason that has nothing to do
      // with the behaviour under test. What matters is that MapView fails
      // LOUDLY for an unregistered name rather than silently rendering a
      // map-less page.
      expect(
        screen.getByText(/caught: No active map provider "[^"]+"/),
      ).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('renders whichever provider is active and follows setActiveMapProvider', async () => {
    registerMapProvider({ name: 'fake-alpha', component: makeFakeProvider('fake-alpha') });
    registerMapProvider({ name: 'fake-beta', component: makeFakeProvider('fake-beta') });
    expect(getRegisteredProviders()).toEqual(['fake-alpha', 'fake-beta']);

    setActiveMapProvider('fake-alpha');
    const { unmount } = render(<MapView schema={NAME_SCHEMA} items={[]} />);
    expect(await screen.findByText('provider: fake-alpha')).toBeInTheDocument();
    unmount();

    setActiveMapProvider('fake-beta');
    render(<MapView schema={NAME_SCHEMA} items={[]} />);
    expect(await screen.findByText('provider: fake-beta')).toBeInTheDocument();
    expect(screen.queryByText('provider: fake-alpha')).not.toBeInTheDocument();
  });

  it('refuses to activate an unregistered provider and keeps the previous one', async () => {
    setActiveMapProvider('fake-alpha');
    expect(() => setActiveMapProvider('mapbox')).toThrow(/"mapbox" is not registered/);

    render(<MapView schema={NAME_SCHEMA} items={[]} />);
    expect(await screen.findByText('provider: fake-alpha')).toBeInTheDocument();
  });
});

// ─── MapView: viewport (center / zoom / initialViewSet) ──────────────────────

describe('MapView — center, zoom and focus point', () => {
  beforeEach(() => {
    setActiveMapProvider('fake-alpha');
  });

  it('falls back to the whole-India default view and lets the provider fit bounds when there is no focus point', async () => {
    // VITE_MAP_DEFAULT_CENTER / _ZOOM are unset in the test env, so the
    // module-level defaults resolve to the exported fallbacks.
    render(<MapView schema={NAME_SCHEMA} items={[]} />);

    expect(
      await screen.findByText(`center: ${FALLBACK_CENTER[0]},${FALLBACK_CENTER[1]}`),
    ).toBeInTheDocument();
    expect(screen.getByText(`zoom: ${FALLBACK_ZOOM}`)).toBeInTheDocument();
    expect(screen.getByText('initialViewSet: false')).toBeInTheDocument();
  });

  it('honours an explicit caller center/zoom when no focus point is set', async () => {
    render(<MapView schema={NAME_SCHEMA} items={[]} center={[10, 20]} zoom={8} />);

    expect(await screen.findByText('center: 10,20')).toBeInTheDocument();
    expect(screen.getByText('zoom: 8')).toBeInTheDocument();
    expect(screen.getByText('initialViewSet: false')).toBeInTheDocument();
  });

  it('centers on the active profile at city zoom and suppresses fit-bounds when a focus point is given', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[]}
        center={[10, 20]}
        zoom={8}
        focusPoint={BLR}
        focusNonce={3}
        closePopupNonce={7}
        selfLocation={BLR}
      />,
    );

    expect(await screen.findByText(`center: ${BLR.lat},${BLR.lng}`)).toBeInTheDocument();
    // PROFILE_ZOOM — the caller's zoom={8} is intentionally overridden.
    expect(screen.getByText('zoom: 12')).toBeInTheDocument();
    expect(screen.getByText('initialViewSet: true')).toBeInTheDocument();
    expect(screen.getByText('focusNonce: 3')).toBeInTheDocument();
    expect(screen.getByText('closePopupNonce: 7')).toBeInTheDocument();
    expect(screen.getByText(`self: ${BLR.lat},${BLR.lng}`)).toBeInTheDocument();
  });

  it('normalises an undefined selfLocation to null and attaches no viewport listener when unset', async () => {
    render(<MapView schema={NAME_SCHEMA} items={[]} />);

    expect(await screen.findByText('self: none')).toBeInTheDocument();
    expect(screen.getByText('viewport listener: no')).toBeInTheDocument();
    expect(screen.getByText('icon resolver: default')).toBeInTheDocument();
  });

  it('forwards viewport reports from the provider to onViewportChange', async () => {
    const onViewportChange = vi.fn();
    render(
      <MapView schema={NAME_SCHEMA} items={[]} onViewportChange={onViewportChange} />,
    );

    expect(await screen.findByText('viewport listener: yes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'emit viewport' }));

    expect(onViewportChange).toHaveBeenCalledWith(EMITTED_VIEWPORT);
  });
});

// ─── MapView: marker resolution ──────────────────────────────────────────────

describe('MapView — marker resolution from item_locations', () => {
  beforeEach(() => {
    setActiveMapProvider('fake-alpha');
  });

  it('emits one marker per stored location, suffixing the location label', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[
          itemAt(
            'item-a',
            [
              { lat: 10, lng: 20, label: 'HQ' },
              { lat: 11, lng: 21 },
            ],
            { name: 'Acme' },
          ),
        ]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Acme — HQ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    // Marker ids are `${itemId}#${index}` so multi-location items stay distinct.
    expect(screen.getByText('item-a#0 @ 10.00000,20.00000')).toBeInTheDocument();
    expect(screen.getByText('item-a#1 @ 11.00000,21.00000')).toBeInTheDocument();
  });

  it('drops items with no stored location instead of geocoding them client-side', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[
          itemAt('placed', [{ lat: 10, lng: 20 }], { name: 'Placed' }),
          { id: 'no-locs', data: { name: 'Unplaced', item_locations: [] } },
          { id: 'not-an-array', data: { name: 'Malformed', item_locations: 'Bengaluru' } },
          { id: 'missing-key', data: { name: 'Missing' } },
        ]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Placed' })).toBeInTheDocument();
    for (const label of ['Unplaced', 'Malformed', 'Missing']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('reports the item id back to onMarkerClick with its location index', async () => {
    const onMarkerClick = vi.fn();
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('item-a', [{ lat: 10, lng: 20 }], { name: 'Acme' })]}
        onMarkerClick={onMarkerClick}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Acme' }));

    expect(onMarkerClick).toHaveBeenCalledWith('item-a#0');
  });

  it('prefers resolveMarkerLabel over the schema heuristic, ignoring a blank result', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[
          itemAt('a', [{ lat: 10, lng: 20 }], { name: 'Schema Name A' }),
          itemAt('b', [{ lat: 11, lng: 21 }], { name: 'Schema Name B' }),
        ]}
        resolveMarkerLabel={(item) => (item.id === 'a' ? '  Per-domain title  ' : '   ')}
      />,
    );

    // Trimmed when present…
    expect(await screen.findByRole('button', { name: 'Per-domain title' })).toBeInTheDocument();
    // …and a whitespace-only value falls back to the schema title field.
    expect(screen.getByRole('button', { name: 'Schema Name B' })).toBeInTheDocument();
  });

  it('passes the raw item data through to renderPopup and resolveMarkerImage', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('a', [{ lat: 10, lng: 20 }], { name: 'Acme', city: 'Pune' })]}
        renderPopup={(marker: MapMarker) => <p>{`popup for ${String(marker.data.city)}`}</p>}
        resolveMarkerImage={() => 'https://example.test/pin.png'}
        resolveMarkerIcon={() => Star}
      />,
    );

    expect(await screen.findByText('popup for Pune')).toBeInTheDocument();
    expect(screen.getByAltText('badge for Acme')).toHaveAttribute(
      'src',
      'https://example.test/pin.png',
    );
    // The custom icon resolver reaches the provider and its icon actually renders.
    expect(screen.getByText('icon resolver: custom')).toBeInTheDocument();
    expect(screen.getByLabelText('icon for Acme')).toBeInTheDocument();
  });

  it('nudges a marker sitting exactly on the self-location so "You" never hides it', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('a', [{ lat: BLR.lat, lng: BLR.lng }], { name: 'On top of you' })]}
        selfLocation={BLR}
      />,
    );

    await screen.findByRole('button', { name: 'On top of you' });
    const exact = `a#0 @ ${BLR.lat.toFixed(5)},${BLR.lng.toFixed(5)}`;
    expect(screen.queryByText(exact)).not.toBeInTheDocument();
  });

  it('ignores a stale in-flight resolution when items change mid-flight', async () => {
    const { rerender } = render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('stale', [{ lat: 10, lng: 20 }], { name: 'Stale item' })]}
      />,
    );
    // Re-render before the first resolution's microtask settles — the first
    // effect's cleanup marks it cancelled, so it must never publish markers.
    rerender(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('fresh', [{ lat: 30, lng: 40 }], { name: 'Fresh item' })]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Fresh item' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stale item' })).not.toBeInTheDocument();
  });
});

// ─── MapView: title-field heuristic ──────────────────────────────────────────

describe('MapView — schema title-field heuristic', () => {
  beforeEach(() => {
    setActiveMapProvider('fake-alpha');
  });

  it('prefers the schema-declared display_name_field', async () => {
    render(
      <MapView
        schema={schemaWith(
          { name: { type: 'string' }, jobProviderName: { type: 'string' } },
          { display_name_field: 'jobProviderName' },
        )}
        items={[
          itemAt('a', [{ lat: 10, lng: 20 }], { name: 'Generic', jobProviderName: 'Declared' }),
        ]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Declared' })).toBeInTheDocument();
  });

  it('ignores a display_name_field that is not an actual property and uses a generic candidate', async () => {
    render(
      <MapView
        schema={schemaWith(
          { title: { type: 'string' } },
          { display_name_field: 'not_a_property' },
        )}
        items={[itemAt('a', [{ lat: 10, lng: 20 }], { title: 'From title' })]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'From title' })).toBeInTheDocument();
  });

  it('falls back to the first declared property when no generic candidate exists', async () => {
    render(
      <MapView
        schema={schemaWith({ headline: { type: 'string' }, other: { type: 'string' } })}
        items={[itemAt('a', [{ lat: 10, lng: 20 }], { headline: 'First property' })]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'First property' })).toBeInTheDocument();
  });

  it('labels the marker "Item" when the schema has no properties at all', async () => {
    render(
      <MapView
        schema={{ type: 'object' } as RJSFSchema}
        items={[itemAt('a', [{ lat: 10, lng: 20 }], { name: 'Never used' })]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Item' })).toBeInTheDocument();
  });

  it('labels the marker "Item" when the title field is absent from the item data', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('a', [{ lat: 10, lng: 20 }])]}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Item' })).toBeInTheDocument();
  });
});

// ─── MapView: overlays and maximize ──────────────────────────────────────────

describe('MapView — loading, empty state and maximize', () => {
  beforeEach(() => {
    setActiveMapProvider('fake-alpha');
  });

  it('shows the loading overlay first, then clears it once markers resolve', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[itemAt('a', [{ lat: 10, lng: 20 }], { name: 'Acme' })]}
      />,
    );

    expect(screen.getByText('Loading map data...')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByText('Loading map data...')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
  });

  it('keeps the map mounted and overlays the default empty message when nothing resolves', async () => {
    render(<MapView schema={NAME_SCHEMA} items={[]} />);

    expect(
      await screen.findByText('No items match the current filters.'),
    ).toBeInTheDocument();
    // The map itself must never be replaced by the empty state.
    expect(screen.getByText('provider: fake-alpha')).toBeInTheDocument();
  });

  it('uses the caller-supplied area-oriented empty message when provided', async () => {
    render(
      <MapView schema={NAME_SCHEMA} items={[]} emptyMessage="No items in this area." />,
    );

    expect(await screen.findByText('No items in this area.')).toBeInTheDocument();
    expect(
      screen.queryByText('No items match the current filters.'),
    ).not.toBeInTheDocument();
  });

  it('toggles maximize, revealing the filters slot only while maximized', async () => {
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[]}
        filtersSlot={<button type="button">Filters slot</button>}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Filters slot' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Maximize map' }));

    expect(screen.getByRole('button', { name: 'Filters slot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit maximized map' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maximize map' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Exit maximized map' }));

    expect(screen.getByRole('button', { name: 'Maximize map' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters slot' })).not.toBeInTheDocument();
  });

  it('reveals the location slot only while maximized, like the filters slot', async () => {
    // The map's location-source control lives in the page header, which
    // fullscreen covers — so without this slot the map loses its one location
    // control exactly when the map is the whole screen.
    render(
      <MapView
        schema={NAME_SCHEMA}
        items={[]}
        filtersSlot={<button type="button">Filters slot</button>}
        locationSlot={<button type="button">Location slot</button>}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Location slot' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Maximize map' }));

    expect(screen.getByRole('button', { name: 'Location slot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filters slot' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Exit maximized map' }));

    expect(screen.queryByRole('button', { name: 'Location slot' })).not.toBeInTheDocument();
  });

  it('exits maximized mode on Escape, and ignores other keys', async () => {
    render(<MapView schema={NAME_SCHEMA} items={[]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Maximize map' }));
    expect(screen.getByRole('button', { name: 'Exit maximized map' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByRole('button', { name: 'Exit maximized map' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      await screen.findByRole('button', { name: 'Maximize map' }),
    ).toBeInTheDocument();
  });

  it('ignores Escape when the map is not maximized (no listener is attached)', async () => {
    render(<MapView schema={NAME_SCHEMA} items={[]} />);
    await screen.findByText('provider: fake-alpha');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Maximize map' })).toBeInTheDocument();
  });

  it('dispatches a window resize so the provider re-fits its canvas after a maximize toggle', async () => {
    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    try {
      render(<MapView schema={NAME_SCHEMA} items={[]} />);
      await waitFor(() => expect(onResize).toHaveBeenCalledTimes(1));

      await userEvent.click(screen.getByRole('button', { name: 'Maximize map' }));

      await waitFor(() => expect(onResize).toHaveBeenCalledTimes(2));
    } finally {
      window.removeEventListener('resize', onResize);
    }
  });
});

// ─── BrowseFiltersPanel ─────────────────────────────────────────────────────────

function domain(id: string, properties: Record<string, unknown>): DotNetworkDomain {
  return {
    id,
    description: id,
    item_schemas: { 'profile_1.0': schemaWith(properties) },
  } as DotNetworkDomain;
}

const SEEKER = domain('seeker', {
  looking_for: { type: 'string', enum: ['Job', 'Internship'] },
});
const JOB_PROVIDER = domain('job_provider', {
  sector: { type: 'string', title: 'Sector', enum: ['IT', 'Retail'] },
});

/** 9 options → above CHIP_THRESHOLD (8), so the group renders as a dropdown. */
const MANY_OPTION_DOMAIN = domain('seeker', {
  district: {
    type: 'string',
    title: 'District',
    enum: [
      'Bengaluru',
      'Mysuru',
      'Hubballi',
      'Mangaluru',
      'Belagavi',
      'Kalaburagi',
      'Davangere',
      'Ballari',
      'Shivamogga',
    ],
  },
});

/** Opens the desktop popover / mobile sheet by clicking the Filters pill. */
async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: 'Open filters' }));
}

/**
 * The collapsible "District" group header. Queried by accessible name rather
 * than by `expanded:` — the Radix popover trigger also carries `aria-expanded`,
 * so an expanded-state query is ambiguous once the panel is open.
 */
const districtToggle = () => screen.getByRole('button', { name: /^District/ });

describe('BrowseFiltersPanel — domain chips', () => {
  beforeEach(() => {
    bridge().isMobile = false;
  });

  it('offers NO domain group — domain moved to the toolbar DomainControl', async () => {
    // #645 D10: domain is selected in the browse toolbar, not here. The panel
    // kept a second, multi-select copy that was already unreachable
    // (`showDomainToggle` was `selectedDomain === null`, and a domain is now
    // always selected), while still counting toward the trigger badge.
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    expect(screen.queryByText('Domain')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Filter by domain:/ }),
    ).not.toBeInTheDocument();
  });

  it('renders nothing at all when the domain declares no enum field', () => {
    const { container } = render(
      <BrowseFiltersPanel
        domains={[domain('seeker', { bio: { type: 'string' } })]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('BrowseFiltersPanel — enum chip groups', () => {
  beforeEach(() => {
    bridge().isMobile = false;
  });

  it('derives the group label from the schema title, humanising the key when absent', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER]}
        filterFieldDomains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    // `looking_for` has no title → humanised; `sector` declares one.
    expect(screen.getByText('Looking For')).toBeInTheDocument();
    expect(screen.getByText('Sector')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter by Sector: Retail' })).toBeInTheDocument();
  });

  it('adds a value to the field selection', async () => {
    const onFieldsChange = vi.fn();
    render(
      <BrowseFiltersPanel
        domains={[SEEKER]}
        selectedFields={{ looking_for: ['Job'] }}
        onFieldsChange={onFieldsChange}
      />,
    );
    await openPanel();

    await userEvent.click(
      screen.getByRole('button', { name: 'Filter by Looking For: Internship' }),
    );

    expect(onFieldsChange).toHaveBeenCalledWith({ looking_for: ['Job', 'Internship'] });
  });

  it('drops the field key entirely when its last value is deselected', async () => {
    const onFieldsChange = vi.fn();
    render(
      <BrowseFiltersPanel
        domains={[SEEKER]}
        selectedFields={{ looking_for: ['Job'] }}
        onFieldsChange={onFieldsChange}
      />,
    );
    await openPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Filter by Looking For: Job' }));

    expect(onFieldsChange).toHaveBeenCalledWith({});
  });

  it('badges the trigger with the FACET count only, never the domain', () => {
    // Was `selectedDomains.length + enumActiveCount`, so a single facet read
    // as "2" on the badge (Q9). Domain is not one of this panel's groups.
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{ looking_for: ['Job', 'Internship'] }}
        onFieldsChange={() => {}}
      />,
    );

    expect(screen.getByLabelText('2 selected')).toHaveTextContent('2');
  });

  it('shows no count badge when nothing is selected', () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );

    expect(screen.queryByLabelText(/selected$/)).not.toBeInTheDocument();
  });
});

describe('BrowseFiltersPanel — clear all, close and help text', () => {
  beforeEach(() => {
    bridge().isMobile = false;
  });

  it('clears the field selections from one link, leaving domain alone', async () => {
    // Clear-all used to also fire `onDomainsChange([])`. The list needs
    // exactly one domain at all times (#645 D11), so resetting it to "none"
    // is not a state the browse feed can fetch from.
    const onFieldsChange = vi.fn();
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{ looking_for: ['Job'] }}
        onFieldsChange={onFieldsChange}
      />,
    );
    await openPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(onFieldsChange).toHaveBeenCalledWith({});
  });

  it('offers no Clear all link while nothing is selected', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  it('closes the panel from its own X button', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();
    expect(
      screen.getByRole('button', { name: 'Filter by Looking For: Job' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close filters' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Filter by Looking For: Job' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('tailors the empty-selection help text to the map view', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="map"
      />,
    );
    await openPanel();

    expect(
      screen.getByText('Select options above to filter map markers.'),
    ).toBeInTheDocument();
  });

  it('tailors the empty-selection help text to the list view', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="list"
      />,
    );
    await openPanel();

    expect(screen.getByText('Select options above to filter listings.')).toBeInTheDocument();
  });

  it('hides the help text once a filter is active', async () => {
    render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{ looking_for: ['Job'] }}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    expect(
      screen.queryByText('Select options above to filter map markers.'),
    ).not.toBeInTheDocument();
  });
});

describe('BrowseFiltersPanel — searchable dropdown for large option sets', () => {
  beforeEach(() => {
    bridge().isMobile = false;
  });

  it('collapses a >8-option field into a dropdown that expands on click', async () => {
    render(
      <BrowseFiltersPanel
        domains={[MANY_OPTION_DOMAIN]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    const toggle = districtToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('District');
    expect(toggle).toHaveTextContent('Any');
    // Collapsed → no option is rendered as a chip.
    expect(screen.queryByRole('button', { name: 'Mysuru' })).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Mysuru' })).toBeInTheDocument();
  });

  it('summarises the selection count on the collapsed header', async () => {
    render(
      <BrowseFiltersPanel
        domains={[MANY_OPTION_DOMAIN]}
        selectedFields={{ district: ['Mysuru', 'Ballari'] }}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();

    const toggle = districtToggle();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('2 selected');
    expect(toggle).not.toHaveTextContent('Any');
  });

  it('filters the checklist by the search box, case-insensitively', async () => {
    render(
      <BrowseFiltersPanel
        domains={[MANY_OPTION_DOMAIN]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();
    await userEvent.click(districtToggle());

    await userEvent.type(screen.getByLabelText('Search District…'), '  mAn  ');

    expect(screen.getByRole('button', { name: 'Mangaluru' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mysuru' })).not.toBeInTheDocument();
    expect(screen.queryByText('No matches')).not.toBeInTheDocument();
  });

  it('shows a no-matches message when the query excludes every option', async () => {
    render(
      <BrowseFiltersPanel
        domains={[MANY_OPTION_DOMAIN]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );
    await openPanel();
    await userEvent.click(districtToggle());

    await userEvent.type(screen.getByLabelText('Search District…'), 'zzz');

    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bengaluru' })).not.toBeInTheDocument();
  });

  it('toggles an option from the checklist and reflects its selected state', async () => {
    const onFieldsChange = vi.fn();
    render(
      <BrowseFiltersPanel
        domains={[MANY_OPTION_DOMAIN]}
        selectedFields={{ district: ['Mysuru'] }}
        onFieldsChange={onFieldsChange}
      />,
    );
    await openPanel();
    await userEvent.click(districtToggle());

    expect(screen.getByRole('button', { name: 'Mysuru' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Ballari' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Ballari' }));

    expect(onFieldsChange).toHaveBeenCalledWith({ district: ['Mysuru', 'Ballari'] });
  });
});

describe('BrowseFiltersPanel — mobile bottom sheet', () => {
  beforeEach(() => {
    bridge().isMobile = true;
  });
  afterEach(() => {
    bridge().isMobile = false;
  });

  it('opens the filter groups in a drawer instead of a popover, with a single close control', async () => {
    const { baseElement } = render(
      <BrowseFiltersPanel
        domains={[SEEKER, JOB_PROVIDER]}
        selectedFields={{}}
        onFieldsChange={() => {}}
      />,
    );

    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeFalsy();

    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="popover-content"]')).toBeFalsy();
    // ResponsiveDialog's own X is suppressed — the panel header owns the only one.
    expect(baseElement.querySelector('[data-slot="drawer-close"]')).toBeFalsy();
    expect(screen.getByRole('button', { name: 'Close filters' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Filter by Looking For: Job' }),
    ).toBeInTheDocument();
  });
});
