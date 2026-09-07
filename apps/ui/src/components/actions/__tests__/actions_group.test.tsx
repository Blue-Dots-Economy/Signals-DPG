import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, DotNetworkSchema } from '@/engine/types';
import type { BulkEnvelope } from '@/lib/bulk';
import type {
  Action,
  ContactDetailsResponse,
  UpdateActionStatusPayload,
  UpdateActionStatusResponse,
} from '@/lib/action-api';
import type { FetchItemsResponse } from '@/lib/item-api';

// The six action components under test all talk to the same few boundaries:
// the action API layer, the bulk mutation hooks, the network/consent config
// hooks and sonner. Everything below the boundary (cards, dialogs, selection,
// consent copy, i18n) stays REAL so the assertions are about user-visible
// behaviour.
//
// `vi.hoisted` is used for every shared mock handle — a vi.mock factory hoists
// above ordinary top-level declarations, so it must not close over them.

/** Options object the component passes to react-query's `mutate`. */
interface StatusMutateOptions {
  onSuccess: () => void;
  onError: (err: Error) => void;
}

interface BulkVars {
  payloads: UpdateActionStatusPayload[];
  guardianOtp?: string;
}

const emptyEnvelope: BulkEnvelope<UpdateActionStatusResponse> = {
  results: [],
  summary: { total: 0, succeeded: 0, failed: 0 },
};

const mocks = vi.hoisted(() => ({
  isMobile: { value: false },
  networkConfig: { value: null as DotNetworkSchema | null },
  consentConfig: { value: null as ConsentConfigDocument | null },
  statusPending: { value: false },
  bulkPending: { value: false },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
  signOut: vi.fn(),
  mutate: vi.fn((_payload: UpdateActionStatusPayload, _opts: StatusMutateOptions) => {}),
  bulkMutateAsync: vi.fn(
    async (_vars: BulkVars): Promise<BulkEnvelope<UpdateActionStatusResponse>> => ({
      results: [],
      summary: { total: 0, succeeded: 0, failed: 0 },
    }),
  ),
  updateActionStatus: vi.fn(
    async (
      _payload: UpdateActionStatusPayload,
      _otp?: string,
    ): Promise<UpdateActionStatusResponse> => ({
      action_id: 'act-1',
      action_type: 'connect',
      action_status: 'accepted',
      update_count: 2,
    }),
  ),
  getActionContactDetails: vi.fn(async (_actionId: string): Promise<ContactDetailsResponse> => {
    throw new Error('getActionContactDetails not stubbed');
  }),
  fetchNetworkItems: vi.fn(async (): Promise<FetchItemsResponse> => ({
    meta: { total: 0, limit: 1, offset: 0 },
    items: [],
  })),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.isMobile.value }));

vi.mock('sonner', () => ({ toast: mocks.toast }));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAuthenticated: true, signOut: mocks.signOut }),
}));

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfig: () => ({
    data: mocks.networkConfig.value,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: mocks.consentConfig.value, isLoading: false }),
}));

vi.mock('@/hooks/use-actions', () => ({
  actionKeys: { all: ['actions'] },
  useUpdateActionStatus: () => ({ mutate: mocks.mutate, isPending: mocks.statusPending.value }),
  useUpdateActionStatusBulk: () => ({
    mutateAsync: mocks.bulkMutateAsync,
    isPending: mocks.bulkPending.value,
  }),
}));

vi.mock('@/lib/action-api', () => ({
  ACTION_CONSENT_SENTINEL: '__consent',
  // Faithful to the real classifier for the codes these components branch on.
  guardianOtpErrorOf: (entry: { error?: string } | null | undefined) =>
    entry?.error === 'GUARDIAN_OTP_REQUIRED' ? 'GUARDIAN_OTP_REQUIRED' : null,
  guardianOtpErrorFromThrown: (err: unknown) => {
    const code = (err as { code?: string } | null | undefined)?.code;
    const known = [
      'GUARDIAN_OTP_REQUIRED',
      'GUARDIAN_OTP_INVALID',
      'GUARDIAN_OTP_THROTTLED',
      'OTP_PROVIDER_UNAVAILABLE',
    ];
    return code && known.includes(code) ? code : null;
  },
  updateActionStatus: mocks.updateActionStatus,
  getActionContactDetails: mocks.getActionContactDetails,
}));

vi.mock('@/lib/network-api', () => ({ fetchNetworkItems: mocks.fetchNetworkItems }));

// Imported AFTER the mocks so the components pick them up.
import { ActionCard } from '../action-card';
import { ActionList } from '../action-list';
import type { ActionSort, ActionStatusFilter, ActiveFacet } from '../action-toolbar';
import { ActionModal } from '../action-modal';
import { ActionStatusUpdater } from '../action-status-updater';
import { BulkStatusDialog } from '../bulk-status-dialog';
import { ProfileCardModal } from '../profile-card-modal';
import { useCardSelection } from '@/hooks/use-card-selection';

// ─── Fixtures ─────────────────────────────────────────────────────

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    action_id: 'act-1',
    action_type: 'connect',
    action_status: 'created',
    update_count: 1,
    source_item_id: 'src111222333',
    source_item_network: 'yellow_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    source_item_owner: 'u-src',
    source_item_name: 'Alice Seeker',
    target_item_id: 'tgt444555666',
    target_item_network: 'yellow_dot',
    target_item_domain: 'provider',
    target_item_type: 'profile_1.0',
    target_item_owner: 'u-tgt',
    target_item_name: 'Bob Builder',
    requirements_snapshot: {},
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ownership_roles: ['initiated'],
    ...overrides,
  };
}

const providerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Phone' },
  },
};

function makeNetworkConfig(overrides: Partial<DotNetworkSchema> = {}): DotNetworkSchema {
  return {
    id: 'yellow_dot',
    display_name: 'Yellow Dot',
    description: 'test network',
    schema_standard: '1.0',
    domains: [
      {
        id: 'provider',
        description: 'a provider',
        item_schemas: { 'profile_1.0': providerSchema },
        card: { title_field: 'name', default_fields: ['phone'] },
      },
    ],
    actions: {
      connect: {
        description: 'connect to a provider',
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: { type: 'object' },
            reveals_pii_on_status: ['accepted', 'completed'],
          },
        ],
      },
    },
    ...overrides,
  };
}

