import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';

// ── Module mocks ───────────────────────────────────────────────────────────
// Only the data/registry edges are mocked; every component under test renders
// for real (real Radix dialogs, real sonner Toaster, real cards) so the
// assertions are on user-visible DOM rather than call bookkeeping.
// NB: mock factories are hoisted above the imports, so they must not close over
// any outer binding — the bare `vi.fn()`s are wired up per test via
// `vi.mocked(...)`.
vi.mock('@/contexts/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/use-actions', () => ({ usePendingActionsCount: vi.fn() }));
vi.mock('@/lib/match-score-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/match-score-api')>(
    '@/lib/match-score-api',
  );
  return { ...actual, calculateMatchScore: vi.fn() };
});
vi.mock('@/engine/wallet/wallet-registry', () => ({
  getRegisteredWalletProviders: vi.fn(),
  getConfiguredWalletProviders: vi.fn(),
  getWalletProvider: vi.fn(),
}));
vi.mock('@/lib/consent-api', () => ({
  submitU18Dob: vi.fn(),
  submitGuardian: vi.fn(),
  verifyGuardian: vi.fn(),
}));
// The guardian form only opens its T&C / privacy popup when a consent doc is
// configured; a null config keeps these tests off the consent-gate path (and
// away from needing a QueryClient).
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
}));

import { useAuth } from '@/contexts/auth-context';
import { usePendingActionsCount } from '@/hooks/use-actions';
import { calculateMatchScore } from '@/lib/match-score-api';
import {
  getConfiguredWalletProviders,
  getRegisteredWalletProviders,
  getWalletProvider,
} from '@/engine/wallet/wallet-registry';
import { submitGuardian } from '@/lib/consent-api';
import type { User } from '@/lib/auth-api';
import type { Item } from '@/lib/item-api';
import type { MapMarker } from '@/engine/types';
import type {
  WalletImportContext,
  WalletImportProviderProps,
  WalletImportResult,
  WalletProvider,
} from '@/engine/wallet/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UserMenu } from '@/components/auth/user-menu';
import { MarkerPopupCard, getPrecisionInfo } from '@/components/map/marker-popup-card';
import { MatchScoreCard } from '@/components/match-score/match-score-card';
import { WalletImportModal } from '@/components/wallet/wallet-import-modal';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';

// ── Fixtures ───────────────────────────────────────────────────────────────

const ada: User = {
  id: 'u-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  emailVerified: true,
  phoneNumber: '+919000000000',
  phoneNumberVerified: true,
  image: '',
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** A full auth-context value; only `user` and `signOut` matter to these tests. */
function authValue(
  user: User | null,
  signOut: () => Promise<void> = async () => {},
): ReturnType<typeof useAuth> {
  return {
    user,
    isLoading: false,
    isAuthenticated: !!user,
    checkUser: async () => false,
    requestOtp: async () => {},
    verifyOtp: async () => {},
    signOut,
    isKeycloakLogin: false,
    startKeycloakLogin: async () => {},
    completeKeycloakLogin: async () => {},
  };
}

const itemFixture = (id: string, state: Record<string, unknown> = { name: 'Dest' }): Item => ({
  item_id: id,
  item_network: 'blue_dot',
  item_domain: 'provider',
  item_type: 'profile_1.0',
  item_instance_url: null,
  item_schema_url: null,
  item_state: state,
  item_locations: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const markerFixture = (overrides: Partial<MapMarker> = {}): MapMarker => ({
  id: 'dest-1',
  lat: 12.9,
  lng: 77.6,
  label: 'Asha Tutors',
  data: { name: 'Asha Tutors' },
  precision: 'exact',
  domain: 'service_provider',
  ...overrides,
});

const nameSchema: RJSFSchema = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): a queued `mockResolvedValueOnce` from a
  // failing/short-circuited test must not leak into the next one.
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(useAuth).mockReturnValue(authValue(ada));
  setPendingCount(0);
});

function setPendingCount(count: number | undefined) {
  vi.mocked(usePendingActionsCount).mockReturnValue({
    data: count,
  } as unknown as ReturnType<typeof usePendingActionsCount>);
}

// ── UserMenu ───────────────────────────────────────────────────────────────

function PathProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderUserMenu() {
  // UserMenu mounts SupportDialog, which reads its attachment limits through
  // React Query (#551) — hence the provider even though nothing here fetches.
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <Toaster />
        <TooltipProvider>
          <UserMenu />
        </TooltipProvider>
        <PathProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openUserMenu() {
  const user = userEvent.setup();
  renderUserMenu();
  // The avatar trigger is the only control on screen while the menu is closed
  // (its accessible name varies with the pending-actions count).
  await user.click(screen.getByRole('button'));
  return user;
}

describe('UserMenu', () => {
  it('renders nothing at all for a signed-out visitor', () => {
    vi.mocked(useAuth).mockReturnValue(authValue(null));
    renderUserMenu();

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the profile photo instead of initials and announces the pending count', () => {
    vi.mocked(useAuth).mockReturnValue(
      authValue({ ...ada, image: 'https://cdn.example.com/ada.png' }),
    );
    setPendingCount(4);
    renderUserMenu();

    const trigger = screen.getByRole('button', { name: '4 pending actions' });
    const avatar = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(avatar).toHaveAttribute('src', 'https://cdn.example.com/ada.png');
    expect(trigger).toContainElement(avatar);
    // The photo replaces the initials fallback entirely.
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('builds two-letter initials from a single-word name', async () => {
    vi.mocked(useAuth).mockReturnValue(authValue({ ...ada, name: 'prakash' }));
    const user = userEvent.setup();
    renderUserMenu();

    // The avatar trigger is the only control rendered while the menu is closed.
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('PR');

    // The same initials label the opened menu header, next to the account name.
    await user.click(trigger);
    expect(screen.getAllByText('PR').length).toBeGreaterThan(1);
    expect(screen.getByText('prakash')).toBeInTheDocument();
  });

  it('confirms a successful sign-out with a toast', async () => {
    const signOut = vi.fn(async () => {});
    vi.mocked(useAuth).mockReturnValue(authValue(ada, signOut));
    const user = await openUserMenu();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    expect(
      screen.getByText(/you've been signed out safely/i),
    ).toBeInTheDocument();
  });

  it('tells the user when signing out failed instead of failing silently', async () => {
    const signOut = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.mocked(useAuth).mockReturnValue(authValue(ada, signOut));
    const user = await openUserMenu();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByText("Couldn't sign out")).toBeInTheDocument();
    expect(screen.queryByText('Signed out')).toBeNull();
  });

  it('navigates to the actions page from the notifications row and closes the menu', async () => {
    setPendingCount(3);
    const user = await openUserMenu();
    expect(screen.getByTestId('path')).toHaveTextContent('/');

    await user.click(screen.getByRole('button', { name: /notifications/i }));

    expect(screen.getByTestId('path')).toHaveTextContent('/my-actions');
    // The popover closes on navigation, taking its contents with it.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /contact support/i })).toBeNull(),
    );
  });

  it('caps the notifications badge at 9+ and hides it when nothing is pending', async () => {
    setPendingCount(12);
    await openUserMenu();

    const notifications = screen.getByRole('button', { name: /notifications/i });
    expect(notifications).toHaveTextContent('9+');
    expect(notifications).not.toHaveTextContent('12');
  });

  it('shows the exact pending count on the notifications row up to nine', async () => {
    setPendingCount(9);
    await openUserMenu();

    expect(screen.getByRole('button', { name: /notifications/i })).toHaveTextContent('9');
  });

  it('treats an unresolved pending count as nothing pending', async () => {
    setPendingCount(undefined);
    await openUserMenu();

    const notifications = screen.getByRole('button', { name: /notifications/i });
    expect(notifications).toHaveTextContent(/^Notifications$/);
  });
});

// ── MarkerPopupCard (map pin popup) ────────────────────────────────────────

describe('getPrecisionInfo', () => {
  it('labels the two known location precisions and falls back for anything else', () => {
    expect(getPrecisionInfo('exact').labelKey).toBe('map.precision.exact');
    expect(getPrecisionInfo('geocoded_full_address').labelKey).toBe(
      'map.precision.full_address',
    );
    // Any future/unrecognised precision must degrade to "unknown" rather than
    // claiming a precision the coordinate does not have.
    expect(getPrecisionInfo('geocoded_pincode').labelKey).toBe('map.precision.unknown');
  });
});

describe('MarkerPopupCard', () => {
  it('shows the location-precision hint and a humanised domain badge', () => {
    render(<MarkerPopupCard marker={markerFixture()} />);

    expect(screen.getByText('Exact location')).toBeInTheDocument();
    expect(screen.getByText('Service Provider')).toBeInTheDocument();
    // The marker label titles the popup (it also appears as a field row).
    expect(screen.getAllByText('Asha Tutors').length).toBeGreaterThan(0);
  });

  it('says the location came from a geocoded address when it is not exact', () => {
    render(
      <MarkerPopupCard
        marker={markerFixture({ precision: 'geocoded_full_address', domain: undefined })}
      />,
    );

    expect(screen.getByText('From full address')).toBeInTheDocument();
    expect(screen.queryByText('Service Provider')).toBeNull();
  });

  it('offers no footer affordance when the caller passes no callbacks', () => {
    render(<MarkerPopupCard marker={markerFixture()} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('falls back to a View details link when there is nothing to match or connect', async () => {
    const user = userEvent.setup();
    const onViewDetails = vi.fn((_id: string) => {});
    render(
      <MarkerPopupCard
        marker={markerFixture({ id: 'dest-9' })}
        onViewDetails={onViewDetails}
      />,
    );

    await user.click(screen.getByRole('button', { name: /view details/i }));

    expect(onViewDetails).toHaveBeenCalledWith('dest-9');
  });

  it('labels the connect CTA from the domain action type and starts the flow', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(
      <MarkerPopupCard
        marker={markerFixture()}
        actions={[
          {
            action_type: 'apply',
            from_domain: 'student',
            to_domain: 'provider',
            requirement_schema: { type: 'object' },
          },
        ]}
        onConnect={onConnect}
      />,
    );

    // The action type drives the label ("apply" → "Apply"), not a hardcoded
    // "Connect"; and the View details fallback is replaced.
    const cta = screen.getByRole('button', { name: /apply/i });
    expect(screen.queryByRole('button', { name: /view details/i })).toBeNull();

    await user.click(cta);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('disables the connect CTA and explains why on hover when an action is already open', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(
      <MarkerPopupCard
        marker={markerFixture()}
        actions={[
          {
            action_type: 'connect',
            from_domain: 'student',
            to_domain: 'provider',
            requirement_schema: { type: 'object' },
          },
        ]}
        onConnect={onConnect}
        connectDisabled
        connectDisabledReason="You already have an open request with this profile"
      />,
    );

    const cta = screen.getByRole('button', { name: /connect/i });
    expect(cta).toBeDisabled();
    // The reason lives on a wrapper span so it still shows on hover over a
    // disabled button (no TooltipProvider in the map overlay).
    expect(cta.closest('span')).toHaveAttribute(
      'title',
      'You already have an open request with this profile',
    );

    await user.click(cta);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('withholds the match-score CTA until the full network item is loaded', () => {
    // A composite marker id (`item#instance`) with no network item yet: the
    // popup renders, but a score needs both sides of the pair.
    render(
      <MarkerPopupCard
        marker={markerFixture({ id: 'dest-1#https://peer.example.com' })}
        localItem={itemFixture('mine')}
        networkItem={null}
        onViewDetails={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /see match score/i })).toBeNull();
    expect(screen.getByRole('button', { name: /view details/i })).toBeInTheDocument();
  });

  it('calculates the score and opens the details modal on one click', async () => {
    const user = userEvent.setup();
    vi.mocked(calculateMatchScore).mockResolvedValue({
      provider: 'signals_search',
      score: 60,
    });
    render(
      <MarkerPopupCard
        marker={markerFixture()}
        localItem={itemFixture('mine', { name: 'Asha K' })}
        networkItem={itemFixture('dest-1')}
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    expect(calculateMatchScore).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('60%')).toBeInTheDocument();
  });

  it('proceeds straight from the score modal into the connect flow', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(
      <MarkerPopupCard
        marker={markerFixture()}
        localItem={itemFixture('mine')}
        // A discover-supplied relevance score seeds the modal, so no API call.
        networkItem={{ ...itemFixture('dest-1'), score: 80 }}
        actions={[
          {
            action_type: 'connect',
            from_domain: 'student',
            to_domain: 'provider',
            requirement_schema: { type: 'object' },
          },
        ]}
        onConnect={onConnect}
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));
    await user.click(await screen.findByRole('button', { name: /proceed with connect/i }));

    expect(calculateMatchScore).not.toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers no proceed action from the modal while the connect CTA is blocked', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(
      <MarkerPopupCard
        marker={markerFixture()}
        localItem={itemFixture('mine')}
        networkItem={{ ...itemFixture('dest-1'), score: 80 }}
        actions={[
          {
            action_type: 'connect',
            from_domain: 'student',
            to_domain: 'provider',
            requirement_schema: { type: 'object' },
          },
        ]}
        onConnect={onConnect}
        connectDisabled
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /proceed with connect/i })).toBeNull();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

// ── MatchScoreCard (list card + modal hand-off) ────────────────────────────

const connectAction = {
  action_type: 'connect',
  from_domain: 'student',
  to_domain: 'provider',
  requirement_schema: { type: 'object' } as RJSFSchema,
};

describe('MatchScoreCard modal hand-off', () => {
  it('proceeding from the modal fires the first domain action and closes the modal', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn((_type: string, _schema: typeof connectAction) => {});
    render(
      <MatchScoreCard
        schema={nameSchema}
        data={{ name: 'Dest' }}
        localItem={itemFixture('mine')}
        // Seeded by discover, so the badge is present without an API round trip.
        networkItem={{ ...itemFixture('dest'), score: 80 }}
        actions={[connectAction]}
        onAction={onAction}
      />,
    );

    await user.click(screen.getByRole('button', { name: /80%/ }));
    await user.click(await screen.findByRole('button', { name: /proceed with connect/i }));

    expect(onAction).toHaveBeenCalledWith('connect', connectAction);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses to proceed while an open action already exists for the pair', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn((_type: string, _schema: typeof connectAction) => {});
    render(
      <MatchScoreCard
        schema={nameSchema}
        data={{ name: 'Dest' }}
        localItem={itemFixture('mine')}
        networkItem={{ ...itemFixture('dest'), score: 80 }}
        actions={[connectAction]}
        onAction={onAction}
        actionsDisabled
        actionsDisabledReason="A request is already open"
      />,
    );

    await user.click(screen.getByRole('button', { name: /80%/ }));
    await user.click(await screen.findByRole('button', { name: /proceed with connect/i }));

    // The modal still closes, but no duplicate action is started (#370/#422).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onAction).not.toHaveBeenCalled();
  });

  it('re-runs the calculation from inside the modal without closing it', async () => {
    const user = userEvent.setup();
    vi.mocked(calculateMatchScore)
      .mockResolvedValueOnce({ provider: 'signals_search', score: 40 })
      .mockResolvedValueOnce({ provider: 'signals_search', score: 90 });
    render(
      <MatchScoreCard
        schema={nameSchema}
        data={{ name: 'Dest' }}
        localItem={itemFixture('mine')}
        networkItem={itemFixture('dest')}
        actions={[connectAction]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));
    // The score shows on both the card badge and in the open modal.
    expect((await screen.findAllByText('40%')).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /recalculate/i }));

    expect((await screen.findAllByText('90%')).length).toBeGreaterThan(0);
    expect(calculateMatchScore).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names both sides of the comparison from the schema title field', async () => {
    const user = userEvent.setup();
    // No `name`/`full_name`/`title` candidate: the first schema property wins.
    const bioSchema: RJSFSchema = {
      type: 'object',
      properties: { org_label: { type: 'string', title: 'Org' } },
    };
    vi.mocked(calculateMatchScore).mockReturnValue(new Promise(() => {}));
    render(
      <MatchScoreCard
        schema={bioSchema}
        data={{ org_label: 'Dest Org' }}
        localItem={itemFixture('mine', { org_label: 'My Org' })}
        networkItem={itemFixture('dest')}
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    expect(await screen.findByText('Comparing My Org with Dest Org')).toBeInTheDocument();
  });

  it('falls back to generic names when the schema declares no fields and the data is empty', async () => {
    const user = userEvent.setup();
    vi.mocked(calculateMatchScore).mockReturnValue(new Promise(() => {}));
    render(
      <MatchScoreCard
        schema={{ type: 'object' }}
        data={{}}
        localItem={itemFixture('mine', {})}
        networkItem={itemFixture('dest')}
      />,
    );

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    expect(
      await screen.findByText('Comparing Your Profile with Target Profile'),
    ).toBeInTheDocument();
  });
});

// ── WalletImportModal (provider picker) ────────────────────────────────────

const walletContext: WalletImportContext = {
  user: { email: 'ada@example.com', phoneNumber: null, name: 'Ada Lovelace' },
  networkId: 'blue_dot',
  domainId: 'student',
  schema: { type: 'object', properties: { full_name: { type: 'string' } } },
  formData: {},
};

const importedResult: WalletImportResult = {
  data: { full_name: 'Ada Lovelace' },
  providerName: 'demo_wallet',
  providerLabel: 'Demo Wallet',
  summary: 'Imported 1 verified field',
};

/** A stand-in provider whose component exposes the success/cancel edges. */
function fakeProvider(overrides: Partial<WalletProvider> = {}): WalletProvider {
  const Component = ({ context, onSuccess, onCancel }: WalletImportProviderProps) => (
    <div>
      <p>Signed in as {context.user.name}</p>
      <button type="button" onClick={() => onSuccess(importedResult)}>
        Finish import
      </button>
      <button type="button" onClick={onCancel}>
        Abort import
      </button>
    </div>
  );
  return {
    name: 'demo_wallet',
    label: 'Demo Wallet',
    description: 'Import verified credentials from the demo wallet.',
    component: Component,
    isConfigured: () => true,
    ...overrides,
  };
}

/** Point the mocked registry at exactly these providers. */
function installProviders(providers: WalletProvider[]) {
  vi.mocked(getRegisteredWalletProviders).mockReturnValue(providers);
  vi.mocked(getConfiguredWalletProviders).mockReturnValue(
    providers.filter((p) => p.isConfigured()),
  );
  vi.mocked(getWalletProvider).mockImplementation((name: string) =>
    providers.find((p) => p.name === name),
  );
}

describe('WalletImportModal', () => {
  it('says so when the build registered no wallet providers at all', () => {
    installProviders([]);
    render(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    expect(screen.getByText('No wallet providers are registered.')).toBeInTheDocument();
    expect(
      screen.getByText('Configure at least one provider before importing credentials.'),
    ).toBeInTheDocument();
  });

  it('lists each provider and only enables the ones that are configured', () => {
    installProviders([
      fakeProvider(),
      fakeProvider({
        name: 'unconfigured_hinted',
        label: 'Hinted Wallet',
        isConfigured: () => false,
        getConfigurationHint: () => 'Set VITE_HINTED_WALLET_URL to enable this provider.',
      }),
      fakeProvider({
        name: 'unconfigured_bare',
        label: 'Bare Wallet',
        isConfigured: () => false,
      }),
    ]);
    render(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Use Demo Wallet' })).toBeEnabled();
    expect(screen.getByText('Ready to import.')).toBeInTheDocument();

    // An unconfigured provider is listed but not usable, and explains itself —
    // its own hint when it has one, a generic line when it doesn't.
    expect(screen.getByRole('button', { name: 'Use Hinted Wallet' })).toBeDisabled();
    expect(
      screen.getByText('Set VITE_HINTED_WALLET_URL to enable this provider.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Bare Wallet' })).toBeDisabled();
    expect(screen.getByText('Provider is not configured.')).toBeInTheDocument();

    // At least one provider IS configured, so the "configure one" nudge is gone.
    expect(
      screen.queryByText('Configure at least one provider before importing credentials.'),
    ).toBeNull();
  });

  it('nudges to configure a provider even when one is registered but unusable', () => {
    installProviders([fakeProvider({ isConfigured: () => false })]);
    render(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    expect(screen.queryByText('No wallet providers are registered.')).toBeNull();
    expect(
      screen.getByText('Configure at least one provider before importing credentials.'),
    ).toBeInTheDocument();
  });

  it('swaps the list for the chosen provider UI, and Back returns to the list', async () => {
    const user = userEvent.setup();
    installProviders([fakeProvider()]);
    render(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Use Demo Wallet' }));

    // The provider's own flow takes over, and receives the import context.
    expect(screen.getByText('Signed in as Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use Demo Wallet' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /back to providers/i }));

    expect(screen.getByRole('button', { name: 'Use Demo Wallet' })).toBeInTheDocument();
    expect(screen.queryByText('Signed in as Ada Lovelace')).toBeNull();
  });

  it('hands a completed import up to the caller and closes itself', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn((_result: WalletImportResult) => {});
    const onOpenChange = vi.fn((_open: boolean) => {});
    installProviders([fakeProvider()]);
    render(
      <WalletImportModal
        open
        onOpenChange={onOpenChange}
        context={walletContext}
        onImported={onImported}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Use Demo Wallet' }));
    await user.click(screen.getByRole('button', { name: 'Finish import' }));

    expect(onImported).toHaveBeenCalledWith(importedResult);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes without importing anything when the provider flow is cancelled', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn((_result: WalletImportResult) => {});
    const onOpenChange = vi.fn((_open: boolean) => {});
    installProviders([fakeProvider()]);
    render(
      <WalletImportModal
        open
        onOpenChange={onOpenChange}
        context={walletContext}
        onImported={onImported}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Use Demo Wallet' }));
    await user.click(screen.getByRole('button', { name: 'Abort import' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('forgets the chosen provider once closed, so it reopens on the picker', async () => {
    const user = userEvent.setup();
    installProviders([fakeProvider()]);
    const { rerender } = render(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Use Demo Wallet' }));
    expect(screen.getByText('Signed in as Ada Lovelace')).toBeInTheDocument();

    rerender(
      <WalletImportModal
        open={false}
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );
    rerender(
      <WalletImportModal
        open
        onOpenChange={() => {}}
        context={walletContext}
        onImported={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Use Demo Wallet' })).toBeInTheDocument();
    expect(screen.queryByText('Signed in as Ada Lovelace')).toBeNull();
  });
});

// ── U18GuardianFlow — inline presentation (#453) ────────────────────────────

describe('U18GuardianFlow inline mode', () => {
  it('renders the steps in place (no blocking dialog) starting at the guardian step', async () => {
    vi.mocked(submitGuardian).mockResolvedValue({ otpSent: true });
    const onLogout = vi.fn();
    render(
      <>
        <Toaster />
        <U18GuardianFlow
          network="blue_dot"
          brand="standard"
          initialStep="guardian"
          inline
          onComplete={() => {}}
          onNotMinor={() => {}}
          onLogout={onLogout}
        />
      </>,
    );

    // Inline: a plain heading in the auth panel, not a Dialog.
    expect(screen.getByRole('heading', { name: 'Guardian details' })).toBeInTheDocument();
    expect(
      screen.getByText("You're under 18, so a guardian needs to confirm this account."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Started at 'guardian' because the caller already resolved the DOB, so
    // there is no birth-year step to go back to.
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    expect(screen.queryByLabelText(/year of birth/i)).toBeNull();

    await userEvent.type(screen.getByLabelText(/guardian name/i), 'Asha Guardian');
    await userEvent.type(screen.getByLabelText(/guardian phone number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(submitGuardian).toHaveBeenCalledWith(
        expect.objectContaining({
          network: 'blue_dot',
          brand: 'standard',
          guardianName: 'Asha Guardian',
          guardianPhone: '+919876543210',
          guardianDeclarationAccepted: true,
        }),
      ),
    );

    // The inline heading tracks the step, and the OTP entry replaces the form.
    expect(
      await screen.findByRole('heading', { name: 'Confirm with your guardian' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);

    // The escape hatch stays available inline for a ward who cannot proceed.
    await userEvent.click(screen.getByRole('button', { name: /not you\? log out/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

// ── item-api (request shaping) ──────────────────────────────────────────────
// Kept last in the file: each case re-imports `item-api` against a stubbed
// axios client, so the module registry is reset per test.

type ClientResponse = { data: unknown };

async function loadItemApi() {
  vi.resetModules();
  const post = vi.fn<(url: string, body?: unknown) => Promise<ClientResponse>>();
  const patch = vi.fn<(url: string, body?: unknown) => Promise<ClientResponse>>();
  const get = vi.fn<
    (
      url: string,
      config?: { params?: URLSearchParams; signal?: AbortSignal },
    ) => Promise<ClientResponse>
  >();
  vi.doMock('@/lib/api-client', () => ({
    createApiClient: () => ({ post, patch, get }),
  }));
  const api = await import('@/lib/item-api');
  return { api, post, patch, get };
}

describe('item-api', () => {
  it('creates an item from the payload as given and returns the new id', async () => {
    const { api, post } = await loadItemApi();
    post.mockResolvedValue({ data: { item_type: 'profile_1.0', item_id: 'new-1' } });

    const payload = {
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      item_state: { name: 'Ada' },
      item_locations: [{ lat: 12.9, lng: 77.6, label: 'Bengaluru' }],
      consent: { category: 'profile_creation' as const, version: 2, brand: null },
    };
    const result = await api.createItem(payload);

    expect(post).toHaveBeenCalledWith('/api/v1/item/create', payload);
    expect(result).toEqual({ item_type: 'profile_1.0', item_id: 'new-1' });
  });

  it('sends only the three required query params when nothing optional is set', async () => {
    const { api, get } = await loadItemApi();
    get.mockResolvedValue({ data: { meta: { total: 0, limit: 20, offset: 0 }, items: [] } });

    await api.fetchItems({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
    });

    expect(get.mock.calls[0][0]).toBe('/api/v1/item/fetch');
    expect(get.mock.calls[0][1]?.params?.toString()).toBe(
      'item_network=blue_dot&item_domain=student&item_type=profile_1.0',
    );
  });

  it('serialises every optional filter, and forwards the abort signal', async () => {
    const { api, get } = await loadItemApi();
    get.mockResolvedValue({ data: { meta: { total: 1, limit: 5, offset: 0 }, items: [] } });
    const controller = new AbortController();

    await api.fetchItems(
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_id: 'i-1',
        item_instance_url: 'https://peer.example.com',
        item_schema_url: 'https://schemas.example.com/profile_1.0.json',
        created_by_me: true,
        include_retired: true,
        limit: 5,
        // 0 is meaningful and must survive the `!== undefined` check.
        offset: 0,
      },
      controller.signal,
    );

    const params = get.mock.calls[0][1]?.params;
    expect(params?.get('item_id')).toBe('i-1');
    expect(params?.get('item_instance_url')).toBe('https://peer.example.com');
    expect(params?.get('item_schema_url')).toBe(
      'https://schemas.example.com/profile_1.0.json',
    );
    expect(params?.get('created_by_me')).toBe('true');
    expect(params?.get('include_retired')).toBe('true');
    expect(params?.get('limit')).toBe('5');
    expect(params?.get('offset')).toBe('0');
    expect(get.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('omits the boolean flags entirely when they are false rather than sending "false"', async () => {
    const { api, get } = await loadItemApi();
    get.mockResolvedValue({ data: { meta: { total: 0, limit: 20, offset: 0 }, items: [] } });

    await api.fetchItems({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      created_by_me: false,
      include_retired: false,
    });

    const params = get.mock.calls[0][1]?.params;
    expect(params?.has('created_by_me')).toBe(false);
    expect(params?.has('include_retired')).toBe(false);
  });

  it('patches a single item by id and returns the updated item', async () => {
    const { api, patch } = await loadItemApi();
    patch.mockResolvedValue({ data: { item: { item_id: 'i-1' } } });

    const result = await api.updateItem('i-1', { item_state: { name: 'Ada B' } });

    expect(patch).toHaveBeenCalledWith('/api/v1/item/i-1', {
      item_state: { name: 'Ada B' },
    });
    expect(result).toEqual({ item: { item_id: 'i-1' } });
  });

  it('posts a lifecycle transition as an item_id + action pair', async () => {
    const { api, post } = await loadItemApi();
    post.mockResolvedValue({ data: { item_id: 'i-1', lifecycle_status: 'retired' } });

    const result = await api.setItemLifecycle('i-1', 'retire');

    expect(post).toHaveBeenCalledWith('/api/v1/item/lifecycle', {
      item_id: 'i-1',
      action: 'retire',
    });
    expect(result).toEqual({ item_id: 'i-1', lifecycle_status: 'retired' });
  });
});
