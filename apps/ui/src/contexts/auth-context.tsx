import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getSession,
  fetchMe,
  signOut as apiSignOut,
  type AuthIdentifier,
  type MeResponse,
  type User,
} from '@/lib/auth-api';
import { setAuthToken, clearAuthToken } from '@/lib/auth-token';
import { clearSchemaCache } from '@/engine';
import { useAuthConfig } from '@/hooks/use-auth-config';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when this deployment logs in through Keycloak rather than OTP. */
  isKeycloakLogin: boolean;
  checkUser: (identifier: AuthIdentifier) => Promise<boolean>;
  requestOtp: (identifier: AuthIdentifier) => Promise<void>;
  verifyOtp: (identifier: AuthIdentifier, otp: string, name?: string) => Promise<void>;
  /** Redirect to Keycloak. Only meaningful when `isKeycloakLogin`. */
  startKeycloakLogin: (returnTo?: string, consentAttempt?: string) => Promise<void>;
  /** Adopt the session established by the OIDC callback page. */
  completeKeycloakLogin: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * The UI's `User` is better-auth's shape. Under Keycloak the API returns the
 * mirror's view (`/api/v1/auth/me`), which is deliberately narrower — identity
 * plus role, no credential metadata. Fill the rest with values that describe
 * what is actually true of a logged-in Keycloak user rather than leaving holes
 * consumers have to null-check.
 *
 * Verified flags are `true` because Keycloak will not complete an OTP login
 * against an unverified identifier, and `banned` is `false` because
 * provisioning refuses a banned user before this point is reached.
 */
