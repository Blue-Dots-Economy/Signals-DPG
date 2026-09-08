import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { takePendingWrongPortal } from '@/lib/pending-wrong-portal';

/**
 * The post-login completion steps the OTP flow performs in `otp-page.tsx` but
 * the OIDC callback originally did not — gaps G3 (durable domains/age), G4 (the
 * U18 guardian gate) and G7 (the wrong-portal domain gate) of
 * docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md.
 *
 * These assert the callback's *orchestration*: which steps run, in what order,
 * and what stops the user landing. The children (guardian flow, consent modal)
 * and the pure helpers have their own tests.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@/hooks/use-auth-config', () => ({
  useAuthConfig: () => ({
    config: {
      selfSignupAllowed: true,
      loginChannels: ['phone', 'email'],
      authProvider: 'keycloak',
      keycloak: { url: 'http://kc', realm: 'bluedots', clientId: 'signals-ui' },
    },
    isLoading: false,
    isKeycloakLogin: true,
  }),
}));

const completeKeycloakLogin = vi.fn(async () => {});
const signOut = vi.fn(async () => {});
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ completeKeycloakLogin, signOut }),
}));

const completeOidcLogin = vi.fn(async () => ({ returnTo: '/dashboard' }));
const oidcLogout = vi.fn(async (_cfg?: unknown) => undefined);
const startOidcLogin =
  vi.fn<(cfg?: unknown, options?: unknown) => Promise<void>>(async () => undefined);
vi.mock('@/lib/oidc-client', () => ({
  completeOidcLogin: () => completeOidcLogin(),
  startOidcLogin: (cfg?: unknown, options?: unknown) => startOidcLogin(cfg, options),
  oidcLogout: (cfg?: unknown) => oidcLogout(cfg),
}));

vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: 'blue_dot', brand: 'standard' }),
}));

// ── the seams under test ───────────────────────────────────────────────────
let servedScope: { network: string; domains: string[] } | null = null;
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => servedScope }));

const resolveHeldDomains = vi.fn(async () => [] as string[]);
vi.mock('@/lib/domain-gate', async (orig) => ({
  ...(await orig<typeof import('@/lib/domain-gate')>()),
  resolveHeldDomains: () => resolveHeldDomains(),
}));

/**
 * The U18 gate is domain-scoped: only a domain with
 * `guardian_consent_required` routes through the guardian flow, so a provider
 * is never asked for a date of birth. `seeker` is gated here, `provider` is not.
 */
const fetchNetworkConfig = vi.fn(async () => ({
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
}));
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: () => fetchNetworkConfig(),
}));

const takePendingSignupExtras =
  vi.fn<() => { domain: string; age?: number } | null>(() => null);
vi.mock('@/lib/pending-signup-extras', () => ({
  takePendingSignupExtras: () => takePendingSignupExtras(),
}));

const takePendingConsent = vi.fn<() => unknown>(() => null);
vi.mock('@/lib/pending-consent', () => ({
  takePendingConsent: () => takePendingConsent(),
}));

const setUserDomains = vi.fn(async (_domains: string[]) => ['seeker']);
vi.mock('@/lib/user-api', () => ({ setUserDomains: (d: string[]) => setUserDomains(d) }));

const setStoredSignupDomain = vi.fn();
vi.mock('@/lib/signup-domain', () => ({
  setStoredSignupDomain: (n: string, d: string) => setStoredSignupDomain(n, d),
}));

const submitU18Dob = vi.fn(async (_body: { network: string; age: number }) => ({ ok: true }));
const getU18Status = vi.fn(async () => ({
  hasBirthData: false,
  isMinor: false,
  guardianVerified: false,
}));
const acceptConsent = vi.fn(async (_body: unknown) => ({ ok: true }));
const fetchConsentConfigs = vi.fn(async () => [] as unknown[]);
const getConsentStatus = vi.fn(async () => ({ statuses: { terms: [], privacy: [] } }));
vi.mock('@/lib/consent-api', () => ({
  acceptConsent: (b: unknown) => acceptConsent(b),
  fetchConsentConfigs: () => fetchConsentConfigs(),
  getConsentStatus: () => getConsentStatus(),
  getU18Status: () => getU18Status(),
  submitU18Dob: (b: { network: string; age: number }) => submitU18Dob(b),
}));

vi.mock('@/components/consent/u18/u18-guardian-flow', () => ({
  U18GuardianFlow: (props: { initialStep: string; onComplete: () => void }) => (
    <div data-testid="u18-guardian-flow" data-initial-step={props.initialStep}>
      <button type="button" onClick={props.onComplete}>
        guardian done
      </button>
    </div>
  ),
}));

vi.mock('@/components/consent/consent-modal', () => ({
  ConsentModal: () => <div data-testid="consent-modal" />,
}));

