import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type { DotActionSchema, DotNetworkDomain, DotNetworkSchema } from '@/engine/types';
import type { BulkEnvelope } from '@/lib/bulk';
import type { Item } from '@/lib/item-api';
import type { PerformActionPayload, PerformActionResponse } from '@/lib/action-api';
import type { U18StatusResponse } from '@/lib/consent-api';
import type { ProfileConsentAcceptArgs } from '@/hooks/use-profile-consent-accept';
import { ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import { HomePage } from '../home-page';

// This suite covers the parts of home-page.tsx that `home-page.test.tsx`
// deliberately left alone: the bulk-connect submit path (success / partial /
// draft / transport failure / stale selection), the batch guardian-OTP
// confirm + challenge dialogs, the U18 guardian gate vs the profile_creation
// consent prompt, infinite-scroll paging (driven through a fake
// IntersectionObserver), the sidebar network selector and the
// VITE_SERVED_BINDINGS single-portal scope.

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
  properties: { company: { type: 'string', title: 'Company' } },
};

const mentorSchema: RJSFSchema = {
  type: 'object',
  properties: { mentor_name: { type: 'string', title: 'Mentor' } },
};

const artisanSchema: RJSFSchema = {
  type: 'object',
  properties: { craft: { type: 'string', title: 'Craft' } },
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

// Same network, but the ward's own domain (seeker) routes minors through the
// U18 guardian flow — the signal `isGuardianConsentRequiredDomain` reads.
const blueDotGuarded: DotNetworkSchema = {
  ...blueDot,
  domains: blueDot.domains.map((domain) =>
    domain.id === 'seeker' ? { ...domain, guardian_consent_required: true } : domain,
  ),
};

// A second configured network, so the sidebar network selector has something to
// switch to. Only `buyer` can initiate, so a viewer with no profile browses
// exactly one domain (artisan).
const purpleDot: DotNetworkSchema = {
  id: 'purple_dot',
  display_name: 'Purple Dot',
  description: 'Craft network',
  schema_standard: '1.0.0',
  domains: [
    {
      id: 'artisan',
      description: 'Artisans at work',
      card: { title_field: 'craft' },
      item_schemas: { 'artisan_1.0': artisanSchema },
    },
    {
      id: 'buyer',
      description: 'Buyers',
      card: { title_field: 'craft' },
      item_schemas: { 'buyer_1.0': artisanSchema },
    },
  ],
  actions: {
    connect: {
      description: 'Commission a piece',
      interactions: [
        { from_domain: 'buyer', to_domain: 'artisan', requirement_schema: requirementSchema },
      ],
    },
  },
};

function mkItem(
  id: string,
  domain: string,
  itemType: string,
  itemState: Record<string, unknown>,
  lifecycle: 'draft' | 'live' = 'live',
): Item {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: domain,
    item_type: itemType,
    item_instance_url: null,
    item_schema_url: null,
    item_state: itemState,
    item_locations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    lifecycle_status: lifecycle,
  };
}

const myProfile = mkItem('me-1', 'seeker', 'profile_1.0', {
  name: 'My Seeker',
  city: 'Bengaluru',
});
const myDraftProfile = mkItem(
  'me-1',
  'seeker',
  'profile_1.0',
  { name: 'My Seeker', city: 'Bengaluru' },
  'draft',
);
const myProviderProfile = mkItem('me-p', 'provider', 'job_posting_1.0', { company: 'My Shop' });

