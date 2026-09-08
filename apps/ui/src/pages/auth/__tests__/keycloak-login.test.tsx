import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { pickBirthYear } from '@/test/pick-dob';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Build 2's merge-safety property: with `VITE_AUTH_PROVIDER` unset, /auth/login
 * still renders the OTP screen and nothing OIDC-related runs. Plus the happy
 * and unhappy paths of the Keycloak screen itself.
 */

const CURRENT_YEAR = new Date().getFullYear();

// The login screen is now chosen from the API's auth config, not a build-time
// env var, so the hook is what gets stubbed.
let keycloakEnabled = false;
let configLoading = false;
let signupAllowed = true;
/** Which channels the instance runs — drives the signup form's identifier choice. */
let loginChannels: Array<'phone' | 'email'> = ['phone', 'email'];
vi.mock('@/hooks/use-auth-config', () => ({
  useAuthConfig: () => ({
    config: {
      selfSignupAllowed: signupAllowed,
      loginChannels,
      authProvider: keycloakEnabled ? 'keycloak' : 'betterauth',
      keycloak: keycloakEnabled
        ? { url: 'http://localhost:8080', realm: 'bluedots', clientId: 'signals-ui' }
        : null,
    },
    isLoading: configLoading,
    isKeycloakLogin: keycloakEnabled,
  }),
}));

const startKeycloakLogin = vi.fn(async () => {});
const completeKeycloakLogin = vi.fn(async () => {});

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isKeycloakLogin: keycloakEnabled,
    startKeycloakLogin,
    completeKeycloakLogin,
    checkUser: vi.fn(),
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

/** Stands in for the id minted per login attempt (see pending-consent.ts). */
const PARKED_ATTEMPT = 'test-attempt-id';

// The OTP screen fetches instance auth config and the network on mount; stub
// both so the "toggle off" case doesn't reach for a real API.
vi.mock('@/lib/auth-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-api')>()),
  fetchAuthConfig: vi
    .fn()
    .mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone', 'email'] }),
  signupWithKeycloak: (body: SignupBody) => signupWithKeycloak(body),
}));
/** The served network's own schema, feeding the signup domain picker. */
const NETWORK_CONFIG = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
};
const fetchNetworkConfig = vi.fn<() => Promise<typeof NETWORK_CONFIG>>();
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: () => fetchNetworkConfig(),
}));
/** Which domains this deployment serves. null = all (the default here). */
let servedScope: { network: string; domains: string[] } | null = null;
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => servedScope }));

type SignupBody = {
  name: string;
  email?: string;
  phoneNumber?: string;
  domain?: string;
  age?: number;
};
const signupWithKeycloak =
  vi.fn<(body: SignupBody) => Promise<{ ok: true; alreadyRegistered: boolean }>>();

// AuthShell renders the footer, which reads consent config through React Query.
const fetchConsentConfigs = vi.fn<() => Promise<unknown[]>>();
const getConsentStatusByIdentifier =
  vi.fn<() => Promise<{ statuses: { terms: string[]; privacy: string[] } }>>();
type AcceptBody = { source: string; items: Array<{ category: string; version: string }> };
const acceptConsent = vi.fn<(body: AcceptBody) => Promise<{ ok: boolean }>>();
const getConsentStatus =
  vi.fn<() => Promise<{ statuses: { terms: string[]; privacy: string[] } }>>();
vi.mock('@/lib/consent-api', () => ({
  fetchConsentConfigs: () => fetchConsentConfigs(),
  getConsentStatusByIdentifier: () => getConsentStatusByIdentifier(),
  getConsentStatus: () => getConsentStatus(),
  acceptConsent: (body: AcceptBody) => acceptConsent(body),
}));

// Stub the pre-auth guardian flow so we assert the panel's gating wiring, not
// the child's internals — those have their own tests.
const guardianComplete = vi.fn();
vi.mock('@/components/consent/u18/signup-guardian-flow', () => ({
  SignupGuardianFlow: (props: {
    domain: string;
    age: number;
    identifier: { email?: string; phoneNumber?: string };
    onComplete: () => void;
  }) => {
    guardianComplete.mockImplementation(props.onComplete);
    return (
      <div
        data-testid="signup-guardian-flow"
        data-domain={props.domain}
        data-age={String(props.age)}
        data-identifier={props.identifier.email ?? props.identifier.phoneNumber ?? ''}
      >
        <button type="button" onClick={props.onComplete}>guardian done</button>
      </div>
    );
  },
}));

