import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import type { Action } from '@/lib/action-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema } from '@/engine/types';

// ── Module mocks ────────────────────────────────────────────────────────────
// Every factory below only *references* an outer binding from inside the
// function it returns (called at test time), never during factory evaluation —
// the pattern used by the sibling public-profile-page test.

const toastCalls: Array<[string, string]> = [];
vi.mock('sonner', () => ({
  toast: {
    success: (m: unknown) => void toastCalls.push(['success', String(m)]),
    error: (m: unknown) => void toastCalls.push(['error', String(m)]),
    warning: (m: unknown) => void toastCalls.push(['warning', String(m)]),
    info: (m: unknown) => void toastCalls.push(['info', String(m)]),
  },
}));

// ── my-actions-page deps ────────────────────────────────────────────────────
const useInitiatedActions = vi.fn();
const useReceivedActions = vi.fn();
vi.mock('@/hooks/use-actions', () => ({
  // Args forwarded so a test can assert the #439 scoping (`itemId` + filters)
  // the page passes down.
  useInitiatedActions: (...a: unknown[]) => useInitiatedActions(...a),
  useReceivedActions: (...a: unknown[]) => useReceivedActions(...a),
  // Used by public-profile-page's action row (never rendered here).
  useActions: () => ({ data: { actions: [], meta: { total: 0 } } }),
  // The shell's top-bar notification bell.
  usePendingActionsCount: () => ({ data: 0, isLoading: false }),
}));

// The two dialogs the page owns are covered in depth by
// components/actions/__tests__/actions_group.test.tsx. Stub them so these tests
// assert the PAGE's wiring: which action/status reaches the updater, which
// selection + target status reaches the bulk dialog, and what the settle
// callback does to the selection.
vi.mock('@/components/actions/action-status-updater', () => ({
  ActionStatusUpdater: ({
    action,
    open,
    suggestedStatus,
  }: {
    action: { action_id: string } | null;
    open: boolean;
    suggestedStatus?: string;
  }) =>
    open ? (
      <div data-testid="status-updater">{`${action?.action_id ?? 'none'} → ${suggestedStatus ?? ''}`}</div>
    ) : null,
}));
vi.mock('@/components/actions/bulk-status-dialog', () => ({
  BulkStatusDialog: ({
    open,
    actions,
    targetStatus,
    onSettled,
  }: {
    open: boolean;
    actions: Array<{ action_id: string }>;
    targetStatus: string;
    onSettled: (succeeded: number, total: number, failedIds: string[]) => void;
  }) =>
    open ? (
      <div data-testid="bulk-dialog">
        <span data-testid="bulk-summary">
          {`${targetStatus}:${actions.map((a) => a.action_id).join(',')}`}
        </span>
        <button type="button" onClick={() => onSettled(actions.length, actions.length, [])}>
          settle-all-ok
        </button>
        <button
          type="button"
          onClick={() => onSettled(0, actions.length, actions.map((a) => a.action_id))}
        >
          settle-all-failed
        </button>
      </div>
    ) : null,
}));
// The counterparty dialog fetches network config/items on mount; not under test.
vi.mock('@/components/actions/profile-card-modal', () => ({
  ProfileCardModal: () => null,
}));

