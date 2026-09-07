import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type {
  DotActionSchema,
  DotNetworkDomain,
  DotNetworkSchema,
  MapMarker,
  MapViewport,
  ViewMode,
} from '@/engine/types';
import type { Item } from '@/lib/item-api';
import type { PerformActionPayload, PerformActionResponse } from '@/lib/action-api';
import type { DiscoverFacetFilter, Marker as NetworkMarker } from '@/lib/network-api';
import type { U18StatusResponse } from '@/lib/consent-api';
import { ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import { apiConfig } from '@/lib/api-config';
import { HomePage } from '../home-page';

// Third home-page suite. `home-page.test.tsx` (tabs / view toggle / filters /
// search / map states / selection) and `home-page-bulk-and-paging.test.tsx`
// (bulk connect, batch guardian OTP, paging, network selector, served scope)
// own their areas; this file covers what neither reaches:
//
//  - the SINGLE-action submit path (`onActionSubmit`): payload construction,
//    instance-URL routing, the draft-profile abort, and the map-popup target
//    that only exists in the popup's own detail fetch;
//  - marker-popup edge states (details unavailable) and label resolution;
//  - the U18 guardian flow's completion / log-out exits and the stored-status
//    fetch failing (fall back to DOB capture);
//  - the active-profile switcher (re-anchor vs consent-gated);
//  - a stale `?domain=` tab that the viewer can't browse;
//  - `VITE_DEFAULT_VIEW_MODE`, facet-param replacement, self-edge filter scope.

// ─── fixtures ────────────────────────────────────────────────────────────────

const requirementSchema: RJSFSchema = {
  type: 'object',
  properties: { message: { type: 'string', title: 'Message' } },
};

const seekerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    city: { type: 'string', title: 'City' },
  },
};

const providerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    company: { type: 'string', title: 'Company' },
    gender: { type: 'string', title: 'Gender', enum: ['female', 'male'] },
    // Declared so the facet-replacement test below filters on a field this
    // domain actually honours. An undeclared facet is now pruned before it
    // reaches the URL or the feed, mirroring the server's silent drop
    // (`resolveAllowedFacetFields`) — see `resolveFacetFieldLabels`.
    city: { type: 'string', title: 'City', enum: ['Mysuru', 'Bengaluru'] },
  },
};

const mentorSchema: RJSFSchema = {
  type: 'object',
  properties: { mentor_name: { type: 'string', title: 'Mentor' } },
};

// Interaction edges: seeker → provider, seeker → mentor, provider → seeker.
const blueDot: DotNetworkSchema = {
  id: 'blue_dot',
  display_name: 'Blue Dot',
  description: 'Test network',
  schema_standard: '1.0.0',
  domains: [
    {
      id: 'seeker',
      description: 'People looking for work',
      card: { title_field: 'name' },
      item_schemas: { 'profile_1.0': seekerSchema },
    },
    {
      id: 'provider',
      description: 'Employers hiring',
      card: { title_field: 'company' },
      item_schemas: { 'job_posting_1.0': providerSchema },
    },
    {
      id: 'mentor',
      description: 'Mentors offering guidance',
      card: { title_field: 'mentor_name' },
      item_schemas: { 'mentor_1.0': mentorSchema },
    },
  ],
  actions: {
    connect: {
      description: 'Connect with someone',
      interactions: [
        { from_domain: 'seeker', to_domain: 'provider', requirement_schema: requirementSchema },
        { from_domain: 'seeker', to_domain: 'mentor', requirement_schema: requirementSchema },
        { from_domain: 'provider', to_domain: 'seeker', requirement_schema: requirementSchema },
      ],
    },
  },
};

// Same network, but a minor whose own profile is a `seeker` is routed through
// the U18 guardian flow.
const blueDotGuarded: DotNetworkSchema = {
  ...blueDot,
  domains: blueDot.domains.map((domain) =>
    domain.id === 'seeker' ? { ...domain, guardian_consent_required: true } : domain,
  ),
};

// A network whose seeker domain gates go-live on completeness alone
// (`go_live_required: ["schema_required"]`, no consent gate) — so the profile
// switcher must NOT prompt for profile_creation consent (#344).
const blueDotConsentFree: DotNetworkSchema = {
  ...blueDot,
  domains: blueDot.domains.map((domain) =>
    domain.id === 'seeker' ? { ...domain, go_live_required: ['schema_required'] } : domain,
  ),
};