const consentConfig: ConsentConfigDocument = {
  documents: {
    terms: {
      current_version: 1,
      versions: [
        { version: 1, title: 'Terms v1', content: 'terms body', effective_from: '2024-01-01' },
      ],
    },
    privacy: {
      current_version: 1,
      versions: [
        { version: 1, title: 'Privacy v1', content: 'privacy body', effective_from: '2024-01-01' },
      ],
    },
    profile_creation: {
      current_version: 1,
      versions: [{ version: 1, statement: 'I agree.', effective_from: '2024-01-01' }],
    },
  },
  actions: {
    connect: {
      initiate: {
        current_version: 2,
        versions: [
          { version: 1, statement: 'old initiate', effective_from: '2024-01-01' },
          {
            version: 2,
            statement: 'I share my details with this __COUNTERPARTY__.',
            effective_from: '2025-01-01',
          },
        ],
      },
      accept: {
        current_version: 3,
        versions: [
          { version: 3, statement: 'I share my contact with this __COUNTERPARTY__.', effective_from: '2025-01-01' },
        ],
      },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function typeOtp(digits: string) {
  const inputs = screen.getAllByRole('textbox');
  digits.split('').forEach((d, i) => {
    fireEvent.change(inputs[i], { target: { value: d } });
  });
}

function successEnvelope(n: number): BulkEnvelope<UpdateActionStatusResponse> {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      index: i,
      status: 'success' as const,
      action_id: `act-${i + 1}`,
      action_type: 'connect',
      action_status: 'accepted',
      update_count: 2,
    })),
    summary: { total: n, succeeded: n, failed: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isMobile.value = false;
  mocks.networkConfig.value = makeNetworkConfig();
  mocks.consentConfig.value = consentConfig;
  mocks.statusPending.value = false;
  mocks.bulkPending.value = false;
  mocks.bulkMutateAsync.mockResolvedValue(emptyEnvelope);
});

// ─── ActionCard ───────────────────────────────────────────────────

