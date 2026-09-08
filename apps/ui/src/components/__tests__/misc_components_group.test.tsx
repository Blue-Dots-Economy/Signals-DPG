import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';

// ── Module mocks ───────────────────────────────────────────────────────────
// Only the network/data edges are mocked; every component under test renders
// for real (real AuthProvider, real sonner Toaster, real Radix dialogs) so the
// assertions below are on user-visible DOM rather than on call bookkeeping.
// NB: mock factories must not close over outer bindings (they are hoisted
// above the imports), hence the bare `vi.fn()`s wired up per-test via
// `vi.mocked(...)`.
// fetchSupportConfig backs the dialog's attachment limits (#551); the real
// defaults keep these tests exercising the same limits as production.
vi.mock('@/lib/support-api', () => ({
  submitSupport: vi.fn(),
  fetchSupportConfig: vi.fn(async () => ({
    enabled: true,
    maxTotalBytes: 5 * 1024 * 1024,
    maxFiles: 3,
    allowedTypes: ['image/png', 'video/mp4', 'audio/mpeg'],
  })),
}));
vi.mock('@/hooks/use-match-score', () => ({ useMatchScore: vi.fn() }));
vi.mock('@/hooks/use-actions', () => ({ usePendingActionsCount: vi.fn() }));
vi.mock('@/lib/auth-api', () => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  checkUser: vi.fn(),
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  fetchMe: vi.fn(),
  // The AuthProvider resolves the instance's auth provider before restoring a
  // session (keycloak split): a resolved betterauth config keeps the OTP-path
  // lifecycle below identical to before. Set here (not per-test) because
  // clearAllMocks keeps implementations, only wiping calls.
  fetchAuthConfig: vi.fn().mockResolvedValue({
    selfSignupAllowed: false,
    loginChannels: ['phone', 'email'],
  }),
}));

import { submitSupport } from '@/lib/support-api';
import { useMatchScore } from '@/hooks/use-match-score';
import { usePendingActionsCount } from '@/hooks/use-actions';
import * as authApi from '@/lib/auth-api';
import type { AuthIdentifier, SessionResponse, User } from '@/lib/auth-api';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';
import type { DotNetworkDomain, DotNetworkSchema } from '@/engine/types';
import type { RJSFSchema } from '@rjsf/utils';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import { SupportDialog } from '@/components/support/support-dialog';
import { MatchScoreContainer } from '@/components/match-score/match-score-container';
import { MatchScoreModal } from '@/components/match-score/match-score-modal';
import { AppSidebar } from '@/components/layout/sidebar';
import { SidebarProvider } from '@/components/ui/sidebar';

// ── Fixtures ───────────────────────────────────────────────────────────────