// A directory-style network whose only interaction is a self-edge: the viewer's
// own domain is also the only browseable one, so there are no "counterpart"
// domains to scope the filter fields to.
const soloDot: DotNetworkSchema = {
  id: 'solo_dot',
  display_name: 'Solo Dot',
  description: 'Peers only',
  schema_standard: '1.0.0',
  domains: [
    {
      id: 'peer',
      description: 'Peers',
      card: { title_field: 'name' },
      item_schemas: { 'peer_1.0': seekerSchema },
    },
  ],
  actions: {
    connect: {
      description: 'Connect with a peer',
      interactions: [
        { from_domain: 'peer', to_domain: 'peer', requirement_schema: requirementSchema },
      ],
    },
  },
};

function mkItem(
  id: string,
  domain: string,
  itemType: string,
  itemState: Record<string, unknown>,
  extra: {
    lifecycle?: 'draft' | 'live';
    instanceUrl?: string | null;
    locations?: Array<{ lat: number; lng: number }>;
  } = {},
): Item {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: domain,
    item_type: itemType,
    item_instance_url: extra.instanceUrl ?? null,
    item_schema_url: null,
    item_state: itemState,
    item_locations: extra.locations ?? [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    lifecycle_status: extra.lifecycle ?? 'live',
  };
}

// The active profile was created on this instance, so its stored instance URL
// is a localhost one — the page must not call that, it must call the CURRENT
// API base URL instead.
const myProfile = mkItem(
  'me-1',
  'seeker',
  'profile_1.0',
  { name: 'My Seeker', city: 'Bengaluru' },
  { instanceUrl: 'http://localhost:2742' },
);
const mySecondProfile = mkItem('me-2', 'seeker', 'profile_1.0', {
  name: 'My Second Seeker',
  city: 'Mysuru',
});
const myDraftProfile = mkItem(
  'me-1',
  'seeker',
  'profile_1.0',
  { name: 'My Seeker', city: 'Bengaluru' },
  { lifecycle: 'draft' },
);
// Only a profile that HAS a location can offer the "profile vs current
// location" toggle — there is otherwise nothing to switch away from.
const myLocatedProfile = mkItem(
  'me-1',
  'seeker',
  'profile_1.0',
  { name: 'My Seeker', city: 'Bengaluru' },
  { locations: [{ lat: 12.9, lng: 77.6 }] },
);
const myProviderProfile = mkItem('me-p', 'provider', 'job_posting_1.0', { company: 'My Shop' });
const myPeerProfile = mkItem('me-peer', 'peer', 'peer_1.0', { name: 'My Peer' });

// A provider that lives on ANOTHER instance — the action must be addressed there.
const remoteProvider = mkItem(
  'p1',
  'provider',
  'job_posting_1.0',
  { company: 'Acme Welding', gender: 'female' },
  { instanceUrl: 'https://peer.example.org' },
);
const provider2 = mkItem('p2', 'provider', 'job_posting_1.0', {
  company: 'Globex Foundry',
  gender: 'male',
});
const mentor1 = mkItem('m1', 'mentor', 'mentor_1.0', { mentor_name: 'Rita Mentor' });
const peer1 = mkItem('peer-1', 'peer', 'peer_1.0', { name: 'Asha Peer', city: 'Mysuru' });

const consentConfigFixture: ConsentConfigDocument = {
  documents: {
    terms: {
      current_version: 1,
      versions: [
        { version: 1, title: 'Terms', content: 'Terms body', effective_from: '2026-01-01' },
      ],
    },
    privacy: {
      current_version: 1,
      versions: [
        { version: 1, title: 'Privacy', content: 'Privacy body', effective_from: '2026-01-01' },
      ],
    },
    profile_creation: {
      current_version: 1,
      versions: [
        {
          version: 1,
          statement: 'I agree to publish this profile on the network.',
          effective_from: '2026-01-01',
        },
      ],
    },
  },
};

const ADULT_STATUS: U18StatusResponse = {
  hasBirthData: true,
  isMinor: false,
  guardianVerified: false,
};
const MINOR_UNVERIFIED_STATUS: U18StatusResponse = {
  hasBirthData: true,
  isMinor: true,
  guardianVerified: false,
};

// ─── mutable mock state (only dereferenced from inside mock function bodies) ──

interface BrowseEntry {
  items: Item[];
  total: number;
}

interface BrowseOpts {
  enabled?: boolean;
  q?: string;
  filters?: DiscoverFacetFilter[];
  relevance?: boolean;
  anchorItemId?: string;
}

interface BrowseCall {
  domainId: string | null;
  opts?: BrowseOpts;
}