describe('ActionCard', () => {
  it('shows the Pending pill and only Accept/Reject for a received pending action', async () => {
    const user = userEvent.setup();
    const onStatusUpdate = vi.fn((_a: Action, _s: string) => {});
    renderWithClient(
      <ActionCard
        action={makeAction({ action_status: 'created' })}
        ownershipRole="received"
        onStatusUpdate={onStatusUpdate}
      />,
    );

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /complete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /accept/i }));
    expect(onStatusUpdate).toHaveBeenCalledWith(expect.objectContaining({ action_id: 'act-1' }), 'accepted');

    await user.click(screen.getByRole('button', { name: /reject/i }));
    expect(onStatusUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ action_id: 'act-1' }),
      'rejected',
    );
  });

  it('offers Complete (not Accept/Reject) for a received accepted action', async () => {
    const user = userEvent.setup();
    const onStatusUpdate = vi.fn((_a: Action, _s: string) => {});
    renderWithClient(
      <ActionCard
        action={makeAction({ action_status: 'accepted' })}
        ownershipRole="received"
        onStatusUpdate={onStatusUpdate}
      />,
    );

    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /complete/i }));
    expect(onStatusUpdate).toHaveBeenCalledWith(expect.anything(), 'completed');
  });

  it('offers Cancel for an initiated pending action and labels the flow "You (Seeker) → Bob Builder (Provider)"', async () => {
    const user = userEvent.setup();
    const onStatusUpdate = vi.fn((_a: Action, _s: string) => {});
    renderWithClient(
      <ActionCard
        action={makeAction({ action_status: 'pending' })}
        ownershipRole="initiated"
        onStatusUpdate={onStatusUpdate}
      />,
    );

    expect(screen.getByText('You (Seeker)')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder (Provider)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onStatusUpdate).toHaveBeenCalledWith(expect.anything(), 'cancelled');
  });

  it('falls back to the raw status text for a status with no configured pill label', () => {
    renderWithClient(
      <ActionCard action={makeAction({ action_status: 'expired' })} ownershipRole="received" />,
    );
    expect(screen.getByText('expired')).toBeInTheDocument();
    // Not actionable: no accept/reject/complete/cancel affordances.
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view profile/i })).toBeInTheDocument();
  });

  it('renders the message and structured requirement fields, and collapses them on toggle', async () => {
    const user = userEvent.setup();
    renderWithClient(
      <ActionCard
        action={makeAction({
          requirements_snapshot: {
            message: 'Please help with algebra',
            subjects: ['Maths', 'Physics'],
            certificates: [],
            mode: 'online',
          },
        })}
        ownershipRole="received"
      />,
    );

    expect(screen.getByText('Please help with algebra')).toBeInTheDocument();
    expect(screen.getByText('Maths')).toBeInTheDocument();
    expect(screen.getByText('Physics')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    // An empty array renders the em-dash placeholder rather than nothing.
    expect(screen.getByText('Certificates')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /requirements/i }));
    expect(screen.queryByText('Please help with algebra')).not.toBeInTheDocument();
    expect(screen.queryByText('Maths')).not.toBeInTheDocument();
  });

  it('shows the remarks reason even when the action has no requirements', () => {
    renderWithClient(
      <ActionCard
        action={makeAction({
          action_status: 'cancelled',
          remarks: 'The other profile was retired',
          requirements_snapshot: {},
        })}
        ownershipRole="initiated"
      />,
    );
    expect(screen.queryByText('Requirements')).not.toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();
    expect(screen.getByText('The other profile was retired')).toBeInTheDocument();
  });

  it('hides the whole footer in selection mode', () => {
    renderWithClient(
      <ActionCard
        action={makeAction({ action_status: 'created' })}
        ownershipRole="received"
        selectionMode
      />,
    );
    expect(screen.queryByRole('button', { name: /view profile/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    // The card body itself still renders.
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('shows the counterparty location labels and falls back to a short id when there is no name', () => {
    renderWithClient(
      <ActionCard
        action={makeAction({
          source_item_name: null,
          source_item_locations: [{ lat: 1, lng: 2, label: 'Bengaluru' }],
        })}
        ownershipRole="received"
      />,
    );
    expect(screen.getByText('Bengaluru')).toBeInTheDocument();
    expect(screen.getByText('#src111 (Seeker)')).toBeInTheDocument();
  });

  it('summarises unlabelled locations as a count', () => {
    renderWithClient(
      <ActionCard
        action={makeAction({
          target_item_locations: [
            { lat: 1, lng: 2 },
            { lat: 3, lng: 4 },
          ],
        })}
        ownershipRole="initiated"
      />,
    );
    expect(screen.getByText('2 locations')).toBeInTheDocument();
  });

  it('opens the counterparty profile dialog from "View profile"', async () => {
    const user = userEvent.setup();
    mocks.getActionContactDetails.mockResolvedValue({
      action_id: 'act-1',
      action_status: 'accepted',
      revealed: true,
      other_actor: {
        item: {
          item_id: 'tgt444555666',
          item_network: 'yellow_dot',
          item_domain: 'provider',
          item_type: 'profile_1.0',
          item_instance_url: null,
          item_schema_url: null,
          item_state: { name: 'Bob Builder', phone: '+91 99999 00000' },
          item_locations: [],
          created_by: 'u-tgt',
          created_at: '2026-08-01T10:00:00.000Z',
          updated_at: '2026-08-01T10:00:00.000Z',
        },
      },
    });

    renderWithClient(
      <ActionCard
        action={makeAction({ action_status: 'accepted' })}
        ownershipRole="initiated"
      />,
    );

    await user.click(screen.getByRole('button', { name: /view profile/i }));

    await waitFor(() => expect(mocks.getActionContactDetails).toHaveBeenCalledWith('act-1'));
    expect(
      await screen.findByText('Full profile, including the shared contact details.'),
    ).toBeInTheDocument();
    expect(screen.getByText('+91 99999 00000')).toBeInTheDocument();
  });
});

// ─── ActionList ───────────────────────────────────────────────────

interface ListHarnessProps {
  initiated?: Action[];
  received?: Action[];
  initiatedTotal?: number;
  receivedTotal?: number;
  activeTab?: 'initiated' | 'received';
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  isRefetching?: boolean;
  onStatusUpdate?: (action: Action, targetStatus: string) => void;
  onBulkAction?: (targetStatus: string) => void;
  onRefresh?: () => void;
  onTabChange?: (tab: 'initiated' | 'received') => void;
  // ── Toolbar + paging (#439): the page owns this state and the server does
  // the filtering, so ActionList only forwards these. ─────────────────────
  status?: ActionStatusFilter;
  sort?: ActionSort;
  activeFacets?: ActiveFacet[];
  onStatusChange?: (status: ActionStatusFilter) => void;
  onSortChange?: (sort: ActionSort) => void;
  onOpenFilters?: () => void;
  onRemoveFacet?: (field: string, value: string) => void;
  onClearFilters?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
}

/**
 * Drives ActionList with the REAL `useCardSelection` and real tab state, so the
 * selection lock / bulk-bar behaviour is exercised end-to-end rather than
 * against a stubbed selection object. Toolbar status is held locally too (as
 * the page does), so clearing the status token really re-renders with 'All'.
 */
function ListHarness(props: ListHarnessProps) {
  const selection = useCardSelection();
  const [tab, setTab] = React.useState<'initiated' | 'received'>(props.activeTab ?? 'received');
  const [status, setStatus] = React.useState<ActionStatusFilter>(props.status ?? 'All');
  return (
    <ActionList
      initiatedActions={props.initiated ?? []}
      receivedActions={props.received ?? []}
      initiatedTotal={props.initiatedTotal}
      receivedTotal={props.receivedTotal}
      isLoading={props.isLoading ?? false}
      isError={props.isError ?? false}
      error={props.error ?? null}
      activeTab={tab}
      onTabChange={(next) => {
        props.onTabChange?.(next);
        setTab(next);
      }}
      onStatusUpdate={props.onStatusUpdate ?? (() => {})}
      onRefresh={props.onRefresh ?? (() => {})}
      isRefetching={props.isRefetching ?? false}
      selection={selection}
      onBulkAction={props.onBulkAction ?? (() => {})}
      toolbarStatus={status}
      toolbarSort={props.sort ?? 'recent'}
      activeFacets={props.activeFacets ?? []}
      onStatusChange={(next) => {
        props.onStatusChange?.(next);
        setStatus(next);
      }}
      onSortChange={props.onSortChange ?? (() => {})}
      onOpenFilters={props.onOpenFilters ?? (() => {})}
      onRemoveFacet={props.onRemoveFacet ?? (() => {})}
      onClearFilters={props.onClearFilters ?? (() => {})}
      hasNextPage={props.hasNextPage ?? false}
      isFetchingNextPage={props.isFetchingNextPage ?? false}
      onLoadMore={props.onLoadMore ?? (() => {})}
    />
  );
}

describe('ActionList', () => {
  const pendingReceived = makeAction({
    action_id: 'a-pending',
    action_status: 'created',
    source_item_name: 'Alice Seeker',
  });
  const acceptedReceived = makeAction({
    action_id: 'a-accepted',
    action_status: 'accepted',
    source_item_name: 'Dave Accepted',
  });
  const rejectedReceived = makeAction({
    action_id: 'a-rejected',
    action_status: 'rejected',
    source_item_name: 'Eve Rejected',
  });

  /** The selection targets SelectableCard wraps each card in (they carry aria-pressed). */
  function selectionTargets(): HTMLElement[] {
    return screen
      .getAllByRole('button')
      .filter((el) => el.getAttribute('aria-pressed') !== null);
  }

  it('renders skeletons and no cards while loading', () => {
    const { baseElement } = renderWithClient(
      <ListHarness isLoading received={[pendingReceived]} />,
    );
    expect(baseElement.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /view profile/i })).not.toBeInTheDocument();
  });

  it('renders the error state with the error message', () => {
    renderWithClient(
      <ListHarness isError error={new Error('network exploded')} received={[pendingReceived]} />,
    );
    expect(screen.getByText('Failed to load actions')).toBeInTheDocument();
    expect(screen.getByText('network exploded')).toBeInTheDocument();
  });

  it('falls back to generic error copy when the error carries no message', () => {
    renderWithClient(<ListHarness isError error={null} />);
    expect(
      screen.getByText('An unexpected error occurred while fetching your actions.'),
    ).toBeInTheDocument();
  });

  it('renders a tab-specific empty state', async () => {
    const user = userEvent.setup();
    renderWithClient(<ListHarness activeTab="received" />);
    expect(screen.getByText('Requests sent to you will appear here.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /initiated/i }));
    expect(screen.getByText('Requests you send will show up here.')).toBeInTheDocument();
  });

  it('shows per-tab counts and switches the rendered list on tab change', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn((_tab: 'initiated' | 'received') => {});
    renderWithClient(
      <ListHarness
        activeTab="received"
        received={[pendingReceived, acceptedReceived]}
        initiated={[makeAction({ action_id: 'i-1', target_item_name: 'Carol Provider' })]}
        onTabChange={onTabChange}
      />,
    );

    const receivedTab = screen.getByRole('button', { name: /received/i });
    expect(receivedTab).toHaveTextContent('2');
    const initiatedTab = screen.getByRole('button', { name: /initiated/i });
    expect(initiatedTab).toHaveTextContent('1');

    await user.click(initiatedTab);
    expect(onTabChange).toHaveBeenCalledWith('initiated');
    // The initiated action's counterparty is the target item.
    expect(await screen.findByText('Carol Provider (Provider)')).toBeInTheDocument();
    expect(screen.queryByText('Alice Seeker (Seeker)')).not.toBeInTheDocument();
  });

  it('renders every row handed down even under an active filter (the server filtered, #439)', () => {
    renderWithClient(
      <ListHarness
        status="Pending"
        activeFacets={[{ field: 'city', label: 'City', value: 'Pune' }]}
        received={[pendingReceived, acceptedReceived, rejectedReceived]}
      />,
    );

    // No client-side re-filter: all three rows render despite status=Pending.
    expect(screen.getAllByRole('button', { name: /view profile/i })).toHaveLength(3);
    // Status counts as one active filter alongside the facet.
    expect(screen.getByTestId('filters-count')).toHaveTextContent('2');
    expect(screen.getByTestId('status-token')).toBeInTheDocument();
  });

  it('hands the toolbar callbacks straight to the page', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn((_s: ActionStatusFilter) => {});
    const onRemoveFacet = vi.fn((_field: string, _value: string) => {});
    const onClearFilters = vi.fn();
    const onOpenFilters = vi.fn();
    renderWithClient(
      <ListHarness
        status="Pending"
        activeFacets={[{ field: 'city', label: 'City', value: 'Pune' }]}
        received={[pendingReceived]}
        onStatusChange={onStatusChange}
        onRemoveFacet={onRemoveFacet}
        onClearFilters={onClearFilters}
        onOpenFilters={onOpenFilters}
      />,
    );

    await user.click(screen.getByTestId('filters-button'));
    expect(onOpenFilters).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('facet-remove-city-Pune'));
    expect(onRemoveFacet).toHaveBeenCalledWith('city', 'Pune');

    await user.click(screen.getByTestId('clear-filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);

    // Clearing the status token asks the page for "All".
    await user.click(screen.getByTestId('status-remove'));
    expect(onStatusChange).toHaveBeenCalledWith('All');
  });

  it('shows the empty state when the filtered page comes back empty', () => {
    renderWithClient(<ListHarness status="Pending" received={[]} />);
    expect(screen.getByText('Requests sent to you will appear here.')).toBeInTheDocument();
  });

  it('takes the tab counts from the server totals, not the loaded page length', () => {
    renderWithClient(
      <ListHarness
        received={[pendingReceived]}
        receivedTotal={42}
        initiated={[makeAction({ action_id: 'i-1' })]}
        initiatedTotal={7}
      />,
    );
    expect(screen.getByRole('button', { name: /received/i })).toHaveTextContent('42');
    expect(screen.getByRole('button', { name: /initiated/i })).toHaveTextContent('7');
  });

  it('Load more asks for the next page, and is disabled while one is in flight', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const { unmount } = renderWithClient(
      <ListHarness received={[pendingReceived]} hasNextPage onLoadMore={onLoadMore} />,
    );
    await user.click(screen.getByTestId('load-more-button'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    unmount();

    renderWithClient(
      <ListHarness received={[pendingReceived]} hasNextPage isFetchingNextPage onLoadMore={onLoadMore} />,
    );
    expect(screen.getByTestId('load-more-button')).toBeDisabled();
  });

  it('offers no Load more button on the last page', () => {
    renderWithClient(<ListHarness received={[pendingReceived]} />);
    expect(screen.queryByTestId('load-more-button')).not.toBeInTheDocument();
  });

  it('disables the refresh button while refetching and calls onRefresh otherwise', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { unmount } = renderWithClient(<ListHarness isRefetching onRefresh={onRefresh} />);
    expect(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
    unmount();

    renderWithClient(<ListHarness onRefresh={onRefresh} />);
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('hides the Select button when nothing in view is actionable', () => {
    renderWithClient(<ListHarness received={[rejectedReceived]} />);
    expect(screen.queryByRole('button', { name: /^select items$/i })).not.toBeInTheDocument();
  });

  it('bulk accept/reject: selecting a pending received card shows the batch bar and locks out accepted cards', async () => {
    const user = userEvent.setup();
    const onBulkAction = vi.fn((_status: string) => {});
    renderWithClient(
      <ListHarness received={[pendingReceived, acceptedReceived]} onBulkAction={onBulkAction} />,
    );

    await user.click(screen.getByRole('button', { name: /^select items$/i }));
    // In select mode each card becomes a pressable selection target.
    const targets = selectionTargets();
    const pendingTarget = targets.find((el) => el.textContent?.includes('Alice Seeker'));
    const acceptedTarget = targets.find((el) => el.textContent?.includes('Dave Accepted'));
    expect(pendingTarget).toBeDefined();
    expect(acceptedTarget).toBeDefined();

    await user.click(pendingTarget as HTMLElement);
    expect(pendingTarget).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // The batch is locked to the "pending" class, so the accepted card can no
    // longer be added.
    expect(acceptedTarget).toHaveAttribute('aria-disabled', 'true');
    await user.click(acceptedTarget as HTMLElement);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onBulkAction).toHaveBeenCalledWith('accepted');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onBulkAction).toHaveBeenLastCalledWith('rejected');
    // Cancel is an initiated-tab affordance, never offered here.
    expect(screen.queryByRole('button', { name: /cancel requests/i })).not.toBeInTheDocument();
  });

  it('bulk complete: an accepted-locked received selection offers Complete only', async () => {
    const user = userEvent.setup();
    const onBulkAction = vi.fn((_status: string) => {});
    renderWithClient(
      <ListHarness received={[pendingReceived, acceptedReceived]} onBulkAction={onBulkAction} />,
    );

    await user.click(screen.getByRole('button', { name: /^select items$/i }));
    const acceptedTarget = selectionTargets().find((el) =>
      el.textContent?.includes('Dave Accepted'),
    );
    await user.click(acceptedTarget as HTMLElement);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    expect(onBulkAction).toHaveBeenCalledWith('completed');
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('bulk cancel: a pending selection on the initiated tab offers Cancel requests', async () => {
    const user = userEvent.setup();
    const onBulkAction = vi.fn((_status: string) => {});
    renderWithClient(
      <ListHarness
        activeTab="initiated"
        initiated={[makeAction({ action_id: 'i-1', action_status: 'created' })]}
        onBulkAction={onBulkAction}
      />,
    );

    await user.click(screen.getByRole('button', { name: /^select items$/i }));
    const target = selectionTargets()[0];
    await user.click(target as HTMLElement);

    await user.click(screen.getByRole('button', { name: /cancel requests/i }));
    expect(onBulkAction).toHaveBeenCalledWith('cancelled');
  });

  it('Clear empties the selection and hides the batch bar without leaving select mode', async () => {
    const user = userEvent.setup();
    renderWithClient(<ListHarness received={[pendingReceived]} />);

    await user.click(screen.getByRole('button', { name: /^select items$/i }));
    const target = selectionTargets()[0];
    await user.click(target as HTMLElement);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear/i }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    // Still in select mode → the toggle reads "Done".
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
  });

  it('changing the status filter drops out of select mode so a hidden selection cannot go stale', async () => {
    const user = userEvent.setup();
    renderWithClient(
      <ListHarness status="Pending" received={[pendingReceived, rejectedReceived]} />,
    );

    await user.click(screen.getByRole('button', { name: /^select items$/i }));
    const target = selectionTargets()[0];
    await user.click(target as HTMLElement);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // The status change goes out to the page (which refetches) — the component
    // only has to make sure the now-possibly-hidden selection is dropped.
    await user.click(screen.getByTestId('status-remove'));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /done/i })).not.toBeInTheDocument();
  });
});

// ─── ActionStatusUpdater ──────────────────────────────────────────

/**
 * Owns `open` locally so `onOpenChange(false)` from inside the component really
 * closes the dialog (which is what the user sees), while still reporting every
 * call to the spy.
 */
function UpdaterHarness({
  action,
  suggestedStatus,
  onOpenChange,
}: {
  action: Action | null;
  suggestedStatus?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <ActionStatusUpdater
      action={action}
      open={open}
      suggestedStatus={suggestedStatus}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
      }}
    />
  );
}

