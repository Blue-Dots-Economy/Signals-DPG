import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthShell } from '@/components/layout/auth-shell';
import { formatDomainLabel } from '@/lib/domain-icons';
import {
  checkUser,
  consentStatusIdentifier,
  isValidPhoneNumber,
  requestOtp,
  u18Precheck,
  type AuthConfigResponse,
  type AuthIdentifier,
  type LoginChannel,
} from '@/lib/auth-api';
import {
  fetchConsentConfigs,
  getConsentStatusByIdentifier,
} from '@/lib/consent-api';
import { mergeConsentConfig } from '@/hooks/use-consent-config';
import { ConsentModal } from '@/components/consent/consent-modal';
import { useNetworkTheme } from '@/theme/theme-provider';
import type { ConsentAcceptBody, ConsentConfigDocument } from '@dpg/schemas';
import { toast } from 'sonner';
import { fetchNetworkConfig } from '@/lib/network-api';
import type { DotNetworkDomain } from '@/engine/types';
import { getServedScope } from '@/lib/served-binding';
import type { SignupExtras } from '@/lib/signup-domain';
import { SignupDobStep } from '@/components/consent/u18/signup-dob-step';
import { isMinorFromAge } from '@/lib/guardian-consent';
import { PhoneInput, toE164 } from '@/components/auth/phone-input';
import { useAuthConfig } from '@/hooks/use-auth-config';
import { KeycloakLoginPanel } from './keycloak-login-panel';
import {
  SignupGuardianFlow,
  type SignupIdentifier,
} from '@/components/consent/u18/signup-guardian-flow';

type AuthMode = 'phone' | 'email';

type PendingConsent = ConsentAcceptBody;

interface ConsentGateState {
  config: ConsentConfigDocument;
  pendingConsent: PendingConsent;
}

function domainLabel(domain: DotNetworkDomain): string {
  return formatDomainLabel(domain.id, [domain]);
}


/**
 * Route entry for /auth/login. Picks the login experience for this deployment.
 *
 * Split as a wrapper rather than a branch inside `OtpLoginPage` so the OTP
 * screen below is byte-for-byte unchanged, and so the choice happens before
 * either component's hooks run.
 *
 * The choice comes from the API (`GET /api/v1/auth/config`), not from a
 * build-time env var — see lib/keycloak-config.ts. That costs one render with
 * no screen while the config loads; showing the OTP form first and then
 * swapping it for a redirect button would be worse.
 */
/**
 * Explain a sign-in that failed before a session existed — cancelled at
 * Keycloak, an expired 5-minute flow, or a refused code exchange. The API can
 * only signal it as `?auth_error=1` on the redirect, so this is the one place
 * that can say what happened.
 *
 * Lives on the WRAPPER, not on either panel: under Keycloak the OTP page never
 * mounts, so an effect placed there would silently never run — which is exactly
 * how this was missed the first time.
 */