const state = {
  networks: [blueDot] as DotNetworkSchema[],
  resolved: { blue_dot: blueDot } as Record<string, DotNetworkSchema>,
  user: { id: 'u1', name: 'Seeker One' } as { id: string; name: string } | null,
  myItems: [] as Item[],
  browse: {} as Record<string, BrowseEntry>,
  markers: [] as NetworkMarker[],
  detail: { item: null as Item | null, isLoading: false },
  /** Marker `data` handed to `resolveMarkerLabel`, keyed by item id. */
  labelData: {} as Record<string, Record<string, unknown>>,
  consentConfig: null as ConsentConfigDocument | null,
  consentedProfileIds: new Set<string>(),
  u18Status: ADULT_STATUS as U18StatusResponse | null,
  browserSupported: false,
  browserStatus: 'idle' as 'idle' | 'loading' | 'error' | 'success',
  // Settable so a test can resolve a centre — `nearest` and the Location
  // control's source section both depend on one existing.
  location: null as { lat: number; lng: number } | null,
  locationSource: 'profile' as string,
};

interface ActionCall {
  payload: PerformActionPayload;
  sourceInstanceUrl?: string;
  guardianOtp?: string;
}

const browseCalls: BrowseCall[] = [];
const actionCalls: ActionCall[] = [];
const u18StatusFetches: string[] = [];
const requestBrowserLocation = vi.fn();
const refetchU18Gate = vi.fn();
const signOut = vi.fn();
const preferredSources: string[] = [];

// ─── module mocks ────────────────────────────────────────────────────────────

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfig: (id: string | null) => ({
    config: id ? (state.resolved[id] ?? null) : null,
    isLoading: false,
  }),
  useNetworkConfigs: () => ({ data: state.networks, isLoading: false }),
  useResolvedNetwork: (id: string | null) => ({
    data: id ? state.resolved[id] : undefined,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-my-items', () => ({
  useMyItems: () => ({ data: state.myItems, isFetched: true, isLoading: false }),
}));

vi.mock('@/hooks/use-profile-consent-status', () => ({
  useProfileConsentStatus: () => ({
    data: state.consentedProfileIds,
    isSuccess: true,
    isError: false,
  }),
}));

vi.mock('@/hooks/use-actions', () => ({
  useActions: () => ({ data: { actions: [] }, isLoading: false }),
  usePendingActionsCount: () => ({ data: 0 }),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: state.consentConfig, isLoading: false }),
}));

vi.mock('@/hooks/use-consent-gate', () => ({
  useConsentGate: () => ({ needed: [], isLoading: false, refetch: refetchU18Gate }),
}));

vi.mock('@/hooks/use-profile-consent-accept', () => ({
  useProfileConsentAccept: () => ({
    accept: async () => {},
    dialogs: null,
    isPending: false,
    guardianActive: false,
  }),
}));

vi.mock('@/hooks/use-match-score', () => ({
  useMatchScore: () => ({
    score: null,
    isLoading: false,
    error: null,
    cached: false,
    calculate: async () => {},
    recalculate: async () => {},
    clearCache: () => {},
  }),
}));

vi.mock('@/hooks/use-geolocation-permission', () => ({
  useGeolocationPermission: () => 'prompt',
}));

vi.mock('@/hooks/use-user-location', () => ({
  useUserLocation: (
    _profileLocation: { lat: number; lng: number } | null,
    _ready: boolean,
    preferred: string,
  ) => {
    preferredSources.push(preferred);
    return {
      location: state.location,
      source: state.location ? state.locationSource : 'none',
      browser: {
        location: null,
        status: state.browserStatus,
        isSupported: state.browserSupported,
        request: requestBrowserLocation,
      },
    };
  },
}));

vi.mock('@/hooks/use-infinite-browse-items', () => ({
  useInfiniteBrowseItems: (
    _network: DotNetworkSchema | null,
    domain: DotNetworkDomain | null,
    _coords: { lat: number; lng: number } | null,
    opts?: BrowseOpts,
  ) => {
    browseCalls.push({ domainId: domain?.id ?? null, opts });
    const entry = (domain && state.browse[domain.id]) || { items: [], total: 0 };
    return {
      items: entry.items,
      hasNextPage: false,
      total: entry.total,
      isLoading: false,
      fetchNextPage: () => {},
      partial: false,
      degraded: false,
      distanceMeters: undefined,
    };
  },
}));

vi.mock('@/hooks/use-map-markers', () => ({
  useMapMarkers: (
    _network: DotNetworkSchema | null,
    _domains: DotNetworkDomain[],
    viewport: MapViewport | null,
  ) => ({
    markers: viewport ? state.markers : [],
    total: viewport ? state.markers.length : 0,
    partial: false,
    truncated: false,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-item-detail', () => ({
  useItemDetail: () => ({ item: state.detail.item, isLoading: state.detail.isLoading }),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: state.user,
    isAuthenticated: !!state.user,
    isLoading: false,
    checkUser: vi.fn(),
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut,
  }),
}));

vi.mock('@/lib/consent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/consent-api')>();
  return {
    ...actual,
    getU18Status: async (network: string): Promise<U18StatusResponse> => {
      u18StatusFetches.push(network);
      if (!state.u18Status) throw new Error('u18 status unavailable');
      return state.u18Status;
    },
  };
});

