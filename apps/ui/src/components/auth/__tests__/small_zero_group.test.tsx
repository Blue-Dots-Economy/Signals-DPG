import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AxiosError, type AxiosResponse } from 'axios';
import { Toaster } from 'sonner';
import i18next from 'i18next';
import type { ConsentConfigDocument } from '@dpg/schemas';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item, FetchItemsQuery, FetchItemsResponse } from '@/lib/item-api';

// ── Mocks ──────────────────────────────────────────────────────────────────
// NOTE: every mocked export is wrapped in an arrow so the vi.mock factory never
// reads a hoisted binding at factory-evaluation time.

const mockUseAuth = vi.fn();
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockUseConsentConfig = vi.fn();
vi.mock('@/hooks/use-consent-config', () => ({
  useConsentConfig: () => mockUseConsentConfig(),
}));

const mockFetchNetworkConfig = vi.fn();
vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfig: (networkId: string) => mockFetchNetworkConfig(networkId),
}));

const mockFetchItems = vi.fn();
vi.mock('@/lib/item-api', () => ({
  fetchItems: (query: FetchItemsQuery) => mockFetchItems(query),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeItem(
  item_id: string,
  item_domain: string,
  lifecycle_status?: Item['lifecycle_status'],
): Item {
  return {
    item_id,
    item_network: 'blue_dot',
    item_domain,
    item_type: 'profile_1.0',
    item_instance_url: null,
    item_schema_url: null,
    item_state: {},
    item_locations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...(lifecycle_status ? { lifecycle_status } : {}),
  };
}

function itemsResponse(items: Item[]): FetchItemsResponse {
  return { meta: { total: items.length, limit: 100, offset: 0 }, items };
}

function consentConfig(overrides: {
  privacyTitle: string;
  privacyContent: string;
  termsTitle: string;
  termsContent: string;
  currentVersion?: number;
}): ConsentConfigDocument {
  const current = overrides.currentVersion ?? 2;
  return {
    documents: {
      privacy: {
        current_version: current,
        versions: [
          {
            version: 1,
            title: 'Old privacy',
            content: 'Superseded privacy text.',
            effective_from: '2025-01-01',
          },
          {
            version: 2,
            title: overrides.privacyTitle,
            content: overrides.privacyContent,
            effective_from: '2026-01-01',
          },
        ],
      },
      terms: {
        current_version: current,
        versions: [
          {
            version: 1,
            title: 'Old terms',
            content: 'Superseded terms text.',
            effective_from: '2025-01-01',
          },
          {
            version: 2,
            title: overrides.termsTitle,
            content: overrides.termsContent,
            effective_from: '2026-01-01',
          },
        ],
      },
      profile_creation: {
        current_version: 1,
        versions: [{ version: 1, statement: 'I agree.', effective_from: '2026-01-01' }],
      },
    },
  };
}

// ── RequireAuth ────────────────────────────────────────────────────────────

function LoginProbe() {
  const location = useLocation();
  return <div data-testid="login-page">{location.search}</div>;
}

async function renderGuardedRoute(entry: string) {
  const { RequireAuth } = await import('../require-auth');
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/profile/new"
          element={
            <RequireAuth>
              <div>Protected profile form</div>
            </RequireAuth>
          }
        />
        <Route path="/auth/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth route guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the guarded children once the session is authenticated', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    await renderGuardedRoute('/profile/new');

    expect(screen.getByText('Protected profile form')).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('shows the session-checking placeholder instead of children while loading', async () => {
    // isAuthenticated is false during the initial session probe — the loading
    // branch must win so a signed-in user is never bounced to login on refresh.
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });

    await renderGuardedRoute('/profile/new');

    expect(screen.getByText('Checking your session...')).toBeInTheDocument();
    expect(screen.queryByText('Protected profile form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to login carrying the encoded return path', async () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });

    await renderGuardedRoute('/profile/new?domain=student&x=a b');

    expect(screen.queryByText('Protected profile form')).not.toBeInTheDocument();
    expect(screen.getByTestId('login-page')).toHaveTextContent(
      `?redirect=${encodeURIComponent('/profile/new?domain=student&x=a b')}`,
    );
  });
});

// ── Legal pages ────────────────────────────────────────────────────────────