// Stub the modal so we assert the panel's gating wiring, not the child's
// internals — those have their own tests.
const consentAcceptSpy = vi.fn();
vi.mock('@/components/consent/consent-modal', () => ({
  ConsentModal: (props: { onAccept: () => void }) => {
    consentAcceptSpy.mockImplementation(props.onAccept);
    return (
      <div data-testid="consent-modal">
        <button type="button" onClick={props.onAccept}>
          accept consent
        </button>
      </div>
    );
  },
}));
vi.mock('@/theme/theme-provider', async () => {
  const { resolveTheme } = await import('@/theme/network-themes');
  return {
    useNetworkTheme: () => ({
      themeId: 'blue_dot',
      theme: resolveTheme('blue_dot'),
      brand: 'standard',
    }),
  };
});

// #558: the callback now resolves the first-time-login profile redirect before
// landing. Unmocked, this would make a real request that never settles in jsdom
// and hold the page on the spinner. Default is a completed profile, so the
// landing assertions below are unaffected.
const fetchMyProfilesLite = vi.fn();
vi.mock('@/lib/login-profiles', () => ({
  fetchMyProfilesLite: (networkId: string) => fetchMyProfilesLite(networkId),
}));

const { LoginPage } = await import('../login-page.js');
const { OidcCallbackPage } = await import('../oidc-callback-page.js');

/**
 * The callback page reads `returnTo` / `consentAttempt` off `window.location`,
 * not off the router: they arrive on the redirect the API sends the browser to
 * after it has done the code exchange (AUTH-VULN-03/04). MemoryRouter never
 * touches the real URL, so keep the two in step here.
 */
const wrap = (ui: React.ReactElement, path: string) => {
  window.history.replaceState({}, '', path);
  return (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/auth/login" element={ui} />
        <Route path="/auth/callback" element={ui} />
        <Route path="/profile/new" element={<div>profile form</div>} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
  );
};

const renderAt = (ui: React.ReactElement, path = '/auth/login') => render(wrap(ui, path));

/**
 * Where Keycloak's redirect actually lands. The `consentAttempt` the API hands
 * back identifies the login attempt that parked a consent, so an acceptance is
 * only honoured by the login that parked it.
 */
const CALLBACK_PATH = `/auth/callback?consentAttempt=${PARKED_ATTEMPT}`;

/**
 * Pick a domain on the signup form. The mocked network serves two domains, so
 * the picker is shown and a signup cannot be submitted without a choice — the
 * same rule the OTP screen applies. Tests that aren't *about* the domain still
 * have to make one, exactly as a real user would.
 */
const pickDomain = async (name: RegExp = /^provider$/i) =>
  userEvent.click(await screen.findByRole('button', { name }));

beforeEach(() => {
  keycloakEnabled = false;
  configLoading = false;
  signupAllowed = true;
  servedScope = null;
  fetchNetworkConfig.mockReset().mockResolvedValue(NETWORK_CONFIG);
  fetchMyProfilesLite.mockReset().mockResolvedValue([
    { item_id: 'p1', item_domain: 'seeker', lifecycle_status: 'live' },
  ]);
  loginChannels = ['phone', 'email'];
  startKeycloakLogin.mockClear().mockResolvedValue(undefined);
  completeKeycloakLogin.mockClear().mockResolvedValue(undefined);
  signupWithKeycloak.mockClear().mockResolvedValue({ ok: true, alreadyRegistered: false });
  // Default: consent already accepted for the current version, so no gate.
  fetchConsentConfigs.mockReset().mockResolvedValue([]);
  getConsentStatusByIdentifier
    .mockReset()
    .mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  acceptConsent.mockClear().mockResolvedValue({ ok: true });
  // Default: nothing outstanding, so the callback's login-time gate stays shut.
  getConsentStatus.mockReset().mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  guardianComplete.mockClear();
  localStorage.clear();
});

/** A consent config whose current versions are NOT yet accepted. */
const CONSENT_CONFIGS = [
  {
    brand: null,
    schema: {
      documents: {
        terms: { current_version: 'v2', title: 'Terms', body: 'terms body' },
        privacy: { current_version: 'v2', title: 'Privacy', body: 'privacy body' },
      },
    },
  },
];