const provider1 = mkItem('p1', 'provider', 'job_posting_1.0', { company: 'Acme Welding' });
const provider2 = mkItem('p2', 'provider', 'job_posting_1.0', { company: 'Globex Foundry' });
const provider3 = mkItem('p3', 'provider', 'job_posting_1.0', { company: 'Initech Casting' });
const mentor1 = mkItem('m1', 'mentor', 'mentor_1.0', { mentor_name: 'Rita Mentor' });
const mentor2 = mkItem('m2', 'mentor', 'mentor_1.0', { mentor_name: 'Sam Mentor' });
const seeker1 = mkItem('s1', 'seeker', 'profile_1.0', { name: 'Asha Seeker', city: 'Mysuru' });

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
      current_version: 2,
      versions: [
        { version: 1, statement: 'Old profile statement.', effective_from: '2025-01-01' },
        {
          version: 2,
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
const MINOR_VERIFIED_STATUS: U18StatusResponse = {
  hasBirthData: true,
  isMinor: true,
  guardianVerified: true,
};
const NO_BIRTH_DATA_STATUS: U18StatusResponse = {
  hasBirthData: false,
  isMinor: false,
  guardianVerified: false,
};

// ─── mutable mock state (only read from inside mock function bodies) ──────────

interface BrowseEntry {
  /** Server pages, revealed one at a time by `fetchNextPage`. */
  pages: Item[][];
  total: number;
  isLoading?: boolean;
}

const state = {
  networks: [blueDot] as DotNetworkSchema[],
  resolved: { blue_dot: blueDot } as Record<string, DotNetworkSchema>,
  user: { id: 'u1', name: 'Seeker One' } as { id: string; name: string } | null,
  myItems: [] as Item[],
  browse: {} as Record<string, BrowseEntry>,
  consentConfig: null as ConsentConfigDocument | null,
  consentedProfileIds: new Set<string>(),
  u18Status: ADULT_STATUS as U18StatusResponse | null,
};

interface BulkCall {
  payloads: PerformActionPayload[];
  sourceInstanceUrl?: string;
  otp?: string;
}

type BulkResponder = (call: BulkCall, index: number) => Promise<BulkEnvelope<PerformActionResponse>>;

const bulk = {
  calls: [] as BulkCall[],
  respond: null as BulkResponder | null,
};

const consentAccept = {
  calls: [] as ProfileConsentAcceptArgs[],
  /** When false the shared flow never resolves the acceptance (retry stays open). */
  autoDone: true,
};

const signOut = vi.fn();

type BulkResults = BulkEnvelope<PerformActionResponse>['results'];
type Outcome = 'ok' | { error: string; message: string };

/** Build a bulk envelope from a per-index outcome list. */
function envelopeOf(outcomes: Outcome[]): BulkEnvelope<PerformActionResponse> {
  const results: BulkResults = outcomes.map((outcome, index) =>
    outcome === 'ok'
      ? {
          index,
          status: 'success' as const,
          action_id: `act-${index}`,
          action_type: 'connect',
          action_status: 'pending',
          update_count: 1,
          source_item_id: 'me-1',
          target_item_id: `t-${index}`,
        }
      : {
          index,
          status: 'error' as const,
          error: outcome.error,
          message: outcome.message,
        },
  );
  const failed = outcomes.filter((o) => o !== 'ok').length;
  return {
    results,
    summary: { total: outcomes.length, succeeded: outcomes.length - failed, failed },
  };
}

// ─── fake IntersectionObserver (drives the load-more sentinels) ───────────────

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

const observerRecords: ObserverRecord[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string;
  // Part of the current DOM lib's IntersectionObserver surface; unused here.
  readonly scrollMargin: string = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.rootMargin = options?.rootMargin ?? '0px';
    this.record = { callback, targets: [], disconnected: false };
    observerRecords.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.push(target);
  }

  unobserve(target: Element): void {
    this.record.targets = this.record.targets.filter((t) => t !== target);
  }

  disconnect(): void {
    this.record.disconnected = true;
    this.record.targets = [];
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** Simulate the bottom sentinel scrolling into view for every live observer. */
async function scrollSentinelIntoView(): Promise<void> {
  const live = observerRecords.filter((r) => !r.disconnected && r.targets.length > 0);
  expect(live.length).toBeGreaterThan(0);
  await act(async () => {
    for (const record of live) {
      const entries = record.targets.map(
        (target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry,
      );
      record.callback(entries, {} as IntersectionObserver);
    }
  });
}

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
  useConsentGate: () => ({ needed: [], isLoading: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/use-profile-consent-accept', () => ({
  useProfileConsentAccept: () => ({
    accept: async (args: ProfileConsentAcceptArgs) => {
      consentAccept.calls.push(args);
      if (!consentAccept.autoDone) return;
      // The real hook records the consent and updates the profileConsent cache
      // before calling onDone. Mirror that here, otherwise the page's gate
      // effect immediately re-prompts for the same (still un-consented) profile.
      state.consentedProfileIds.add(args.item.item_id);
      args.onDone();
    },
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
  useUserLocation: () => ({
    location: null,
    source: 'none',
    browser: {
      location: null,
      status: 'idle',
      isSupported: false,
      request: async () => {},
    },
  }),
}));

// Paged browse feed: reveals one fixture page at a time so firing the sentinel
// observer actually renders more cards (rather than only proving a spy ran).
vi.mock('@/hooks/use-infinite-browse-items', async () => {
  const ReactMod = await import('react');
  return {
    useInfiniteBrowseItems: (
      _network: DotNetworkSchema | null,
      domain: DotNetworkDomain | null,
      _coords: { lat: number; lng: number } | null,
      opts?: { enabled?: boolean },
    ) => {
      const domainId = domain?.id ?? null;
      const [page, setPage] = ReactMod.useState<{ id: string | null; n: number }>({
        id: domainId,
        n: 1,
      });
      const fetchNextPage = ReactMod.useCallback(() => {
        setPage((prev) => ({ id: domainId, n: (prev.id === domainId ? prev.n : 1) + 1 }));
      }, [domainId]);
      const enabled = opts?.enabled !== false;
      const entry = domainId ? state.browse[domainId] : undefined;
      const pages = entry?.pages ?? [];
      const loaded = page.id === domainId ? page.n : 1;
      return {
        items: enabled ? pages.slice(0, loaded).flat() : [],
        hasNextPage: enabled && loaded < pages.length,
        total: enabled ? (entry?.total ?? 0) : 0,
        isLoading: enabled ? (entry?.isLoading ?? false) : false,
        fetchNextPage,
        partial: false,
        degraded: false,
        distanceMeters: undefined,
      };
    },
  };
});

vi.mock('@/hooks/use-map-markers', () => ({
  useMapMarkers: () => ({
    markers: [],
    total: 0,
    partial: false,
    truncated: false,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-item-detail', () => ({
  useItemDetail: () => ({ item: null, isLoading: false }),
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
    getU18Status: async (): Promise<U18StatusResponse> => {
      if (!state.u18Status) throw new Error('u18 status unavailable');
      return state.u18Status;
    },
  };
});

vi.mock('@/lib/item-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/item-api')>();
  return {
    ...actual,
    performActionsBulk: async (
      payloads: PerformActionPayload[],
      sourceInstanceUrl?: string,
      otp?: string,
    ): Promise<BulkEnvelope<PerformActionResponse>> => {
      const call: BulkCall = { payloads, sourceInstanceUrl, otp };
      bulk.calls.push(call);
      if (!bulk.respond) throw new Error('no bulk responder configured for this test');
      return bulk.respond(call, bulk.calls.length - 1);
    },
  };
});

// The map SDK providers register themselves on import — never load them.
vi.mock('@/components/map/providers', () => ({}));

vi.mock('@/components/map/map-container', () => ({
  MapView: () => <div data-testid="map-view" />,
}));

vi.mock('@/components/filters/browse-filters-panel', () => ({
  BrowseFiltersPanel: () => <div data-testid="filters-panel" />,
}));

// The real ActionModal submits through RJSF, which doesn't fire under happy-dom
// (and has its own suite). This stub stands in for the requirement form so the
// page's own bulk handler is what's under test — it submits the same shape the
// real modal does, consent sentinel included.
interface ActionModalStubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionSchema: DotActionSchema;
  onSubmit: (formData: Record<string, unknown>) => void;
  loading?: boolean;
}

function ActionModalStub({ open, actionSchema, onSubmit, loading }: ActionModalStubProps) {
  if (!open) return null;
  return (
    <div
      data-testid="action-modal"
      data-action-type={actionSchema.action_type}
      data-loading={String(!!loading)}
    >
      <button
        type="button"
        onClick={() =>
          onSubmit({
            message: 'Hoping to work with you',
            [ACTION_CONSENT_SENTINEL]: { acknowledged: true, version: 3, brand: null },
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

// U18GuardianFlow has its own suite; here we only care that home-page mounts it
// (blocking the consent prompt) and honours its two exits.
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

function UrlProbe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="url">{location.search}</div>;
}

/** Renders the page with a real Toaster so toast copy is observable in the DOM. */
function renderHome(initialUrl = '/?view=list') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <HomePage />
        <UrlProbe />
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function url(): string {
  return screen.getByTestId('url').textContent ?? '';
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

function setRuntimeConfig(config: Record<string, string> | undefined): void {
  const host = window as unknown as { __DPG_UI_CONFIG__?: Record<string, string> };
  if (config === undefined) delete host.__DPG_UI_CONFIG__;
  else host.__DPG_UI_CONFIG__ = config;
}

async function enterSelectMode(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Select items' }));
  await screen.findByRole('button', { name: 'Done' });
}

/** Click each named card's select wrapper (role=button in select mode). */
async function pickCards(user: UserEvent, ...titles: string[]): Promise<void> {
  for (const title of titles) {
    await user.click(screen.getByRole('button', { name: new RegExp(title) }));
  }
}

/** Open the bulk requirement modal for `count` selected cards and submit it. */
async function submitBulkConnect(user: UserEvent, count: number): Promise<void> {
  const label = count === 1 ? 'Connect (1)' : `Connect all (${count})`;
  await user.click(screen.getByRole('button', { name: label }));
  const modal = await screen.findByTestId('action-modal');
  await user.click(within(modal).getByRole('button', { name: 'submit requirement form' }));
}

/**
 * Fill the guardian OTP dialog's six boxes. `fireEvent.change` (not userEvent)
 * because the boxes live inside a radix Dialog, whose body-level
 * `pointer-events: none` makes userEvent's pointer check unreliable here.
 */
async function enterGuardianOtp(code = '246810'): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  const boxes = within(dialog).getAllByRole('textbox');
  expect(boxes).toHaveLength(6);
  boxes.forEach((box, i) => {
    fireEvent.change(box, { target: { value: code[i] } });
  });
}

const GUARDIAN_REQUIRED: Outcome = {
  error: 'GUARDIAN_OTP_REQUIRED',
  message: 'Guardian confirmation required',
};

/** Signed-in adult seeker browsing two providers (the default bulk fixture). */
function signedInSeeker(): void {
  state.myItems = [myProfile];
  state.browse = {
    provider: { pages: [[provider1, provider2]], total: 2 },
    mentor: { pages: [[mentor1]], total: 1 },
  };
}

/** Same, but the ward is a verified minor on a guardian-gated domain. */
function signedInMinorSeeker(): void {
  state.networks = [blueDotGuarded];
  state.resolved = { blue_dot: blueDotGuarded };
  state.u18Status = MINOR_VERIFIED_STATUS;
  signedInSeeker();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setRuntimeConfig(undefined);
  observerRecords.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  bulk.calls.length = 0;
  bulk.respond = null;
  consentAccept.calls.length = 0;
  consentAccept.autoDone = true;
  state.networks = [blueDot];
  state.resolved = { blue_dot: blueDot };
  state.user = { id: 'u1', name: 'Seeker One' };
  state.myItems = [];
  state.browse = {};
  state.consentConfig = null;
  state.consentedProfileIds = new Set<string>();
  state.u18Status = ADULT_STATUS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('HomePage — bulk connect submit', () => {
  it('sends one payload per selected card, lifting consent out of the requirements snapshot', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    bulk.respond = async () => envelopeOf(['ok', 'ok']);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    expect(await screen.findByText('2 selected')).toBeInTheDocument();

    await submitBulkConnect(user, 2);

    // User-visible outcome first: the success toast, and select mode released.
    expect(await screen.findByText('Connected 2 requests')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Select items' })).toBeInTheDocument();
    expect(screen.queryByTestId('action-modal')).not.toBeInTheDocument();

    // …and the payload the page built for each target.
    expect(bulk.calls).toHaveLength(1);
    const { payloads } = bulk.calls[0];
    expect(payloads.map((p) => p.target_item.item_id)).toEqual(['p1', 'p2']);
    expect(payloads.every((p) => p.action_type === 'connect')).toBe(true);
    expect(payloads.every((p) => p.source_item.item_id === 'me-1')).toBe(true);
    // The consent sentinel is stripped from the snapshot and promoted to `consent`.
    expect(payloads[0].requirements_snapshot).toEqual({ message: 'Hoping to work with you' });
    expect(payloads[0].consent).toEqual({ acknowledged: true, version: 3, brand: null });
  });

  it('sources the batch from the acting profile, so a provider connects to seekers', async () => {
    const user = userEvent.setup();
    // The provider→seeker edge of the same schema: the acting profile decides
    // which action the bulk bar offers and what the payload's source_item is.
    state.myItems = [myProviderProfile];
    state.browse = { seeker: { pages: [[seeker1]], total: 1 } };
    bulk.respond = async () => envelopeOf(['ok']);
    renderHome('/?view=list&domain=seeker');
    await findCard('Asha Seeker');

    await enterSelectMode(user);
    await pickCards(user, 'Asha Seeker');
    await submitBulkConnect(user, 1);

    expect(await screen.findByText('Connected 1 request')).toBeInTheDocument();
    expect(bulk.calls).toHaveLength(1);
    expect(bulk.calls[0].payloads).toHaveLength(1);
    expect(bulk.calls[0].payloads[0].source_item).toMatchObject({
      item_id: 'me-p',
      item_domain: 'provider',
    });
    expect(bulk.calls[0].payloads[0].target_item).toMatchObject({
      item_id: 's1',
      item_domain: 'seeker',
    });
  });

  it('reports a partial batch and keeps only the failed card selected', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    bulk.respond = async () =>
      envelopeOf(['ok', { error: 'ACTION_LIMIT_REACHED', message: 'A request is already open.' }]);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);

    expect(await screen.findByText('Connected 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('First error: A request is already open.')).toBeInTheDocument();
    // Still in select mode, narrowed to the one item that needs a retry.
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect (1)' })).toBeInTheDocument();
  });

  it('surfaces a transport failure without dropping the selection', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    bulk.respond = async () => {
      throw new Error('Network unreachable');
    };
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);

    expect(await screen.findByText('Could not send connection requests')).toBeInTheDocument();
    expect(screen.getByText('Network unreachable')).toBeInTheDocument();
    // The batch is still selected so the user can retry it.
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('prompts a draft profile to be completed instead of submitting the batch', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    state.myItems = [myDraftProfile];
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding');
    await submitBulkConnect(user, 1);

    expect(await screen.findByText('Complete your profile first')).toBeInTheDocument();
    expect(screen.getByText(/Your profile is still a draft/)).toBeInTheDocument();
    expect(bulk.calls).toHaveLength(0);
    // The requirement modal is dismissed, but the selection survives.
    await waitFor(() => expect(screen.queryByTestId('action-modal')).not.toBeInTheDocument());
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('abandons a stale selection (nothing left to send) instead of posting an empty batch', async () => {
    const user = userEvent.setup();
    signedInSeeker();
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding');
    expect(await screen.findByText('1 selected')).toBeInTheDocument();

    // Switching the browse domain leaves the provider id selected while the
    // active feed now holds mentors only — no target resolves.
    await user.click(screen.getByRole('button', { name: 'Mentor' }));
    await findCard('Rita Mentor');
    await submitBulkConnect(user, 1);

    expect(bulk.calls).toHaveLength(0);
    // Select mode is released rather than left showing a batch that can't send.
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Select items' })).toBeInTheDocument();
    expect(screen.queryByTestId('action-modal')).not.toBeInTheDocument();
  });
});

describe('HomePage — batch guardian OTP for a minor ward', () => {
  it('confirms before dispatching the guardian code, and sends nothing if cancelled', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);

    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('Guardian confirmation needed')).toBeInTheDocument();
    expect(within(confirm).getByText(/a one-time code will be sent to your guardian/i)).toBeInTheDocument();
    // The purpose panel names the batch the code would authorise.
    expect(within(confirm).getByText('Connecting with 2 profiles')).toBeInTheDocument();
    // Nothing has been dispatched yet — that's the point of the confirm step.
    expect(bulk.calls).toHaveLength(0);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bulk.calls).toHaveLength(0);
    // The selection is untouched, so the ward can proceed later.
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('resubmits the whole batch with one guardian code after Proceed', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    bulk.respond = async (_call, index) =>
      index === 0
        ? envelopeOf([GUARDIAN_REQUIRED, GUARDIAN_REQUIRED])
        : envelopeOf(['ok', 'ok']);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);

    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Proceed' }));

    // The gated submit is what dispatches the code; no raw error is surfaced.
    const otpDialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(otpDialog).getByText("This requires your guardian's confirmation via OTP"),
      ).toBeInTheDocument(),
    );
    expect(within(otpDialog).getByText('Connecting with 2 profiles')).toBeInTheDocument();
    expect(bulk.calls).toHaveLength(1);
    expect(bulk.calls[0].otp).toBeUndefined();

    await enterGuardianOtp('246810');

    expect(await screen.findByText('Connected 2 requests')).toBeInTheDocument();
    // ONE code for the whole batch: the same two payloads, resubmitted with it.
    expect(bulk.calls).toHaveLength(2);
    expect(bulk.calls[1].otp).toBe('246810');
    expect(bulk.calls[1].payloads.map((p) => p.target_item.item_id)).toEqual(['p1', 'p2']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Select items' })).toBeInTheDocument();
  });

  it('challenges only the guardian-gated items of a mixed batch, keeping the others selected', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    bulk.respond = async (_call, index) =>
      index === 0
        ? envelopeOf([
            GUARDIAN_REQUIRED,
            { error: 'ACTION_LIMIT_REACHED', message: 'A request is already open.' },
          ])
        : envelopeOf(['ok']);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proceed' }));

    const otpDialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(otpDialog).getByText("This requires your guardian's confirmation via OTP"),
      ).toBeInTheDocument(),
    );
    // Only the gated item rides on the code — the other failure is not re-sent.
    expect(within(otpDialog).getByText('Connecting with 1 profiles')).toBeInTheDocument();

    await enterGuardianOtp();

    // Not "all done": the non-guardian failure still needs a retry.
    expect(await screen.findByText('Connected 1 of 2')).toBeInTheDocument();
    expect(bulk.calls[1].payloads.map((p) => p.target_item.item_id)).toEqual(['p1']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('keeps the OTP dialog open with an inline error when the code is wrong', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    bulk.respond = async (_call, index) =>
      index === 0
        ? envelopeOf([GUARDIAN_REQUIRED, GUARDIAN_REQUIRED])
        : envelopeOf([
            { error: 'GUARDIAN_OTP_INVALID', message: 'That code is not valid' },
            { error: 'GUARDIAN_OTP_INVALID', message: 'That code is not valid' },
          ]);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proceed' }));
    await waitFor(() => expect(bulk.calls).toHaveLength(1));

    await enterGuardianOtp('000000');

    const otpDialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(otpDialog).getByText('Incorrect code')).toBeInTheDocument());
    // Still open for a retry, and no success toast was shown.
    expect(
      within(otpDialog).getByText("This requires your guardian's confirmation via OTP"),
    ).toBeInTheDocument();
    expect(screen.queryByText('Connected 2 requests')).not.toBeInTheDocument();
    expect(bulk.calls).toHaveLength(2);
  });

  it('offers a stuck ward the sign-out escape hatch from the OTP dialog', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    bulk.respond = async () => envelopeOf([GUARDIAN_REQUIRED, GUARDIAN_REQUIRED]);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proceed' }));

    const otpDialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(otpDialog).getByRole('button', { name: 'Not you? Log out' })).toBeInTheDocument(),
    );
    fireEvent.click(within(otpDialog).getByRole('button', { name: 'Not you? Log out' }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('does not gate an adult ward on a guardian-gated domain', async () => {
    const user = userEvent.setup();
    signedInMinorSeeker();
    state.u18Status = ADULT_STATUS;
    bulk.respond = async () => envelopeOf(['ok', 'ok']);
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await enterSelectMode(user);
    await pickCards(user, 'Acme Welding', 'Globex Foundry');
    await submitBulkConnect(user, 2);

    expect(await screen.findByText('Connected 2 requests')).toBeInTheDocument();
    expect(screen.queryByText('Guardian confirmation needed')).not.toBeInTheDocument();
    expect(bulk.calls).toHaveLength(1);
    expect(bulk.calls[0].otp).toBeUndefined();
  });
});

describe('HomePage — U18 first-login gate vs the profile consent prompt', () => {
  /** Guarded domain + un-consented profile + no stored birth data. */
  function guardedWardWithUnconsentedProfile(): void {
    state.networks = [blueDotGuarded];
    state.resolved = { blue_dot: blueDotGuarded };
    state.u18Status = NO_BIRTH_DATA_STATUS;
    state.consentConfig = consentConfigFixture;
    state.myItems = [myProfile];
    state.browse = { provider: { pages: [[provider1]], total: 1 } };
  }

  it('runs the guardian flow (DOB first) and suppresses the consent prompt while it is up', async () => {
    guardedWardWithUnconsentedProfile();
    renderHome('/?view=list&domain=provider');

    const flow = await screen.findByTestId('u18-guardian-flow');
    expect(flow).toHaveAttribute('data-network', 'blue_dot');
    // Nothing is stored yet, so the flow starts by capturing the date of birth.
    expect(flow).toHaveAttribute('data-initial-step', 'dob');
    // The ordinary consent prompt must not stack on top of the gate.
    expect(screen.queryByText('Confirm your profile consent')).not.toBeInTheDocument();
  });

  it('reveals the consent prompt once the flow resolves the ward as an adult', async () => {
    guardedWardWithUnconsentedProfile();
    renderHome('/?view=list&domain=provider');

    const flow = await screen.findByTestId('u18-guardian-flow');
    fireEvent.click(within(flow).getByRole('button', { name: 'resolved as adult' }));

    await waitFor(() =>
      expect(screen.queryByTestId('u18-guardian-flow')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Confirm your profile consent')).toBeInTheDocument();
  });

  it('accepts the current profile_creation version for the named profile and closes the prompt', async () => {
    const user = userEvent.setup();
    state.consentConfig = consentConfigFixture;
    state.myItems = [myProfile];
    state.browse = { provider: { pages: [[provider1]], total: 1 } };
    renderHome('/?view=list&domain=provider');

    expect(await screen.findByText('Confirm your profile consent')).toBeInTheDocument();
    // The current version's statement, and which profile it is for.
    expect(
      screen.getByText('I agree to publish this profile on the network.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This consent is for your profile: My Seeker')).toBeInTheDocument();

    const accept = screen.getByRole('button', { name: 'Accept & Continue' });
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(accept);

    await waitFor(() =>
      expect(screen.queryByText('Confirm your profile consent')).not.toBeInTheDocument(),
    );
    expect(consentAccept.calls).toHaveLength(1);
    expect(consentAccept.calls[0]).toMatchObject({
      network: 'blue_dot',
      // v2 is current even though v1 also exists in the document.
      version: 2,
      isMinor: false,
      item: { item_id: 'me-1', item_domain: 'seeker', item_type: 'profile_1.0' },
    });
  });

  it('keeps the prompt open when the acceptance never completes', async () => {
    const user = userEvent.setup();
    consentAccept.autoDone = false;
    state.consentConfig = consentConfigFixture;
    state.myItems = [myProfile];
    renderHome('/?view=list&domain=provider');

    expect(await screen.findByText('Confirm your profile consent')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Accept & Continue' }));

    await waitFor(() => expect(consentAccept.calls).toHaveLength(1));
    // The flow toasts its own failure and never calls onDone, so the blocking
    // prompt stays up for a retry rather than letting the user through.
    expect(screen.getByText('Confirm your profile consent')).toBeInTheDocument();
  });

  it('does not prompt for a profile that already has consent recorded', async () => {
    state.consentConfig = consentConfigFixture;
    state.myItems = [myProfile];
    state.consentedProfileIds = new Set(['me-1']);
    state.browse = { provider: { pages: [[provider1]], total: 1 } };
    renderHome('/?view=list&domain=provider');

    await findCard('Acme Welding');
    expect(screen.queryByText('Confirm your profile consent')).not.toBeInTheDocument();
  });
});

describe('HomePage — infinite-scroll paging', () => {
  it('loads the next page of a single domain when the bottom sentinel scrolls in', async () => {
    signedInSeeker();
    state.browse = {
      provider: { pages: [[provider1, provider2], [provider3]], total: 3 },
    };
    renderHome('/?view=list&domain=provider');

    await findCard('Acme Welding');
    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(2);
    expect(cardFor('Initech Casting')).toBeNull();

    await scrollSentinelIntoView();

    expect(await findCard('Initech Casting')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(3);
  });

  it('stops paging once the last page is loaded', async () => {
    signedInSeeker();
    state.browse = { provider: { pages: [[provider1], [provider2]], total: 2 } };
    renderHome('/?view=list&domain=provider');
    await findCard('Acme Welding');

    await scrollSentinelIntoView();
    expect(await findCard('Globex Foundry')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(2);

    // Sentinel is now disabled — firing it again must not fetch past the end.
    await scrollSentinelIntoView();

    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(2);
  });

  // #644 (spec D8): the sentinel drives ONE feed. It used to fan a single
  // scroll out across every visible domain's independent pager, then merge and
  // re-sort the union — which is what discarded the server's ranking (P6).
  it('advances the selected domain’s feed from the list sentinel', async () => {
    signedInSeeker();
    state.browse = {
      provider: { pages: [[provider1], [provider2]], total: 2 },
      mentor: { pages: [[mentor1], [mentor2]], total: 2 },
    };
    renderHome('/?view=list');

    await findCard('Acme Welding');
    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(1);
    expect(cardFor('Globex Foundry')).toBeNull();
    // A different domain's feed is not paged in alongside it.
    expect(cardFor('Sam Mentor')).toBeNull();

    await scrollSentinelIntoView();

    expect(await findCard('Globex Foundry')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-item-card]')).toHaveLength(2);
    expect(cardFor('Sam Mentor')).toBeNull();
  });
});

describe('HomePage — network selector and served scope', () => {
  it('lists every configured network and switches the browse feed on selection', async () => {
    const user = userEvent.setup();
    state.networks = [blueDot, purpleDot];
    state.resolved = { blue_dot: blueDot, purple_dot: purpleDot };
    state.browse = {
      provider: { pages: [[provider1]], total: 1 },
      artisan: { pages: [[mkItem('a1', 'artisan', 'artisan_1.0', { craft: 'Blue Pottery' })]], total: 1 },
    };
    // #644: pin blue_dot's domain explicitly. This viewer has no profile, so
    // the default would be blue_dot's first VISIBLE domain (`seeker`) rather
    // than `provider` — irrelevant before, when the "All" tab browsed every
    // domain at once. Switching network clears `?domain=`, so purple_dot still
    // resolves its own default (`artisan`, its only to_domain).
    renderHome('/?view=list&domain=provider');

    expect(await screen.findByText('Networks')).toBeInTheDocument();
    await findCard('Acme Welding');

    await user.click(screen.getByRole('button', { name: 'Purple Dot' }));

    expect(await findCard('Blue Pottery')).toBeInTheDocument();
    expect(cardFor('Acme Welding')).toBeNull();
    // The switch is reflected in the URL, and the domain tab is reset with it.
    expect(url()).toContain('network=purple_dot');
    expect(url()).not.toContain('domain=');
  });

  it('hides the network group when only one network is configured', async () => {
    signedInSeeker();
    renderHome('/?view=list&domain=provider');

    await findCard('Acme Welding');
    expect(screen.queryByText('Networks')).not.toBeInTheDocument();
  });

  it('pins a single-binding portal to its served domain and drops the network selector', async () => {
    setRuntimeConfig({ VITE_SERVED_BINDINGS: 'blue_dot/provider' });
    state.networks = [blueDot, purpleDot];
    state.resolved = { blue_dot: blueDot, purple_dot: purpleDot };
    state.browse = {
      seeker: { pages: [[seeker1]], total: 1 },
      provider: { pages: [[provider1]], total: 1 },
    };
    renderHome('/?view=list');

    // Acting as a provider, the portal browses that domain's counterparts only.
    expect(await findCard('Asha Seeker')).toBeInTheDocument();
    expect(cardFor('Acme Welding')).toBeNull();
    // The page-header domain title is gone (#645) — a duplicate of the
    // toolbar's control. With one selectable domain that control collapses to
    // a plural "Showing Seekers" label instead of a dead one-button toggle.
    expect(await screen.findByTestId('domain-single-label')).toHaveTextContent('Seekers');
    // The scope pins the network, so no selector is offered even with two configured.
    expect(screen.queryByText('Networks')).not.toBeInTheDocument();
    expect(screen.queryByText('Purple Dot')).not.toBeInTheDocument();
  });
});
