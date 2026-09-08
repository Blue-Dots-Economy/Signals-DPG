import { oidcLogout } from '@/lib/oidc-client';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, OctagonX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { takePendingConsent } from '@/lib/pending-consent';
import { takePendingSignupExtras } from '@/lib/pending-signup-extras';
import {
  acceptConsent,
  fetchConsentConfigs,
  getConsentStatus,
  getU18Status,
  submitU18Dob,
} from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { useNetworkTheme } from '@/theme/theme-provider';
import { getServedScope } from '@/lib/served-binding';
import { setPendingWrongPortal } from '@/lib/pending-wrong-portal';
import { evaluateDomainGate, resolveHeldDomains } from '@/lib/domain-gate';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { fetchNetworkConfig } from '@/lib/network-api';
import { setStoredSignupDomain } from '@/lib/signup-domain';
import { setUserDomains } from '@/lib/user-api';
import { resolvePostLoginLanding } from '@/lib/post-login-landing';
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';

/** How long to wait for the consent write before landing the user anyway. */
const CONSENT_WRITE_TIMEOUT_MS = 8000;

/** Reject after `ms` so a hanging request can't stall the redirect. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('consent write timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Write any consent accepted on the login screen. The accept endpoint is
 * authenticated, so this is the first moment it can be persisted — the
 * acceptance was parked across the Keycloak redirect.
 *
 * Deliberately non-fatal: the user is signed in either way, and a failed write
 * means the gate re-prompts next login rather than stranding them here.
 */
async function flushPendingConsent(
  persistErrorMessage: string,
  consentAttempt: string | undefined,
): Promise<void> {
  // `consentAttempt` comes back from the OIDC `state` of the login that just
  // landed. A parked acceptance is honoured only if it was parked by that same
  // login — otherwise it belongs to someone else's abandoned round trip on this
  // device and must not be written against this session. See pending-consent.ts.
  const pending = takePendingConsent(consentAttempt);
  if (!pending) return;
  try {
    // Bounded: a slow or hanging consent write must not hold the user on
    // the spinner after they are already signed in.
    await withTimeout(acceptConsent(pending), CONSENT_WRITE_TIMEOUT_MS);
  } catch (consentErr) {
    // eslint-disable-next-line no-console
    console.error('could not persist accepted consent', consentErr);
    toast.error(persistErrorMessage);
  }
}

/**
 * Durable write of the signup form's domain/age (G3). The server parked
 * these in Redis with a 30-minute TTL and swallows failures, so this
 * authenticated write is the backstop that stops a user landing with
 * `domains = null` / `age = null` — the latter being fail-closed
 * server-side for a guardian-gated domain. Idempotent with the stash.
 */
async function flushPendingSignupExtras(
  network: string,
  persistErrorMessage: string,
): Promise<void> {
  const signupExtras = takePendingSignupExtras();
  if (!signupExtras) return;
  // Hand the domain to profile-form-page (one-shot) as well as
  // persisting it, exactly as the OTP flow does.
  setStoredSignupDomain(network, signupExtras.domain);
  try {
    await setUserDomains([signupExtras.domain]);
  } catch {
    // Best-effort — profile-form falls back to held items if unset.
  }
  if (signupExtras.age !== undefined) {
    try {
      await submitU18Dob({ network, age: signupExtras.age });
    } catch {
      toast.error(persistErrorMessage);
    }
  }
}

/**
 * Authenticated U18 guardian gate (G4), ported from `otp-page.tsx`.
 *
 * The Keycloak chooser never collects an identifier, so the OTP flow's
 * pre-login `u18Precheck` has no equivalent here — the DOB capture has to
 * happen now instead, which is what the `'dob'` step is for when no birth data
 * is stored yet. Returns the step the blocking guardian flow should open on,
 * or null when the user is not gated.
 *
 * Best-effort: a failed status lookup resolves to null and the user lands. The
 * home-page gate is a backstop and the server-side go-live gate is the real
 * fail-closed control.
 *
 * `heldDomains` is the already-resolved held-domain list when the caller has
 * one (a bound deployment resolves it once per login rather than twice).
 */