describe('LoginPage provider switch', () => {
  it('renders the OTP screen when the toggle is off', () => {
    renderAt(<LoginPage />);

    // The OTP screen's identifier field; the Keycloak panel has no inputs.
    expect(document.querySelector('input')).not.toBeNull();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('renders the Keycloak panel when the toggle is on', () => {
    keycloakEnabled = true;

    renderAt(<LoginPage />);

    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
    expect(document.querySelector('input')).toBeNull();
  });
});

describe('KeycloakLoginPanel', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('redirects to Keycloak on click', async () => {
    renderAt(<LoginPage />);

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/', undefined));
  });

  it('round-trips the ?redirect= target so a deep link survives login', async () => {
    renderAt(<LoginPage />, '/auth/login?redirect=%2Fprofile%2Fnew');

    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/profile/new', undefined));
  });

  it('surfaces a redirect failure instead of hanging on a spinner', async () => {
    startKeycloakLogin.mockRejectedValueOnce(new Error('Keycloak is not configured'));

    renderAt(<LoginPage />);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Keycloak is not configured')).toBeTruthy();
    // Re-enabled, so the user can retry.
    expect(screen.getByRole('button', { name: /continue/i })).toBeTruthy();
  });
});

describe('OidcCallbackPage', () => {
  // You only reach the callback when Keycloak is the provider, and the page now
  // requires the server to advertise it before touching the single-use code.
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('picks up the session the API already opened, resolves the user, and lands on home', async () => {
    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText('home')).toBeTruthy();
    expect(completeKeycloakLogin).toHaveBeenCalledOnce();
  });

  it('honours the returnTo the API hands back on the redirect', async () => {
    renderAt(<OidcCallbackPage />, `${CALLBACK_PATH}&returnTo=%2Fprofile%2Fnew`);

    expect(await screen.findByText('profile form')).toBeTruthy();
  });

  it('resolves the session exactly once', async () => {
    // StrictMode double-invokes effects. The single-use code is the API's
    // problem now, but this page still runs a chain of writes (parked consent,
    // signup domain/age) that must not happen twice.
    const { rerender } = renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    rerender(wrap(<OidcCallbackPage />, CALLBACK_PATH));

    await waitFor(() => expect(completeKeycloakLogin).toHaveBeenCalledTimes(1));
  });

  it("shows the API's own message when provisioning refuses the login", async () => {
    // This is how SELF_SIGNUP_DISABLED / USER_BANNED reach the user: as the
    // API's message on GET /api/v1/auth/me, not a generic failure.
    completeKeycloakLogin.mockRejectedValueOnce({
      response: {
        data: {
          code: 'SELF_SIGNUP_DISABLED',
          message: 'Self sign-up is disabled on this instance.',
        },
      },
    });

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(
      await screen.findByText('Self sign-up is disabled on this instance.')
    ).toBeTruthy();
  });

  it('falls back to a generic message when the failure carries none', async () => {
    completeKeycloakLogin.mockRejectedValueOnce({});

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
  });
});

describe('OidcCallbackPage — the redirect-loop regression', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('does not exchange the code while the auth config is still loading', async () => {
    // The bug: this page runs once, behind a ref guard, and used to run before
    // /api/v1/auth/config had resolved — so it decided the instance was not
    // Keycloak-configured, set the guard, and never retried. The user then
    // bounced between the error and Keycloak's still-valid SSO session. The
    // guard is still one-shot, so the "wait for config" half still matters.
    configLoading = true;

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    // Still on the spinner, and crucially nothing has been decided yet.
    expect(await screen.findByText(/signing you in/i)).toBeTruthy();
    expect(completeKeycloakLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(/not configured/i)).toBeNull();
  });

  it('runs exactly once, after the config arrives', async () => {
    configLoading = true;
    const { rerender } = renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    expect(completeKeycloakLogin).not.toHaveBeenCalled();

    // Config resolves.
    configLoading = false;
    rerender(wrap(<OidcCallbackPage />, CALLBACK_PATH));

    await waitFor(() => expect(completeKeycloakLogin).toHaveBeenCalledTimes(1));
  });

  it('reports an unconfigured instance distinctly from a failed sign-in', async () => {
    // Config loaded but advertises no Keycloak: either the API isn't in a
    // Keycloak mode, or the config request failed outright.
    keycloakEnabled = false;

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText(/single sign-on isn't available/i)).toBeTruthy();
    expect(completeKeycloakLogin).not.toHaveBeenCalled();
  });
});

