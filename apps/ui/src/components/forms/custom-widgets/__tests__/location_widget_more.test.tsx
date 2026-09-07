/**
 * Remaining branches of two share/form surfaces:
 *
 *  - `LocationAutocompleteWidget` — everything past the first keystroke: the
 *    debounced geocode, the suggestion dropdown (including the flip-upward
 *    placement), picking a suggestion (`ResolvedPlace` reporting), the
 *    stale-response guard after the field is cleared, and the blur/refocus
 *    dance. The sibling `location-autocomplete-widget.test.tsx` covers the
 *    required-validity `onChange` contract and is deliberately untouched.
 *  - `PublicProfilePage` — the action row's submit path (consent-sentinel
 *    stripping, instance routing, guardian OTP pass-through), the U18
 *    guardian-confirm gate, the open-action lockout, the match-score modal
 *    wiring, active-profile switching, and the schema-driven details grid's
 *    empty-row/odd-count handling.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema, WidgetProps } from '@rjsf/utils';
import type { GeoSuggestion } from '@/lib/geo/types';
import type { Item } from '@/lib/item-api';
import type { DotActionSchema, DotNetworkSchema } from '@/engine/types';
import type { PerformActionPayload, PerformActionResponse } from '@/lib/action-api';
import type { U18StatusResponse } from '@/lib/consent-api';

// ── Module mocks ────────────────────────────────────────────────────────────
// Every factory below only *references* an outer binding from inside the
// function it returns (called at test time), never during factory evaluation —
// the pattern used by the sibling page tests.

// ── geo ─────────────────────────────────────────────────────────────────────
const geoState: { results: GeoSuggestion[]; delayMs: number } = { results: [], delayMs: 0 };
const suggestCalls: string[] = [];
vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({
    suggest: async (query: string, _signal?: AbortSignal): Promise<GeoSuggestion[]> => {
      suggestCalls.push(query);
      if (geoState.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, geoState.delayMs));
      }
      return geoState.results;
    },
  }),
}));

// ── page deps ───────────────────────────────────────────────────────────────
const toastCalls: Array<[string, string]> = [];
vi.mock('sonner', () => ({
  toast: {
    success: (m: unknown) => void toastCalls.push(['success', String(m)]),
    error: (m: unknown) => void toastCalls.push(['error', String(m)]),
    warning: (m: unknown) => void toastCalls.push(['warning', String(m)]),
    info: (m: unknown) => void toastCalls.push(['info', String(m)]),
  },
}));

const performAction = vi.fn(
  async (
    _payload: PerformActionPayload,
    _sourceInstanceUrl?: string,
    _guardianOtp?: string,
  ): Promise<PerformActionResponse> => ({
    action_id: 'act-new',
    action_type: 'connect',
    action_status: 'created',
    update_count: 0,
    source_item_id: 'src',
    target_item_id: 'tgt',
  }),
);
vi.mock('@/lib/action-api', () => ({
  ACTION_CONSENT_SENTINEL: '__consent',
  performAction: (
    payload: PerformActionPayload,
    sourceInstanceUrl?: string,
    guardianOtp?: string,
  ) => performAction(payload, sourceInstanceUrl, guardianOtp),
}));

const getU18Status = vi.fn(
  async (_network: string): Promise<U18StatusResponse> => ({
    hasBirthData: true,
    isMinor: false,
    guardianVerified: false,
  }),
);
vi.mock('@/lib/consent-api', () => ({
  getU18Status: (network: string) => getU18Status(network),
}));

const useItemDetail = vi.fn();
vi.mock('@/hooks/use-item-detail', () => ({
  useItemDetail: (...a: unknown[]) => useItemDetail(...a),
}));

const useResolvedNetwork = vi.fn();
vi.mock('@/hooks/use-network-config', () => ({
  useResolvedNetwork: (...a: unknown[]) => useResolvedNetwork(...a),
  useNetworkConfig: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const useAuth = vi.fn();
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => useAuth() }));

const useMyItems = vi.fn();
vi.mock('@/hooks/use-my-items', () => ({ useMyItems: (...a: unknown[]) => useMyItems(...a) }));

const useActionsQuery = vi.fn();
vi.mock('@/hooks/use-actions', () => ({
  useActions: (...a: unknown[]) => useActionsQuery(...a),
}));

// The sidebar is heavy (its own data fetching); stub it down to the two
// callbacks the page owns so their effects are assertable.
vi.mock('@/components/layout/sidebar', () => ({
  AppSidebar: ({
    onActiveProfileChange,
    onProfilesChanged,
  }: {
    onActiveProfileChange: (id: string) => void;
    onProfilesChanged: () => void;
  }) => (
    <div data-testid="app-sidebar">
      <button type="button" onClick={() => onActiveProfileChange(SECOND_PROFILE_ID)}>
        pick-second-profile
      </button>
      <button type="button" onClick={onProfilesChanged}>
        profiles-changed
      </button>
    </div>
  ),
}));
vi.mock('@/components/layout/portal-header', () => ({
  PortalHeader: () => <div data-testid="portal-header" />,
}));
vi.mock('@/components/auth/user-menu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }));
vi.mock('@/components/layout/theme-mode-toggle', () => ({
  ThemeModeToggle: () => <div data-testid="theme-toggle" />,
}));

// Render-prop stub that also exposes the page's `onActionSubmit` as two
// clickable submits (one carrying an acknowledged consent + guardian OTP, one
// carrying an UNacknowledged consent and no OTP) plus the resolved
// guardian-confirm flag, so the page's submit contract is exercised directly.
const submitOutcomes: string[] = [];
const triggeredActions: string[] = [];
vi.mock('@/components/actions/action-handler', () => ({
  ActionHandler: ({
    children,
    onActionSubmit,
    guardianConfirmRequired,
  }: {
    children: (
      trigger: (actionType: string, schema: DotActionSchema, targetItemId: string) => void,
    ) => React.ReactNode;
    onActionSubmit: (
      actionType: string,
      actionSchema: DotActionSchema,
      formData: Record<string, unknown>,
      targetItemId: string,
      guardianOtp?: string,
    ) => Promise<void>;
    guardianConfirmRequired?: boolean;
  }) => {
    const schema: DotActionSchema = {
      action_type: 'connect',
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: { type: 'object' },
    };
    const settle = (p: Promise<void>) =>
      void p.then(
        () => void submitOutcomes.push('resolved'),
        (e: unknown) =>
          void submitOutcomes.push(`rejected:${e instanceof Error ? e.message : String(e)}`),
      );
    return (
      <>
        <span data-testid="guardian-confirm-required">{String(guardianConfirmRequired === true)}</span>
        <button
          type="button"
          onClick={() =>
            settle(
              onActionSubmit(
                'connect',
                schema,
                {
                  __consent: { acknowledged: true, version: 4, brand: 'upsdm' },
                  message: 'Hello',
                },
                'ignored-target-arg',
                '112233',
              ),
            )
          }
        >
          submit-with-consent
        </button>
        <button
          type="button"
          onClick={() =>
            settle(
              onActionSubmit(
                'apply',
                schema,
                { __consent: { acknowledged: false, version: 4 }, message: 'Hi' },
                'ignored-target-arg',
              ),
            )
          }
        >
          submit-unacknowledged
        </button>
        {children((actionType, _schema, targetItemId) =>
          void triggeredActions.push(`${actionType}:${targetItemId}`),
        )}
      </>
    );
  },
}));

vi.mock('@/components/cards/action-button', () => ({
  ActionButton: ({
    actionType,
    actionSchema,
    disabled,
    disabledReason,
    onAction,
  }: {
    actionType: string;
    actionSchema: DotActionSchema;
    disabled?: boolean;
    disabledReason?: string;
    onAction: (actionType: string, schema: DotActionSchema) => void;
  }) => (
    <button
      type="button"
      data-testid="action-button"
      disabled={disabled}
      title={disabledReason}
      onClick={() => onAction(actionType, actionSchema)}
    >
      {actionType}
    </button>
  ),
}));

const matchScoreCalls = { calculate: 0, recalculate: 0 };
vi.mock('@/hooks/use-match-score', () => ({
  useMatchScore: () => ({
    score: null,
    isLoading: false,
    error: null,
    cached: false,
    calculate: async () => void (matchScoreCalls.calculate += 1),
    recalculate: async () => void (matchScoreCalls.recalculate += 1),
    clearCache: () => {},
  }),
}));

vi.mock('@/components/match-score', () => ({
  MatchScoreButton: ({
    localItem,
    networkItem,
    onCalculate,
    onViewDetails,
  }: {
    localItem: Item | null;
    networkItem: Item;
    onCalculate: () => void;
    onViewDetails: () => void;
  }) => (
    <>
      <span data-testid="score-pair">{`${localItem?.item_id ?? 'none'}->${networkItem.item_id}`}</span>
      <button type="button" onClick={onCalculate}>
        calc-score
      </button>
      <button type="button" onClick={onViewDetails}>
        view-score
      </button>
    </>
  ),
  MatchScoreModal: ({
    isOpen,
    onClose,
    onRecalculate,
    localItemName,
    networkItemName,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onRecalculate: () => void;
    localItemName: string;
    networkItemName: string;
  }) =>
    isOpen ? (
      <div data-testid="match-modal">
        <span data-testid="match-modal-names">{`${localItemName} vs ${networkItemName}`}</span>
        <button type="button" onClick={onClose}>
          close-score
        </button>
        <button type="button" onClick={onRecalculate}>
          recalc-score
        </button>
      </div>
    ) : null,
}));

// Imported after the mocks so both subjects pick them up.
import { LocationAutocompleteWidget } from '@/components/forms/custom-widgets/location-autocomplete-widget';
import type { ResolvedPlace } from '@/components/forms/custom-widgets/location-autocomplete-widget';
import { PublicProfilePage } from '@/pages/public-profile-page';
import { apiConfig } from '@/lib/api-config';
import { queryKeys } from '@/lib/query-keys';

// ── LocationAutocompleteWidget ──────────────────────────────────────────────

const BENGALURU: GeoSuggestion = {
  label: 'Bengaluru, Karnataka, India',
  lat: 12.9716,
  lng: 77.5946,
  components: { city: 'Bengaluru', state: 'Karnataka', country: 'India' },
};
const BENGALURU_SOUTH: GeoSuggestion = {
  label: 'Bengaluru South, Karnataka, India',
  lat: 12.9,
  lng: 77.55,
};

function renderWidget(
  overrides: Partial<WidgetProps> = {},
  formContext: { onLocationResolved?: (place: ResolvedPlace | null) => void } = {},
) {
  const onChange = vi.fn((_next: string | undefined) => {});
  const props = {
    id: 'root_location',
    value: '',
    onChange,
    schema: {},
    options: { isPrimaryLocation: true },
    label: 'Location',
    name: 'location',
    disabled: false,
    readonly: false,
    required: true,
    formContext,
    ...overrides,
  } as unknown as WidgetProps;
  const view = render(<LocationAutocompleteWidget {...props} />);
  return { onChange, ...view };
}

describe('LocationAutocompleteWidget — suggestions, selection, stale responses', () => {
  beforeEach(() => {
    suggestCalls.length = 0;
    geoState.results = [];
    geoState.delayMs = 0;
    vi.clearAllMocks();
  });

  it('opens the dropdown with the geocoded suggestions once the debounce fires', async () => {
    geoState.results = [BENGALURU, BENGALURU_SOUTH];
    renderWidget();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Beng' } });

    expect(await screen.findByText('Bengaluru, Karnataka, India')).toBeInTheDocument();
    expect(screen.getByText('Bengaluru South, Karnataka, India')).toBeInTheDocument();
    // Debounced: one keystroke → one geocode, for the typed query.
    expect(suggestCalls).toEqual(['Beng']);
    // Room below the input → the list hangs downward.
    expect(screen.getByRole('listbox').className).toContain('top-full');
  });

  it('keeps the dropdown shut when the geocoder finds nothing', async () => {
    geoState.results = [];
    renderWidget();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Nowhere at all' } });

    await waitFor(() => expect(suggestCalls).toEqual(['Nowhere at all']));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reports the picked place (point + components) and closes the list', async () => {
    geoState.results = [BENGALURU, BENGALURU_SOUTH];
    const onLocationResolved = vi.fn((_place: ResolvedPlace | null) => {});
    const { onChange } = renderWidget({}, { onLocationResolved });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Beng' } });
    const option = await screen.findByText('Bengaluru, Karnataka, India');

    // Typing first drops any previously resolved point for the primary field.
    expect(onLocationResolved).toHaveBeenCalledWith(null);

    fireEvent.mouseDown(option);

    expect(onChange).toHaveBeenLastCalledWith('Bengaluru, Karnataka, India');
    expect(screen.getByRole('combobox')).toHaveValue('Bengaluru, Karnataka, India');
    expect(onLocationResolved).toHaveBeenLastCalledWith({
      lat: 12.9716,
      lng: 77.5946,
      components: { city: 'Bengaluru', state: 'Karnataka', country: 'India' },
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    // Selecting must not kick off another geocode (which would re-open the list).
    expect(suggestCalls).toEqual(['Beng']);
  });

  it('never reports a resolved place for a non-primary location field', async () => {
    geoState.results = [BENGALURU];
    const onLocationResolved = vi.fn((_place: ResolvedPlace | null) => {});
    const { onChange } = renderWidget({ options: {} }, { onLocationResolved });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Beng' } });
    fireEvent.mouseDown(await screen.findByText('Bengaluru, Karnataka, India'));

    expect(onChange).toHaveBeenLastCalledWith('Bengaluru, Karnataka, India');
    // Only the primary field feeds item_locations.
    expect(onLocationResolved).not.toHaveBeenCalled();
  });

  it('flips the list upward when the input sits near the bottom of the viewport', async () => {
    geoState.results = [BENGALURU];
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ bottom: window.innerHeight - 40, top: 0, left: 0, right: 0, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    try {
      renderWidget();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Beng' } });
      await screen.findByText('Bengaluru, Karnataka, India');
      expect(screen.getByRole('listbox').className).toContain('bottom-full');
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('drops an in-flight geocode when the field is cleared, so it cannot re-open the list', async () => {
    geoState.results = [BENGALURU];
    geoState.delayMs = 150;
    const { onChange } = renderWidget();
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'Bengaluru' } });
    // Wait until the debounce has fired and the (slow) geocode is in flight.
    await waitFor(() => expect(suggestCalls).toEqual(['Bengaluru']));
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    // Let the aborted request settle; its results must be discarded.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('closes the list on blur and re-opens the same suggestions on refocus', async () => {
    geoState.results = [BENGALURU];
    renderWidget();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Beng' } });
    await screen.findByText('Bengaluru, Karnataka, India');

    fireEvent.blur(input);
    // The close is delayed (so a suggestion mousedown still registers).
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('Bengaluru, Karnataka, India')).toBeInTheDocument();
    // Refocusing reuses the cached suggestions — no second geocode.
    expect(suggestCalls).toEqual(['Beng']);
  });

  it('shows the field errors and blocks input when read-only', () => {
    const { container } = renderWidget({ readonly: true, rawErrors: ['Location is required'] });
    expect(screen.getByText('Location is required')).toBeInTheDocument();
    const input = container.querySelector('input');
    expect(input).toBeDisabled();
    expect(input?.className).toContain('border-destructive');
  });
});

// ── PublicProfilePage ───────────────────────────────────────────────────────

const VIEWED_ID = '9b545eb9-5406-4bce-bc71-0cdac4b63bd0';
const SEEKER_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const REMOTE_INSTANCE = 'https://remote.example.org';

const seekerSchema: RJSFSchema = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
};

const providerSchema: RJSFSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    headline: { type: 'string', title: 'Headline' },
    city: { type: 'string', title: 'City' },
    bio: { type: 'string', title: 'Bio' },
    tagline: { type: 'string', title: 'Tagline' },
    sector: { type: 'string', title: 'Sector' },
  },
};

/** Seeker → provider `connect`; the seeker domain routes minors via a guardian. */
function makeNetwork(over: Partial<DotNetworkSchema> = {}): DotNetworkSchema {
  return {
    id: 'blue_dot',
    display_name: 'Blue Dot',
    description: 'seekers and providers',
    schema_standard: 'dpg/1.0',
    domains: [
      {
        id: 'seeker',
        description: 'seekers',
        guardian_consent_required: true,
        card: { title_field: 'name' },
        item_schemas: { 'profile_1.0': seekerSchema },
      },
      {
        id: 'provider',
        description: 'providers',
        card: {
          title_field: 'name',
          subtitle_field: 'headline',
          // `bio` is declared but absent from the item → an empty row that must
          // be dropped rather than rendered as a blank cell.
          default_fields: ['city', 'bio', 'tagline', 'sector'],
          extra_fields: ['bio'],
        },
        item_schemas: { 'profile_1.0': providerSchema },
      },
    ],
    actions: {
      connect: {
        description: 'connect',
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: { type: 'object', properties: {} },
          },
        ],
      },
    },
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    item_id: VIEWED_ID,
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'profile_1.0',
    item_instance_url: REMOTE_INSTANCE,
    item_schema_url: null,
    item_state: {
      name: 'Acme Co',
      headline: 'Hiring now',
      city: 'Pune',
      tagline: 'We build things',
      sector: 'Retail',
    },
    item_locations: [],
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    lifecycle_status: 'live',
    ...over,
  };
}