async function resolveGuardianGateStep(
  network: string,
  heldDomains: string[] | null,
): Promise<'dob' | 'guardian' | null> {
  try {
    const u18 = await getU18Status(network);
    /**
     * `isMinor` is `age !== null && isMinor(age)` server-side, so it is
     * FALSE for a user whose age is unknown — which is every existing user
     * onboarded by an aggregator (bulk upload / form link never captures
     * one). Gating on `isMinor` alone therefore skipped exactly the
     * population the `'dob'` step was written for, leaving it unreachable:
     * those users fell through to the landing page and were then caught by
     * home-page's `u18BirthUnresolved` backstop, which renders the DOB step
     * on top of the map view.
     *
     * `!hasBirthData` is the missing condition. With it, DOB is captured
     * here — before any navigation — which is what the OTP flow achieved
     * via its pre-login `u18Precheck`.
     */
    const needsBirthData = !u18.hasBirthData;
    const needsGuardian = u18.isMinor && !u18.guardianVerified;
    if (!needsBirthData && !needsGuardian) return null;

    /**
     * Only gate inside a guardian-gated domain. A provider has no U18
     * flow at all (`guardian_consent_required: false`), so asking them
     * for a date of birth is pure friction.
     *
     * Keyed on the domains the user ALREADY holds a profile in, matching
     * how home-page derives `wardDomain` from `myItem.item_domain` — a
     * user with no profile yet has no domain to judge, and is gated later
     * at profile creation once they pick one.
     */
    const held = heldDomains ?? (await resolveHeldDomains(network));

    // No profile yet → no domain to judge, so nothing to fetch either.
    if (held.length === 0) return null;

    const networkCfg = await fetchNetworkConfig(network);
    const inGatedDomain = held.some((domainId) =>
      isGuardianConsentRequiredDomain(networkCfg, domainId),
    );
    if (!inGatedDomain) return null;

    return u18.hasBirthData ? 'guardian' : 'dob';
  } catch {
    // fall through and land the user
    return null;
  }
}

/**
 * Landing page for the Keycloak redirect (`/auth/callback`).
 *
 * Exchanges the authorization code, then asks the API who the resulting token
 * belongs to — which is also what provisions the local `user` mirror on a
 * first login. On success the user never really sees this page; on failure it
 * is the only place that can explain what went wrong, so the API's own message
 * is surfaced rather than a generic error.
 */