describe('KeycloakLoginPanel — existing vs new user chooser', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('offers both choices, and neither acts until picked', async () => {
    renderAt(<LoginPage />);

    expect(await screen.findByText(/existing user/i)).toBeTruthy();
    expect(screen.getByText(/new here/i)).toBeTruthy();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('sends an existing user straight to Keycloak', async () => {
    renderAt(<LoginPage />);

    await userEvent.click(await screen.findByText(/existing user/i));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalledWith('/', undefined));
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('re-enables the choices when the page comes back from the bfcache', async () => {
    // Clicking sign-in hands the browser to Keycloak, so the code after
    // `startKeycloakLogin` never runs and `isRedirecting` stays true by
    // design. Pressing Back restores this page from the back/forward cache
    // with that flag intact, which left every choice disabled with a spinner
    // until a manual reload. Modelled with a call that never settles — which
    // is what a real navigation looks like to this component.
    startKeycloakLogin.mockImplementationOnce(() => new Promise<void>(() => {}));

    renderAt(<LoginPage />);
    const existing = await screen.findByText(/existing user/i);
    await userEvent.click(existing);

    const choice = existing.closest('button');
    await waitFor(() => expect(choice?.disabled).toBe(true));

    // `persisted: true` is what marks a bfcache restore; a fresh load
    // re-runs the module and resets the state on its own.
    const event = new Event('pageshow') as Event & { persisted?: boolean };
    Object.defineProperty(event, 'persisted', { value: true });
    await act(async () => {
      window.dispatchEvent(event);
    });

    await waitFor(() => expect(choice?.disabled).toBe(false));
  });

  it('hides the signup choice when the instance is gated', async () => {
    // selfSignupAllowed comes from the API; a gated instance must not offer it.
    keycloakEnabled = true;
    signupAllowed = false;

    renderAt(<LoginPage />);

    expect(await screen.findByText(/existing user/i)).toBeTruthy();
    expect(screen.queryByText(/new here/i)).toBeNull();
  });

  it('explains a gated instance without claiming the account was not found', async () => {
    // The note renders on ARRIVAL, before any identifier is entered, so it
    // must not assert a lookup result. The better-auth path says "User
    // doesn't exist" only after one (login-page sets `signupBlocked` from
    // `exists === false`); reusing that string here told every visitor their
    // account was missing before they had typed anything.
    keycloakEnabled = true;
    signupAllowed = false;

    renderAt(<LoginPage />);

    // Matched on the explanatory clause, not "invite-only" alone — the
    // auth footer already carries an "Invite-only · …" line.
    expect(await screen.findByText(/created by an administrator/i)).toBeTruthy();
    expect(screen.queryByText(/doesn't exist/i)).toBeNull();
  });

  it('collects name, identifier, domain and birth year, then signs in', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    // The birth-year field only exists for a guardian-gated domain, so pick one first.
    await userEvent.click(await screen.findByRole('button', { name: /^seeker$/i }));
    await pickBirthYear(2005);

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    const [body] = signupWithKeycloak.mock.calls[0];
    expect(body.name).toBe('Asha Rao');
    expect(body.phoneNumber).toContain('9876543210');
    expect(body.age).toBe(CURRENT_YEAR - 2005);
    // Signup is followed immediately by the normal OIDC login.
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('refuses to submit without a name', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/please enter your name/i)).toBeTruthy();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('surfaces the API refusal message', async () => {
    signupWithKeycloak.mockRejectedValueOnce({
      response: { data: { code: 'SIGNUP_RATE_LIMITED', message: 'Too many sign-up attempts.' } },
    });

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/too many sign-up attempts/i)).toBeTruthy();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('still signs in when the identifier is already registered', async () => {
    signupWithKeycloak.mockResolvedValueOnce({ ok: true, alreadyRegistered: true });

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });
});

/**
 * Domain picker parity with the OTP signup form (login-page.tsx). A per-domain
 * portal must not ask a question with one answer, and a signup must never be
 * submitted without a domain: `domain` is optional on POST /auth/signup, so a
 * domainless signup creates an account with no `user.domains` — the
 * single-domain lock then never binds, and the age/guardian branch (which keys
 * off the selected domain) is skipped.
 */
describe('KeycloakLoginPanel — signup domain picker', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('hides the picker and auto-selects when the portal serves one domain', async () => {
    servedScope = { network: 'blue_dot', domains: ['provider'] };

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');

    // No choice to make: the label and the one-option toggle are both absent.
    await waitFor(() => expect(screen.queryByText(/your domain/i)).toBeNull());
    expect(screen.queryByRole('button', { name: /^provider$/i })).toBeNull();

    // …and the domain still reaches the API, without the user clicking anything.
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(signupWithKeycloak.mock.calls[0][0].domain).toBe('provider');
  });

  it('still offers the picker when the portal serves several domains', async () => {
    servedScope = { network: 'blue_dot', domains: ['seeker', 'provider'] };

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    expect(await screen.findByRole('button', { name: /^seeker$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^provider$/i })).toBeTruthy();
  });

  it('refuses to submit a signup with no domain chosen', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    // Two served domains, nothing picked — the account must not be created.
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // Still on the signup form with the picker waiting for a choice; awaiting a
    // query here also flushes the click's microtasks before the negative
    // assertions below, so "never called" means never, not "not yet".
    expect(await screen.findByRole('button', { name: /^seeker$/i })).toBeTruthy();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('retries the domain fetch after it failed, instead of dead-ending', async () => {
    // First load fails → no options at all, so nothing can be picked.
    fetchNetworkConfig.mockRejectedValueOnce(new Error('offline'));

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');

    // Submitting is refused AND schedules a refetch...
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(signupWithKeycloak).not.toHaveBeenCalled();

    // ...so the picker appears once the retry succeeds, with no page reload.
    await userEvent.click(await screen.findByRole('button', { name: /^provider$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(signupWithKeycloak.mock.calls[0][0].domain).toBe('provider');
  });

  it('does not retry when the config loaded but nothing is selectable', async () => {
    // A served binding naming a domain this network doesn't define: the fetch
    // succeeds, the option list is still empty, and no amount of retrying fixes
    // it — so the failure path must not spin the fetch.
    servedScope = { network: 'blue_dot', domains: ['not_a_real_domain'] };

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await waitFor(() => expect(fetchNetworkConfig).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(fetchNetworkConfig).toHaveBeenCalledTimes(1);
  });
});

describe('KeycloakLoginPanel — guardian-gated signup requires a birth year', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    // A single-domain portal on the gated domain: the picker is hidden and the
    // domain auto-selected, so the birth year is the only thing left to fill.
    servedScope = { network: 'blue_dot', domains: ['seeker'] };
  });

  it('refuses to create the account when the birth year is blank', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');

    // The birth-year field is shown (gated domain) but left unpicked.
    expect(await screen.findByRole('combobox', { name: /birth year/i })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // Without this the unpicked year reads as `age === undefined`, the minor
    // check is skipped, and a minor is signed up as an adult.
    expect(await screen.findByRole('combobox', { name: /birth year/i })).toBeTruthy();
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('does not fall through the U18 gate when a later domain fetch fails', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    // First load succeeds: seeker is auto-selected and the birth-year field appears.
    expect(await screen.findByRole('combobox', { name: /birth year/i })).toBeTruthy();

    // Back only flips the mode — `domain` stays 'seeker'. Re-entering signup
    // refires the fetch, and this time it fails.
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    fetchNetworkConfig.mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // A domain is still selected, so the !domain guard passes. If the gating
    // flag is inferred from an empty domain list it reads as "not gated", the
    // blank-birth-year guard is skipped, and a minor is signed up as an adult.
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('still routes a minor to the guardian flow once a birth year is given', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await screen.findByRole('combobox', { name: /birth year/i });
    await pickBirthYear(2015);
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-domain')).toBe('seeker');
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });
});

/**
 * The signup form used to hard-code phone whenever the phone channel was on, so
 * an email-only person could not create an account on a phone+email instance —
 * even though `POST /api/v1/auth/signup` has always accepted either identifier.
 */
describe('KeycloakLoginPanel — signup identifier channel', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('defaults to phone but offers email when both channels are on', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    expect(screen.getByLabelText(/mobile number/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^email$/i)).toBeNull();
    // Both options are offered, not just the default.
    expect(screen.getByRole('button', { name: /^phone$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^email$/i })).toBeTruthy();
  });

  it('creates the account with an email when email is picked', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'asha@example.com');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    const [body] = signupWithKeycloak.mock.calls[0];
    expect(body.email).toBe('asha@example.com');
    expect(body.phoneNumber).toBeUndefined();
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('sends only the phone when phone is picked, even after visiting email', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    // A half-typed address on the other tab must not leak onto the request.
    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));
    await userEvent.type(screen.getByLabelText(/^email$/i), 'typo@');
    await userEvent.click(screen.getByRole('button', { name: /^phone$/i }));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    const [body] = signupWithKeycloak.mock.calls[0];
    expect(body.phoneNumber).toContain('9876543210');
    expect(body.email).toBeUndefined();
  });

  it('refuses a malformed email instead of letting the API 400 it', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'asha@example');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });

  it('shows the email field with no toggle on an email-only instance', async () => {
    loginChannels = ['email'];

    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    expect(screen.getByLabelText(/^email$/i)).toBeTruthy();
    expect(screen.queryByLabelText(/mobile number/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^phone$/i })).toBeNull();

    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'asha@example.com');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(signupWithKeycloak.mock.calls[0][0].email).toBe('asha@example.com');
  });

  it('keys the guardian capture on the email for a minor signing up by email', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    await userEvent.click(screen.getByRole('button', { name: /^email$/i }));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Minor Kid');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'kid@example.com');
    await userEvent.click(screen.getByRole('button', { name: /seeker/i }));
    await pickBirthYear(CURRENT_YEAR - 15);
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-identifier')).toBe('kid@example.com');
    expect(signupWithKeycloak).not.toHaveBeenCalled();
  });
});

