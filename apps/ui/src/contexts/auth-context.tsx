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
import {
  clearCsrfToken,
  endBffSession,
  fetchBffSession,
  startBffLogin,
} from '@/lib/bff-session';
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
  const { isKeycloakLogin, isLoading: isConfigLoading } = useAuthConfig();

  /**
   * Restore an existing session on mount. Both providers now ask the SERVER
   * whether this browser has a session — better-auth via its own session
   * endpoint, Keycloak via the BFF's `GET /auth/session`. Neither reads a
   * credential out of the page, because there is no longer one to read.
   *
   * Waits for the auth config first: which of the two to ask is the API's
   * answer, so asking before it lands means asking the wrong one.
   */

  /**
   * Bumped every time a login explicitly establishes the user (OIDC callback or
   * OTP verify). `fetchSession` captures it before awaiting and discards its own
   * result if it changed, because the two can race on a first login and the
   * restore can lose:
   *
   *   1. provider mounts, fetchSession waits for the auth config
   *   2. the config lands, fetchSession asks the API for the session
   *   3. the callback page resolves the user, completeKeycloakLogin sets it
   *   4. step 2's await finally resolves and `setUser(null)` lands LAST
   *
   * The user ended up signed out while perfectly authenticated: /me kept
   * returning 200 and cached queries kept rendering, so only the top bar looked
   * wrong. Moving the code exchange server-side makes step 2 far less likely to
   * come back empty — the cookie is already set before this page loads — but
   * "less likely" is not "cannot", and the guard costs one integer.
   */
  const authEpochRef = useRef(0);

  const fetchSession = useCallback(async () => {
    if (isConfigLoading) return;
    const epoch = authEpochRef.current;
    /** A login landed while we were awaiting — its user is newer than ours. */
    const superseded = () => epoch !== authEpochRef.current;
    try {
      if (isKeycloakLogin) {
        // The BFF owns the session now (AUTH-VULN-03/04): ask whether this
        // browser has one rather than reading a token out of storage. The
        // cookie is httpOnly, so there is nothing here to read even in
        // principle — `authenticated` is the whole answer.
        const session = await fetchBffSession();
        if (superseded()) return;
        if (!session.authenticated) {
          setUser(null);
          return;
        }
        const me = meToUser(await fetchMe());
        if (superseded()) return;
        setUser(me);
        return;
      }

      // better-auth path (AUTH_PROVIDER=betterauth). Its session is a cookie
      // better-auth sets and reads itself, so the token it also returns no
      // longer needs storing — it was only ever kept to build a Bearer header,
      // which is the storage this change removes.
      const session = await getSession();
      if (superseded()) return;
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
  }, [isConfigLoading, isKeycloakLogin]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

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
    // Same precedence claim as the OIDC path (see authEpochRef).
    authEpochRef.current += 1;
    setUser(response.user);
  }, []);

  const startKeycloakLogin = useCallback(
    async (returnTo?: string, consentAttempt?: string): Promise<void> => {
      // Full navigation to the API, which runs the OIDC flow server-side and
      // sets the session cookie on the way back. The code exchange no longer
      // happens in the page, so no token passes through the browser at all.
      startBffLogin(returnTo ?? '/', consentAttempt);
    },
    []
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
      // Destroys the server-side session, then hands off to Keycloak so the SSO
      // session goes too. Signed out locally first, so a failure to reach
      // Keycloak still logs the user out of this app.
      await endBffSession();
      return;
    }

    try {
      await apiSignOut();
    } finally {
      clearCsrfToken();
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
  }, [isKeycloakLogin, queryClient]);

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