vi.mock('@/lib/item-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/item-api')>();
  return {
    ...actual,
    performAction: async (
      payload: PerformActionPayload,
      sourceInstanceUrl?: string,
      guardianOtp?: string,
    ): Promise<PerformActionResponse> => {
      actionCalls.push({ payload, sourceInstanceUrl, guardianOtp });
      return {
        action_id: 'act-1',
        action_type: payload.action_type,
        action_status: 'pending',
        update_count: 1,
        source_item_id: payload.source_item.item_id,
        target_item_id: payload.target_item.item_id,
      };
    },
  };
});

// The map SDK providers register themselves on import — never load them.
vi.mock('@/components/map/providers', () => ({}));

interface MapViewStubProps {
  items: Array<{ id: string; domain?: string; data: Record<string, unknown> }>;
  emptyMessage?: string;
  filtersSlot?: React.ReactNode;
  closePopupNonce?: number;
  resolveMarkerLabel?: (item: {
    id: string;
    domain?: string;
    data: Record<string, unknown>;
  }) => string | undefined;
  onViewportChange?: (viewport: MapViewport) => void;
  renderPopup?: (marker: MapMarker) => React.ReactNode;
}

// Stands in for the real map: reports a viewport on demand, opens one marker's
// popup at a time, and surfaces both `closePopupNonce` (the page bumps it to
// close the popup before a modal opens) and the labels the page resolves for
// each marker.
function MapViewStub({
  items,
  emptyMessage,
  filtersSlot,
  closePopupNonce,
  resolveMarkerLabel,
  onViewportChange,
  renderPopup,
}: MapViewStubProps) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const open = items.find((item) => item.id === openId);
  return (
    <div data-testid="map-view" data-close-popup-nonce={String(closePopupNonce ?? 0)}>
      {filtersSlot}
      <button
        type="button"
        onClick={() =>
          onViewportChange?.({
            lat: 12.9,
            lng: 77.6,
            radiusMeters: 5000,
            zoom: 12,
            minLat: 12.8,
            minLng: 77.5,
            maxLat: 13,
            maxLng: 77.7,
          })
        }
      >
        report viewport
      </button>
      {items.length === 0 && <p>{emptyMessage}</p>}
      {items.map((item) => (
        <div key={item.id}>
          <button type="button" onClick={() => setOpenId(item.id)}>
            {`marker ${item.id}`}
          </button>
          <span data-testid={`label-${item.id}`}>
            {resolveMarkerLabel?.({
              id: item.id,
              domain: item.domain,
              data: state.labelData[item.id] ?? item.data,
            }) ?? ''}
          </span>
        </div>
      ))}
      {open &&
        renderPopup?.({
          id: `${open.id}#0`,
          lat: 12.9,
          lng: 77.6,
          label: 'Item',
          data: {},
          precision: 'exact',
          domain: open.domain,
        })}
    </div>
  );
}

vi.mock('@/components/map/map-container', () => ({
  MapView: (props: MapViewStubProps) => <MapViewStub {...props} />,
}));

interface FiltersStubProps {
  filterFieldDomains: DotNetworkDomain[];
  selectedFields: Record<string, string[]>;
  onFieldsChange: (fields: Record<string, string[]>) => void;
  viewMode?: ViewMode;
}

function FiltersStub({ filterFieldDomains, selectedFields, onFieldsChange }: FiltersStubProps) {
  return (
    <div
      data-testid="filters-panel"
      data-filter-field-domains={filterFieldDomains.map((d) => d.id).join(',')}
      data-selected-fields={JSON.stringify(selectedFields)}
    >
      <button type="button" onClick={() => onFieldsChange({ city: ['Mysuru'] })}>
        apply city filter
      </button>
    </div>
  );
}

vi.mock('@/components/filters/browse-filters-panel', () => ({
  BrowseFiltersPanel: (props: FiltersStubProps) => <FiltersStub {...props} />,
}));

// RJSF doesn't submit under happy-dom (and ActionModal has its own suite), so
// this stub stands in for the requirement form and submits the same shape the
// real one does — consent sentinel included. ActionHandler renders it for the
// single-card action path, which is what these tests drive.
interface ActionModalStubProps {
  open: boolean;
  actionSchema: DotActionSchema;
  onSubmit: (formData: Record<string, unknown>) => void;
}

function ActionModalStub({ open, actionSchema, onSubmit }: ActionModalStubProps) {
  if (!open) return null;
  return (
    <div data-testid="action-modal" data-action-type={actionSchema.action_type}>
      <button
        type="button"
        onClick={() =>
          onSubmit({
            message: 'Hoping to work with you',
            [ACTION_CONSENT_SENTINEL]: { acknowledged: true, version: 4, brand: null },
          })
        }
      >
        submit requirement form
      </button>
    </div>
  );
}