vi.mock('@/components/layout/auth-shell', () => ({
  AuthShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// #558: the first-time-login profile check the callback now shares with the OTP
// page. Default (set in beforeEach) is a live profile, so tests that are not
// about the redirect land normally.
const fetchMyProfilesLite = vi.fn();
vi.mock('@/lib/login-profiles', () => ({
  fetchMyProfilesLite: (networkId: string) => fetchMyProfilesLite(networkId),
}));

const { OidcCallbackPage } = await import('../oidc-callback-page');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OidcCallbackPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  servedScope = null;
  resolveHeldDomains.mockResolvedValue([]);
  takePendingSignupExtras.mockReturnValue(null);
  takePendingConsent.mockReturnValue(null);
  setUserDomains.mockResolvedValue(['seeker']);
  submitU18Dob.mockResolvedValue({ ok: true });
  // Default: a resolved ADULT, so tests that are not about the U18 gate never
  // trip it. `hasBirthData: false` is now itself a gating condition (an unknown
  // age must be captured), so leaving it as the default would hold every test
  // on the guardian flow.
  getU18Status.mockResolvedValue({
    hasBirthData: true,
    isMinor: false,
    guardianVerified: false,
  });
  getConsentStatus.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  fetchConsentConfigs.mockResolvedValue([]);
  completeOidcLogin.mockResolvedValue({ returnTo: '/dashboard' });
  // A completed profile → no #376 redirect, so existing expectations hold.
  fetchMyProfilesLite.mockResolvedValue([
    { item_id: 'p1', item_domain: 'seeker', lifecycle_status: 'live' },
  ]);
  localStorage.clear();
});

describe('G7 — wrong-portal domain gate', () => {
  it('signs a user out and bounces them when they hold an unserved domain', async () => {
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockResolvedValue(['provider']);

    renderPage();

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith('/auth/login', {
      replace: true,
      state: { wrongPortalDomain: 'provider' },
    });
    // Nothing may be written for a user who is being turned away.
    expect(setUserDomains).not.toHaveBeenCalled();
    expect(getU18Status).not.toHaveBeenCalled();
  });

  /**
   * The regression this file previously could not see: `signOut` is mocked as
   * an instantly-resolving fn here, but under Keycloak it hands off to
   * `signoutRedirect()` — a full-page navigation whose promise never settles.
   * Everything after that await, including the `navigate` carrying
   * `wrongPortalDomain`, never runs, and Keycloak returns the browser to the
   * site root with a fresh document that has no router state. The user was
   * bounced with no explanation.
   *
   * So the reason must be parked BEFORE `signOut` is awaited. Modelled here
   * with a `signOut` that never resolves, which is what actually happens.
   */
  it('parks the reason before signing out, so a never-returning signOut still explains itself', async () => {
    servedScope = { network: 'blue_dot', domains: ['provider'] };
    resolveHeldDomains.mockResolvedValue(['seeker']);
    signOut.mockImplementationOnce(() => new Promise<void>(() => {}));

    renderPage();

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalledWith('/auth/login', expect.anything());
    expect(takePendingWrongPortal()).toBe('seeker');
  });

  it('lands a user who holds only served domains', async () => {
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockResolvedValue(['seeker']);

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it('is skipped entirely when the deployment has no served scope', async () => {
    servedScope = null;

    renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(resolveHeldDomains).not.toHaveBeenCalled();
  });
});

describe('G3 — durable domains/age write', () => {
  it('persists the parked domain and hands it to the profile form', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalledWith(['seeker']));
    expect(setStoredSignupDomain).toHaveBeenCalledWith('blue_dot', 'seeker');
  });

  it('persists the age when one was captured', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });

    renderPage();

    await waitFor(() =>
      expect(submitU18Dob).toHaveBeenCalledWith({ network: 'blue_dot', age: 15 })
    );
  });

  it('does not submit an age for an ungated signup that captured none', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'provider' });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalled());
    expect(submitU18Dob).not.toHaveBeenCalled();
  });

  it('still lands the user when the domain write fails', async () => {
    // Best-effort: profile-form falls back to held items if unset.
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });
    setUserDomains.mockRejectedValue(new Error('network'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('still lands the user when the age write fails', async () => {
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });
    submitU18Dob.mockRejectedValue(new Error('network'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('writes nothing for a returning user with nothing parked', async () => {
    takePendingSignupExtras.mockReturnValue(null);

    renderPage();

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(setUserDomains).not.toHaveBeenCalled();
    expect(submitU18Dob).not.toHaveBeenCalled();
  });
});

describe('G4 — authenticated U18 guardian gate', () => {
  // The gate keys on the domain of a profile the user already holds, mirroring
  // how home-page derives `wardDomain` from `myItem.item_domain`.
  beforeEach(() => {
    resolveHeldDomains.mockResolvedValue(['seeker']);
  });

  it('holds an unverified minor on the guardian flow instead of landing them', async () => {
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    const flow = await screen.findByTestId('u18-guardian-flow');
    // Birth data already stored → skip straight to the guardian step.
    expect(flow.getAttribute('data-initial-step')).toBe('guardian');
    expect(navigate).not.toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('starts at the DOB step when no birth data is stored', async () => {
    // The Keycloak chooser has no pre-login step to collect it, unlike the OTP
    // flow's u18Precheck — so the callback must be able to ask here.
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    const flow = await screen.findByTestId('u18-guardian-flow');
    expect(flow.getAttribute('data-initial-step')).toBe('dob');
  });

  it('holds the user BEFORE navigating anywhere — the whole point of gating here', async () => {
    // The defect this guards: the gate used to miss an unknown age, the user
    // landed, and home-page's backstop then rendered the DOB step ON TOP OF the
    // map. Asserting "the flow renders" is not enough — it has to render
    // instead of a navigation, not after one.
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: false,
      guardianVerified: false,
    });

    renderPage();

    await screen.findByTestId('u18-guardian-flow');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('gates a user whose age is UNKNOWN, even though isMinor is false', async () => {
    // The regression this guard exists for: `isMinor` is `age !== null &&
    // isMinor(age)` server-side, so an aggregator-onboarded user (bulk upload /
    // form link never captures an age) reports isMinor:false. Gating on isMinor
    // alone let them land, and home-page's backstop then rendered the DOB step
    // on top of the map view.
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: false,
      guardianVerified: false,
    });

    renderPage();

    const flow = await screen.findByTestId('u18-guardian-flow');
    expect(flow.getAttribute('data-initial-step')).toBe('dob');
    expect(navigate).not.toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('never asks a provider for a date of birth', async () => {
    // `provider` has guardian_consent_required: false — no U18 flow applies, so
    // an unknown age is not a reason to hold them.
    resolveHeldDomains.mockResolvedValue(['provider']);
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: false,
      guardianVerified: false,
    });

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(screen.queryByTestId('u18-guardian-flow')).toBeNull();
  });

  it('does not gate a user with no profile yet — there is no domain to judge', async () => {
    // Gated later, at profile creation, once they pick a domain.
    resolveHeldDomains.mockResolvedValue([]);
    getU18Status.mockResolvedValue({
      hasBirthData: false,
      isMinor: false,
      guardianVerified: false,
    });

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(fetchNetworkConfig).not.toHaveBeenCalled();
  });

  it('does not gate a minor whose guardian is already verified', async () => {
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: true,
    });

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
    expect(screen.queryByTestId('u18-guardian-flow')).toBeNull();
  });

  it('falls through and lands the user when the status lookup fails', async () => {
    // The server-side go-live gate is the real fail-closed control.
    getU18Status.mockRejectedValue(new Error('status down'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('skips the adult consent gate for a gated minor', async () => {
    // #453: the guardian flow records their consent guardian-sourced, so the
    // adult terms/privacy screens must not also be shown.
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    await screen.findByTestId('u18-guardian-flow');
    expect(screen.queryByTestId('consent-modal')).toBeNull();
    expect(getConsentStatus).not.toHaveBeenCalled();
  });
});

describe('ordering', () => {
  it('applies the parked age before checking U18 status', async () => {
    // Otherwise a fresh minor's age is not yet stored and the gate reports
    // isMinor:false, silently skipping the guardian capture.
    const order: string[] = [];
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker', age: 15 });
    submitU18Dob.mockImplementation(async () => {
      order.push('submitU18Dob');
      return { ok: true };
    });
    getU18Status.mockImplementation(async () => {
      order.push('getU18Status');
      return { hasBirthData: true, isMinor: false, guardianVerified: false };
    });

    renderPage();

    await waitFor(() => expect(getU18Status).toHaveBeenCalled());
    expect(order).toEqual(['submitU18Dob', 'getU18Status']);
  });

  it('runs the domain gate before any write', async () => {
    const order: string[] = [];
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
    resolveHeldDomains.mockImplementation(async () => {
      order.push('domainGate');
      return [];
    });
    takePendingSignupExtras.mockReturnValue({ domain: 'seeker' });
    setUserDomains.mockImplementation(async () => {
      order.push('setUserDomains');
      return ['seeker'];
    });

    renderPage();

    await waitFor(() => expect(setUserDomains).toHaveBeenCalled());
    expect(order).toEqual(['domainGate', 'setUserDomains']);
  });
});

/**
 * #558 — the #376 first-time-login profile redirect, which previously lived
 * only in `otp-page.tsx` and so never ran under `AUTH_PROVIDER=keycloak`.
 * The decision itself is `resolvePostLoginRedirect` (unit-tested separately);
 * these assert the callback *applies* it, and that it composes correctly with
 * the gates that can hold a user before landing.
 */
describe('#558 — first-time-login profile redirect', () => {
  it('sends a user with no profiles to the create page instead of the return url', async () => {
    fetchMyProfilesLite.mockResolvedValue([]);

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/profile/new', { replace: true })
    );
    // The redirect takes precedence over returnTo — a user with no completed
    // profile can't act on a deep link anyway.
    expect(navigate).not.toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('sends a user whose profiles are all draft to the edit page', async () => {
    fetchMyProfilesLite.mockResolvedValue([
      { item_id: 'draft1', item_domain: 'seeker', lifecycle_status: 'draft' },
    ]);

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/profile/draft1/edit', { replace: true })
    );
  });

  it('leaves a user with a completed profile on the normal landing', async () => {
    fetchMyProfilesLite.mockResolvedValue([
      { item_id: 'p1', item_domain: 'seeker', lifecycle_status: 'live' },
    ]);

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('still lands the user when the profile lookup fails — never blocks sign-in', async () => {
    fetchMyProfilesLite.mockRejectedValue(new Error('network down'));

    renderPage();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    );
  });

  it('holds a gated minor on the guardian flow FIRST, rather than the profile form', async () => {
    // The gate keys on a domain the user already holds, so it needs one — as in
    // the G4 block above.
    resolveHeldDomains.mockResolvedValue(['seeker']);
    fetchMyProfilesLite.mockResolvedValue([]);
    getU18Status.mockResolvedValue({
      hasBirthData: true,
      isMinor: true,
      guardianVerified: false,
    });

    renderPage();

    await screen.findByTestId('u18-guardian-flow');
    expect(navigate).not.toHaveBeenCalledWith('/profile/new', { replace: true });
  });

  it('resolves the landing only after the session exists — an authenticated read', async () => {
    const order: string[] = [];
    completeKeycloakLogin.mockImplementation(async () => {
      order.push('session');
    });
    fetchMyProfilesLite.mockImplementation(async () => {
      order.push('profiles');
      return [];
    });

    renderPage();

    await waitFor(() => expect(fetchMyProfilesLite).toHaveBeenCalled());
    expect(order).toEqual(['session', 'profiles']);
  });

  describe('cross-app sign-in (#753)', () => {
    /** Fails the exchange with an API error carrying `code` + `message`. */
    function rejectWith(code: string, message: string) {
      completeOidcLogin.mockRejectedValue({
        response: { data: { code, message } },
      });
    }

    it('ENDS the session when the caller is an aggregator account', async () => {
      // "Back to sign in" is a loop: Keycloak's SSO cookie is still valid, so
      // the login page returns the same identity and the same error.
      //
      // A forced re-prompt does not fix it either. `prompt=login`
      // re-authenticates the CURRENT user, so entering a different one makes
      // Keycloak throw USER_CONFLICT and report `invalid_user_credentials` —
      // rendered as "Invalid username or password" on a passwordless flow.
      // Only ending the session clears the authenticated user.
      rejectWith('TOKEN_AGGREGATOR_ACCOUNT', 'You are signed in as an aggregator account.');
      renderPage();

      const button = await screen.findByRole('button', { name: /different account/i });
      fireEvent.click(button);

      await waitFor(() => expect(oidcLogout).toHaveBeenCalled());
      // Regression guard: starting a fresh login here is the broken behaviour.
      expect(startOidcLogin).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalledWith('/auth/login', { replace: true });
    });

    it('shows the LOCALISED body, not the API English, for that case', async () => {
      // The API message is English by construction (it doubles as log and
      // API-client copy). Rendering it verbatim put an English sentence above
      // a translated button on a Hindi or Kannada session.
      rejectWith('TOKEN_AGGREGATOR_ACCOUNT', 'RAW-API-ENGLISH-SHOULD-NOT-RENDER');
      renderPage();
      expect(
        await screen.findByText(/signed in as an aggregator account/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/RAW-API-ENGLISH-SHOULD-NOT-RENDER/)).toBeNull();
    });

    it('keeps the plain retry for any other failure', async () => {
      rejectWith('TOKEN_ROLE_REJECTED', 'This account is not a participant of the Signals Stack');
      renderPage();

      expect(await screen.findByText(/not a participant/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /different account/i })).toBeNull();
    });

    it('falls back to the login page when the sign-out cannot start', async () => {
      // A dead button would be worse than a redirect that at least moves them.
      rejectWith('TOKEN_AGGREGATOR_ACCOUNT', 'You are signed in as an aggregator account.');
      oidcLogout.mockRejectedValueOnce(new Error('keycloak unreachable'));
      renderPage();

      fireEvent.click(await screen.findByRole('button', { name: /different account/i }));
      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith('/auth/login', { replace: true }),
      );
    });
  });
});