function meToUser(me: MeResponse): User {
  const now = new Date().toISOString();
  return {
    id: me.id,
    name: me.name,
    email: me.email || null,
    emailVerified: Boolean(me.email),
    phoneNumber: null,
    phoneNumberVerified: false,
    image: '',
    role: me.role ?? 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  // Which provider this instance runs is served by the API, not compiled in.
  const {
    config: authCfg,
    isKeycloakLogin,
    isLoading: isConfigLoading,
  } = useAuthConfig();

  /**
   * Restore an existing session on mount. The two providers restore
   * differently: better-auth asks the server for the session, whereas OIDC
   * holds the tokens client-side and then asks the API who that token is.
   *
   * Waits for the auth config first — restoring the wrong way round would
   * either miss an OIDC session or fire a pointless better-auth request.
   */
  /**
   * `authCfg` is React Query data, so a refetch hands back a NEW object with
   * identical contents. Depending on that identity re-ran the whole restore and
   * re-derived `user` from storage on every refetch — turning any momentary
   * "no usable token" (an expired access token whose renewal is still in
   * flight) into a visible sign-out. Depend on the config's VALUES instead, and
   * read the object through a ref so the callback stays stable.
   */
  const authCfgRef = useRef(authCfg);
  // Synced in an effect rather than during render: a render-phase ref write is
  // an impure render and misbehaves under concurrent rendering. Declared BEFORE
  // the fetchSession effect so the ref is current by the time it runs, and
  // seeded by useRef's initial value for the very first render.
  useEffect(() => {
    authCfgRef.current = authCfg;
  }, [authCfg]);

  const keycloakConfigKey = authCfg?.keycloak
    ? `${authCfg.keycloak.url}|${authCfg.keycloak.realm}|${authCfg.keycloak.clientId}`
    : '';

  /**
   * Bumped every time a login explicitly establishes the user (OIDC callback or
   * OTP verify). `fetchSession` captures it before awaiting and discards its own
   * result if it changed, because on a FIRST login the two race and the restore
   * loses:
   *
   *   1. provider mounts, fetchSession waits for authCfg
   *   2. authCfg lands, fetchSession calls restoreOidcSession — storage is still
   *      EMPTY, the code exchange has not finished → resolves null
   *   3. the callback page finishes the exchange, /me returns 200,
   *      completeKeycloakLogin sets the user
   *   4. step 2's await finally resolves and `setUser(null)` lands LAST
   *
   * The user ended up signed out with a perfectly valid token in storage: /me
   * kept returning 200 and cached queries kept rendering, so only the top bar
   * looked wrong. A second login "fixed" it because storage was populated by
   * then, so the restore returned a token instead of null.
   */
  const authEpochRef = useRef(0);

  const fetchSession = useCallback(async () => {
    if (isConfigLoading) return;
    const epoch = authEpochRef.current;
    /** A login landed while we were awaiting — its user is newer than ours. */
    const superseded = () => epoch !== authEpochRef.current;
    try {
      if (isKeycloakLogin) {
        // Dynamic import so the OIDC library is not pulled into the bundle for
        // deployments still on the OTP login.
        const { restoreOidcSession } = await import('@/lib/oidc-client');
        const token = await restoreOidcSession(authCfgRef.current);
        if (superseded()) return;
        if (!token) {
          setUser(null);
          return;
        }
        const me = meToUser(await fetchMe());
        if (superseded()) return;
        setUser(me);
        return;
      }

      const session = await getSession();
      if (superseded()) return;
      if (session.token) {
        setAuthToken(session.token);
      }
      setUser(session.user);
    } catch {
      if (superseded()) return;
      setUser(null);
    } finally {
      // Superseded means a login already owns the state — including having
      // cleared isLoading itself. Touching it here would be this run leaking
      // past the guard it just respected.
      if (!superseded()) setIsLoading(false);
    }
  }, [keycloakConfigKey, isConfigLoading, isKeycloakLogin]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // ── Terminal session expiry ────────────────────────────────────────────────
  //
  // Raised by `api-client.ts` on a 401 `TOKEN_EXPIRED`/`NO_ACTIVE_SESSION`, and
  // by `oidc-client.ts` when silent renewal itself fails. Both mean the
  // credentials are unrecoverable — a routine access-token expiry is absorbed
  // by `automaticSilentRenew` and never reaches here.
  //
  // `setUser(null)` is the line that actually stops the traffic: every polling
  // query carries `enabled: isAuthenticated` (`use-actions.ts`), so dropping
  // the user disables all of them at source. Without it, the client kept
  // believing it was signed in and polled 401s forever. `cancelQueries` then
  // aborts whatever is already in flight and `removeQueries` drops the cache,
  // so a signed-out page cannot keep rendering the previous user's data.
  //
  // `window.location` rather than `useNavigate`: `AuthProvider` wraps
  // `BrowserRouter` (`app.tsx`), so there is no router context above it. A full
  // navigation is also the safer choice here — it guarantees no stale
  // in-memory state survives. Same approach as the aggregator's `forceLogout`.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    void import('@/lib/auth-events').then(({ onSessionExpired }) => {
      if (cancelled) return;
      unsubscribe = onSessionExpired(() => {
        clearAuthToken();
        authEpochRef.current += 1;
        setUser(null);
        void queryClient.cancelQueries();
        queryClient.removeQueries();
        clearSchemaCache();
        void Promise.all([import('sonner'), import('i18next')]).then(
          ([{ toast }, i18next]) =>
            toast.error(i18next.default.t('auth.session_expired_title'), {
              description: i18next.default.t('auth.session_expired_desc'),
            }),
        );
        const path = window.location.pathname;
        // Already on the login flow: clearing state is enough, and navigating
        // would discard a half-entered login.
        if (path.startsWith('/auth/')) return;
        // `redirect` is the param LoginPage already reads (`login-page.tsx`),
        // so the user lands back where they were after signing in.
        const ret = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `/auth/login?reason=expired&redirect=${ret}`;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [queryClient]);

  const checkUser = useCallback(async (identifier: AuthIdentifier): Promise<boolean> => {
    const { checkUser: checkUserApi } = await import('@/lib/auth-api');
    const response = await checkUserApi(identifier);
    return response.userExists;
  }, []);

  const requestOtp = useCallback(async (identifier: AuthIdentifier): Promise<void> => {
    const { requestOtp: requestOtpApi } = await import('@/lib/auth-api');
    await requestOtpApi(identifier);
  }, []);

  const verifyOtp = useCallback(async (identifier: AuthIdentifier, otp: string, name?: string): Promise<void> => {
    const { verifyOtp: verifyOtpApi } = await import('@/lib/auth-api');
    const response = await verifyOtpApi(identifier, otp, name);
    setAuthToken(response.token);
    // Same precedence claim as the OIDC path (see authEpochRef).
    authEpochRef.current += 1;
    setUser(response.user);
  }, []);

  const startKeycloakLogin = useCallback(
    async (returnTo?: string, consentAttempt?: string): Promise<void> => {
      const { startOidcLogin } = await import('@/lib/oidc-client');
      await startOidcLogin(authCfg, returnTo, consentAttempt);
    },
    [authCfg]
  );

  /**
   * Called by the callback page once the code exchange has succeeded and the
   * access token is in place. Resolving the user here (rather than in the
   * page) keeps the context the single owner of `user`.
   */
  const completeKeycloakLogin = useCallback(async (): Promise<void> => {
    const me = meToUser(await fetchMe());
    // Claim precedence over any restore still in flight (see authEpochRef).
    authEpochRef.current += 1;
    setUser(me);
    setIsLoading(false);
  }, []);

  const signOut = useCallback(async () => {
    if (isKeycloakLogin) {
      setUser(null);
      // Ends the Keycloak SSO session too, then redirects; clears the local
      // token first, so a failure to reach Keycloak still logs out this app.
      const { oidcLogout } = await import('@/lib/oidc-client');
      await oidcLogout(authCfg);
      return;
    }

    try {
      await apiSignOut();
    } finally {
      clearAuthToken();
      setUser(null);
      clearSchemaCache();
      // Drop the signed-out user's cached data so it doesn't linger until
      // gcTime and bleed into the next session (SPA sign-out does not reload
      // the page). All five hold per-user data: my-items + edit-item are the
      // user's own items; profile-consent is their accepted profiles; actions
      // covers their applications/connections — including pendingCount, whose
      // key is NOT network/user-scoped, so a stale count would otherwise show
      // to the next user on re-login. consent-status
      // (`['consent-status', themeId]`, see `use-consent-gate.ts`) is keyed
      // only by network, not by user, and its endpoint reflects whichever
      // session's token is attached when it resolves — without this, signing
      // out and straight back in as someone else on the same device/tab would
      // let the U18 guardian consent gate serve the FIRST user's cached
      // "already consented" status to the second, skipping the documents
      // until the background refetch corrects it. browse-items/markers/
      // *-config are public network-scoped data and can stay.
      queryClient.removeQueries({ queryKey: ['my-items'] });
      queryClient.removeQueries({ queryKey: ['profile-consent'] });
      queryClient.removeQueries({ queryKey: ['edit-item'] });
      queryClient.removeQueries({ queryKey: ['actions'] });
      queryClient.removeQueries({ queryKey: ['consent-status'] });
    }
  }, [authCfg, isKeycloakLogin, queryClient]);

  // Memoised so consumers only re-render when the session actually changes —
  // every callback above is a stable useCallback reference.
  const value = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      isKeycloakLogin,
      checkUser,
      requestOtp,
      verifyOtp,
      startKeycloakLogin,
      completeKeycloakLogin,
      signOut,
    }),
    [
      user,
      isLoading,
      isKeycloakLogin,
      checkUser,
      requestOtp,
      verifyOtp,
      startKeycloakLogin,
      completeKeycloakLogin,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