vi.mock('@/components/actions/action-modal', () => ({
  ActionModal: (props: ActionModalStubProps) => <ActionModalStub {...props} />,
}));

// U18GuardianFlow has its own suite; here we only drive home-page's handling of
// its exits (complete / not-a-minor / log out) and the step it is opened on.
interface U18FlowStubProps {
  network: string;
  initialStep?: 'dob' | 'guardian' | 'otp';
  onComplete: () => void;
  onNotMinor: () => void;
  onLogout?: () => void;
}

function U18FlowStub({ network, initialStep, onComplete, onNotMinor, onLogout }: U18FlowStubProps) {
  return (
    <div data-testid="u18-guardian-flow" data-network={network} data-initial-step={initialStep}>
      <button type="button" onClick={onComplete}>
        guardian verified
      </button>
      <button type="button" onClick={onNotMinor}>
        resolved as adult
      </button>
      {onLogout && (
        <button type="button" onClick={onLogout}>
          flow log out
        </button>
      )}
    </div>
  );
}

vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (props: U18FlowStubProps) => <U18FlowStub {...props} />,
}));

// ─── harness ─────────────────────────────────────────────────────────────────

function RouteProbe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="route">{`${location.pathname}${location.search}`}</div>;
}

function renderHome(initialUrl = '/?view=list') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <HomePage />
        <RouteProbe />
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function route(): string {
  return screen.getByTestId('route').textContent ?? '';
}

// A browse card renders its title twice (card heading + the schema-driven field
// row), so card presence is asserted on the card element, not a text node.
function cardFor(title: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-item-card]')).find((card) =>
      card.textContent?.includes(title),
    ) ?? null
  );
}

function findCard(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const card = cardFor(title);
    if (!card) throw new Error(`no browse card titled ${title}`);
    return card;
  });
}

/** The sonner toast announcing the draft-profile block. */
function draftToast(): HTMLElement {
  const toast = Array.from(document.querySelectorAll<HTMLElement>('[data-sonner-toast]')).find(
    (el) => el.textContent?.includes('Complete your profile first'),
  );
  expect(toast).toBeDefined();
  return toast as HTMLElement;
}

function browseOptsFor(domainId: string): BrowseOpts | undefined {
  const calls = browseCalls.filter((c) => c.domainId === domainId);
  return calls.length > 0 ? calls[calls.length - 1].opts : undefined;
}

function setRuntimeConfig(config: Record<string, string> | undefined): void {
  const host = window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> };
  if (config === undefined) delete host.__DPG_UI_CONFIG__;
  else host.__DPG_UI_CONFIG__ = config;
}

/** Signed-in adult seeker browsing one remote provider + one mentor. */
function signedInSeeker(): void {
  state.myItems = [myProfile];
  state.browse = {
    provider: { items: [remoteProvider, provider2], total: 2 },
    mentor: { items: [mentor1], total: 1 },
  };
}