describe('legal content pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the current privacy version title and markdown body', async () => {
    mockUseConsentConfig.mockReturnValue({
      config: consentConfig({
        privacyTitle: 'Privacy Policy v2',
        privacyContent: '## How we store data\n\nWe encrypt your contact details.',
        termsTitle: 'Terms v2',
        termsContent: 'Terms body.',
      }),
      isLoading: false,
    });
    const { LegalPage } = await import('@/pages/legal/legal-page');

    render(<LegalPage />, { wrapper: MemoryRouter });

    // Privacy is first on the page, so it is the page's <h1>.
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy v2' })).toBeInTheDocument();
    // Markdown is actually rendered, not dumped as raw text.
    expect(
      screen.getByRole('heading', { level: 2, name: 'How we store data' }),
    ).toBeInTheDocument();
    expect(screen.getByText('We encrypt your contact details.')).toBeInTheDocument();
    // The superseded version is not shown.
    expect(screen.queryByText('Superseded privacy text.')).not.toBeInTheDocument();
  });

  it('renders the current terms version title and markdown body', async () => {
    mockUseConsentConfig.mockReturnValue({
      config: consentConfig({
        privacyTitle: 'Privacy v2',
        privacyContent: 'Privacy body.',
        termsTitle: 'Terms of Service v2',
        termsContent: 'You agree to **behave**.',
      }),
      isLoading: false,
    });
    const { LegalPage } = await import('@/pages/legal/legal-page');

    render(<LegalPage />, { wrapper: MemoryRouter });

    // Terms follows Privacy on the page, so it is an <h2> — a real heading,
    // just not the page's primary one.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Terms of Service v2' }),
    ).toBeInTheDocument();
    expect(screen.getByText('behave')).toBeInTheDocument();
    expect(screen.queryByText('Superseded terms text.')).not.toBeInTheDocument();
  });

  it('shows a spinner and no content while the consent config is loading', async () => {
    mockUseConsentConfig.mockReturnValue({ config: null, isLoading: true });
    const { LegalPage } = await import('@/pages/legal/legal-page');

    const { container } = render(<LegalPage />, { wrapper: MemoryRouter });

    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText('Legal documents unavailable.')).not.toBeInTheDocument();
  });

  it('falls back to an unavailable message when the instance publishes no consent config', async () => {
    mockUseConsentConfig.mockReturnValue({ config: null, isLoading: false });
    const { LegalPage } = await import('@/pages/legal/legal-page');

    // One page, one message — it no longer names whichever document the route
    // happened to be for.
    render(<LegalPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('Legal documents unavailable.')).toBeInTheDocument();
  });
});

// ── login-profiles ─────────────────────────────────────────────────────────

const domainWithSchema = {
  id: 'student',
  description: 'Students',
  item_schemas: { 'profile_1.0': { type: 'object' as const } },
};
const domainWithoutSchema = { id: 'provider', description: 'Providers' };

function network(domains: DotNetworkSchema['domains']): DotNetworkSchema {
  return {
    id: 'blue_dot',
    display_name: 'Blue Dot',
    description: 'Test network',
    schema_standard: '1.0',
    domains,
    actions: {},
  };
}

describe('fetchMyProfilesLite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches own profiles per domain, deriving item_type from the domain schema', async () => {
    mockFetchNetworkConfig.mockResolvedValue(network([domainWithSchema, domainWithoutSchema]));
    mockFetchItems.mockImplementation((query: FetchItemsQuery) =>
      Promise.resolve(
        itemsResponse(
          query.item_domain === 'student'
            ? [makeItem('s-1', 'student', 'live')]
            : [makeItem('p-1', 'provider', 'draft')],
        ),
      ),
    );
    const { fetchMyProfilesLite } = await import('@/lib/login-profiles');

    const profiles = await fetchMyProfilesLite('blue_dot');

    expect(profiles).toEqual([
      { item_id: 's-1', item_domain: 'student', lifecycle_status: 'live' },
      { item_id: 'p-1', item_domain: 'provider', lifecycle_status: 'draft' },
    ]);
    expect(mockFetchNetworkConfig).toHaveBeenCalledWith('blue_dot');
    // Declared schema key wins for the domain that has one; 'profile' otherwise.
    expect(mockFetchItems).toHaveBeenCalledWith({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      created_by_me: true,
      include_retired: true,
      limit: 100,
    });
    expect(mockFetchItems).toHaveBeenCalledWith(
      expect.objectContaining({ item_domain: 'provider', item_type: 'profile' }),
    );
  });

  it('defaults item_type to profile when the domain declares an empty item_schemas map', async () => {
    mockFetchNetworkConfig.mockResolvedValue(
      network([{ id: 'student', description: 'Students', item_schemas: {} }]),
    );
    mockFetchItems.mockResolvedValue(itemsResponse([makeItem('s-1', 'student')]));
    const { fetchMyProfilesLite } = await import('@/lib/login-profiles');

    const profiles = await fetchMyProfilesLite('blue_dot');

    expect(mockFetchItems).toHaveBeenCalledWith(
      expect.objectContaining({ item_type: 'profile' }),
    );
    // An item with no lifecycle_status degrades to '' rather than undefined, so
    // the post-login "completed" check never sees a missing field.
    expect(profiles).toEqual([{ item_id: 's-1', item_domain: 'student', lifecycle_status: '' }]);
  });

  it('degrades a failing domain to an empty list without losing the other domain', async () => {
    mockFetchNetworkConfig.mockResolvedValue(network([domainWithSchema, domainWithoutSchema]));
    mockFetchItems.mockImplementation((query: FetchItemsQuery) =>
      query.item_domain === 'student'
        ? Promise.reject(new Error('domain fetch blew up'))
        : Promise.resolve(itemsResponse([makeItem('p-1', 'provider', 'paused')])),
    );
    const { fetchMyProfilesLite } = await import('@/lib/login-profiles');

    const profiles = await fetchMyProfilesLite('blue_dot');

    expect(profiles).toEqual([
      { item_id: 'p-1', item_domain: 'provider', lifecycle_status: 'paused' },
    ]);
  });

  it('returns an empty list and fetches nothing when the network config has no domains', async () => {
    mockFetchNetworkConfig.mockResolvedValue({
      ...network([]),
      domains: undefined,
    } as unknown as DotNetworkSchema);
    const { fetchMyProfilesLite } = await import('@/lib/login-profiles');

    await expect(fetchMyProfilesLite('blue_dot')).resolves.toEqual([]);
    expect(mockFetchItems).not.toHaveBeenCalled();
  });
});