function useFailedSignInNotice(): void {
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  useEffect(() => {
    if (searchParams.get('auth_error') !== '1') return;
    toast.error(t('auth.oidc_error_title', 'Sign-in could not be completed'), {
      // Stable id so StrictMode's double-invoke shows one toast, not two.
      id: 'oidc-auth-error',
      description: t(
        'auth.oidc_error_cancelled',
        'The sign-in was cancelled or timed out. Please try again.',
      ),
    });
    // Scrub the param so a refresh does not re-announce a stale failure.
    const url = new URL(window.location.href);
    url.searchParams.delete('auth_error');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, [searchParams, t]);
}

export function LoginPage() {
  const { isKeycloakLogin, isLoading } = useAuthConfig();
  useFailedSignInNotice();

  if (isLoading) {
    return (
      <AuthShell>
        <div className="mx-auto flex max-w-md justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </AuthShell>
    );
  }

  return isKeycloakLogin ? <KeycloakLoginPanel /> : <OtpLoginPage />;
}

function OtpLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { t } = useTranslation();
  const { themeId, brand } = useNetworkTheme();

  useEffect(() => {
    const wrongPortalDomain = (location.state as { wrongPortalDomain?: string } | null)?.wrongPortalDomain;
    if (wrongPortalDomain) {
      // Stable id so the toast is de-duped if this effect runs more than once
      // (e.g. React StrictMode double-invokes it in dev) — one visible toast.
      toast.error(t('auth.wrong_portal', { domain: wrongPortalDomain }), {
        id: 'wrong-portal-block',
      });
      // Clear the state so the toast doesn't re-fire on back/refresh.
      window.history.replaceState({}, '');
    }
  }, [location.state, t]);

  const [mode, setMode] = useState<AuthMode>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [userExists, setUserExists] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [consentGate, setConsentGate] = useState<ConsentGateState | null>(null);
  // Shared with the LoginPage wrapper above via React Query, so the instance's
  // auth config is fetched once per session rather than once per component.
  // The fail-safe default (gated + both channels) keeps the API authoritative
  // if the request fails — see use-auth-config.ts.
  const { config: fetchedAuthCfg } = useAuthConfig();
  const authCfg: AuthConfigResponse | null =
    fetchedAuthCfg ?? { selfSignupAllowed: false, loginChannels: ['phone', 'email'] };
  const [signupBlocked, setSignupBlocked] = useState(false);
  const [networkDomains, setNetworkDomains] = useState<DotNetworkDomain[]>([]);
  // Capture the checked identifier at the time of submission so the consent
  // accept and OTP request use the same normalized values.
  const [pendingIdentifier, setPendingIdentifier] = useState<AuthIdentifier | null>(null);
  const [pendingUserExists, setPendingUserExists] = useState<boolean>(false);
  const [pendingName, setPendingName] = useState<string>('');
  const [pendingSignupExtras, setPendingSignupExtras] = useState<SignupExtras | null>(null);
  // Set only for a brand-new MINOR signup in a guardian-gated domain — renders
  // the pre-auth SignupGuardianFlow and defers the ward's own OTP until the
  // guardian is verified (U18 option A). null for every other path.
  const [signupGuardianGate, setSignupGuardianGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    age: number;
    resolvedName: string;
    resolvedSignupExtras: SignupExtras;
    /** true = an EXISTING user backfilling age before login (not a new signup). */
    exists: boolean;
  } | null>(null);
  // Set for a guardian-gated (u18-enabled) domain — renders the DOB step. For a
  // brand-new signup it's AFTER the name/domain form; for an existing user
  // missing DOB it's after the phone check, BEFORE the login OTP.
  const [signupDobGate, setSignupDobGate] = useState<{
    identifier: AuthIdentifier;
    domain: string;
    resolvedName: string;
    exists: boolean;
  } | null>(null);
  const redirectTo = searchParams.get('redirect') ?? '/';
  const servedScope = useMemo(() => getServedScope(), []);

  // Domain options for the signup form's domain select. Fetched from the
  // served network's own schema (network.domains) — not user input — so the
  // domain a signup submits is always one the network actually defines.
  useEffect(() => {
    fetchNetworkConfig(themeId)
      .then((cfg) => setNetworkDomains(cfg.domains ?? []))
      .catch(() => setNetworkDomains([]));
  }, [themeId]);

  // Restrict to the served set when this deployment is bound to a subset of
  // domains (single- or multi-domain portal) — mirrors profile-form-page's
  // own domain-picker scoping so a signup can't pick a domain this portal
  // doesn't serve.
  const domainOptions = servedScope
    ? networkDomains.filter((d) => servedScope.domains.includes(d.id))
    : networkDomains;

  // Single-domain / split portal: exactly one served domain means there is no
  // choice to make. Auto-select it (so the signup still carries a domain and
  // the guardian/DOB gating below still runs) and hide the picker in the JSX —
  // a one-option toggle is meaningless and would force a pointless click.
  useEffect(() => {
    if (domainOptions.length === 1 && !domain) {
      setDomain(domainOptions[0].id);
    }
  }, [domainOptions, domain]);

  const channels: LoginChannel[] = authCfg?.loginChannels ?? ['phone', 'email'];
  const onlyEmail = channels.length === 1 && channels[0] === 'email';
  const onlyPhone = channels.length === 1 && channels[0] === 'phone';

  useEffect(() => {
    if (authCfg && !authCfg.loginChannels.includes(mode)) {
      setMode(authCfg.loginChannels[0]);
    }
  }, [authCfg, mode]);

  // phoneNumber holds the national part; the wire value is the full E.164.
  const fullPhone = toE164(phoneNumber);
  const identifier: AuthIdentifier = mode === 'email' ? { email } : { phoneNumber: fullPhone };
  const contactValue = mode === 'email' ? email : phoneNumber;
  // Gate the CTA: in phone mode the full 10-digit national number must be in;
  // in email mode a non-empty value. Keeps "Continue" disabled until then.
  const contactComplete = mode === 'email' ? email.trim().length > 0 : phoneNumber.length === 10;
  const contactLabel = mode === 'email'
    ? t('auth.contact_label_email')
    : t('auth.contact_label_phone');

  const handleModeChange = (value: AuthMode) => {
    setMode(value);
    setUserExists(null);
    setSignupBlocked(false);
  };

  const proceedToOtp = async (
    resolvedIdentifier: AuthIdentifier,
    resolvedUserExists: boolean,
    resolvedName: string,
    resolvedSignupExtras: SignupExtras | null,
    pendingConsent?: PendingConsent,
  ) => {
    await requestOtp(resolvedIdentifier);
    navigate('/auth/otp', {
      state: {
        ...resolvedIdentifier,
        userExists: resolvedUserExists,
        name: resolvedName,
        redirectTo,
        pendingConsent: pendingConsent ?? null,
        // Set for a new signup (domain + age) and for an existing minor who
        // picked their year of birth pre-OTP (age only). otp-page persists it.
        signupExtras: resolvedSignupExtras,
      },
    });
  };

  const handleConsentAccept = async () => {
    if (!consentGate || !pendingIdentifier) return;
    // Capture locals and close the modal immediately to prevent re-entry
    // from a double-click before the async OTP request completes.
    const gate = consentGate;
    const ident = pendingIdentifier;
    const userEx = pendingUserExists;
    const uname = pendingName;
    const extras = pendingSignupExtras;
    setConsentGate(null);
    try {
      await proceedToOtp(ident, userEx, uname, extras, gate.pendingConsent);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    }
  };

  // Evaluate consent, then send the OTP (or hold for the consent modal).
  // Best-effort: on any pre-check failure we proceed without gating — the user
  // is re-prompted post-verify on their next login (spec §1.1). Adults reach
  // this from the signup form (ungated) or after the DOB step (gated-adult);
  // minors never do (the guardian flow records their consent instead).
  const runConsentThenOtp = async (
    ident: AuthIdentifier,
    exists: boolean,
    resolvedName: string,
    resolvedSignupExtras: SignupExtras | null,
  ) => {
    try {
      // Normalize the phone to the canonical E.164 form auth stores; otherwise
      // the exact-match lookup in status-by-identifier misses a returning user
      // and the T&C gate re-prompts every login (see consentStatusIdentifier).
      const identifierParam = consentStatusIdentifier(ident);

      const [consentStatus, configEntries] = await Promise.all([
        getConsentStatusByIdentifier({ network: themeId, ...identifierParam }),
        fetchConsentConfigs(themeId),
      ]);

      const networkDefault = configEntries.find((e) => e.brand === null);
      if (networkDefault) {
        const brandEntry = brand && brand !== 'standard'
          ? configEntries.find((e) => e.brand === brand)
          : undefined;
        const mergedConfig = mergeConsentConfig(networkDefault.schema, brandEntry?.schema);

        const needed = (['terms', 'privacy'] as const).filter(
          (c) => !consentStatus.statuses[c].includes(mergedConfig.documents[c].current_version),
        );

        if (needed.length > 0) {
          setPendingIdentifier(ident);
          setPendingUserExists(exists);
          setPendingName(resolvedName);
          setPendingSignupExtras(resolvedSignupExtras);
          setConsentGate({
            config: mergedConfig,
            pendingConsent: {
              network: themeId,
              brand: brand !== 'standard' ? brand : null,
              source: exists ? 'login' : 'signup',
              items: needed.map((c) => ({
                category: c,
                version: mergedConfig.documents[c].current_version,
              })),
            },
          });
          // Do NOT send OTP yet — wait for accept.
          setIsLoading(false);
          return;
        }
      }
    } catch {
      // Consent pre-check failed — fail-open, proceed to OTP without gating.
      // The user will be re-prompted post-verify on their next login.
    }

    await proceedToOtp(ident, exists, resolvedName, resolvedSignupExtras);
  };

  // Resolve the birth-year step: minor -> guardian flow (before their own OTP);
  // adult -> ordinary consent + OTP. Age rides along in signupExtras so
  // otp-page persists it post-verify.
  const handleSignupDob = async (age: number) => {
    const gate = signupDobGate;
    if (!gate) return;
    const extras: SignupExtras = { domain: gate.domain, age };
    setSignupDobGate(null);

    // A minor never sees the adult terms/privacy consent checkbox — the guardian
    // flow records their consent instead.
    if (isMinorFromAge(age)) {
      if (!gate.exists) {
        // NEW minor: the guardian flow is the very next screen, so the toast
        // matches what they see next.
        toast.info(t('auth.minor_toast_title', "You're under 18"), {
          description: t(
            'auth.minor_toast_desc',
            'A guardian needs to confirm your account before you can continue.',
          ),
        });
        // Guardian pre-auth is safe (account materializes on creation, same
        // session owns the new identifier).
        setSignupGuardianGate({
          identifier: gate.identifier,
          domain: gate.domain,
          age,
          resolvedName: gate.resolvedName,
          resolvedSignupExtras: extras,
          exists: gate.exists,
        });
        return;
      }
      // EXISTING minor: the guardian APIs are session-scoped, so the guardian
      // step must run AFTER the login OTP. Skip the adult consent and send the
      // OTP; the post-login authed guardian flow (otp-page) records their u18
      // consent. Age rides in signupExtras and is persisted post-verify. Set the
      // two-step expectation here so the OTP page (not the guardian step) coming
      // next doesn't read as a mismatch.
      toast.info(t('auth.minor_toast_title', "You're under 18"), {
        description: t(
          'auth.minor_verify_then_guardian_desc',
          'First verify your number, then a guardian will confirm your account.',
        ),
      });
      setIsLoading(true);
      try {
        await proceedToOtp(gate.identifier, gate.exists, gate.resolvedName, extras);
      } catch {
        toast.error(t('auth.toast_send_code_error'), {
          description: t('auth.toast_send_code_error_desc'),
        });
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setIsLoading(true);
    try {
      await runConsentThenOtp(gate.identifier, gate.exists, gate.resolvedName, extras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Guards extracted from handleSubmit to keep its cognitive complexity within
  // bounds (SonarCloud S3776) — each is a self-contained, side-effecting step.
  // handleSubmit's `finally` owns `setIsLoading(false)`, so these never repeat it.

  /** Contact-format guard. Toasts + returns false when the number/email is malformed. */
  const validateContact = (): boolean => {
    if (mode === 'phone' && !isValidPhoneNumber(fullPhone)) {
      toast.error(t('auth.toast_invalid_phone'), {
        description: t('auth.toast_invalid_phone_desc'),
      });
      return false;
    }
    if (mode === 'email' && !/^[^\s@]+@[^\s.@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error(t('auth.toast_invalid_email'), {
        description: t('auth.toast_invalid_email_desc'),
      });
      return false;
    }
    return true;
  };

  /** Signup-only pre-flight guards (self-signup gate, name, domain). Halt = true. */
  const signupPreflightHalts = (exists: boolean): boolean => {
    if (!exists && authCfg && !authCfg.selfSignupAllowed) {
      toast.error(t('auth.toast_signup_disabled'), {
        description: t('auth.toast_signup_disabled_desc'),
      });
      setSignupBlocked(true);
      return true;
    }
    if (!exists && !name.trim()) {
      toast.info(t('auth.toast_one_more_step'), {
        description: t('auth.toast_one_more_step_desc', { contactLabel }),
      });
      return true;
    }
    if (!exists && !domain) {
      toast.error(
        domainOptions.length === 0
          ? t('auth.signup_options_unavailable')
          : t('auth.select_domain_required'),
      );
      return true;
    }
    return false;
  };

  /**
   * Existing-user U18 pre-check: opens the DOB step and returns true (halt
   * before OTP) when a year-of-birth is required. Fail-open on precheck error —
   * the post-login gate still catches a minor.
   */
  const resolveExistingDobGate = async (): Promise<boolean> => {
    try {
      const pre = await u18Precheck(themeId, identifier);
      if (pre.requiresDob) {
        setSignupDobGate({ identifier, domain: '', resolvedName: '', exists: true });
        return true;
      }
    } catch {
      // Fail-open: precheck failure must not block login.
    }
    return false;
  };

  /**
   * Whether a brand-new signup's domain goes live on completeness alone
   * (`go_live_required` without `consent_required`) — then the Terms/Privacy
   * pre-check is skipped. Absent config ⇒ require consent (safe default).
   */
  const domainSkipsConsent = (): boolean => {
    const domGates = networkDomains.find((d) => d.id === domain)?.go_live_required;
    return domGates ? !domGates.includes('consent_required') : false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactValue.trim()) return;

    // Client-side validation — server won't crash on a malformed number
    // but the OTP send will fail silently. Surface a clean inline error.
    if (!validateContact()) return;

    setIsLoading(true);
    try {
      const response = await checkUser(identifier);
      const exists = response.userExists;
      setUserExists(exists);
      setSignupBlocked(false);

      // Signup-only pre-flight guards (self-signup gate, name, domain). DOB is
      // NOT asked here — it's a separate step for guardian-gated domains (below).
      if (signupPreflightHalts(exists)) return;

      const resolvedName = exists ? '' : name;

      // A brand-new signup in a guardian-gated (u18-enabled) domain collects
      // DOB in a SEPARATE next step. Ungated domains (e.g. provider) skip DOB
      // entirely and go straight to consent + OTP. The server stays
      // authoritative on minor + gated + served.
      const gatedDomain =
        !exists && (networkDomains.find((d) => d.id === domain)?.guardian_consent_required ?? false);
      if (gatedDomain) {
        setSignupDobGate({ identifier, domain, resolvedName, exists: false });
        setIsLoading(false);
        return; // DOB step renders next; no OTP yet.
      }

      // EXISTING user missing a DOB on a gated domain: collect the year of birth
      // BEFORE the OTP (UI-only capture — no API call, no session yet). The
      // branch happens here: an adult continues to consent + OTP; a minor is
      // sent to the OTP first (ownership) and then, POST-login, the AUTHENTICATED
      // guardian flow runs — the guardian APIs are session-scoped and must never
      // be public for an existing account, so the guardian step can't precede
      // the OTP. Age is persisted post-verify (otp-page) via signupExtras.
      if (exists && (await resolveExistingDobGate())) return; // DOB step renders next; no OTP yet.

      const resolvedSignupExtras: SignupExtras | null = exists ? null : { domain };

      // The Terms/Privacy gate is tied to the domain's `consent_required`
      // go-live gate. A brand-new signup on a domain that does NOT require
      // consent (e.g. a provider configured `go_live_required: ["schema_required"]`)
      // skips the consent pre-check and goes straight to OTP. Absent config ⇒
      // require consent (safe default). Returning users keep the pre-check.
      if (!exists && domainSkipsConsent()) {
        await proceedToOtp(identifier, exists, resolvedName, resolvedSignupExtras);
        return;
      }

      // Non-gated / returning user: runConsentThenOtp runs the same terms/privacy
      // pre-check (getConsentStatusByIdentifier) before sending the OTP.
      await runConsentThenOtp(identifier, exists, resolvedName, resolvedSignupExtras);
    } catch {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  // While the DOB step or the guardian flow is active, the signup form is
  // hidden so the step reads as its own page (auth background only) rather
  // than stacking over the half-filled form.
  const showSignupForm = !signupDobGate && !signupGuardianGate;

  // Guardian verified — send the ward's own OTP. No pendingConsent: the
  // minor's terms/privacy are recorded guardian-sourced on account creation
  // (materializeSignupGuardian), not via the adult gate.
  const handleGuardianComplete = () => {
    const gate = signupGuardianGate;
    if (!gate) return;
    setSignupGuardianGate(null);
    // The guardian step and the ward's own verification are separate — make the
    // hand-off explicit so the jump to the user OTP screen isn't a surprise.
    toast.success(t('auth.guardian_confirmed_title', 'Guardian confirmed'), {
      description: t(
        'auth.guardian_confirmed_desc',
        "Now enter the code we're sending to your own {{contactLabel}} to finish creating your account.",
        { contactLabel },
      ),
    });
    void proceedToOtp(gate.identifier, gate.exists, gate.resolvedName, gate.resolvedSignupExtras).catch(() => {
      toast.error(t('auth.toast_send_code_error'), {
        description: t('auth.toast_send_code_error_desc'),
      });
    });
  };

  return (
    <>
      {consentGate && (
        <ConsentModal
          open={true}
          mode="gate"
          initialTab="privacy"
          config={consentGate.config}
          onAccept={() => { void handleConsentAccept(); }}
        />
      )}
      <AuthShell>
        {signupDobGate ? (
          <SignupDobStep existing={signupDobGate.exists} onSubmit={(age) => { void handleSignupDob(age); }} />
        ) : signupGuardianGate ? (
          <SignupGuardianFlow
            network={themeId}
            domain={signupGuardianGate.domain}
            brand={brand !== 'standard' ? brand : null}
            identifier={
              (signupGuardianGate.identifier.email
                ? { email: signupGuardianGate.identifier.email }
                : { phoneNumber: signupGuardianGate.identifier.phoneNumber }) as SignupIdentifier
            }
            age={signupGuardianGate.age}
            onComplete={handleGuardianComplete}
            onBack={() => {
              // Return to the birth-year step: rebuild its gate from the
              // guardian gate, then clear the guardian gate.
              const g = signupGuardianGate;
              if (!g) return;
              setSignupGuardianGate(null);
              setSignupDobGate({
                identifier: g.identifier,
                domain: g.domain,
                resolvedName: g.resolvedName,
                exists: g.exists,
              });
            }}
          />
        ) : !showSignupForm ? null : (
        <>
        {/* Back link */}
        <button
          type="button"
          onClick={() => navigate('/')}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('auth.back')}
        </button>

        {/* Heading */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-foreground">
            {userExists === null || signupBlocked
              ? t('auth.heading_sign_in')
              : userExists
                ? t('auth.heading_welcome_back')
                : t('auth.heading_create_account')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {userExists === null || signupBlocked
              ? t(onlyEmail ? 'auth.sub_initial_email' : onlyPhone ? 'auth.sub_initial_phone' : 'auth.sub_initial')
              : userExists
                ? t('auth.sub_existing', { contactLabel })
                : t('auth.sub_new', { contactLabel })}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Phone / Email pill toggle — hidden entirely when only one channel is allowed */}
          {channels.length > 1 && (
            <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
              {channels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleModeChange(m)}
                  className={[
                    'flex-1 rounded-full py-1.5 font-medium transition-colors capitalize',
                    mode === m
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {/* Domain — grouped directly under the channel toggle above so the
              two selectors read as one unit. Shown only when
              creating an account AND there's a real choice (>1 served domain);
              a single-domain portal auto-selects it and hides this. DOB is NOT
              asked here — it's a separate step for guardian-gated domains. */}
          {userExists === false && !signupBlocked && domainOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t('auth.label_domain', 'Your Domain')}
              </Label>
              {/* Distinct outlined buttons (not a segmented pill) — nothing is
                  pre-selected on a multi-domain portal, so each option must
                  clearly read as a clickable button on its own; the chosen one
                  fills with the brand colour. */}
              <div className="flex flex-wrap gap-2 text-sm">
                {domainOptions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setDomain(d.id)}
                    disabled={isLoading}
                    className={[
                      'flex-1 rounded-full border py-2 px-3 font-medium transition-colors capitalize whitespace-nowrap',
                      domain === d.id
                        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                        : 'border-border bg-background text-foreground hover:border-primary/60 hover:bg-muted',
                    ].join(' ')}
                  >
                    {domainLabel(d)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Contact input */}
          <div className="space-y-1.5">
            <Label htmlFor="contact" className="text-sm font-medium">
              {mode === 'email' ? t('auth.label_email') : t('auth.label_mobile')}
            </Label>
            {mode === 'phone' ? (
              <PhoneInput
                id="contact"
                value={phoneNumber}
                onChange={setPhoneNumber}
                disabled={isLoading}
                placeholder={t('auth.placeholder_phone', '10-digit mobile number')}
              />
            ) : (
              <Input
                id="contact"
                type="email"
                placeholder={t('auth.placeholder_email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                required
                className="h-11"
              />
            )}
          </div>

          {/* Name — only shown when creating account (and self-signup isn't gated) */}
          {userExists === false && !signupBlocked && (
            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-sm font-medium">
                {t('auth.label_name')}
              </Label>
              <Input
                id="name"
                type="text"
                placeholder={t('auth.placeholder_name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
                required
                className="h-11"
              />
            </div>
          )}

          {signupBlocked && (
            <p className="text-sm text-destructive">
              {t('auth.signup_disabled_message')}
            </p>
          )}

          {/* CTA */}
          <button
            type="submit"
            disabled={isLoading || !contactComplete}
            className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-11"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {/* "Send OTP" only for a returning user, where submit truly sends
                the code. A new signup submit leads to more steps (DOB /
                guardian / consent) before any OTP, so it reads "Continue". */}
            {userExists === true ? t('auth.cta_send_otp') : t('auth.cta_continue')}
          </button>
        </form>
        </>
        )}
      </AuthShell>
    </>
  );
}