/** One marker for the remote provider, so the map has something to open. */
function providerMarker(): NetworkMarker {
  return {
    item_id: 'p1',
    item_domain: 'provider',
    item_instance_url: 'https://peer.example.org',
    item_locations: [{ lat: 12.91, lng: 77.61 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setRuntimeConfig(undefined);
  browseCalls.length = 0;
  actionCalls.length = 0;
  u18StatusFetches.length = 0;
  preferredSources.length = 0;
  state.networks = [blueDot];
  state.resolved = { blue_dot: blueDot };
  state.user = { id: 'u1', name: 'Seeker One' };
  state.myItems = [];
  state.browse = {};
  state.markers = [];
  state.detail = { item: null, isLoading: false };
  state.labelData = {};
  state.consentConfig = null;
  state.consentedProfileIds = new Set<string>();
  state.u18Status = ADULT_STATUS;
  state.browserSupported = false;
  state.browserStatus = 'idle';
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('HomePage — single action submit', () => {
  it('sends the connect request to the target’s own instance and confirms it', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    renderHome('/?view=list&domain=provider');
    const card = await findCard('Acme Welding');

    await user.click(within(card).getByRole('button', { name: 'Connect' }));
    const modal = await screen.findByTestId('action-modal');
    expect(modal).toHaveAttribute('data-action-type', 'connect');
    await user.click(within(modal).getByRole('button', { name: 'submit requirement form' }));

    expect(await screen.findByText('Connect request sent!')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The other party will be notified and can accept or respond to your request.',
      ),
    ).toBeInTheDocument();

    expect(actionCalls).toHaveLength(1);
    const { payload, sourceInstanceUrl, guardianOtp } = actionCalls[0];
    expect(payload.action_type).toBe('connect');
    expect(payload.source_item).toEqual({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_id: 'me-1',
    });
    // The target lives elsewhere, so the payload names that instance…
    expect(payload.target_item).toEqual({
      item_network: 'blue_dot',
      item_domain: 'provider',
      item_type: 'job_posting_1.0',
      item_id: 'p1',
      item_instance_url: 'https://peer.example.org',
    });
    // …while the call itself goes to the source instance. The active profile's
    // stored URL is a localhost one, so the CURRENT api base URL is used.
    expect(sourceInstanceUrl).toBe(apiConfig.getUrl());
    expect(guardianOtp).toBeUndefined();
    // The consent sentinel is lifted out of the requirements snapshot.
    expect(payload.requirements_snapshot).toEqual({ message: 'Hoping to work with you' });
    expect(payload.consent).toEqual({ acknowledged: true, version: 4, brand: null });
  });

  it('routes a same-instance target through the current api base url', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    renderHome('/?view=list&domain=provider');
    // `provider2` carries no instance URL at all, so the page has to fall back.
    const card = await findCard('Globex Foundry');

    await user.click(within(card).getByRole('button', { name: 'Connect' }));
    const modal = await screen.findByTestId('action-modal');
    await user.click(within(modal).getByRole('button', { name: 'submit requirement form' }));

    await waitFor(() => expect(actionCalls).toHaveLength(1));
    expect(actionCalls[0].payload.target_item.item_id).toBe('p2');
    expect(actionCalls[0].payload.target_item.item_instance_url).toBe(apiConfig.getUrl());
  });

  it('blocks a draft profile from acting and links straight to the edit form', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    state.myItems = [myDraftProfile];
    renderHome('/?view=list&domain=provider');
    const card = await findCard('Acme Welding');

    await user.click(within(card).getByRole('button', { name: 'Connect' }));
    const modal = await screen.findByTestId('action-modal');
    await user.click(within(modal).getByRole('button', { name: 'submit requirement form' }));

    expect(await screen.findByText('Complete your profile first')).toBeInTheDocument();
    expect(screen.getByText(/Your profile is still a draft/)).toBeInTheDocument();
    expect(actionCalls).toHaveLength(0);
    // The abort is signalled as an ActionAbortedError, so ActionHandler must NOT
    // also raise its generic failure toast on top of this tailored one.
    expect(screen.queryByText('Action failed')).not.toBeInTheDocument();

    // Scoped to the toast: the sidebar's per-profile row has its own edit
    // control with the same label.
    const toast = draftToast();
    await user.click(within(toast).getByRole('button', { name: 'Edit profile' }));

    await waitFor(() => expect(route()).toBe('/profile/me-1/edit?network=blue_dot'));
  });
});

describe('HomePage — map popup actions', () => {
  it('connects to a map-only item using the detail the popup itself fetched', async () => {
    const user = userEvent.setup();
    // No list feed at all: the target exists ONLY as a viewport marker, so the
    // page has to reuse the popup's resolved item to build the payload.
    state.myItems = [myProfile];
    state.markers = [providerMarker()];
    state.detail = { item: remoteProvider, isLoading: false };
    renderHome('/?view=map');

    await user.click(screen.getByRole('button', { name: 'report viewport' }));
    await user.click(await screen.findByRole('button', { name: 'marker p1' }));

    const map = screen.getByTestId('map-view');
    expect(map).toHaveAttribute('data-close-popup-nonce', '0');
    await user.click(within(map).getByRole('button', { name: 'Connect' }));

    // The popup is dismissed first so it can't cover the requirement modal.
    await waitFor(() =>
      expect(screen.getByTestId('map-view')).toHaveAttribute('data-close-popup-nonce', '1'),
    );

    const modal = await screen.findByTestId('action-modal');
    await user.click(within(modal).getByRole('button', { name: 'submit requirement form' }));

    expect(await screen.findByText('Connect request sent!')).toBeInTheDocument();
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0].payload.target_item).toMatchObject({
      item_id: 'p1',
      item_domain: 'provider',
      item_type: 'job_posting_1.0',
      item_instance_url: 'https://peer.example.org',
    });
  });

  it('says the details are unavailable when the marker’s item cannot be fetched', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    state.markers = [providerMarker()];
    state.detail = { item: null, isLoading: false };
    renderHome('/?view=map');

    await user.click(screen.getByRole('button', { name: 'report viewport' }));
    await user.click(await screen.findByRole('button', { name: 'marker p1' }));

    const map = screen.getByTestId('map-view');
    expect(within(map).getByText('Details unavailable.')).toBeInTheDocument();
    // Nothing to act on, so no connect CTA is offered.
    expect(within(map).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('titles each marker from its own domain’s card config', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    state.markers = [
      providerMarker(),
      {
        item_id: 'm1',
        item_domain: 'mentor',
        item_instance_url: null,
        item_locations: [{ lat: 12.92, lng: 77.62 }],
      },
    ];
    // provider titles on `company`, mentor on `mentor_name` — the mentor marker
    // is missing its title field, so it must resolve to no label at all rather
    // than borrowing the provider's.
    state.labelData = { p1: { company: 'Acme Welding' }, m1: { company: 'Acme Welding' } };
    renderHome('/?view=map');

    await user.click(screen.getByRole('button', { name: 'report viewport' }));

    await waitFor(() => expect(screen.getByTestId('label-p1')).toHaveTextContent('Acme Welding'));
    expect(screen.getByTestId('label-m1')).toHaveTextContent('');
  });
});

