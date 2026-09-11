import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Loader2, LockKeyhole, OctagonX, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/layout/auth-shell';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/auth-context';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { useNetworkConfig } from '@/hooks/use-network-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import {
  consentStatusIdentifier,
  isValidPhoneNumber,
  signupWithKeycloak,
  type AuthIdentifier,
  type LoginChannel,
} from '@/lib/auth-api';
import { fetchConsentConfigs, getConsentStatusByIdentifier } from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import {
  clearPendingConsent,
  newConsentAttemptId,
  setPendingConsent,
} from '@/lib/pending-consent';
import { setPendingSignupExtras } from '@/lib/pending-signup-extras';
import { isMinorFromAge } from '@/lib/guardian-consent';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';
import { BirthYearSelect } from '@/components/consent/u18/birth-year-select';
import { getServedScope } from '@/lib/served-binding';
import type { DotNetworkDomain } from '@/engine/types';
import { formatDomainLabel } from '@/lib/domain-icons';
import { SessionExpiredNotice } from './session-expired-notice';
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';

/**
 * Same shape as `local@rest` with an inner dot in `rest` — the check the OTP
 * screen applies. Scanned with string operations rather than the equivalent
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, whose backtracking is super-linear.
 */
function hasEmailShape(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || value.includes('@', at + 1)) return false;
  const rest = value.slice(at + 1);
  const dot = rest.indexOf('.', 1);
  return dot !== -1 && dot < rest.length - 1;
}

/** Re-narrow to the discriminated pair the guardian flow's props take. */
function toSignupIdentifier(identifier: AuthIdentifier): SignupIdentifier {
  return (identifier.email
    ? { email: identifier.email }
    : { phoneNumber: identifier.phoneNumber }) as SignupIdentifier;
}

/**
 * The login screen for deployments where the API reports `authProvider:
 * 'keycloak'`.
 *
 * Two states. First a **chooser** — existing user vs. new — because the two go to
 * very different places, and the OTP screen's "type an identifier and we'll work
 * it out" trick isn't available here: identity lookup lives inside Keycloak now.
 *
 * Signing in is a pure hand-off: identifier entry, OTP delivery, verification and
 * the consent gates all live in Keycloak's flow (the custom OTP authenticator).
 *
 * Signing up **cannot** be a hand-off. The OTP SPI is login-only — it fails with
 * `user_not_found` for an unknown identifier and cannot create users — and
 * Keycloak's built-in registration form is password-based, which breaks the
 * passwordless model. So signals creates the identity via
 * `POST /api/v1/auth/signup`, parks the signals-only fields (domain, DOB) against
 * the identifier, and then sends the person through the normal login. Nothing
 * exists in signals until that login succeeds; provisioning applies the parked
 * fields at that point.
 */