// ── guardian-consent helpers ───────────────────────────────────────────────

describe('guardian consent helpers', () => {
  it('reports guardian consent only for the domains that declare it', async () => {
    const { isGuardianConsentRequiredDomain } = await import('@/lib/guardian-consent');
    const schema = network([
      { id: 'student', description: 'Students', guardian_consent_required: true },
      { id: 'provider', description: 'Providers', guardian_consent_required: false },
      { id: 'mentor', description: 'Mentors' },
    ]);

    expect(isGuardianConsentRequiredDomain(schema, 'student')).toBe(true);
    expect(isGuardianConsentRequiredDomain(schema, 'provider')).toBe(false);
    // Absent flag defaults to false…
    expect(isGuardianConsentRequiredDomain(schema, 'mentor')).toBe(false);
    // …and so does an unknown domain (fail-open here; the server is authoritative).
    expect(isGuardianConsentRequiredDomain(schema, 'nope')).toBe(false);
  });

  it('derives age from the birth year alone, using the injected clock', async () => {
    const { ageFromBirthYear } = await import('@/lib/guardian-consent');
    const now = new Date('2026-02-01T00:00:00.000Z');

    expect(ageFromBirthYear(2008, now)).toBe(18);
    expect(ageFromBirthYear(2006, now)).toBe(20);
    // Late-December birthday still yields the plain year difference — no
    // month/day is ever collected.
    expect(ageFromBirthYear(2026, new Date('2026-12-31T00:00:00.000Z'))).toBe(0);
    // Callers may omit the clock — it defaults to now.
    expect(ageFromBirthYear(2000)).toBe(new Date().getFullYear() - 2000);
  });

  it('treats the whole 18th year as a minor (fail-closed boundary)', async () => {
    const { isMinorFromAge } = await import('@/lib/guardian-consent');

    expect(isMinorFromAge(17)).toBe(true);
    expect(isMinorFromAge(18)).toBe(true);
    expect(isMinorFromAge(19)).toBe(false);
  });
});

describe('toastGuardianSendError', () => {
  const fallback = { key: 'u18.guardian_send_failed', def: 'Could not send the code.' };

  function axiosErrorWithStatus(status: number): AxiosError {
    return new AxiosError('request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status,
      statusText: '',
      data: {},
      headers: {},
      config: { headers: {} },
    } as AxiosResponse);
  }

  async function toastAndFind(err: unknown): Promise<void> {
    const { toastGuardianSendError } = await import('@/lib/guardian-consent');
    // Toaster must be subscribed before the toast is published, otherwise sonner
    // drops it.
    render(<Toaster />);
    await act(async () => {
      toastGuardianSendError(err, i18next.t, fallback);
    });
  }

  it('maps a 429 to the shared rate-limited copy', async () => {
    await toastAndFind(axiosErrorWithStatus(429));

    expect(
      await screen.findByText('Too many attempts. Please try again shortly.'),
    ).toBeInTheDocument();
  });

  it('maps a 503 to the confirmation-unavailable copy', async () => {
    await toastAndFind(axiosErrorWithStatus(503));

    expect(
      await screen.findByText("Guardian confirmation isn't available on this instance right now."),
    ).toBeInTheDocument();
  });

  it('falls back to the caller-supplied message for any other HTTP status', async () => {
    await toastAndFind(axiosErrorWithStatus(500));

    expect(await screen.findByText('Could not send the code.')).toBeInTheDocument();
  });

  it('falls back to the caller-supplied message for a non-axios failure', async () => {
    await toastAndFind(new TypeError('network down'));

    expect(await screen.findByText('Could not send the code.')).toBeInTheDocument();
  });
});