const asha: User = {
  id: 'u-1',
  name: 'Asha K',
  email: 'asha@example.com',
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

function session(over: Partial<SessionResponse> = {}): SessionResponse {
  return {
    user: asha,
    token: 'tok-restored',
    session: { id: 's-1', expiresAt: '2026-12-31T00:00:00Z' },
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: {},
    item_locations: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

type MatchScoreHookState = ReturnType<typeof useMatchScore>;

function hookState(over: Partial<MatchScoreHookState> = {}): MatchScoreHookState {
  return {
    score: null,
    isLoading: false,
    error: null,
    cached: false,
    calculate: async () => {},
    recalculate: async () => {},
    clearCache: () => {},
    ...over,
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ═══════════════════════════════════════════════════════════════════════════
// auth-context — the app's only React Context. It owns the bearer token that
// api-client's request interceptor reads out of `auth-token`'s localStorage
// slot, so the token store is asserted alongside the rendered session state.
// ═══════════════════════════════════════════════════════════════════════════

function AuthProbe() {
  const { user, isLoading, isAuthenticated, checkUser, requestOtp, verifyOtp, signOut } = useAuth();
  const [outcome, setOutcome] = React.useState('');

  return (
    <div>
      <p>{isLoading ? 'loading' : 'ready'}</p>
      <p data-testid="who">{user ? user.name : 'anonymous'}</p>
      <p data-testid="authed">{String(isAuthenticated)}</p>
      <p data-testid="outcome">{outcome}</p>
      <button
        onClick={() => {
          void checkUser({ email: 'asha@example.com' }).then((exists) =>
            setOutcome(exists ? 'existing account' : 'new account'),
          );
        }}
      >
        check user
      </button>
      <button
        onClick={() => {
          void requestOtp({ phoneNumber: '+919000000000' }).then(() => setOutcome('otp sent'));
        }}
      >
        request otp
      </button>
      <button
        onClick={() => {
          void verifyOtp({ email: 'asha@example.com' }, '123456', 'Asha K');
        }}
      >
        verify otp
      </button>
      <button
        onClick={() => {
          void signOut();
        }}
      >
        sign out
      </button>
    </div>
  );
}

function renderAuthProbe() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('AuthProvider session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(authApi.getSession).mockResolvedValue(session());
    vi.mocked(authApi.signOut).mockResolvedValue(undefined);
  });

  it('reports a loading session until the restore call settles', async () => {
    let release: (value: SessionResponse) => void = () => {};
    vi.mocked(authApi.getSession).mockReturnValue(
      new Promise<SessionResponse>((resolve) => {
        release = resolve;
      }),
    );

    renderAuthProbe();
    // Nothing is known yet: consumers must be able to render a spinner instead
    // of flashing the signed-out UI.
    expect(screen.getByText('loading')).toBeInTheDocument();
    expect(screen.getByTestId('authed')).toHaveTextContent('false');

    await act(async () => {
      release(session());
    });

    // findBy: the session restore now runs behind the auth-config query
    // (keycloak split), so the release lands one scheduler tick later.
    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('Asha K');
  });

  it('restores the signed-in user and stores the bearer token', async () => {
    renderAuthProbe();

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('Asha K');
    expect(screen.getByTestId('authed')).toHaveTextContent('true');
    expect(localStorage.getItem('auth_token')).toBe('tok-restored');
  });

  it('signs the user in without writing a token when the session carries none', async () => {
    vi.mocked(authApi.getSession).mockResolvedValue(session({ token: null }));
    renderAuthProbe();

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('authed')).toHaveTextContent('true');
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('falls back to anonymous when the session restore call fails', async () => {
    vi.mocked(authApi.getSession).mockRejectedValue(new Error('offline'));
    renderAuthProbe();

    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('who')).toHaveTextContent('anonymous');
    expect(screen.getByTestId('authed')).toHaveTextContent('false');
  });

  it('signs the user in from a verified OTP and stores the issued token', async () => {
    vi.mocked(authApi.getSession).mockRejectedValue(new Error('no session'));
    vi.mocked(authApi.verifyOtp).mockResolvedValue({
      redirect: false,
      token: 'tok-from-otp',
      user: asha,
    });
    renderAuthProbe();
    expect(await screen.findByText('ready')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'verify otp' }));

    expect(await screen.findByText('Asha K')).toBeInTheDocument();
    expect(screen.getByTestId('authed')).toHaveTextContent('true');
    expect(localStorage.getItem('auth_token')).toBe('tok-from-otp');
    expect(vi.mocked(authApi.verifyOtp).mock.calls[0]).toEqual([
      { email: 'asha@example.com' },
      '123456',
      'Asha K',
    ]);
  });

  it('surfaces whether an account already exists, and requests an OTP', async () => {
    vi.mocked(authApi.getSession).mockRejectedValue(new Error('no session'));
    vi.mocked(authApi.checkUser).mockResolvedValueOnce({ userExists: true });
    vi.mocked(authApi.requestOtp).mockResolvedValue({ ok: true, user: true });
    renderAuthProbe();
    expect(await screen.findByText('ready')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'check user' }));
    expect(await screen.findByText('existing account')).toBeInTheDocument();

    vi.mocked(authApi.checkUser).mockResolvedValueOnce({ userExists: false });
    await userEvent.click(screen.getByRole('button', { name: 'check user' }));
    expect(await screen.findByText('new account')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'request otp' }));
    expect(await screen.findByText('otp sent')).toBeInTheDocument();
    const identifier: AuthIdentifier = { phoneNumber: '+919000000000' };
    expect(vi.mocked(authApi.requestOtp)).toHaveBeenCalledWith(identifier);
  });

  it('drops the user and the stored token on sign-out', async () => {
    renderAuthProbe();
    expect(await screen.findByText('Asha K')).toBeInTheDocument();
    expect(localStorage.getItem('auth_token')).toBe('tok-restored');

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByText('anonymous')).toBeInTheDocument();
    expect(screen.getByTestId('authed')).toHaveTextContent('false');
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('refuses to be used outside an AuthProvider', () => {
    // React logs the thrown render error; silence it so the failure output
    // stays readable while still asserting the guard fires.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<AuthProbe />)).toThrow(/must be used within an AuthProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SupportDialog — remaining branches: the anonymous (no prefill) path, the
// success/reset path, the generic failure toast, the type switch, and the
// defensive validation guards.
// ═══════════════════════════════════════════════════════════════════════════

function renderSupportDialog(onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthProvider>
        {/* sonner renders toasts into a mounted <Toaster />, as app.tsx does. */}
        <Toaster />
        <SupportDialog open onOpenChange={onOpenChange} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function supportForm(): HTMLFormElement {
  const form = document.querySelector('form');
  if (!form) throw new Error('support form did not render');
  return form;
}

describe('SupportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Anonymous by default: exercises the "nothing to prefill" branch.
    vi.mocked(authApi.getSession).mockRejectedValue(new Error('no session'));
    vi.mocked(authApi.signOut).mockResolvedValue(undefined);
    vi.mocked(submitSupport).mockResolvedValue(undefined);
  });

  it('prefills nothing for an anonymous visitor and submits a phone-only contact', async () => {
    const onOpenChange = vi.fn((open: boolean) => open);
    renderSupportDialog(onOpenChange);

    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Phone')).toHaveValue('');

    await userEvent.type(screen.getByLabelText('Name'), '  Ravi  ');
    await userEvent.type(screen.getByLabelText('Phone'), '+919111111111');
    await userEvent.type(screen.getByLabelText('Details'), '  App keeps logging me out  ');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Values are trimmed, and an empty email is omitted rather than sent as ''.
    expect(vi.mocked(submitSupport).mock.calls[0]).toEqual([
      {
        name: 'Ravi',
        email: undefined,
        phone: '+919111111111',
        type: 'complaint',
        details: 'App keeps logging me out',
        consent: true,
      },
    ]);
    expect(await screen.findByText('Message sent')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // reset() clears only the message fields — the contact details stay so a
    // follow-up report doesn't have to be retyped.
    expect(screen.getByLabelText('Details')).toHaveValue('');
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByLabelText('Name')).toHaveValue('  Ravi  ');
  });

  it('sends the chosen support-request type and the signed-in user contact', async () => {
    vi.mocked(authApi.getSession).mockResolvedValue(session());
    renderSupportDialog();
    expect(await screen.findByDisplayValue('Asha K')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Support Request' }));
    await userEvent.type(screen.getByLabelText('Details'), 'Please raise my listing cap');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(vi.mocked(submitSupport).mock.calls[0]).toEqual([
      {
        name: 'Asha K',
        email: 'asha@example.com',
        phone: '+919000000000',
        type: 'support_request',
        details: 'Please raise my listing cap',
        consent: true,
      },
    ]);
  });

  it('keeps the dialog open with a generic error toast when the submit fails', async () => {
    vi.mocked(submitSupport).mockRejectedValue(new Error('boom'));
    const onOpenChange = vi.fn((open: boolean) => open);
    renderSupportDialog(onOpenChange);

    await userEvent.type(screen.getByLabelText('Name'), 'Ravi');
    await userEvent.type(screen.getByLabelText('Phone'), '+919111111111');
    await userEvent.type(screen.getByLabelText('Details'), 'Still broken');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText("Couldn't send your message")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    // The typed message survives the failure so it can be retried.
    expect(screen.getByLabelText('Details')).toHaveValue('Still broken');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('guards a submit that bypasses the disabled button: missing details', async () => {
    renderSupportDialog();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.submit(supportForm());

    expect(await screen.findByText('Please describe your issue')).toBeInTheDocument();
    expect(vi.mocked(submitSupport)).not.toHaveBeenCalled();
  });

  it('guards a submit that bypasses the disabled button: no email or phone', async () => {
    renderSupportDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'No way to reach me');

    fireEvent.submit(supportForm());

    expect(await screen.findByText('Please provide an email or phone number')).toBeInTheDocument();
    expect(vi.mocked(submitSupport)).not.toHaveBeenCalled();
  });

  it('guards a submit that bypasses the disabled button: consent not given', async () => {
    renderSupportDialog();
    await userEvent.type(screen.getByLabelText('Phone'), '+919111111111');
    await userEvent.type(screen.getByLabelText('Details'), 'Reachable but no consent');

    fireEvent.submit(supportForm());

    expect(await screen.findByText('Please accept the consent to continue')).toBeInTheDocument();
    expect(vi.mocked(submitSupport)).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MatchScoreContainer — wires the badge/button to the details modal.
// ═══════════════════════════════════════════════════════════════════════════

const localItem = makeItem({ item_id: 'mine-1' });
const networkItem = makeItem({ item_id: 'theirs-1', item_domain: 'private_tutor' });

function renderContainer(props: Partial<React.ComponentProps<typeof MatchScoreContainer>> = {}) {
  return render(
    <MatchScoreContainer
      localItem={localItem}
      networkItem={networkItem}
      localItemName="Me"
      networkItemName="Them"
      {...props}
    />,
  );
}

function footerCloseButton(): HTMLElement {
  // Radix's own X affordance is also named "Close"; pick the footer button.
  const buttons = screen.getAllByRole('button', { name: 'Close' });
  const footer = buttons.find((b) => b.getAttribute('data-slot') !== 'dialog-close');
  if (!footer) throw new Error('footer Close button did not render');
  return footer;
}

describe('MatchScoreContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The modal's progress bar eases over 600ms of requestAnimationFrame; run
    // it to completion in a single synchronous frame so no animation callback
    // outlives the test.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 10_000);
      return 0;
    });
    vi.mocked(useMatchScore).mockReturnValue(hookState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calculates on demand and shows the pending state, with the modal closed', async () => {
    const calculate = vi.fn(async () => {});
    vi.mocked(useMatchScore).mockReturnValue(hookState({ calculate }));
    const { rerender } = renderContainer();

    expect(screen.queryByText('Match Score Details')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /See Match Score/ }));
    expect(calculate).toHaveBeenCalledTimes(1);

    vi.mocked(useMatchScore).mockReturnValue(hookState({ isLoading: true, calculate }));
    rerender(
      <MatchScoreContainer
        localItem={localItem}
        networkItem={networkItem}
        localItemName="Me"
        networkItemName="Them"
      />,
    );

    const pending = screen.getByRole('button', { name: /Calculating/ });
    expect(pending).toBeDisabled();
  });

  it('disables the trigger when the viewer has no profile of their own', () => {
    renderContainer({ localItem: null });
    expect(screen.getByRole('button', { name: /See Match Score/ })).toBeDisabled();
  });

  it('offers a retry when the calculation failed', async () => {
    const calculate = vi.fn(async () => {});
    vi.mocked(useMatchScore).mockReturnValue(
      hookState({ error: new Error('relevance down'), calculate }),
    );
    renderContainer();

    await userEvent.click(screen.getByRole('button', { name: /Unable to calculate/ }));
    expect(calculate).toHaveBeenCalledTimes(1);
  });

  it('opens the details modal from the score badge and closes it again', async () => {
    const score: MatchScoreResult = {
      provider: 'signals_search',
      score: 71,
    };
    vi.mocked(useMatchScore).mockReturnValue(hookState({ score }));
    renderContainer();

    expect(screen.queryByText('Match Score Details')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /71%/ }));

    expect(screen.getByRole('heading', { name: 'Match Score Details' })).toBeInTheDocument();
    // #646 §5.5: reasoning, confidence and signal summaries are gone — the
    // signals_search provider never populated them, so the modal advertised
    // explanations that were always absent in practice.
    expect(screen.queryByText('Both teach physics in the same city.')).toBeNull();
    expect(screen.queryByText(/Confidence/)).toBeNull();

    await userEvent.click(footerCloseButton());
    expect(screen.queryByText('Match Score Details')).toBeNull();
  });

  it('recalculates from inside the modal without closing it', async () => {
    const recalculate = vi.fn(async () => {});
    vi.mocked(useMatchScore).mockReturnValue(
      hookState({ score: { provider: 'signals_search', score: 55 }, recalculate }),
    );
    renderContainer();

    await userEvent.click(screen.getByRole('button', { name: /55%/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Recalculate' }));

    expect(recalculate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Match Score Details' })).toBeInTheDocument();
  });

  it('shows the proceed action only when the caller supplies one', async () => {
    const onProceed = vi.fn();
    vi.mocked(useMatchScore).mockReturnValue(
      hookState({ score: { provider: 'signals_search', score: 90 } }),
    );
    const { unmount } = renderContainer();
    await userEvent.click(screen.getByRole('button', { name: /90%/ }));
    expect(screen.queryByRole('button', { name: /Proceed with Connect/ })).toBeNull();
    unmount();

    renderContainer({ onProceed });
    await userEvent.click(screen.getByRole('button', { name: /90%/ }));
    await userEvent.click(screen.getByRole('button', { name: /Proceed with Connect/ }));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MatchScoreModal — the loading / empty / signals branches.
// ═══════════════════════════════════════════════════════════════════════════

function renderModal(props: Partial<React.ComponentProps<typeof MatchScoreModal>> = {}) {
  return render(
    <MatchScoreModal
      isOpen
      onClose={() => {}}
      score={null}
      isLoading={false}
      localItemName="Me"
      networkItemName="Them"
      onRecalculate={() => {}}
      {...props}
    />,
  );
}

describe('MatchScoreModal states', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 10_000);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows who is being compared while the score is being calculated', () => {
    renderModal({ isLoading: true });

    expect(screen.getByText('Calculating match score...')).toBeInTheDocument();
    expect(screen.getByText('Comparing Me with Them')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // No point re-asking while a calculation is already in flight.
    expect(screen.getByRole('button', { name: 'Recalculate' })).toBeDisabled();
  });

  it('shows an empty state when there is no score to explain', () => {
    renderModal();

    expect(screen.getByText('No match score available')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Matching Factors')).toBeNull();
    expect(screen.queryByText('AI Reasoning')).toBeNull();
    expect(screen.getByRole('button', { name: 'Recalculate' })).toBeEnabled();
  });

  // #646 §5.5: the Matching Factors and AI Reasoning panels are deleted, along
  // with the `signals` / `reasoning` fields they rendered — the
  // signals_search provider never populated either, so the modal advertised
  // explanations that were always absent. The two tests that lived here
  // asserted that dead surface; the relevance explanation panel has its own
  // suite.
  it('renders the score without any factors or reasoning panel', () => {
    renderModal({ score: { provider: 'signals_search', score: 42 } });

    expect(screen.queryByText('Matching Factors')).toBeNull();
    expect(screen.queryByText('AI Reasoning')).toBeNull();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AppSidebar — network selector, browse selector, the my-items accordion and
// the pending-actions badge.
// ═══════════════════════════════════════════════════════════════════════════

function domain(id: string, over: Partial<DotNetworkDomain> = {}): DotNetworkDomain {
  return { id, description: `${id} domain`, ...over };
}

function network(id: string, over: Partial<DotNetworkSchema> = {}): DotNetworkSchema {
  return {
    id,
    display_name: `${id} network`,
    description: '',
    schema_standard: 'dot-1.0',
    domains: [],
    actions: {},
    ...over,
  };
}

const nameSchema: RJSFSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
};
const headlineSchema: RJSFSchema = {
  type: 'object',
  properties: { headline: { type: 'string' } },
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderSidebar(props: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SidebarProvider>
        <AppSidebar
          domains={[]}
          selectedDomain={null}
          onDomainSelect={() => {}}
          selectedNetwork="blue_dot"
          {...props}
        />
      </SidebarProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function setPendingCount(count: number | undefined) {
  vi.mocked(usePendingActionsCount).mockReturnValue({
    data: count,
  } as unknown as ReturnType<typeof usePendingActionsCount>);
}

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPendingCount(0);
  });

  it('offers a create-profile shortcut and navigates to the form when there are no items', async () => {
    renderSidebar({ myItems: [] });

    expect(screen.getByText('My Profile(s)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create Profile' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/profile/new?network=blue_dot');
  });

  it('lists the available networks, marks the current one and reports a switch', async () => {
    const onNetworkSelect = vi.fn((networkId: string) => networkId);
    renderSidebar({
      networks: [network('blue_dot'), network('yellow_dot', { display_name: '' })],
      onNetworkSelect,
    });

    expect(screen.getByText('Networks')).toBeInTheDocument();
    const current = screen.getByRole('button', { name: 'blue_dot network' });
    expect(current).toHaveAttribute('data-active', 'true');
    // A network with no display_name falls back to its id.
    const other = screen.getByRole('button', { name: 'yellow_dot' });
    expect(other).toHaveAttribute('data-active', 'false');

    await userEvent.click(other);
    expect(onNetworkSelect).toHaveBeenCalledWith('yellow_dot');
  });

  it('hides the network group entirely when no networks are supplied', () => {
    renderSidebar();
    expect(screen.queryByText('Networks')).toBeNull();
  });

  it('hides the browse selector when there is only one browseable domain', () => {
    renderSidebar({ domains: [domain('private_tutor')] });

    expect(screen.queryByText('Browse')).toBeNull();
    expect(screen.queryByText('All')).toBeNull();
  });

  it('shows the browse selector for several domains and reports the choice', async () => {
    const onDomainSelect = vi.fn((domainId: string | null) => domainId);
    renderSidebar({
      domains: [domain('student'), domain('private_tutor')],
      selectedDomain: 'student',
      onDomainSelect,
    });

    expect(screen.getByText('Browse')).toBeInTheDocument();
    // Domain ids are humanised for the tab labels.
    expect(screen.getByRole('button', { name: 'Private Tutor' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Student' })).toHaveAttribute('data-active', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Private Tutor' }));
    expect(onDomainSelect).toHaveBeenCalledWith('private_tutor');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onDomainSelect).toHaveBeenCalledWith(null);
  });

  it('hides the browse selector on the form page even with several domains', () => {
    renderSidebar({ domains: [domain('student'), domain('private_tutor')], hideBrowse: true });
    expect(screen.queryByText('Browse')).toBeNull();
  });

  it('shows a single domain group flat, with its network-authored heading', () => {
    renderSidebar({
      domains: [domain('private_tutor', { my_items_label: 'My Jobs' })],
      myItems: [
        makeItem({
          item_id: 'p-1',
          item_domain: 'private_tutor',
          item_state: { name: 'Physics tuition' },
          lifecycle_status: 'live',
        }),
      ],
      userSchemas: { private_tutor: nameSchema },
      activeProfileId: 'p-1',
    });

    expect(screen.getByText('My Jobs')).toBeInTheDocument();
    expect(screen.queryByText('My Profile(s)')).toBeNull();
    // A lone group has no accordion header — no count chip, profile shown flat.
    expect(screen.getByText('Physics tuition')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Private Tutor 1/ })).toBeNull();
  });

  it('labels each profile with its lifecycle status', () => {
    renderSidebar({
      myItems: [
        makeItem({ item_id: 'p-1', item_state: { name: 'Live one' }, lifecycle_status: 'live' }),
        makeItem({ item_id: 'p-2', item_state: { name: 'Paused one' }, lifecycle_status: 'paused' }),
        makeItem({ item_id: 'p-3', item_state: { name: 'Draft one' }, lifecycle_status: 'draft' }),
        makeItem({ item_id: 'p-4', item_state: { name: 'Unknown one' } }),
      ],
      userSchemas: { student: nameSchema },
    });

    // `live` reads as "Active" to owners, not as the internal status word.
    expect(screen.getByText('Active')).toHaveClass('bg-green-100');
    expect(screen.getByText('Paused')).toHaveClass('bg-amber-100');
    expect(screen.getByText('Draft')).toHaveClass('bg-slate-200');
    // A profile with no lifecycle status gets no chip at all.
    expect(screen.getByText('Unknown one')).toBeInTheDocument();
    expect(screen.getAllByText(/^(Active|Paused|Draft)$/)).toHaveLength(3);
  });

  it('falls back through the title candidates when naming a profile row', () => {
    renderSidebar({
      myItems: [
        makeItem({ item_id: 'p-1', item_state: { name: 'Named by name' } }),
        makeItem({ item_id: 'p-2', item_state: { nickname: 'ignored' } }),
      ],
      userSchemas: { student: nameSchema },
    });

    expect(screen.getByText('Named by name')).toBeInTheDocument();
    // The schema declares `name`, but this item has no value for it.
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });

  it('names a row from the first schema field when no candidate key matches', () => {
    renderSidebar({
      myItems: [makeItem({ item_id: 'p-1', item_state: { headline: 'Maths mentor' } })],
      userSchemas: { student: headlineSchema },
    });

    expect(screen.getByText('Maths mentor')).toBeInTheDocument();
  });

  it('falls back to a generic row label when no schema is available', () => {
    renderSidebar({
      myItems: [makeItem({ item_id: 'p-1', item_state: { name: 'Hidden without a schema' } })],
    });

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.queryByText('Hidden without a schema')).toBeNull();
  });

  it('accordions several domain groups, opening the active profile’s domain', async () => {
    const onActiveProfileChange = vi.fn((profileId: string) => profileId);
    renderSidebar({
      domains: [domain('student', { my_items_label: 'My Studies' }), domain('private_tutor')],
      myItems: [
        makeItem({ item_id: 'p-1', item_domain: 'student', item_state: { name: 'My learning' } }),
        makeItem({
          item_id: 'p-2',
          item_domain: 'private_tutor',
          item_state: { name: 'My tutoring' },
        }),
      ],
      userSchemas: { student: nameSchema, private_tutor: nameSchema },
      activeProfileId: 'p-1',
      onActiveProfileChange,
    });

    // Mixed domains ⇒ the per-domain override does not apply.
    expect(screen.getByText('My Profile(s)')).toBeInTheDocument();
    expect(screen.queryByText('My Studies')).toBeNull();

    // The active profile's domain starts expanded; the other stays collapsed.
    expect(screen.getByText('My learning')).toBeInTheDocument();
    expect(screen.queryByText('My tutoring')).toBeNull();

    // The accordion header carries the group's profile count, which is what
    // distinguishes it from the same-named Browse tab above it.
    const tutorHeader = screen.getByRole('button', { name: 'Private Tutor 1' });
    await userEvent.click(tutorHeader);
    expect(screen.getByText('My tutoring')).toBeInTheDocument();

    await userEvent.click(tutorHeader);
    expect(screen.queryByText('My tutoring')).toBeNull();

    // Collapsing the active domain is allowed too, and re-selecting a profile
    // is reported to the owner.
    await userEvent.click(screen.getByText('My learning'));
    expect(onActiveProfileChange).toHaveBeenCalledWith('p-1');
  });

  it('expands the domain of a newly activated profile', () => {
    const props = {
      domains: [domain('student'), domain('private_tutor')],
      myItems: [
        makeItem({ item_id: 'p-1', item_domain: 'student', item_state: { name: 'My learning' } }),
        makeItem({
          item_id: 'p-2',
          item_domain: 'private_tutor',
          item_state: { name: 'My tutoring' },
        }),
      ],
      userSchemas: { student: nameSchema, private_tutor: nameSchema },
      selectedDomain: null,
      onDomainSelect: () => {},
    };
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <SidebarProvider>
          <AppSidebar {...props} activeProfileId="p-1" />
        </SidebarProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText('My tutoring')).toBeNull();

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <SidebarProvider>
          <AppSidebar {...props} activeProfileId="p-2" />
        </SidebarProvider>
      </MemoryRouter>,
    );

    // Both are open now: switching profiles reveals the new one without
    // collapsing what was already expanded.
    expect(screen.getByText('My tutoring')).toBeInTheDocument();
    expect(screen.getByText('My learning')).toBeInTheDocument();
  });

  it('navigates to the actions page and badges the pending count', async () => {
    setPendingCount(7);
    renderSidebar();

    expect(screen.getByText('7')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /My Actions/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/my-actions');
  });

  it('caps a large pending count and shows no badge at zero', () => {
    setPendingCount(250);
    const { unmount } = renderSidebar();
    expect(screen.getByText('99+')).toBeInTheDocument();
    unmount();

    setPendingCount(0);
    renderSidebar();
    expect(screen.queryByText('99+')).toBeNull();
    expect(screen.getByRole('button', { name: 'My Actions' })).toBeInTheDocument();
  });

  it('treats an unresolved pending count as no badge', () => {
    setPendingCount(undefined);
    renderSidebar();
    expect(screen.getByRole('button', { name: 'My Actions' })).toBeInTheDocument();
  });
});