// ── public-profile-page deps ────────────────────────────────────────────────
const useItemDetail = vi.fn();
vi.mock('@/hooks/use-item-detail', () => ({
  useItemDetail: (...a: unknown[]) => useItemDetail(...a),
}));
const useResolvedNetwork = vi.fn();
const useNetworkConfigs = vi.fn();
vi.mock('@/hooks/use-network-config', () => ({
  useResolvedNetwork: (...a: unknown[]) => useResolvedNetwork(...a),
  // my-actions-page discovers which networks the deployment serves before it
  // can resolve one (#439).
  useNetworkConfigs: () => useNetworkConfigs(),
  useNetworkConfig: () => ({ data: undefined, isLoading: false, isError: false }),
}));
const useAuth = vi.fn();
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => useAuth() }));
const useMyItems = vi.fn();
vi.mock('@/hooks/use-my-items', () => ({ useMyItems: (...a: unknown[]) => useMyItems(...a) }));
vi.mock('@/components/layout/sidebar', () => ({ AppSidebar: () => <div data-testid="app-sidebar" /> }));
vi.mock('@/components/layout/portal-header', () => ({ PortalHeader: () => <div data-testid="portal-header" /> }));
vi.mock('@/components/auth/user-menu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));

// ── tourist-app deps ────────────────────────────────────────────────────────
const fetchNetworkConfig = vi.fn();
const fetchNetworkItems = vi.fn();
vi.mock('@/lib/network-api', () => ({
  PROFILE_FETCH_LIMIT: 100,
  fetchNetworkConfig: (...a: unknown[]) => fetchNetworkConfig(...a),
  fetchNetworkItems: (...a: unknown[]) => fetchNetworkItems(...a),
}));

const requestLocation = vi.fn(() => Promise.resolve(null));
const browserLocationState = {
  location: null as { lat: number; lng: number } | null,
  status: 'idle' as 'idle' | 'loading' | 'success' | 'error',
  isSupported: true,
};
vi.mock('@/hooks/use-browser-location', () => ({
  useBrowserLocation: () => ({
    location: browserLocationState.location,
    status: browserLocationState.status,
    error: null,
    isSupported: browserLocationState.isSupported,
    request: requestLocation,
    reset: () => {},
  }),
}));

const geoPermission = { value: 'prompt' as PermissionState | 'unknown' };
vi.mock('@/hooks/use-geolocation-permission', () => ({
  useGeolocationPermission: () => geoPermission.value,
}));

// Leaflet map → a stub that surfaces the props the page computes (which items
// survived search/filters, where the map is centred, the visitor focus point).
vi.mock('@/tourist/tourist-map', () => ({
  TouristMap: ({
    items,
    center,
    focusPoint,
  }: {
    items: Array<{ id: string; data: Record<string, unknown> }>;
    center: [number, number];
    focusPoint: { lat: number; lng: number } | null;
  }) => (
    <div data-testid="tourist-map">
      <span data-testid="map-center">{center.join(',')}</span>
      <span data-testid="map-focus">{focusPoint ? `${focusPoint.lat},${focusPoint.lng}` : 'none'}</span>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{String(i.data.name)}</li>
        ))}
      </ul>
    </div>
  ),
}));
// Radix popover filters are unreliable under happy-dom; expose one button that
// drives the panel's onFieldsChange contract instead.
vi.mock('@/components/filters/browse-filters-panel', () => ({
  BrowseFiltersPanel: ({ onFieldsChange }: { onFieldsChange: (f: Record<string, string[]>) => void }) => (
    <button type="button" onClick={() => onFieldsChange({ category: ['Stay'] })}>
      filter-stay
    </button>
  ),
}));

// Imported after the mocks so the pages pick them up.
import { MyActionsPage } from '@/pages/my-actions-page';
import { PublicProfilePage } from '@/pages/public-profile-page';
import { TouristApp } from '@/tourist/tourist-app';
import { TOURIST_NETWORK_ID } from '@/tourist/resolve-tourist-config';
import { TooltipProvider } from '@/components/ui/tooltip';

// ── Helpers / fixtures ──────────────────────────────────────────────────────

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * `useInitiatedActions`/`useReceivedActions` are `useInfiniteQuery`s since
 * #439 — the page flattens `data.pages` and reads the tab badge count off the
 * FIRST page's `meta.total`, so the fixture has to be page-shaped, not a bare
 * `{ actions, meta }`.
 */