describe('HomePage — active profile switching', () => {
  it('re-anchors the browse feed on the newly picked profile and remembers it', async () => {
    const user = userEvent.setup();
    state.myItems = [myProfile, mySecondProfile];
    state.browse = { provider: { items: [remoteProvider], total: 1 } };
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await waitFor(() => expect(browseOptsFor('provider')?.anchorItemId).toBe('me-1'));

    await user.click(screen.getByRole('button', { name: /My Second Seeker/ }));

    await waitFor(() => expect(browseOptsFor('provider')?.anchorItemId).toBe('me-2'));
    expect(localStorage.getItem('activeProfileId:blue_dot')).toBe('me-2');
  });

  it('gates the switch behind profile consent when the picked profile has none', async () => {
    const user = userEvent.setup();
    state.consentConfig = consentConfigFixture;
    state.consentedProfileIds = new Set(['me-1']);
    state.myItems = [myProfile, mySecondProfile];
    state.browse = { provider: { items: [remoteProvider], total: 1 } };
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await user.click(screen.getByRole('button', { name: /My Second Seeker/ }));

    expect(await screen.findByText('Confirm your profile consent')).toBeInTheDocument();
    expect(
      screen.getByText('This consent is for your profile: My Second Seeker'),
    ).toBeInTheDocument();
    // The switch itself is withheld until consent is recorded.
    expect(localStorage.getItem('activeProfileId:blue_dot')).toBe('me-1');
    expect(browseOptsFor('provider')?.anchorItemId).toBe('me-1');
  });

  it('does NOT gate the switch when the profile domain omits consent_required (#344)', async () => {
    const user = userEvent.setup();
    // Seeker domain gates go-live on completeness alone → no consent prompt,
    // even though the picked profile (me-2) has no recorded consent.
    state.networks = [blueDotConsentFree];
    state.resolved = { blue_dot: blueDotConsentFree };
    state.consentConfig = consentConfigFixture;
    state.consentedProfileIds = new Set(['me-1']);
    state.myItems = [myProfile, mySecondProfile];
    state.browse = { provider: { items: [remoteProvider], total: 1 } };
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await user.click(screen.getByRole('button', { name: /My Second Seeker/ }));

    // Switch goes through with no consent prompt withheld.
    await waitFor(() => expect(localStorage.getItem('activeProfileId:blue_dot')).toBe('me-2'));
    expect(screen.queryByText('Confirm your profile consent')).toBeNull();
  });

  it('falls back to the domain name when the profile schema has no title field', async () => {
    // `job_posting_1.0` has no name/title-ish field, so the consent prompt can
    // only identify the profile by its domain.
    state.consentConfig = consentConfigFixture;
    state.myItems = [myProviderProfile];
    state.browse = { seeker: { items: [], total: 0 } };
    renderHome('/?view=list');

    expect(await screen.findByText('Confirm your profile consent')).toBeInTheDocument();
    expect(screen.getByText('This consent is for your profile: provider')).toBeInTheDocument();
  });
});