export function KeycloakLoginPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { startKeycloakLogin } = useAuth();
  const { config } = useAuthConfig();
  const { themeId, brand } = useNetworkTheme();

  const [mode, setMode] = useState<'choose' | 'signup'>('choose');
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [domain, setDomain] = useState('');
  /**
   * Age snapshot derived from the birth YEAR the user picks (#331) — the day
   * and month are never collected, here or anywhere else in the app. Undefined
   * until a year is chosen; `BirthYearSelect` owns the year itself and hands
   * back only `currentYear - birthYear`.
   */
  const [age, setAge] = useState<number | undefined>(undefined);
  /**
   * Set only for a brand-new MINOR signing up into a guardian-gated domain.
   * Renders the pre-auth guardian capture BEFORE the account is created, exactly
   * as the OTP flow does (U18 option A): `startSignupGuardian` parks the capture
   * against the signup identifier, and provisioning's `materializeSignupGuardian`
   * writes it onto the user row at first login.
   *
   * A minor does NOT go through the ordinary terms/privacy gate — the guardian
   * flow records their consent guardian-sourced instead.
   */
  const [guardianGate, setGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    age: number;
  } | null>(null);
  // Set when terms/privacy need accepting before the account is created —
  // mirrors the OTP screen's gate (`runConsentThenOtp` in login-page.tsx).
  const [consentGate, setConsentGate] = useState<{
    config: ConsentConfigDocument;
    pendingConsent: ConsentAcceptBody;
    identifier: AuthIdentifier;
  } | null>(null);

  // Same contract as the OTP login: RequireAuth sends the intended path here
  // as ?redirect=, and it must survive the round-trip through Keycloak.
  const redirectTo = searchParams.get('redirect') ?? '/';

  const channels: LoginChannel[] = config?.loginChannels ?? ['phone', 'email'];
  const canSignup = config?.selfSignupAllowed === true;

  /**
   * Which identifier the new account is created with. Phone is the default when
   * both channels are enabled, matching the OTP screen — but it is a *default*,
   * not the only option: a signup may use either channel the instance allows,
   * exactly as `POST /api/v1/auth/signup` accepts either.
   */
  const [signupChannel, setSignupChannel] = useState<LoginChannel>('phone');

  // The config arrives after first paint, so the default above can be a channel
  // this instance doesn't run. Same correction the OTP screen applies to `mode`.
  useEffect(() => {
    if (config && !config.loginChannels.includes(signupChannel)) {
      setSignupChannel(config.loginChannels[0]);
    }
  }, [config, signupChannel]);

  /**
   * Domain options come from the served network's own schema — not user input —
   * so a signup can only ever name a domain the network actually defines. The
   * API validates against served domains again; this is just the picker.
   *
   * Via React Query (the app's caching layer — see apps/ui/CLAUDE.md) rather
   * than a hand-rolled effect, which buys three things that matter here:
   * `isLoading` distinct from `isError` (an empty list otherwise cannot say
   * whether it is still loading or failed), automatic retry, and retention of
   * the last successful config across a failed refetch — so a blip can never
   * empty the list that `guardian_consent_required` is read from.
   *
   * Passing `null` outside signup mode leaves the query disabled, matching the
   * old effect's early return.
   */
  const {
    data: networkConfig,
    isLoading: domainsLoading,
    isError: domainsError,
    refetch: refetchNetworkConfig,
  } = useNetworkConfig(mode === 'signup' ? themeId : null);
  const networkDomains = useMemo(() => networkConfig?.domains ?? [], [networkConfig]);

  // Memoised (like the OTP screen) so the auto-select effect below has a stable
  // dependency instead of re-running on every render.
  const servedScope = useMemo(() => getServedScope(), []);
  const domainOptions = useMemo(
    () =>
      servedScope
        ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
        : networkDomains,
    [servedScope, networkDomains],
  );

  // Single-domain / split portal: exactly one served domain means there is no
  // choice to make. Auto-select it and hide the picker in the JSX — a
  // one-option toggle is meaningless and would force a pointless click.
  // Mirrors login-page.tsx's OTP signup form.
  //
  // This makes the signup carry a domain, which is what lets `handleSignup`
  // reach the gated-domain branch at all. Enforcing that branch is a separate
  // guard there (a gated domain rejects a blank DOB); auto-selection alone
  // would leave the U18 path reachable but skippable.
  useEffect(() => {
    if (domainOptions.length === 1 && !domain) {
      setDomain(domainOptions[0].id);
    }
  }, [domainOptions, domain]);

  /**
   * Whether the domain being signed up for routes minors through the guardian
   * flow. Only such a domain has any use for a birth year — a provider has no
   * U18 flow at all, so asking them is pure friction. Drives both the field's
   * visibility and the minor check in `handleSignup`, so the two cannot disagree.
   *
   * Unknown while the network config is still loading (`networkDomains` empty),
   * which resolves to "not gated" and simply hides the field until it arrives.
   */
  const selectedDomainIsGated =
    networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false;

  /**
   * The picker is unmounted whenever the chosen domain isn't guardian-gated,
   * and `BirthYearSelect` owns the year internally — so switching seeker →
   * provider → seeker would show an empty picker while a previously derived
   * age still sat here and rode along with the signup. Clear it whenever the
   * field is not on screen, so what's submitted is always what's displayed.
   */
  useEffect(() => {
    if (!selectedDomainIsGated) setAge(undefined);
  }, [selectedDomainIsGated]);

  /**
   * Clear the busy flags when this page comes BACK from the bfcache.
   *
   * Clicking "Sign in" sets `isRedirecting` and hands the browser to
   * Keycloak — the code after `startKeycloakLogin` never runs, by design.
   * Pressing Back then restores this page from the browser's back/forward
   * cache with its JS heap intact, busy flags included, so every choice
   * renders disabled with a spinner and stays that way until a manual
   * reload.
   *
   * `pageshow` with `persisted: true` is the one signal that distinguishes a
   * bfcache restore from a fresh load (a fresh load re-runs the module and
   * resets the state on its own, which is why this only ever bites on Back).
   *
   * Not reproducible under `vite dev`: its HMR WebSocket makes the page
   * ineligible for the bfcache, so Back re-executes the app instead of
   * restoring it — the bug only appears on a deployed build.
   */
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setIsRedirecting(false);
      setIsSigningUp(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const handleSignIn = async (consentAttempt?: string) => {
    setIsRedirecting(true);
    setError(null);
    try {
      await startKeycloakLogin(redirectTo, consentAttempt);
      // On success the browser navigates to Keycloak and never gets here.
    } catch (err) {
      setIsRedirecting(false);
      setError(err instanceof Error ? err.message : t('auth.oidc_error_desc'));
    }
  };

  /**
   * The selected domain's entry in the list actually loaded, or null after
   * telling the user why it can't be resolved.
   *
   * A miss must BLOCK rather than fall through: `guardian_consent_required` is
   * read from this entry, so treating "not in the list" as "not gated" is what
   * lets a failed refetch quietly switch off the U18 gate for a domain that is
   * still selected.
   */
  const resolveSelectedDomain = (): DotNetworkDomain | null => {
    // Submitting mid-fetch reports "still loading", not a failure — and does
    // not retry, so the in-flight request is left to finish.
    if (domainsLoading) {
      toast.error(t('auth.signup_options_loading'));
      return null;
    }

    const meta = domain ? networkDomains.find((d) => d.id === domain) : undefined;
    if (meta) return meta;

    if (domainsError) {
      // Transient — offer a retry, so a blip that outlived React Query's own
      // retries recovers on the next attempt instead of needing a reload.
      refetchNetworkConfig();
      toast.error(t('auth.signup_options_unavailable'));
    } else if (domainOptions.length === 0) {
      // Loaded, but nothing is selectable: a config problem (the network
      // defines no domains, or VITE_SERVED_BINDINGS names one it doesn't
      // define). Retrying cannot fix that, so don't spin on it.
      toast.error(t('auth.signup_options_unavailable'));
    } else {
      toast.error(t('auth.select_domain_required'));
    }
    return null;
  };

  const handleSignup = async () => {
    setError(null);

    if (!name.trim()) {
      setError(t('auth.signup_name_required'));
      return;
    }
    if (signupChannel === 'phone' && !isValidPhoneNumber(phoneNumber)) {
      toast.error(t('auth.toast_invalid_phone'), {
        description: t('auth.toast_invalid_phone_desc'),
      });
      return;
    }
    // Same shape check the OTP screen applies — the API takes `z.email()`, so a
    // malformed address is a 400 the user can't act on if it gets that far.
    if (signupChannel === 'email' && !hasEmailShape(email.trim())) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return;
    }
    /**
     * A signup must always carry a domain — the same guard the OTP screen
     * applies. `domain` is optional on POST /auth/signup, so submitting without
     * one creates an account with no `user.domains`: the single-domain lock
     * never binds, and (on a guardian-gated domain) the DOB/guardian branch
     * below is skipped because it keys off the selected domain.
     */
    const selectedDomainMeta = resolveSelectedDomain();
    if (!selectedDomainMeta) return;

    /**
     * Normalise ONCE, here, and use this everywhere downstream.
     *
     * The pre-auth guardian capture is keyed on a hash of the identifier and the
     * server only trims it — it does not convert to E.164. Handing the guardian
     * flow the raw national number while the Keycloak token later carries the
     * E.164 form means `materializeSignupGuardian` finds no match at first login
     * and silently no-ops: the user completes the guardian OTP, the account is
     * created, and the guardian record is dropped. `login-page` avoids this the
     * same way (`toE164` before building its identifier).
     */
    const identifier: AuthIdentifier =
      signupChannel === 'phone' ? { phoneNumber: toE164(phoneNumber) } : { email: email.trim() };

    // Read from the resolved entry, not the render-time flag: that one falls
    // back to `false` for an unknown domain, which is fine for hiding a field
    // but must never decide whether the U18 gate applies.
    const domainIsGated = selectedDomainMeta.guardian_consent_required === true;

    /**
     * On a guardian-gated domain the age must be known BEFORE the account
     * exists. The OTP screen enforces that with a blocking DOB step whose
     * continue button stays disabled until a year is picked
     * (`components/consent/u18/signup-dob-step.tsx`). Here the field is inline
     * and optional, so without this guard an unpicked year yields
     * `age === undefined`, the minor check below never fires, and a minor is
     * signed up as an adult — the U18 path skipped entirely rather than
     * merely deferred.
     */
    if (domainIsGated && age === undefined) {
      toast.error(t('auth.signup_dob_required'));
      return;
    }

    // A minor in a guardian-gated domain must have a guardian captured and
    // OTP-verified before the account exists — same ordering as the OTP flow.
    // Mirrors the server check in services/minor.ts; the server re-checks and
    // rejects an adult with NOT_A_MINOR.
    if (domainIsGated && age !== undefined && isMinorFromAge(age)) {
      setGuardianGate({ identifier, domain, age });
      return;
    }

    setIsSigningUp(true);
    // Terms/privacy must be accepted BEFORE the account is created, matching the
    // OTP flow's ordering. If the gate opens, `handleConsentAccept` resumes here.
    const gated = await openConsentGateIfNeeded(identifier);
    if (gated) {
      setIsSigningUp(false);
      return;
    }
    await createAccountAndSignIn(identifier);
  };

  /**
   * Consent pre-check, mirroring `runConsentThenOtp` in login-page.tsx.
   *
   * Returns true when the modal is now showing and signup should pause. Fails
   * OPEN on error, exactly as the OTP flow does — a consent-service blip must not
   * block registration; the user is re-prompted on their next login.
   */
  const openConsentGateIfNeeded = async (identifier: AuthIdentifier): Promise<boolean> => {
    try {
      // Normalize the phone to the canonical E.164 form the API stores, or the
      // exact-match lookup misses and the gate re-prompts every time.
      const identifierParam = consentStatusIdentifier(identifier);

      const [consentStatus, configEntries] = await Promise.all([
        getConsentStatusByIdentifier({ network: themeId, ...identifierParam }),
        fetchConsentConfigs(themeId),
      ]);

      const networkDefault = configEntries.find((e) => e.brand === null);
      if (!networkDefault) return false;

      const brandEntry =
        brand && brand !== 'standard' ? configEntries.find((e) => e.brand === brand) : undefined;
      const mergedConfig = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

      const needed = (['terms', 'privacy'] as const).filter(
        (c) => !consentStatus.statuses[c].includes(mergedConfig.documents[c].current_version),
      );
      if (needed.length === 0) return false;

      setConsentGate({
        config: mergedConfig,
        identifier,
        pendingConsent: {
          network: themeId,
          brand: brand !== 'standard' ? brand : null,
          source: 'signup',
          items: needed.map((c) => ({
            category: c,
            version: mergedConfig.documents[c].current_version,
          })),
        },
      });
      return true;
    } catch {
      // Fail open — same posture as the OTP flow's pre-check.
      return false;
    }
  };

  /**
   * Accepted in the modal. The acceptance can't be written yet — the accept
   * endpoint is authenticated — so park it for the callback page to flush once
   * the session exists, then carry on creating the account.
   */
  const handleConsentAccept = async () => {
    if (!consentGate) return;
    const { pendingConsent, identifier } = consentGate;
    // Bind the parked acceptance to THIS login. The same id is routed through
    // Keycloak in the OIDC `state`, so only the callback for this redirect can
    // consume it — without that, an abandoned round trip on a shared device
    // gets written against whoever signs in next. See lib/pending-consent.ts.
    const consentAttempt = newConsentAttemptId();
    if (consentAttempt) {
      setPendingConsent(pendingConsent, consentAttempt);
    } else {
      // No CSPRNG, so the acceptance cannot be bound to this login. Park
      // nothing rather than parking something any later login could claim —
      // the gate re-prompts once signed in, which is the safe direction to
      // fail. Also drop anything already sitting there for the same reason.
      clearPendingConsent();
    }
    setConsentGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier, consentAttempt ?? undefined);
  };

  /**
   * Guardian captured and verified. Create the account straight away — the
   * guardian flow has already recorded terms/privacy guardian-sourced, so the
   * ordinary consent gate must not also run.
   */
  const handleGuardianComplete = async () => {
    if (!guardianGate) return;
    const { identifier } = guardianGate;
    setGuardianGate(null);
    setIsSigningUp(true);
    await createAccountAndSignIn(identifier);
  };

  const createAccountAndSignIn = async (identifier: AuthIdentifier, consentAttempt?: string) => {
    try {
      const result = await signupWithKeycloak({
        name: name.trim(),
        ...identifier,
        ...(domain ? { domain } : {}),
        ...(age !== undefined ? { age } : {}),
      });

      // Park the same fields client-side for the callback to write over an
      // authenticated session. The server already stashed them in Redis, but
      // that stash has a 30-minute TTL and fails silently — see
      // lib/pending-signup-extras.ts. Both paths are idempotent.
      if (domain) {
        setPendingSignupExtras({ domain, ...(age !== undefined ? { age } : {}) });
      }

      // Either way the next step is the same — sign in. An identifier that is
      // already taken isn't something the user needs to act on differently.
      toast.success(
        result.alreadyRegistered
          ? t('auth.signup_existing_title')
          : t('auth.signup_created_title'),
        {
          description: result.alreadyRegistered
            ? t('auth.signup_existing_desc')
            : t('auth.signup_created_desc'),
        }
      );
      await handleSignIn(consentAttempt);
    } catch (err) {
      const apiMessage = (err as { response?: { data?: { message?: unknown } } } | null)
        ?.response?.data?.message;
      setError(
        typeof apiMessage === 'string' && apiMessage.trim() !== ''
          ? apiMessage
          : t('auth.oidc_error_desc')
      );
    } finally {
      setIsSigningUp(false);
    }
  };

  const busy = isRedirecting || isSigningUp;

  const modeBody =
    mode === 'choose' ? (
      <div className="space-y-3">
        <ChoiceCard
          icon={<LockKeyhole className="size-5" />}
          title={t('auth.choose_existing_title')}
          description={t('auth.choose_existing_desc')}
          emphasised
          disabled={busy}
          busy={isRedirecting}
          onClick={() => {
            void handleSignIn();
          }}
        />

        {canSignup && (
          <ChoiceCard
            icon={<UserPlus className="size-5" />}
            title={t('auth.choose_new_title')}
            description={t('auth.choose_new_desc')}
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode('signup');
            }}
          />
        )}

        {/* Gated instance: explain why "Create an account" is missing. This
            is shown on ARRIVAL, before any identifier is entered, so it must
            not claim the account was looked up and not found — which is what
            `auth.signup_disabled_message` says. That string is the
            better-auth path's post-lookup result (login-page.tsx sets
            `signupBlocked` only after `exists === false`), and reusing it
            here told every visitor "User doesn't exist" before they had
            typed anything. */}
        {!canSignup && (
          <p className="pt-1 text-sm text-muted-foreground">
            {t('auth.signup_invite_only')}
          </p>
        )}
      </div>
    ) : (
      <div className="space-y-4">
        {/* Phone / Email pill toggle — the account can be created against
            either identifier, so it is only hidden when the instance runs a
            single channel and there is nothing to choose. Mirrors the OTP
            screen's toggle. */}
        {channels.length > 1 && (
          <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSignupChannel(c);
                  setError(null);
                }}
                className={[
                  'flex-1 rounded-full py-1.5 font-medium transition-colors capitalize',
                  signupChannel === c
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="signup-name">{t('auth.label_name')}</Label>
          <Input
            id="signup-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('auth.placeholder_name')}
            autoComplete="name"
          />
        </div>

        {signupChannel === 'phone' ? (
          <div className="space-y-1.5">
            <Label htmlFor="signup-phone">{t('auth.label_mobile')}</Label>
            <PhoneInput id="signup-phone" value={phoneNumber} onChange={setPhoneNumber} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="signup-email">{t('auth.label_email')}</Label>
            <Input
              id="signup-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.placeholder_email')}
              autoComplete="email"
            />
          </div>
        )}

        {/* Shown only when there is a real choice (>1 served domain); a
            single-domain portal auto-selects it above and hides this. */}
        {domainOptions.length > 1 && (
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{t('auth.label_domain')}</Label>
            {/* Segmented toggle, matching the OTP signup form's domain picker. */}
            <div className="flex flex-wrap gap-1 rounded-full border border-border bg-muted p-1 text-sm">
              {domainOptions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDomain(d.id)}
                  disabled={busy}
                  className={[
                    'flex-1 rounded-full py-1.5 px-3 font-medium transition-colors capitalize whitespace-nowrap',
                    domain === d.id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {formatDomainLabel(d.id, networkDomains)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Only a guardian-gated domain (e.g. seeker) needs an age; a provider
            is never routed through the U18 flow, so the field is hidden. The
            YEAR alone is collected (#331) — same control the OTP screen's DOB
            step uses, so both signup entry points ask for the same thing. */}
        {selectedDomainIsGated && (
          <div className="space-y-1.5">
            <Label htmlFor="signup-dob-year">{t('auth.signup_dob_label_ym')}</Label>
            <BirthYearSelect idPrefix="signup-dob" onChange={setAge} />
            <p className="text-xs text-muted-foreground">{t('auth.signup_dob_hint')}</p>
          </div>
        )}

        <Button
          className="w-full"
          disabled={busy}
          onClick={() => {
            void handleSignup();
          }}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {isSigningUp ? t('auth.signup_submitting') : t('auth.oidc_redirecting')}
            </>
          ) : (
            t('auth.cta_create_account')
          )}
        </Button>
      </div>
    );

  return (
    <>
      {consentGate && (
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          onAccept={() => {
            void handleConsentAccept();
          }}
        />
      )}
      <AuthShell>
      <button
        type="button"
        onClick={() => (mode === 'signup' ? setMode('choose') : navigate('/'))}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('auth.back')}
      </button>

      <SessionExpiredNotice />

      <div className="mb-6">
        <h2 className="text-3xl font-bold text-foreground">
          {mode === 'signup'
            ? t('auth.heading_create_account')
            : t('auth.heading_welcome_back')}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {mode === 'signup' ? t('auth.signup_sub') : t('auth.choose_sub')}
        </p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <OctagonX className="size-4" />
          <AlertTitle>{t('auth.oidc_error_title')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {guardianGate ? (
        <SignupGuardianFlow
          network={themeId}
          domain={guardianGate.domain}
          brand={brand !== 'standard' ? brand : null}
          identifier={toSignupIdentifier(guardianGate.identifier)}
          age={guardianGate.age}
          onComplete={() => {
            void handleGuardianComplete();
          }}
        />
      ) : (
        modeBody
      )}
      </AuthShell>
    </>
  );
}

/**
 * One of the two entry choices. A button rather than a link because both do work
 * (one redirects to Keycloak, one swaps the panel) — nothing here is navigation.
 */
function ChoiceCard({
  icon,
  title,
  description,
  emphasised = false,
  disabled,
  busy = false,
  onClick,
}: Readonly<{
  icon: React.ReactNode;
  title: string;
  description: string;
  emphasised?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-4 rounded-xl border px-4 py-4 text-left transition-colors disabled:opacity-60 ${
        emphasised
          ? 'border-primary/60 hover:border-primary'
          : 'border-border hover:border-foreground/30'
      }`}
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
          emphasised ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
        }`}
      >
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span>
      </span>

      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
          emphasised ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ArrowRight className="size-4" />
        )}
      </span>
    </button>
  );
}