describe('terms & privacy gate on registration', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
    // Nothing accepted yet → the gate must open.
    getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });
  });

  const fillSignupForm = async () => {
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await pickDomain();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('shows the consent modal BEFORE creating the account', async () => {
    renderAt(<LoginPage />);
    await fillSignupForm();

    expect(await screen.findByTestId('consent-modal')).toBeTruthy();
    // Ordering is the point: nothing is created until terms are accepted.
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('creates the account and signs in once accepted', async () => {
    renderAt(<LoginPage />);
    await fillSignupForm();
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('parks the acceptance so it survives the Keycloak redirect', async () => {
    // The accept endpoint is authenticated, so it can't be written yet.
    renderAt(<LoginPage />);
    await fillSignupForm();
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(localStorage.getItem('pendingConsent')).not.toBeNull());
    // Envelope is `{ body, at, attempt }` (see `pending-consent.ts`). `at`
    // bounds how long an abandoned redirect lingers; `attempt` is what
    // actually stops it being flushed onto a DIFFERENT login on this device,
    // and must be handed to Keycloak so only this login's callback matches it.
    const parked = JSON.parse(localStorage.getItem('pendingConsent') as string);
    expect(typeof parked.at).toBe('number');
    expect(typeof parked.attempt).toBe('string');
    expect(parked.attempt).not.toBe('');
    await waitFor(() =>
      expect(startKeycloakLogin).toHaveBeenCalledWith(expect.anything(), parked.attempt)
    );
    expect(parked.body.source).toBe('signup');
    expect(parked.body.items.map((i: { category: string }) => i.category).sort()).toEqual([
      'privacy',
      'terms',
    ]);
    // Not written pre-login.
    expect(acceptConsent).not.toHaveBeenCalled();
  });

  it('skips the gate when the current versions are already accepted', async () => {
    getConsentStatusByIdentifier.mockResolvedValue({
      statuses: { terms: ['v2'], privacy: ['v2'] },
    });

    renderAt(<LoginPage />);
    await fillSignupForm();

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('fails open when the consent pre-check errors', async () => {
    // Same posture as the OTP flow: a consent-service blip must not block
    // registration; the user is re-prompted next login.
    getConsentStatusByIdentifier.mockRejectedValue(new Error('consent service down'));

    renderAt(<LoginPage />);
    await fillSignupForm();

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });
});

describe('OidcCallbackPage — flushing the parked consent', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('writes the parked acceptance once the session exists', async () => {
    const parked = {
      network: 'blue_dot',
      brand: null,
      source: 'signup',
      items: [{ category: 'terms', version: 'v2' }],
    };
    // Envelope is `{ body, at }` (see `pending-consent.ts`); `at` must be
    // recent enough to survive the staleness check.
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({ body: parked, at: Date.now(), attempt: PARKED_ATTEMPT })
    );

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    await waitFor(() => expect(acceptConsent).toHaveBeenCalledWith(parked));
    // Read-once: cleared so it can't be replayed onto a later login.
    expect(localStorage.getItem('pendingConsent')).toBeNull();
    expect(await screen.findByText('home')).toBeTruthy();
  });

  it('does nothing when there is no parked consent', async () => {
    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText('home')).toBeTruthy();
    expect(acceptConsent).not.toHaveBeenCalled();
  });

  it('still signs the user in when persisting the consent fails', async () => {
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({
        body: { network: 'blue_dot', brand: null, source: 'signup', items: [] },
        at: Date.now(),
        attempt: PARKED_ATTEMPT,
      })
    );
    acceptConsent.mockRejectedValueOnce(new Error('write failed'));

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    // Signed in regardless — the gate re-prompts next login.
    expect(await screen.findByText('home')).toBeTruthy();
  });

  /**
   * Regression guard for a Critical found in the sibling aggregator repo
   * (apps/web): a "Register another" affordance there reset the form but not
   * the accepted-consent flag, so participant #2 onward inherited consent as
   * already given with no documents shown. Signals has no such affordance,
   * but `pendingConsent` (this describe block) has the equivalent risk: it
   * survives a full-page redirect to Keycloak's hosted pages via
   * `localStorage`, which — unlike router state — is shared by every tab and
   * outlives an abandoned attempt. Without a staleness check, whichever
   * Keycloak callback completes next on that device would have this consent
   * flushed onto ITS session, regardless of whether it belongs to the person
   * who actually accepted it.
   */
  it('drops a parked acceptance old enough to belong to an abandoned, unrelated login attempt', async () => {
    const parked = {
      network: 'blue_dot',
      brand: null,
      source: 'signup',
      items: [{ category: 'terms', version: 'v2' }],
    };
    // Parked minutes ago — far past a normal Keycloak round-trip — as if some
    // earlier, different signup attempt abandoned the redirect and someone
    // else's login is completing now.
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({ body: parked, at: Date.now() - 6 * 60 * 1000, attempt: PARKED_ATTEMPT })
    );

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText('home')).toBeTruthy();
    expect(acceptConsent).not.toHaveBeenCalled();
    // Read-once even for a dropped entry — it must not linger to ambush a
    // third login either.
    expect(localStorage.getItem('pendingConsent')).toBeNull();
  });
});