function makeOwnProfile(over: Partial<Item> = {}): Item {
  return {
    item_id: SEEKER_ID,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    // A localhost instance URL is ignored in favour of the current API base.
    item_instance_url: 'http://localhost:2742',
    item_schema_url: null,
    item_state: { name: 'Asha' },
    item_locations: [],
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    lifecycle_status: 'live',
    ...over,
  };
}

const VIEWED_PATH = `/public/blue_dot/provider/profile_1.0/${VIEWED_ID}?network=blue_dot`;

function renderProfile(path: string = VIEWED_PATH, client?: QueryClient) {
  const queryClient = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<div>map view</div>} />
          <Route
            path="/public/:network/:domain/:itemType/:itemId"
            element={<PublicProfilePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

describe('PublicProfilePage — action submit, U18 gate, match score, details grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    toastCalls.length = 0;
    submitOutcomes.length = 0;
    triggeredActions.length = 0;
    matchScoreCalls.calculate = 0;
    matchScoreCalls.recalculate = 0;
    useResolvedNetwork.mockReturnValue({ data: makeNetwork(), isLoading: false, isError: false });
    useItemDetail.mockReturnValue({ item: makeItem(), isLoading: false, isError: false });
    useAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: { id: 'u1', name: 'Asha' },
    });
    useMyItems.mockReturnValue({ data: [makeOwnProfile()], isLoading: false, isFetched: true });
    useActionsQuery.mockReturnValue({ data: { actions: [], meta: { total: 0 } } });
    getU18Status.mockResolvedValue({ hasBirthData: true, isMinor: false, guardianVerified: false });
  });

  it('sends the action from the active profile: sentinel stripped, consent + OTP forwarded, instances routed', async () => {
    const { queryClient } = renderProfile();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByRole('button', { name: 'submit-with-consent' }));
    await waitFor(() => expect(performAction).toHaveBeenCalledTimes(1));

    const [payload, sourceInstanceUrl, guardianOtp] = performAction.mock.calls[0];
    expect(payload.action_type).toBe('connect');
    expect(payload.source_item).toEqual({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_id: SEEKER_ID,
    });
    expect(payload.target_item).toEqual({
      item_network: 'blue_dot',
      item_domain: 'provider',
      item_type: 'profile_1.0',
      item_id: VIEWED_ID,
      // The viewed item's own (non-localhost) instance is honoured.
      item_instance_url: REMOTE_INSTANCE,
    });
    // The consent sentinel must never reach the server inside the snapshot.
    expect(payload.requirements_snapshot).toEqual({ message: 'Hello' });
    expect(payload.consent).toEqual({ acknowledged: true, version: 4, brand: 'upsdm' });
    // The action is posted to the SOURCE instance; the source's localhost URL is
    // replaced by the current API base.
    expect(sourceInstanceUrl).toBe(apiConfig.getUrl());
    expect(guardianOtp).toBe('112233');

    await waitFor(() => expect(toastCalls).toContainEqual(['success', 'Connect request sent']));
    expect(submitOutcomes).toEqual(['resolved']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.actions.all });
  });

  it('omits consent entirely when the checkbox was not acknowledged', async () => {
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'submit-unacknowledged' }));
    await waitFor(() => expect(performAction).toHaveBeenCalledTimes(1));

    const [payload, , guardianOtp] = performAction.mock.calls[0];
    expect(payload.action_type).toBe('apply');
    expect('consent' in payload).toBe(false);
    expect(payload.requirements_snapshot).toEqual({ message: 'Hi' });
    expect(guardianOtp).toBeUndefined();
    await waitFor(() => expect(toastCalls).toContainEqual(['success', 'Apply request sent']));
  });

  it('refuses to send and asks for sign-in when the session has no user', async () => {
    useAuth.mockReturnValue({ isAuthenticated: true, isLoading: false, user: null });
    renderProfile();

    // No user → the viewer's U18 status is never fetched.
    expect(getU18Status).not.toHaveBeenCalled();
    expect(screen.getByTestId('guardian-confirm-required')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'submit-with-consent' }));
    await waitFor(() => expect(submitOutcomes).toEqual(['rejected:No user']));
    expect(performAction).not.toHaveBeenCalled();
    expect(toastCalls).toContainEqual(['error', 'Sign in']);
  });

  it('surfaces the failure toast when the action request fails', async () => {
    performAction.mockRejectedValueOnce(new Error('boom'));
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'submit-with-consent' }));

    await waitFor(() => expect(submitOutcomes).toEqual(['rejected:boom']));
    // The page does not swallow the failure into a success toast.
    expect(toastCalls).not.toContainEqual(['success', 'Connect request sent']);
  });

  it('requires guardian confirmation for a minor on a guardian-consent domain', async () => {
    getU18Status.mockResolvedValue({ hasBirthData: true, isMinor: true, guardianVerified: false });
    renderProfile();
    await waitFor(() =>
      expect(screen.getByTestId('guardian-confirm-required')).toHaveTextContent('true'),
    );
    expect(getU18Status).toHaveBeenCalledWith('blue_dot');
  });

  it('falls back to the adult path when the U18 status lookup fails', async () => {
    getU18Status.mockRejectedValue(new Error('offline'));
    renderProfile();
    await waitFor(() => expect(getU18Status).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('guardian-confirm-required')).toHaveTextContent('false');
  });

  it('disables the action when the active profile already has an open action with the viewed item', () => {
    useActionsQuery.mockReturnValue({
      data: {
        actions: [
          { action_status: 'created', source_item_id: SEEKER_ID, target_item_id: VIEWED_ID },
        ],
        meta: { total: 1 },
      },
    });
    renderProfile();
    const button = screen.getByTestId('action-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'A request is already open with this profile.');
  });

  it('keeps the action enabled once the open action reaches a terminal status, and routes the click to the viewed item', () => {
    useActionsQuery.mockReturnValue({
      data: {
        actions: [
          { action_status: 'rejected', source_item_id: SEEKER_ID, target_item_id: VIEWED_ID },
        ],
        meta: { total: 1 },
      },
    });
    renderProfile();
    const button = screen.getByTestId('action-button');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(triggeredActions).toEqual([`connect:${VIEWED_ID}`]);
  });

  it('opens, closes and re-opens the match-score modal for the viewed pair', async () => {
    renderProfile();
    expect(screen.getByTestId('score-pair')).toHaveTextContent(`${SEEKER_ID}->${VIEWED_ID}`);
    expect(screen.queryByTestId('match-modal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calc-score' }));
    expect(screen.getByTestId('match-modal')).toBeInTheDocument();
    // Names come from the two items, not from hardcoded copy.
    expect(screen.getByTestId('match-modal-names')).toHaveTextContent('Asha vs Acme Co');
    await waitFor(() => expect(matchScoreCalls.calculate).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'recalc-score' }));
    await waitFor(() => expect(matchScoreCalls.recalculate).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'close-score' }));
    expect(screen.queryByTestId('match-modal')).toBeNull();

    // Viewing details re-opens without recomputing.
    fireEvent.click(screen.getByRole('button', { name: 'view-score' }));
    expect(screen.getByTestId('match-modal')).toBeInTheDocument();
    expect(matchScoreCalls.calculate).toBe(1);
  });

  it('labels an unnamed active profile generically in the match-score modal', () => {
    useMyItems.mockReturnValue({
      data: [makeOwnProfile({ item_state: {} })],
      isLoading: false,
      isFetched: true,
    });
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'calc-score' }));
    expect(screen.getByTestId('match-modal-names')).toHaveTextContent('Your Profile vs Acme Co');
  });

  it('re-anchors the action row when the sidebar switches the active profile', async () => {
    useMyItems.mockReturnValue({
      data: [makeOwnProfile(), makeOwnProfile({ item_id: SECOND_PROFILE_ID, item_state: { name: 'Ravi' } })],
      isLoading: false,
      isFetched: true,
    });
    renderProfile();
    expect(screen.getByTestId('score-pair')).toHaveTextContent(`${SEEKER_ID}->${VIEWED_ID}`);

    fireEvent.click(screen.getByRole('button', { name: 'pick-second-profile' }));
    await waitFor(() =>
      expect(screen.getByTestId('score-pair')).toHaveTextContent(`${SECOND_PROFILE_ID}->${VIEWED_ID}`),
    );
    // The choice is persisted per network for the next visit.
    expect(localStorage.getItem('activeProfileId:blue_dot')).toBe(SECOND_PROFILE_ID);

    fireEvent.click(screen.getByRole('button', { name: 'submit-with-consent' }));
    await waitFor(() => expect(performAction).toHaveBeenCalledTimes(1));
    expect(performAction.mock.calls[0][0].source_item.item_id).toBe(SECOND_PROFILE_ID);
  });

  it('refreshes the owned profiles when the sidebar reports a change', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderProfile(VIEWED_PATH, client);

    fireEvent.click(screen.getByRole('button', { name: 'profiles-changed' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.myItems('blue_dot') });
  });

  it('drops empty configured rows and closes the details grid on an odd row count', () => {
    renderProfile();
    // Subtitle comes from the card config's subtitle_field.
    expect(screen.getByText('Hiring now')).toBeInTheDocument();
    for (const label of ['City', 'Tagline', 'Sector']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // `bio` is declared in default_fields/extra_fields but empty on this item.
    expect(screen.queryByText('Bio')).toBeNull();

    const grid = screen.getByText('City').closest('.grid');
    expect(grid).not.toBeNull();
    // 3 rows + one presentational filler cell so the borders close cleanly.
    expect(grid?.children).toHaveLength(4);
    expect(grid?.lastElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