describe('HomePage — U18 guardian gate exits', () => {
  function guardedMinor(): void {
    state.networks = [blueDotGuarded];
    state.resolved = { blue_dot: blueDotGuarded };
    state.u18Status = MINOR_UNVERIFIED_STATUS;
    state.myItems = [myProfile];
    state.browse = { provider: { items: [remoteProvider], total: 1 } };
  }

  it('gates an unverified minor and re-reads the stored status once verified', async () => {
    const user = userEvent.setup();
    guardedMinor();
    renderHome('/?view=list&domain=provider');

    const flow = await screen.findByTestId('u18-guardian-flow');
    // Birth data is already stored, so the DOB step is skipped.
    expect(flow).toHaveAttribute('data-initial-step', 'guardian');
    const fetchesBefore = u18StatusFetches.length;

    await user.click(within(flow).getByRole('button', { name: 'guardian verified' }));

    await waitFor(() =>
      expect(screen.queryByTestId('u18-guardian-flow')).not.toBeInTheDocument(),
    );
    // The gate is re-evaluated and the stored status re-read, so a later profile
    // creation doesn't re-ask for the date of birth.
    expect(refetchU18Gate).toHaveBeenCalled();
    await waitFor(() => expect(u18StatusFetches.length).toBeGreaterThan(fetchesBefore));
    expect(await findCard('Acme Welding')).toBeInTheDocument();
  });

  it('lets a ward who cannot finish the flow sign out of it', async () => {
    const user = userEvent.setup();
    guardedMinor();
    renderHome('/?view=list&domain=provider');

    const flow = await screen.findByTestId('u18-guardian-flow');
    await user.click(within(flow).getByRole('button', { name: 'flow log out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('falls back to capturing the date of birth when the stored status cannot be read', async () => {
    // Fail-closed: an unreadable U18 status must not leave a possible minor
    // ungated — the flow still runs, starting from DOB capture.
    state.networks = [blueDotGuarded];
    state.resolved = { blue_dot: blueDotGuarded };
    state.u18Status = null;
    state.myItems = [myProfile];
    renderHome('/?view=list&domain=provider');

    const flow = await screen.findByTestId('u18-guardian-flow');
    expect(flow).toHaveAttribute('data-initial-step', 'dob');
    expect(u18StatusFetches).toContain('blue_dot');
  });
});

describe('HomePage — browse scope and view defaults', () => {
  it('drops a ?domain= tab the viewer is not allowed to browse', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    // A seeker cannot initiate toward other seekers, so `seeker` is not a
    // browseable tab for them — the stale param must be discarded.
    renderHome('/?view=list&domain=seeker');

    // #644 (spec D8/D19): the stale param is REPAIRED to a valid default
    // rather than dropped back to an all-domains view — there is no longer an
    // "All" tab to fall back to.
    await waitFor(() => expect(route()).toContain('domain=provider'));
    expect(route()).not.toContain('domain=seeker');
    expect(await findCard('Acme Welding')).toBeInTheDocument();
    // Sanity: a legitimate tab still survives.
    await user.click(screen.getByRole('button', { name: 'Mentor' }));
    await waitFor(() => expect(route()).toContain('domain=mentor'));
  });

  it('honours VITE_DEFAULT_VIEW_MODE=list when the URL names no view', async () => {
    setRuntimeConfig({ VITE_DEFAULT_VIEW_MODE: 'list' });
    signedInSeeker();
    renderHome('/');

    expect(await findCard('Acme Welding')).toBeInTheDocument();
    expect(screen.queryByTestId('map-view')).not.toBeInTheDocument();
  });

  it('scopes the filter fields to the viewer’s own domain when the only edge is a self-edge', async () => {
    state.networks = [soloDot];
    state.resolved = { solo_dot: soloDot };
    state.myItems = [myPeerProfile];
    state.browse = { peer: { items: [peer1], total: 1 } };
    renderHome('/?view=list');

    await findCard('Asha Peer');
    // There are no counterpart domains to filter on, so the viewer's own domain
    // supplies the filter fields rather than leaving the panel empty.
    expect(screen.getByTestId('filters-panel')).toHaveAttribute(
      'data-filter-field-domains',
      'peer',
    );
  });

  it('replaces the previous facet params rather than accumulating them', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    renderHome('/?view=list&domain=provider&f_gender=female');
    await findCard('Acme Welding');

    expect(screen.getByTestId('filters-panel')).toHaveAttribute(
      'data-selected-fields',
      '{"gender":["female"]}',
    );

    await user.click(screen.getByRole('button', { name: 'apply city filter' }));

    await waitFor(() => expect(route()).toContain('f_city=Mysuru'));
    expect(route()).not.toContain('f_gender');
    expect(browseOptsFor('provider')?.filters).toEqual([{ field: 'city', values: ['Mysuru'] }]);
  });

  it('does not fire a second geolocation request while one is already in flight', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    state.myItems = [myLocatedProfile];
    state.browserSupported = true;
    state.browserStatus = 'loading';
    // A resolved centre, or `nearest` is unavailable and the source section
    // legitimately does not render.
    state.location = { lat: 12.97, lng: 77.59 };
    state.locationSource = 'profile';
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    // The source now lives inside the one Location control (#644 QA
    // redesign), and its section renders only when a centre is used — so
    // pick `nearest` first, then open Location.
    await user.click(screen.getByRole('button', { name: /sort/i }));
    await user.click(screen.getByRole('option', { name: /nearest/i }));
    await user.click(screen.getByRole('button', { name: /location/i }));
    await user.click(screen.getByRole('button', { name: /current location/i }));

    // The preference switched (so results re-resolve), but no duplicate prompt.
    expect(preferredSources[preferredSources.length - 1]).toBe('browser');
    expect(requestBrowserLocation).not.toHaveBeenCalled();
  });
});