describe('OidcCallbackPage — landing is not conditional on the effect surviving', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('lands on / even when the page re-renders while consent is being written', async () => {
    // In the app, completeKeycloakLogin() calls setUser(), which re-renders this
    // page. Any dep identity change then runs the effect cleanup. If navigation
    // is gated on that flag, the user is stranded on the spinner despite being
    // fully signed in — which is exactly what the consent write's extra await
    // exposed.
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({
        body: { network: 'blue_dot', brand: null, source: 'signup', items: [] },
        at: Date.now(),
        attempt: PARKED_ATTEMPT,
      })
    );
    let resolveAccept: (v: { ok: boolean }) => void = () => {};
    acceptConsent.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => { resolveAccept = resolve; })
    );

    const { rerender } = renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());

    // Simulate the re-render that the session update causes.
    rerender(wrap(<OidcCallbackPage />, CALLBACK_PATH));
    resolveAccept({ ok: true });

    expect(await screen.findByText('home')).toBeTruthy();
  });
});

describe('OidcCallbackPage — consent write cannot stall the landing', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands the user anyway when the consent write hangs', async () => {
    localStorage.setItem(
      'pendingConsent',
      JSON.stringify({
        body: { network: 'blue_dot', brand: null, source: 'signup', items: [] },
        at: Date.now(),
        attempt: PARKED_ATTEMPT,
      })
    );
    // Never resolves.
    acceptConsent.mockImplementationOnce(() => new Promise(() => {}));

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(8500);

    expect(await screen.findByText('home')).toBeTruthy();
  });
});