/** Typed view over the recorded `mutate(payload, options)` calls. */
function statusMutateCall(index = 0): [UpdateActionStatusPayload, StatusMutateOptions] {
  return mocks.mutate.mock.calls[index] as [UpdateActionStatusPayload, StatusMutateOptions];
}

describe('ActionStatusUpdater', () => {
  it('renders nothing when there is no action', () => {
    renderWithClient(<UpdaterHarness action={null} suggestedStatus="accepted" />);
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  });

  it('reject flow: submits the typed reason, toasts success and closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn((_open: boolean) => {});
    mocks.mutate.mockImplementation((_payload, opts) => opts.onSuccess());

    renderWithClient(
      <UpdaterHarness action={makeAction()} suggestedStatus="rejected" onOpenChange={onOpenChange} />,
    );

    expect(screen.getByText('Reject Request')).toBeInTheDocument();
    expect(screen.getByText('Let the other party know why this is being declined.')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/reason \(optional\)/i), 'Not a fit');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(statusMutateCall()[0]).toEqual({
      action_id: 'act-1',
      action_status: 'rejected',
      remarks: 'Not a fit',
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Request rejected', {
      description: 'The status has been updated and both parties will be notified.',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument(),
    );
  });

  it('omits remarks entirely when the reason box is left blank', async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation((_payload, opts) => opts.onSuccess());

    renderWithClient(<UpdaterHarness action={makeAction()} suggestedStatus="cancelled" />);
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(statusMutateCall()[0]).toEqual({ action_id: 'act-1', action_status: 'cancelled' });
    expect(mocks.toast.success).toHaveBeenCalledWith('Request cancelled', expect.anything());
  });

  it('accept flow: gates submit behind the consent tick and sends the consent block instead of remarks', async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation((_payload, opts) => opts.onSuccess());

    renderWithClient(<UpdaterHarness action={makeAction()} suggestedStatus="accepted" />);

    // Consent statement is rendered with the REQUESTER's domain as the noun.
    expect(screen.getByText('I share my contact with this seeker.')).toBeInTheDocument();
    // The consent variant replaces the remarks box.
    expect(screen.queryByLabelText(/reason \(optional\)/i)).not.toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(submit).not.toBeDisabled();

    await user.click(submit);
    expect(statusMutateCall()[0]).toEqual({
      action_id: 'act-1',
      action_status: 'accepted',
      consent: { acknowledged: true, version: 3, brand: null },
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Request accepted', expect.anything());
  });

  it('keeps Submit disabled until the network config has loaded (consent requirement unknown)', () => {
    mocks.networkConfig.value = null;
    renderWithClient(<UpdaterHarness action={makeAction()} suggestedStatus="accepted" />);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  it('shows the updating label and disables both buttons while the mutation is pending', () => {
    mocks.statusPending.value = true;
    renderWithClient(<UpdaterHarness action={makeAction()} suggestedStatus="rejected" />);
    expect(screen.getByRole('button', { name: 'Updating...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('errors without submitting when no target status was supplied', async () => {
    const user = userEvent.setup();
    renderWithClient(<UpdaterHarness action={makeAction()} />);

    expect(screen.getByText('Update Status')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('No status selected', {
      description: 'No target status was provided for this action.',
    });
  });

  it('surfaces a non-guardian failure as a toast and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn((_open: boolean) => {});
    mocks.mutate.mockImplementation((_payload, opts) => opts.onError(new Error('server on fire')));

    renderWithClient(
      <UpdaterHarness action={makeAction()} suggestedStatus="rejected" onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mocks.toast.error).toHaveBeenCalledWith('Failed to update status: server on fire');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('a GUARDIAN_OTP_REQUIRED failure swaps the dialog for the guardian OTP challenge and replays the payload with the code', async () => {
    const user = userEvent.setup();
    mocks.mutate.mockImplementation((_payload, opts) =>
      opts.onError(Object.assign(new Error('needs guardian'), { code: 'GUARDIAN_OTP_REQUIRED' })),
    );

    renderWithClient(<UpdaterHarness action={makeAction()} suggestedStatus="accepted" />);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    // No generic error toast for a minor — the challenge replaces it.
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/guardian's confirmation via otp/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument(),
    );

    typeOtp('246810');

    await waitFor(() =>
      expect(mocks.updateActionStatus).toHaveBeenCalledWith(
        {
          action_id: 'act-1',
          action_status: 'accepted',
          consent: { acknowledged: true, version: 3, brand: null },
        },
        '246810',
      ),
    );
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith('Request accepted', expect.anything()),
    );
    await waitFor(() =>
      expect(screen.queryByText(/guardian's confirmation via otp/i)).not.toBeInTheDocument(),
    );
  });

  it('renders as a drawer on mobile', () => {
    mocks.isMobile.value = true;
    const { baseElement } = renderWithClient(
      <UpdaterHarness action={makeAction()} suggestedStatus="rejected" />,
    );
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeFalsy();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });
});

// ─── BulkStatusDialog ─────────────────────────────────────────────

function BulkHarness({
  actions,
  targetStatus,
  onSettled,
  onOpenChange,
}: {
  actions: Action[];
  targetStatus: string;
  onSettled: (succeeded: number, total: number, failedIds: string[]) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <BulkStatusDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
      }}
      actions={actions}
      targetStatus={targetStatus}
      onSettled={onSettled}
    />
  );
}

describe('BulkStatusDialog', () => {
  const twoActions = [
    makeAction({ action_id: 'act-1' }),
    makeAction({ action_id: 'act-2', source_item_domain: 'provider' }),
  ];

  it('rejects a batch with one shared reason, toasts the total and closes', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    const onOpenChange = vi.fn((_open: boolean) => {});
    mocks.bulkMutateAsync.mockResolvedValue(successEnvelope(2));

    renderWithClient(
      <BulkHarness
        actions={twoActions}
        targetStatus="rejected"
        onSettled={onSettled}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Reject 2 requests?' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/reason \(optional, applied to all\)/i), 'Out of scope');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(mocks.bulkMutateAsync).toHaveBeenCalledWith({
        payloads: [
          { action_id: 'act-1', action_status: 'rejected', remarks: 'Out of scope' },
          { action_id: 'act-2', action_status: 'rejected', remarks: 'Out of scope' },
        ],
      }),
    );
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Updated 2 requests'));
    expect(onSettled).toHaveBeenCalledWith(2, 2, []);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reports a partial failure as a warning and hands back the failed ids for reselection', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    mocks.bulkMutateAsync.mockResolvedValue({
      results: [
        {
          index: 0,
          status: 'success',
          action_id: 'act-1',
          action_type: 'connect',
          action_status: 'rejected',
          update_count: 2,
        },
        {
          index: 1,
          status: 'error',
          error: 'ACTION_ALREADY_FINAL',
          message: 'already final',
        },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    });

    renderWithClient(
      <BulkHarness actions={twoActions} targetStatus="rejected" onSettled={onSettled} />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledWith('Updated 1 of 2'));
    expect(onSettled).toHaveBeenCalledWith(1, 2, ['act-2']);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts the failure when the whole bulk call throws', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    const onOpenChange = vi.fn((_open: boolean) => {});
    mocks.bulkMutateAsync.mockRejectedValue(new Error('gateway timeout'));

    renderWithClient(
      <BulkHarness
        actions={twoActions}
        targetStatus="rejected"
        onSettled={onSettled}
        onOpenChange={onOpenChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('Could not update requests', {
        description: 'gateway timeout',
      }),
    );
    expect(onSettled).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('bulk accept gates on one consent tick naming every distinct requester domain', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    mocks.bulkMutateAsync.mockResolvedValue(successEnvelope(2));

    renderWithClient(
      <BulkHarness actions={twoActions} targetStatus="accepted" onSettled={onSettled} />,
    );

    expect(screen.getByText('I share my contact with this seeker / provider.')).toBeInTheDocument();
    // The consent variant replaces the shared-reason box.
    expect(screen.queryByLabelText(/reason \(optional, applied to all\)/i)).not.toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    await waitFor(() =>
      expect(mocks.bulkMutateAsync).toHaveBeenCalledWith({
        payloads: [
          {
            action_id: 'act-1',
            action_status: 'accepted',
            consent: { acknowledged: true, version: 3, brand: null },
          },
          {
            action_id: 'act-2',
            action_status: 'accepted',
            consent: { acknowledged: true, version: 3, brand: null },
          },
        ],
      }),
    );
  });

  it('disables Confirm for an empty selection', () => {
    renderWithClient(<BulkHarness actions={[]} targetStatus="accepted" onSettled={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('blocks cancelling mid-submit while the bulk call is pending', () => {
    mocks.bulkPending.value = true;
    renderWithClient(
      <BulkHarness actions={twoActions} targetStatus="rejected" onSettled={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Updating...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('a GUARDIAN_OTP_REQUIRED row opens ONE guardian OTP dialog and clears the whole gated batch with a single code', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    mocks.bulkMutateAsync
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'error', error: 'GUARDIAN_OTP_REQUIRED', message: 'guardian needed' },
          { index: 1, status: 'error', error: 'GUARDIAN_OTP_REQUIRED', message: 'guardian needed' },
        ],
        summary: { total: 2, succeeded: 0, failed: 2 },
      })
      .mockResolvedValueOnce(successEnvelope(2));

    renderWithClient(
      <BulkHarness actions={twoActions} targetStatus="accepted" onSettled={onSettled} />,
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/guardian's confirmation via otp/i)).toBeInTheDocument();
    // The raw per-row failure is never surfaced as a partial-success warning.
    expect(mocks.toast.warning).not.toHaveBeenCalled();

    typeOtp('135790');

    await waitFor(() =>
      expect(mocks.bulkMutateAsync).toHaveBeenLastCalledWith({
        payloads: [
          {
            action_id: 'act-1',
            action_status: 'accepted',
            consent: { acknowledged: true, version: 3, brand: null },
          },
          {
            action_id: 'act-2',
            action_status: 'accepted',
            consent: { acknowledged: true, version: 3, brand: null },
          },
        ],
        guardianOtp: '135790',
      }),
    );
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Updated 2 requests'));
    expect(onSettled).toHaveBeenCalledWith(2, 2, []);
    await waitFor(() =>
      expect(screen.queryByText(/guardian's confirmation via otp/i)).not.toBeInTheDocument(),
    );
  });

  it('a mixed batch keeps the non-guardian failures selected after the guardian code succeeds', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn((_s: number, _t: number, _f: string[]) => {});
    mocks.bulkMutateAsync
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'error', error: 'GUARDIAN_OTP_REQUIRED', message: 'guardian needed' },
          { index: 1, status: 'error', error: 'ACTION_ALREADY_FINAL', message: 'already final' },
        ],
        summary: { total: 2, succeeded: 0, failed: 2 },
      })
      .mockResolvedValueOnce(successEnvelope(1));

    renderWithClient(
      <BulkHarness actions={twoActions} targetStatus="accepted" onSettled={onSettled} />,
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/guardian's confirmation via otp/i)).toBeInTheDocument();

    typeOtp('112233');

    // Only the gated row is replayed…
    await waitFor(() =>
      expect(mocks.bulkMutateAsync).toHaveBeenLastCalledWith({
        payloads: [
          {
            action_id: 'act-1',
            action_status: 'accepted',
            consent: { acknowledged: true, version: 3, brand: null },
          },
        ],
        guardianOtp: '112233',
      }),
    );
    // …and the other failure is reported back as still-needing-a-retry.
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalledWith('Updated 1 of 2'));
    expect(onSettled).toHaveBeenCalledWith(1, 2, ['act-2']);
  });

  it('shows an inline retry message when the guardian code itself is rejected', async () => {
    const user = userEvent.setup();
    mocks.bulkMutateAsync
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'error', error: 'GUARDIAN_OTP_REQUIRED', message: 'guardian needed' },
        ],
        summary: { total: 1, succeeded: 0, failed: 1 },
      })
      .mockResolvedValueOnce({
        results: [
          { index: 0, status: 'error', error: 'GUARDIAN_OTP_INVALID', message: 'bad code' },
        ],
        summary: { total: 1, succeeded: 0, failed: 1 },
      });

    renderWithClient(
      <BulkHarness
        actions={[makeAction({ action_id: 'act-1' })]}
        targetStatus="accepted"
        onSettled={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/guardian's confirmation via otp/i)).toBeInTheDocument();

    typeOtp('000000');

    expect(await screen.findByText(/incorrect code/i)).toBeInTheDocument();
    // Stays open so the ward can retry with a fresh code.
    expect(screen.getByText(/guardian's confirmation via otp/i)).toBeInTheDocument();
  });
});

// ─── ProfileCardModal ─────────────────────────────────────────────

const counterparty = {
  name: 'Bob Builder',
  itemId: 'tgt444555666',
  itemNetwork: 'yellow_dot',
  itemDomain: 'provider',
  itemType: 'profile_1.0',
};

function contactDetails(
  overrides: Partial<ContactDetailsResponse> = {},
  itemState: Record<string, unknown> = { name: 'Bob Builder', phone: '+91 99999 00000' },
): ContactDetailsResponse {
  return {
    action_id: 'act-1',
    action_status: 'accepted',
    revealed: true,
    other_actor: {
      item: {
        item_id: 'tgt444555666',
        item_network: 'yellow_dot',
        item_domain: 'provider',
        item_type: 'profile_1.0',
        item_instance_url: null,
        item_schema_url: null,
        item_state: itemState,
        item_locations: [],
        created_by: 'u-tgt',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    },
    ...overrides,
  };
}

function maskedItemsResponse(): FetchItemsResponse {
  return {
    meta: { total: 1, limit: 1, offset: 0 },
    items: [
      {
        item_id: 'tgt444555666',
        item_network: 'yellow_dot',
        item_domain: 'provider',
        item_type: 'profile_1.0',
        item_instance_url: null,
        item_schema_url: null,
        item_state: { name: 'Bob Builder', phone: '•••• masked' },
        item_locations: [],
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-01T10:00:00.000Z',
      },
    ],
  };
}

function renderProfileModal(actionStatus: string, open = true) {
  return renderWithClient(
    <ProfileCardModal
      open={open}
      onOpenChange={() => {}}
      actionId="act-1"
      actionStatus={actionStatus}
      counterparty={counterparty}
    />,
  );
}

describe('ProfileCardModal', () => {
  it('fetches nothing while closed', () => {
    renderProfileModal('accepted', false);
    expect(mocks.getActionContactDetails).not.toHaveBeenCalled();
    expect(screen.queryByText('Bob Builder')).not.toBeInTheDocument();
  });

  it('falls back to the masked public profile when the reveal returns PII_NOT_REVEALED', async () => {
    mocks.getActionContactDetails.mockRejectedValue(
      Object.assign(new Error('not revealed'), { code: 'PII_NOT_REVEALED' }),
    );
    mocks.fetchNetworkItems.mockResolvedValue(maskedItemsResponse());

    renderProfileModal('created');

    expect(
      await screen.findByText(
        'Public profile. Contact details are shared once the request is accepted.',
      ),
    ).toBeInTheDocument();
    expect(mocks.fetchNetworkItems).toHaveBeenCalled();
    expect(screen.getByText('•••• masked')).toBeInTheDocument();
  });

  it('shows the "paused / not active" note when a cross-instance reveal is unsupported', async () => {
    mocks.getActionContactDetails.mockRejectedValue(
      Object.assign(new Error('cross instance'), {
        code: 'CROSS_INSTANCE_REVEAL_NOT_SUPPORTED',
      }),
    );
    mocks.fetchNetworkItems.mockResolvedValue(maskedItemsResponse());

    renderProfileModal('accepted');

    expect(await screen.findByText(/currently paused or not active/i)).toBeInTheDocument();
  });

  it('shows the self-blocked note when the viewer’s own profile is paused', async () => {
    mocks.getActionContactDetails.mockResolvedValue(
      contactDetails({ revealed: false, reveal_blocked_reason: 'self' }),
    );

    renderProfileModal('accepted');

    expect(await screen.findByText(/your profile is currently paused/i)).toBeInTheDocument();
  });

  it('shows only the retired notice for a retired counterparty and renders no profile card', async () => {
    mocks.getActionContactDetails.mockResolvedValue(
      contactDetails({ revealed: false, reveal_blocked_reason: 'retired' }),
    );

    renderProfileModal('accepted');

    expect(await screen.findByText(/this profile is retired/i)).toBeInTheDocument();
    // The leftover non-PII fields must NOT be rendered (#347).
    expect(screen.queryByText('+91 99999 00000')).not.toBeInTheDocument();
  });

  it('surfaces a real reveal failure as a translated error instead of masked copy', async () => {
    mocks.getActionContactDetails.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'NOT_ACTION_PARTICIPANT' }),
    );

    renderProfileModal('accepted');

    expect(await screen.findByText("Couldn't load contact details")).toBeInTheDocument();
    expect(screen.getByText("You don't have access to these details.")).toBeInTheDocument();
    expect(mocks.fetchNetworkItems).not.toHaveBeenCalled();
  });

  it('errors when the masked fallback finds no live profile', async () => {
    mocks.getActionContactDetails.mockRejectedValue(
      Object.assign(new Error('not revealed'), { code: 'PII_NOT_REVEALED' }),
    );
    mocks.fetchNetworkItems.mockResolvedValue({
      meta: { total: 0, limit: 1, offset: 0 },
      items: [],
    });

    renderProfileModal('created');

    expect(await screen.findByText("Couldn't load contact details")).toBeInTheDocument();
    expect(screen.getByText('Something went wrong; please try again.')).toBeInTheDocument();
  });

  it('dumps the raw item state when the network config has no schema for the domain', async () => {
    mocks.networkConfig.value = makeNetworkConfig({ domains: [] });
    mocks.getActionContactDetails.mockResolvedValue(contactDetails());

    renderProfileModal('accepted');

    expect(await screen.findByText(/"phone": "\+91 99999 00000"/)).toBeInTheDocument();
  });
});

// ─── ActionModal ──────────────────────────────────────────────────

function makeActionSchema(overrides: Partial<DotActionSchema> = {}): DotActionSchema {
  return {
    action_type: 'connect',
    from_domain: 'seeker',
    to_domain: 'provider',
    requirement_schema: undefined as unknown as RJSFSchema,
    ...overrides,
  };
}

describe('ActionModal', () => {
  it('submits straight away when the interaction needs no requirement form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_formData: Record<string, unknown>) => {});
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText('No additional information required.')).toBeInTheDocument();
    // No consent required → the generic subtitle is shown.
    expect(
      screen.getByText('Share details so the other party can review your request.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('renders the requirement form and wires Confirm to submit it', () => {
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema({
          requirement_schema: {
            type: 'object',
            properties: { note: { type: 'string', title: 'Your note' } },
          } as RJSFSchema,
        })}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('Your note')).toBeInTheDocument();
    expect(screen.queryByText('No additional information required.')).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveAttribute('type', 'submit');
    expect(confirm).toHaveAttribute('form', 'action-requirement-form');
  });

  it('gates Confirm behind the initiate consent and attaches the consent sentinel to the payload', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_formData: Record<string, unknown>) => {});
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema({ reveals_pii_on_status: ['accepted'] })}
        onSubmit={onSubmit}
      />,
    );

    // Initiate stage → the noun is the TARGET domain.
    expect(screen.getByText('I share my details with this provider.')).toBeInTheDocument();
    // The consent card provides the framing, so the generic subtitle is suppressed.
    expect(
      screen.queryByText('Share details so the other party can review your request.'),
    ).not.toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(confirm).not.toBeDisabled();
    // Ticking alone must not submit for an adult.
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith({
      __consent: { acknowledged: true, version: 2, brand: null },
    });
  });

  it('for a minor the consent tick IS the trigger — no separate Confirm click', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_formData: Record<string, unknown>) => {});
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema({ reveals_pii_on_status: ['accepted'] })}
        onSubmit={onSubmit}
        minor
      />,
    );

    await user.click(screen.getByRole('checkbox'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      __consent: { acknowledged: true, version: 2, brand: null },
    });
  });

  it('shows the working state and disables both buttons while loading', () => {
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema()}
        onSubmit={vi.fn()}
        loading
      />,
    );
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('Cancel closes the modal', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn((_open: boolean) => {});
    renderWithClient(
      <ActionModal
        open
        onOpenChange={onOpenChange}
        actionSchema={makeActionSchema()}
        onSubmit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('titles the modal from an unknown action type and falls back to a generic subtitle', () => {
    renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema({ action_type: 'mentor' })}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Mentor' })).toBeInTheDocument();
    expect(screen.getByText('Mentor request')).toBeInTheDocument();
  });

  it('renders as a drawer on mobile', () => {
    mocks.isMobile.value = true;
    const { baseElement } = renderWithClient(
      <ActionModal
        open
        onOpenChange={() => {}}
        actionSchema={makeActionSchema()}
        onSubmit={vi.fn()}
      />,
    );
    expect(baseElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
    expect(screen.getByText('No additional information required.')).toBeInTheDocument();
  });
});