export function OidcCallbackPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { completeKeycloakLogin, signOut } = useAuth();
  // The OIDC client is built from the server's advertised Keycloak details.
  const { config: authCfg, isLoading: isConfigLoading } = useAuthConfig();
  const { themeId, brand } = useNetworkTheme();
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  /**
   * Terms/privacy still outstanding for this user — the login-time gate.
   *
   * better-auth gates these on EVERY login (pre-OTP, by identifier). The
   * Keycloak chooser has no identifier to pre-check, so the equivalent has to
   * run here, once the session exists and the authenticated status endpoint can
   * be used. Without it a migrated user, or anyone who signed up before a
   * version bump, is never re-prompted.
   */
  const [consentGate, setConsentGate] = useState<{
    config: ConsentConfigDocument;
    pendingConsent: ConsentAcceptBody;
    returnTo: string;
  } | null>(null);
  /**
   * A gated minor held on a blocking guardian flow AFTER login (ownership
   * proven by Keycloak) and BEFORE landing — never home-first. The OTP flow
   * does the same in `otp-page.tsx`; `initialStep` is `'dob'` when no birth
   * data is stored, because the Keycloak chooser had no pre-login step to
   * collect it.
   */
  const [guardianGate, setGuardianGate] = useState<{
    initialStep: 'dob' | 'guardian';
    returnTo: string;
  } | null>(null);

  // The authorization code is single-use. React 18+ StrictMode double-invokes
  // effects in development, and a second exchange of a spent code fails — so
  // guard rather than letting dev see a phantom error.
  const exchangeStarted = useRef(false);

  useEffect(() => {
    /**
     * Wait for the auth config before touching the code.
     *
     * This page is reached by a full-page redirect from Keycloak, so the
     * module-level UserManager built on the login page is gone and the OIDC
     * client has to be rebuilt from the server's advertised Keycloak details.
     * Exchanging before `/api/v1/auth/config` resolves means building it from
     * `undefined` — which fails with "Keycloak is not configured" and, because
     * the single-use guard below has already been set, never retries. The
     * user then bounces: error → sign in → Keycloak's still-valid SSO cookie →
     * straight back here.
     */
    if (isConfigLoading) return;
    if (exchangeStarted.current) return;

    // Config has loaded but names no Keycloak — either the API isn't in a
    // Keycloak mode, or the request failed and React Query gave up. Say so
    // rather than reporting it as a broken sign-in.
    if (!authCfg?.keycloak) {
      exchangeStarted.current = true;
      setError(t('auth.oidc_error_unconfigured'));
      return;
    }

    exchangeStarted.current = true;
    let cancelled = false;

    (async () => {
      try {
        const { completeOidcLogin } = await import('@/lib/oidc-client');
        const { returnTo, consentAttempt } = await completeOidcLogin(authCfg);
        await completeKeycloakLogin();

        // Per-domain UI gate (G7), ported from `otp-page.tsx`: block a user who
        // already holds a profile in a domain this deployment does not serve —
        // they must use that domain's portal. Runs first, before any write, so a
        // wrong-portal user is turned away rather than partially onboarded.
        // Reused by the U18 gate below, so a bound deployment resolves the
        // user's held domains once per login rather than twice.
        let heldDomains: string[] | null = null;

        const scope = getServedScope();
        if (scope) {
          const held = await resolveHeldDomains(scope.network);
          heldDomains = held;
          const gate = evaluateDomainGate(held, scope.domains);
          if (!gate.allow) {
            // Park the reason BEFORE signing out. Under Keycloak `signOut()`
            // hands off to `signoutRedirect()`, a full-page navigation to the
            // end-session endpoint — this await never resolves, so the
            // `navigate` below (and the router state it carries) never runs,
            // and Keycloak returns the browser to the site root with a fresh
            // document. Without this the user was correctly bounced but landed
            // on the logged-out home page with no explanation. `WrongPortalToast`
            // reads it back once the new document boots.
            setPendingWrongPortal(gate.heldDomain);
            await signOut();
            // Still reached when `signoutRedirect()` could not navigate (e.g.
            // Keycloak unreachable, so `oidcLogout` falls back to a local
            // `removeUser`). Both paths share the `wrong-portal-block` toast
            // id, so the user sees one message, not two.
            navigate('/auth/login', {
              replace: true,
              state: { wrongPortalDomain: gate.heldDomain },
            });
            return;
          }
        }

        // Write any consent accepted on the login screen — deliberately after
        // the session is established, since the accept endpoint is
        // authenticated. The acceptance was parked across the Keycloak redirect.
        await flushPendingConsent(t('auth.toast_consent_persist_error'), consentAttempt);

        // Durable write of the signup form's domain/age (G3).
        await flushPendingSignupExtras(themeId, t('auth.toast_consent_persist_error'));

        // First-time-login profile redirect (#376), previously wired only into
        // the OTP page and therefore dead under Keycloak (#558). Resolved ONCE
        // here so all three exits below — guardian gate, consent gate and the
        // direct navigate — inherit the same landing. Placed after the session
        // is established (an authenticated read) and after the parked consent /
        // signup writes are flushed, but BEFORE the gates, so a gated user
        // still clears their gate first and only then lands on the form.
        const landing = await resolvePostLoginLanding(themeId, returnTo ?? '/');

        // Authenticated U18 guardian gate (G4). Runs BEFORE the adult
        // terms/privacy gate below on purpose: a gated minor must not be shown
        // the adult consent screens, because the guardian flow records their
        // consent guardian-sourced instead (#453).
        const guardianStep = await resolveGuardianGateStep(themeId, heldDomains);
        if (guardianStep) {
          setGuardianGate({ initialStep: guardianStep, returnTo: landing });
          return;
        }

        // Login-time terms/privacy gate. Runs AFTER the parked signup consent is
        // flushed, so a fresh signup that just accepted has nothing outstanding.
        const outstanding = await resolveOutstandingConsent(themeId, brand);
        if (outstanding) {
          setConsentGate({ ...outstanding, returnTo: landing });
          return;
        }

        // Navigate unconditionally — NOT gated on `cancelled`.
        //
        // `completeKeycloakLogin` updates the session, which re-renders this page;
        // if a dep identity changes in that render React runs this effect's
        // cleanup. Gating the navigation on that flag stranded a fully
        // authenticated user on the spinner. The flag's only legitimate job is
        // avoiding a setState after unmount, which is why the catch below still
        // honours it.
        navigate(landing, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setErrorCode(extractCode(err));
        setError(extractMessage(err) ?? t('auth.oidc_error_desc'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authCfg, brand, completeKeycloakLogin, isConfigLoading, navigate, signOut, t, themeId]);

  /**
   * Accepted the login-time gate. The session already exists here, so unlike the
   * signup path this writes straight through rather than parking anything.
   * Non-fatal: the user is signed in regardless, and a failed write just means
   * the gate re-prompts next login.
   */
  const handleConsentAccept = async () => {
    if (!consentGate) return;
    const { pendingConsent, returnTo } = consentGate;
    setConsentGate(null);
    try {
      await withTimeout(acceptConsent(pendingConsent), CONSENT_WRITE_TIMEOUT_MS);
    } catch (consentErr) {
      // eslint-disable-next-line no-console
      console.error('could not persist accepted consent', consentErr);
      toast.error(t('auth.toast_consent_persist_error'));
    }
    navigate(returnTo, { replace: true });
  };

  // Blocking guardian gate for a minor — replaces the spinner inside the same
  // AuthShell, mirroring `otp-page.tsx`, so the ward never sees home until the
  // guardian is verified. Both `onNotMinor` (DOB resolved adult) and
  // `onComplete` (guardian verified) land the user.
  if (guardianGate) {
    return (
      <AuthShell>
        <U18GuardianFlow
          inline
          network={themeId}
          brand={brand === 'standard' ? null : brand}
          initialStep={guardianGate.initialStep}
          onComplete={() => navigate(guardianGate.returnTo, { replace: true })}
          onNotMinor={() => navigate(guardianGate.returnTo, { replace: true })}
          onLogout={() => {
            void signOut();
            navigate('/auth/login', { replace: true });
          }}
        />
      </AuthShell>
    );
  }

  if (consentGate) {
    return (
      <>
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          onAccept={() => {
            void handleConsentAccept();
          }}
        />
        <AuthShell>
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('auth.oidc_signing_in')}</p>
          </div>
        </AuthShell>
      </>
    );
  }

  if (!error) {
    return (
      <AuthShell>
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('auth.oidc_signing_in')}</p>
        </div>
      </AuthShell>
    );
  }

  /**
   * End the Keycloak session so the user can sign in as someone else.
   *
   * A forced re-prompt (`prompt=login`) is NOT enough: it re-authenticates the
   * CURRENT user, so naming a different one makes Keycloak throw USER_CONFLICT
   * (AuthenticationProcessor.setAutheticatedUser) and report
   * `invalid_user_credentials` — which the login theme renders as "Invalid
   * username or password" on a flow that never asked for a password. Only
   * ending the session clears the authenticated user.
   *
   * Falls back to the login page if the redirect cannot start, which at least
   * leaves them somewhere rather than on a dead button.
   */
  const switchAccount = async (): Promise<void> => {
    try {
      await oidcLogout(authCfg);
    } catch {
      navigate('/auth/login', { replace: true });
    }
  };

  // The API's message is English by construction (it doubles as log and
  // API-client copy), so prefer a localised equivalent wherever one exists —
  // otherwise a Hindi user reads an English sentence above a Hindi button.
  const body = LOCALISED_REJECTION_KEYS[errorCode ?? ''] ?? '';

  return (
    <AuthShell>
      <div className="mx-auto flex max-w-md flex-col gap-4 py-16">
        <Alert variant="destructive">
          <OctagonX className="size-4" />
          <AlertTitle>{t('auth.oidc_error_title')}</AlertTitle>
          <AlertDescription>{body ? t(body) : error}</AlertDescription>
        </Alert>
        {isRecoverableIdentity(errorCode) ? (
          // "Back to sign in" is a loop for EVERY one of these: Keycloak's SSO
          // cookie is still valid, so the login page hands back the same
          // identity and the same error. The loop is caused by the live realm
          // session, not by which identity it holds — so the escape cannot be
          // gated on one diagnosis.
          <Button onClick={() => void switchAccount()}>{t('auth.switch_account')}</Button>
        ) : (
          <Button onClick={() => navigate('/auth/login', { replace: true })}>
            {t('auth.oidc_retry')}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}

/**
 * Rejections whose copy we localise, keyed by the API's error code.
 *
 * Anything absent falls back to the API's own English message, which is the
 * right default for the long tail (SELF_SIGNUP_DISABLED, USER_BANNED, …).
 */
const LOCALISED_REJECTION_KEYS: Readonly<Record<string, string>> = {
  TOKEN_AGGREGATOR_ACCOUNT: 'auth.aggregator_account_no_signals',
  TOKEN_ROLE_REJECTED: 'auth.non_participant_no_signals',
};

/**
 * Whether signing out and back in could plausibly succeed.
 *
 * True only for "the realm handed us the wrong identity" — the caller may well
 * hold a participant account. Deliberately NOT true for the long tail:
 * offering "sign in with a different account" for KEYCLOAK_NOT_CONFIGURED or
 * USER_BANNED would send the user round a loop that cannot resolve.
 *
 * @param errorCode - Machine-readable code from the API, when present.
 * @returns True when the sign-out escape should be offered.
 */
function isRecoverableIdentity(errorCode: string | null | undefined): boolean {
  return errorCode === 'TOKEN_AGGREGATOR_ACCOUNT' || errorCode === 'TOKEN_ROLE_REJECTED';
}

/**
 * Pull a human-readable reason out of whatever failed.
 *
 * Two very different error shapes reach here: an axios failure from
 * `/api/v1/auth/me` (which carries the API's `{ code, error, message }` — this
 * is how SELF_SIGNUP_DISABLED, USER_BANNED and friends become visible to the
 * user), or an oidc-client-ts error from the code exchange itself.
 */
/**
 * Reads the API's machine-readable error code, when present.
 *
 * `TOKEN_AGGREGATOR_ACCOUNT` means the caller is signed in as an aggregator
 * account via the shared realm's SSO session — recoverable by switching
 * account, unlike the other failures here (#753).
 *
 * @param err - The thrown request error.
 * @returns The `error.code` string, or null.
 */
function extractCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

function extractMessage(err: unknown): string | null {
  const apiMessage = (
    err as { response?: { data?: { message?: unknown } } } | null
  )?.response?.data?.message;
  if (typeof apiMessage === 'string' && apiMessage.trim() !== '') return apiMessage;

  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return null;
}

/**
 * Which account consents this signed-in user still owes, if any.
 *
 * Uses the AUTHENTICATED status endpoint — the identifier-based variant the OTP
 * login uses isn't available here, because the chooser never collects an
 * identifier. Returns null when nothing is outstanding.
 *
 * Fails OPEN, matching the OTP flow's pre-check: a consent-service blip must not
 * block a login that has already succeeded. The user is re-prompted next time.
 */
async function resolveOutstandingConsent(
  network: string,
  brand: string,
): Promise<{ config: ConsentConfigDocument; pendingConsent: ConsentAcceptBody } | null> {
  try {
    const [status, configEntries] = await Promise.all([
      getConsentStatus(network),
      fetchConsentConfigs(network),
    ]);

    const networkDefault = configEntries.find((e) => e.brand === null);
    if (!networkDefault) return null;

    const brandEntry =
      brand && brand !== 'standard' ? configEntries.find((e) => e.brand === brand) : undefined;
    const config = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

    const needed = (['terms', 'privacy'] as const).filter(
      (c) => !status.statuses[c].includes(config.documents[c].current_version),
    );
    if (needed.length === 0) return null;

    return {
      config,
      pendingConsent: {
        network,
        brand: brand !== 'standard' ? brand : null,
        // 'login', not 'signup' — this is a returning user, or a version bump.
        source: 'login',
        items: needed.map((c) => ({
          category: c,
          version: config.documents[c].current_version,
        })),
      },
    };
  } catch {
    return null;
  }
}