describe('U18 guardian capture on the Keycloak signup path', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  // `birthYear` is optional because the field only exists for a guardian-gated domain.
  const fillSignup = async (opts: { domain: string; birthYear?: number }) => {
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(`^${opts.domain}$`, 'i') })
    );
    if (opts.birthYear !== undefined) {
      await pickBirthYear(opts.birthYear);
    }
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
  };

  it('runs the guardian flow BEFORE creating the account for a gated minor', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', birthYear: 2015 });

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-domain')).toBe('seeker');
    expect(flow.getAttribute('data-age')).toBe(String(CURRENT_YEAR - 2015));
    // Ordering is the point: nothing exists until the guardian is verified.
    expect(signupWithKeycloak).not.toHaveBeenCalled();
    expect(startKeycloakLogin).not.toHaveBeenCalled();
  });

  it('creates the account once the guardian is verified', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', birthYear: 2015 });
    await userEvent.click(await screen.findByRole('button', { name: /guardian done/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    await waitFor(() => expect(startKeycloakLogin).toHaveBeenCalled());
  });

  it('does NOT show the ordinary consent gate for a minor', async () => {
    // The guardian flow records terms/privacy guardian-sourced, so stacking the
    // ordinary gate on top would double-ask and mis-attribute the source.
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
    getConsentStatusByIdentifier.mockResolvedValue({ statuses: { terms: [], privacy: [] } });

    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', birthYear: 2015 });

    expect(await screen.findByTestId('signup-guardian-flow')).toBeTruthy();
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('skips the guardian flow for an ADULT in a gated domain', async () => {
    renderAt(<LoginPage />);
    await fillSignup({ domain: 'seeker', birthYear: 1990 });

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
  });

  it('never asks an UNGATED domain for a birth year, and skips the guardian flow', async () => {
    // `provider` has guardian_consent_required: false — no U18 flow applies, so
    // the field is not rendered at all and no age is submitted.
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(await screen.findByRole('button', { name: /^provider$/i }));

    expect(screen.queryByRole('combobox', { name: /birth year/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    const [body] = signupWithKeycloak.mock.calls[0];
    expect(body.age).toBeUndefined();
    expect(screen.queryByTestId('signup-guardian-flow')).toBeNull();
  });

  it('shows the birth year only once a GATED domain is selected', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));

    // No domain chosen yet → nothing to gate on, so no field.
    expect(screen.queryByRole('combobox', { name: /birth year/i })).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: /^seeker$/i }));
    expect(screen.getByRole('combobox', { name: /birth year/i })).toBeTruthy();

    // Switching to an ungated domain withdraws it again.
    await userEvent.click(await screen.findByRole('button', { name: /^provider$/i }));
    expect(screen.queryByRole('combobox', { name: /birth year/i })).toBeNull();
  });
});