interface ActionsQueryState {
  data: { pages: Array<{ actions: Action[]; meta: { total: number; limit: number; offset: number } }> };
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

const refetchInitiated = vi.fn();
const refetchReceived = vi.fn();

/**
 * Builds one loaded page from `actions` (total defaults to what's there), then
 * applies `over` — so a call site that only cares about a flag stays short.
 */
function actionsState(
  over: Partial<Omit<ActionsQueryState, 'data'>> & { actions?: Action[]; total?: number } = {},
): ActionsQueryState {
  const { actions = [], total, ...rest } = over;
  return {
    data: {
      pages: [{ actions, meta: { total: total ?? actions.length, limit: 20, offset: 0 } }],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
    ...rest,
  };
}

function makeAction(over: Partial<Action> = {}): Action {
  return {
    action_id: 'act-1',
    action_type: 'connect',
    action_status: 'created',
    update_count: 0,
    source_item_id: 'src-1',
    source_item_network: 'blue_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    source_item_owner: 'u2',
    target_item_id: 'tgt-1',
    target_item_network: 'blue_dot',
    target_item_domain: 'provider',
    target_item_type: 'profile_1.0',
    target_item_owner: 'u1',
    requirements_snapshot: { message: 'Please connect' },
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ownership_roles: ['received'],
    source_item_name: 'Asha Kumar',
    target_item_name: 'Acme Co',
    ...over,
  };
}

const RECEIVED_PENDING = makeAction({ action_id: 'recv-1', source_item_name: 'Asha Kumar' });
const INITIATED_PENDING = makeAction({
  action_id: 'init-1',
  ownership_roles: ['initiated'],
  target_item_name: 'Beta Ltd',
});

function renderMyActions(entries: string[] = ['/my-actions'], index = 0) {
  return render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <Routes>
          <Route path="/browse" element={<div>previous page</div>} />
          <Route path="/my-actions" element={<MyActionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MyActionsPage', () => {
  beforeEach(() => {
    refetchInitiated.mockClear();
    refetchReceived.mockClear();
    // #439 scoping deps: the page resolves a served network and a LIVE own
    // profile before either actions query becomes enabled.
    useNetworkConfigs.mockReturnValue({ data: [publicNetwork], isLoading: false, isError: false });
    useResolvedNetwork.mockReturnValue({ data: publicNetwork, isLoading: false, isError: false });
    useMyItems.mockReturnValue({ data: [makeItem()], isLoading: false, isFetched: true });
    // The shell's top bar reads the session.
    useAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'u1', name: 'Asha' },
    });
    useInitiatedActions.mockReturnValue(
      actionsState({ actions: [INITIATED_PENDING], refetch: refetchInitiated }),
    );
    useReceivedActions.mockReturnValue(
      actionsState({ actions: [RECEIVED_PENDING], refetch: refetchReceived }),
    );
  });