describe('OidcCallbackPage — login-time consent re-prompt', () => {
  beforeEach(() => {
    keycloakEnabled = true;
    fetchConsentConfigs.mockResolvedValue(CONSENT_CONFIGS);
  });

  it('gates a returning user whose accepted version is stale', async () => {
    // The gap this closes: better-auth gates at every login, the Keycloak
    // chooser has no identifier to pre-check, so a migrated user or anyone who
    // signed up before a version bump was never re-prompted.
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByTestId('consent-modal')).toBeTruthy();
    // Held on the callback — not landed yet.
    expect(screen.queryByText('home')).toBeNull();
  });

  it('writes the acceptance and lands the user', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    await waitFor(() => expect(acceptConsent).toHaveBeenCalled());
    const [body] = acceptConsent.mock.calls[0];
    // A returning user, not a signup.
    expect(body.source).toBe('login');
    expect(body.items).toHaveLength(2);
    expect(await screen.findByText('home')).toBeTruthy();
  });

  it('does not gate when the current versions are already accepted', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v2'], privacy: ['v2'] } });

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText('home')).toBeTruthy();
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('fails open when the status check errors — never blocks a completed login', async () => {
    getConsentStatus.mockRejectedValue(new Error('consent service down'));

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);

    expect(await screen.findByText('home')).toBeTruthy();
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('lands the user even when persisting the acceptance fails', async () => {
    getConsentStatus.mockResolvedValue({ statuses: { terms: ['v1'], privacy: ['v1'] } });
    acceptConsent.mockRejectedValueOnce(new Error('write failed'));

    renderAt(<OidcCallbackPage />, CALLBACK_PATH);
    await userEvent.click(await screen.findByRole('button', { name: /accept consent/i }));

    expect(await screen.findByText('home')).toBeTruthy();
  });
});

describe('guardian capture identifier normalisation', () => {
  beforeEach(() => {
    keycloakEnabled = true;
  });

  it('keys the guardian capture on the E.164 phone, not the raw input', async () => {
    // The pre-auth guardian capture is keyed on a hash of the identifier, and the
    // server only trims — it does NOT convert to E.164. At first login the token
    // carries the E.164 number, so a capture keyed on the national form never
    // matches and materializeSignupGuardian silently no-ops: the user sees
    // "verified", the account is created, and the guardian record is dropped.
    await userEvent.click(await (async () => {
      renderAt(<LoginPage />);
      return screen.findByText(/new here/i);
    })());
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(await screen.findByRole('button', { name: /^seeker$/i }));
    await pickBirthYear(2015);
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    const flow = await screen.findByTestId('signup-guardian-flow');
    expect(flow.getAttribute('data-identifier')).toBe('+919876543210');
  });

  it('sends the same E.164 identifier on to signup', async () => {
    renderAt(<LoginPage />);
    await userEvent.click(await screen.findByText(/new here/i));
    await userEvent.type(screen.getByLabelText(/your name/i), 'Asha Rao');
    await userEvent.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await userEvent.click(await screen.findByRole('button', { name: /^provider$/i }));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(signupWithKeycloak).toHaveBeenCalled());
    // Must be the SAME value the guardian capture would have used, or the two
    // halves of the signup key on different identifiers.
    expect(signupWithKeycloak.mock.calls[0][0].phoneNumber).toBe('+919876543210');
  });
});