  it('opens on the Received tab and shows the received counterparty and per-tab counts', () => {
    renderMyActions();
    expect(screen.getByRole('heading', { name: 'My Actions' })).toBeInTheDocument();
    expect(screen.getByText("Manage requests you've initiated and the ones you've received.")).toBeInTheDocument();
    // Received tab is the default → the sender is the counterparty shown.
    expect(screen.getByText('Asha Kumar (Seeker)')).toBeInTheDocument();
    expect(screen.queryByText('Beta Ltd (Provider)')).not.toBeInTheDocument();
    // A received pending action offers Accept/Reject, never Cancel.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('switches the rendered list when the Initiated tab is picked', async () => {
    const user = userEvent.setup();
    renderMyActions();
    await user.click(screen.getByRole('button', { name: /Initiated/ }));
    expect(screen.getByText('Beta Ltd (Provider)')).toBeInTheDocument();
    expect(screen.queryByText('Asha Kumar (Seeker)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('routes Refresh to the query for the active tab only', async () => {
    const user = userEvent.setup();
    renderMyActions();
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(refetchReceived).toHaveBeenCalledTimes(1);
    expect(refetchInitiated).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Initiated/ }));
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(refetchInitiated).toHaveBeenCalledTimes(1);
    expect(refetchReceived).toHaveBeenCalledTimes(1);
  });

  it('takes the loading / error / refetching flags from the active tab', async () => {
    const user = userEvent.setup();
    useInitiatedActions.mockReturnValue(
      actionsState({ isError: true, error: new Error('initiated blew up'), refetch: refetchInitiated }),
    );
    useReceivedActions.mockReturnValue(
      actionsState({
        actions: [RECEIVED_PENDING],
        isRefetching: true,
        refetch: refetchReceived,
      }),
    );
    renderMyActions();
    // Received tab: refetching → Refresh disabled, no error state.
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled();
    expect(screen.queryByText('Failed to load actions')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Initiated/ }));
    // Initiated tab: its own error surfaces, and its Refresh is enabled again.
    expect(screen.getByText('Failed to load actions')).toBeInTheDocument();
    expect(screen.getByText('initiated blew up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeEnabled();
  });

  it('shows the tab-specific empty state when the active tab has no actions', async () => {
    const user = userEvent.setup();
    useInitiatedActions.mockReturnValue(actionsState({ refetch: refetchInitiated }));
    useReceivedActions.mockReturnValue(actionsState({ refetch: refetchReceived }));
    renderMyActions();
    expect(screen.getByText('Requests sent to you will appear here.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Initiated/ }));
    expect(screen.getByText('Requests you send will show up here.')).toBeInTheDocument();
  });

  it('opens the status updater with the clicked action and its target status', async () => {
    const user = userEvent.setup();
    renderMyActions();
    expect(screen.queryByTestId('status-updater')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(screen.getByTestId('status-updater')).toHaveTextContent('recv-1 → accepted');
  });

  it('bulk accept: the selection reaches the bulk dialog, and a clean settle clears select mode', async () => {
    const user = userEvent.setup();
    renderMyActions();
    await user.click(screen.getByRole('button', { name: 'Select items' }));
    const card = screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') !== null);
    expect(card).toBeDefined();
    await user.click(card!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(screen.getByTestId('bulk-summary')).toHaveTextContent('accepted:recv-1');

    await user.click(screen.getByRole('button', { name: 'settle-all-ok' }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select items' })).toBeInTheDocument();
  });

  it('bulk accept: a failed settle keeps the failed ids selected so they can be retried', async () => {
    const user = userEvent.setup();
    renderMyActions();
    await user.click(screen.getByRole('button', { name: 'Select items' }));
    const card = screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') !== null);
    await user.click(card!);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.click(screen.getByRole('button', { name: 'settle-all-failed' }));
    // Still in select mode with the failed action selected.
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('leaves select mode when the tab changes so a hidden selection cannot go stale', async () => {
    const user = userEvent.setup();
    renderMyActions();
    await user.click(screen.getByRole('button', { name: 'Select items' }));
    const card = screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') !== null);
    await user.click(card!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Initiated/ }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select items' })).toBeInTheDocument();
  });

  it('the header back button returns to the previous in-app page', async () => {
    const user = userEvent.setup();
    renderMyActions(['/browse', '/my-actions'], 1);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('previous page')).toBeInTheDocument();
  });
});

// ── PublicProfilePage ───────────────────────────────────────────────────────

const ITEM_ID = '9b545eb9-5406-4bce-bc71-0cdac4b63bd0';

const publicNetwork = {
  id: 'blue_dot',
  display_name: 'Blue Dot',
  description: 'seekers and providers',
  schema_standard: 'dpg/1.0',
  domains: [
    {
      id: 'seeker',
      description: 'seekers',
      card: { title_field: 'name' },
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            city: { type: 'string', title: 'City' },
          },
        } as RJSFSchema,
      },
    },
  ],
  actions: {},
} satisfies DotNetworkSchema;

function makeItem(over: Partial<Item> = {}): Item {
  return {
    item_id: ITEM_ID,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: { name: 'Asha', city: 'Pune' },
    item_locations: [],
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    lifecycle_status: 'live',
    ...over,
  };
}

/** Surfaces the router's current path+query so URL side effects are assertable. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe">{`${loc.pathname}${loc.search}`}</div>;
}

function renderPublic(entries: string[], index = 0) {
  return render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter initialEntries={entries} initialIndex={index}>
        <Routes>
          <Route path="/" element={<div>map view</div>} />
          <Route path="/browse" element={<div>previous page</div>} />
          <Route
            path="/public/:network/:domain/:itemType/:itemId"
            element={
              <>
                <PublicProfilePage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LIVE_PATH = `/public/blue_dot/seeker/profile_1.0/${ITEM_ID}?network=blue_dot`;

describe('PublicProfilePage — retired / unresolvable / share + back affordances', () => {
  beforeEach(() => {
    toastCalls.length = 0;
    useResolvedNetwork.mockReturnValue({ data: publicNetwork, isLoading: false, isError: false });
    useItemDetail.mockReturnValue({ item: makeItem(), isLoading: false, isError: false });
    useAuth.mockReturnValue({ isAuthenticated: false, isLoading: false, user: null });
    useMyItems.mockReturnValue({ data: [], isLoading: false, isFetched: true });
  });

  it('treats a retired item as unavailable and offers no share affordance', () => {
    useItemDetail.mockReturnValue({
      item: makeItem({ lifecycle_status: 'retired', item_state: { name: 'Asha' } }),
      isLoading: false,
      isError: false,
    });
    renderPublic([LIVE_PATH]);
    expect(screen.getByRole('heading', { name: 'Profile unavailable' })).toBeInTheDocument();
    expect(
      screen.getByText('This profile is no longer available, or the link is invalid.'),
    ).toBeInTheDocument();
    // A retired profile's name must not leak into the page.
    expect(screen.queryByText('Asha')).not.toBeInTheDocument();
    // Share is live-only: a retired profile gets no share button, hence no QR.
    expect(screen.queryByRole('button', { name: 'Share profile' })).not.toBeInTheDocument();
  });

  it('treats a paused item as unavailable too', () => {
    useItemDetail.mockReturnValue({
      item: makeItem({ lifecycle_status: 'paused' }),
      isLoading: false,
      isError: false,
    });
    renderPublic([LIVE_PATH]);
    expect(screen.getByRole('heading', { name: 'Profile unavailable' })).toBeInTheDocument();
  });

  it('shows unavailable when the link names a network that cannot be resolved', () => {
    useResolvedNetwork.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    useItemDetail.mockReturnValue({ item: null, isLoading: false, isError: false });
    renderPublic([`/public/no_such_dot/seeker/profile_1.0/${ITEM_ID}?network=no_such_dot`]);
    expect(screen.getByRole('heading', { name: 'Profile unavailable' })).toBeInTheDocument();
    // Nothing to share, so no share button (and no QR) at all.
    expect(screen.queryByRole('button', { name: 'Share profile' })).not.toBeInTheDocument();
  });

  it('renders the details grid for a live item with no explicit lifecycle status', () => {
    // The masked public projection omits lifecycle_status — it must still render.
    useItemDetail.mockReturnValue({
      item: makeItem({ lifecycle_status: undefined }),
      isLoading: false,
      isError: false,
    });
    renderPublic([LIVE_PATH]);
    expect(screen.getByRole('heading', { name: 'Asha' })).toBeInTheDocument();
    expect(screen.getByText('Seeker')).toBeInTheDocument();
    expect(screen.getByText('Pune')).toBeInTheDocument();
    // The masked projection has no lifecycle_status, but the page's own live
    // gate passed — the share button must still be offered.
    expect(screen.getByRole('button', { name: 'Share profile' })).toBeEnabled();
  });

  it('shares via a QR dialog that copies the canonical share URL', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    renderPublic([LIVE_PATH]);
    await user.click(screen.getByRole('button', { name: 'Share profile' }));
    // The dialog previews the same link as a scannable QR…
    const qr = await screen.findByAltText('QR code linking to this profile');
    expect(qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // …and "Copy link" copies exactly that link.
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe(
      `${window.location.origin}/public/blue_dot/seeker/profile_1.0/${ITEM_ID}?network=blue_dot`,
    );
    await waitFor(() =>
      expect(toastCalls).toContainEqual(['success', 'Link copied to clipboard']),
    );
  });

  it('reports a copy failure when neither clipboard path works', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn((_cmd: string) => false),
      configurable: true,
      writable: true,
    });
    renderPublic([LIVE_PATH]);
    await user.click(screen.getByRole('button', { name: 'Share profile' }));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(toastCalls).toContainEqual(['error', 'Could not copy the link']));
    expect(toastCalls).not.toContainEqual(['success', 'Link copied to clipboard']);
  });

  it('back goes to the network map view for a cold-opened share link', async () => {
    const user = userEvent.setup();
    renderPublic([LIVE_PATH]);
    await user.click(screen.getByRole('button', { name: 'Back to map' }));
    expect(await screen.findByText('map view')).toBeInTheDocument();
  });

  it('back returns to the previous in-app page when there is history', async () => {
    const user = userEvent.setup();
    renderPublic(['/browse', LIVE_PATH], 1);
    await user.click(screen.getByRole('button', { name: 'Back to map' }));
    expect(await screen.findByText('previous page')).toBeInTheDocument();
  });

  it("adds the link's network to the query string when it is missing, so the theme resolves", async () => {
    renderPublic([`/public/blue_dot/seeker/profile_1.0/${ITEM_ID}`]);
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent(
        `/public/blue_dot/seeker/profile_1.0/${ITEM_ID}?network=blue_dot`,
      ),
    );
  });
});

// ── TouristApp ──────────────────────────────────────────────────────────────

const practitionerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    category: { type: 'string', title: 'Category', enum: ['Stay', 'Artists'] },
    description: { type: 'string', title: 'About' },
  },
};

const touristNetwork = {
  id: TOURIST_NETWORK_ID,
  display_name: 'Orange Dot',
  description: 'tourism & culture',
  schema_standard: 'dpg/1.0',
  domains: [
    {
      id: 'practitioner',
      description: 'practitioners',
      card: { title_field: 'name' },
      item_schemas: { 'profile_1.0': practitionerSchema },
    },
  ],
  actions: {},
} satisfies DotNetworkSchema;

function practitioner(id: string, name: string, category: string, lat: number, lng: number): Item {
  return {
    item_id: id,
    item_network: TOURIST_NETWORK_ID,
    item_domain: 'practitioner',
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: { name, category, description: `${name} in Udupi` },
    item_locations: [{ lat, lng }],
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
  };
}

const STAY = practitioner('p-1', 'Kadike Homestay', 'Stay', 13.34, 74.74);
const ARTIST = practitioner('p-2', 'Yakshagana Troupe', 'Artists', 19.0, 72.8);

function renderTourist() {
  return render(
    <QueryClientProvider client={newClient()}>
      <TooltipProvider>
        <TouristApp />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('TouristApp', () => {
  beforeEach(() => {
    requestLocation.mockClear();
    fetchNetworkConfig.mockReset();
    fetchNetworkItems.mockReset();
    browserLocationState.location = null;
    browserLocationState.status = 'idle';
    browserLocationState.isSupported = true;
    geoPermission.value = 'prompt';
    fetchNetworkConfig.mockResolvedValue(touristNetwork);
    fetchNetworkItems.mockResolvedValue({
      items: [STAY, ARTIST],
      meta: { total: 2, limit: 100, offset: 0 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-requests the visitor location once and centres the map on the region default until it resolves', async () => {
    renderTourist();
    expect(await screen.findByText('Kadike Homestay')).toBeInTheDocument();
    expect(fetchNetworkConfig).toHaveBeenCalledWith(TOURIST_NETWORK_ID);
    expect(requestLocation).toHaveBeenCalledTimes(1);
    // No location yet → region default (Udupi), no self focus point.
    expect(screen.getByTestId('map-center')).toHaveTextContent('13.3409,74.7421');
    expect(screen.getByTestId('map-focus')).toHaveTextContent('none');
    expect(screen.getByText('Yakshagana Troupe')).toBeInTheDocument();
    // Location is merely pending — no banner while the prompt is in flight.
    expect(screen.queryByText('Showing all practitioners')).not.toBeInTheDocument();
  });

  it('centres on the visitor once geolocation resolves', async () => {
    browserLocationState.status = 'success';
    browserLocationState.location = { lat: 12.9, lng: 74.8 };
    renderTourist();
    expect(await screen.findByTestId('tourist-map')).toBeInTheDocument();
    expect(screen.getByTestId('map-center')).toHaveTextContent('12.9,74.8');
    expect(screen.getByTestId('map-focus')).toHaveTextContent('12.9,74.8');
    // Already resolved → no second auto-request.
    expect(requestLocation).not.toHaveBeenCalled();
  });

  it('offers the enable-location banner when geolocation is unsupported, and re-requests on click', async () => {
    browserLocationState.isSupported = false;
    const user = userEvent.setup();
    renderTourist();
    expect(await screen.findByText('Showing all practitioners')).toBeInTheDocument();
    expect(screen.getByText("Enable location to see what's nearest to you.")).toBeInTheDocument();
    // Unsupported → the mount effect must not fire a request.
    expect(requestLocation).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Enable location' }));
    expect(requestLocation).toHaveBeenCalledTimes(1);
    // Discovery still works without permission.
    expect(await screen.findByText('Kadike Homestay')).toBeInTheDocument();
  });

  it('drops the banner CTA and explains the block when permission is denied', async () => {
    browserLocationState.status = 'error';
    geoPermission.value = 'denied';
    renderTourist();
    expect(await screen.findByText('Showing all practitioners')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Location is blocked. Allow location for this site in your browser settings to see what's nearest to you.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable location' })).not.toBeInTheDocument();
  });

  it('filters the visible practitioners by the search box', async () => {
    const user = userEvent.setup();
    renderTourist();
    expect(await screen.findByText('Kadike Homestay')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'yaksha');
    await waitFor(() => expect(screen.queryByText('Kadike Homestay')).not.toBeInTheDocument());
    expect(screen.getByText('Yakshagana Troupe')).toBeInTheDocument();
  });

  it('applies the schema-derived enum filter chosen in the filters panel', async () => {
    const user = userEvent.setup();
    renderTourist();
    expect(await screen.findByText('Yakshagana Troupe')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'filter-stay' }));
    await waitFor(() => expect(screen.queryByText('Yakshagana Troupe')).not.toBeInTheDocument());
    expect(screen.getByText('Kadike Homestay')).toBeInTheDocument();
  });

  it('switches to the nearest-first list view', async () => {
    browserLocationState.status = 'success';
    browserLocationState.location = { lat: 13.35, lng: 74.75 };
    const user = userEvent.setup();
    renderTourist();
    expect(await screen.findByText('Kadike Homestay')).toBeInTheDocument();
    // Radix ToggleGroup (type="single") exposes its items as radios.
    await user.click(screen.getByRole('radio', { name: 'List view' }));
    await waitFor(() => expect(screen.queryByTestId('tourist-map')).not.toBeInTheDocument());
    const names = screen.getAllByText(/Kadike Homestay|Yakshagana Troupe/).map((el) => el.textContent);
    expect(names[0]).toBe('Kadike Homestay');
  });

  it('shows the loading copy while the network config is in flight', () => {
    fetchNetworkConfig.mockImplementation(() => new Promise(() => {}));
    renderTourist();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByTestId('tourist-map')).not.toBeInTheDocument();
  });

  it('stays on the loading copy (and offers no filters) when the config has no practitioner domain', async () => {
    fetchNetworkConfig.mockResolvedValue({
      ...touristNetwork,
      domains: [{ id: 'something_else', description: 'other' }],
    });
    renderTourist();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'filter-stay' })).not.toBeInTheDocument();
    // No practitioner domain → nothing to fetch items for is still attempted
    // with the fallback item_type, but the view can't render.
    expect(screen.queryByTestId('tourist-map')).not.toBeInTheDocument();
  });

  it('surfaces a retry that recovers from a failed config load', async () => {
    const user = userEvent.setup();
    fetchNetworkConfig.mockRejectedValueOnce(new Error('offline'));
    renderTourist();
    expect(await screen.findByText("Couldn't load practitioners.")).toBeInTheDocument();
    fetchNetworkConfig.mockResolvedValue(touristNetwork);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('tourist-map')).toBeInTheDocument();
    expect(screen.getByText('Kadike Homestay')).toBeInTheDocument();
  });

  it('surfaces the error state when the items fetch fails even though the config loaded', async () => {
    fetchNetworkItems.mockRejectedValue(new Error('items down'));
    renderTourist();
    expect(await screen.findByText("Couldn't load practitioners.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
