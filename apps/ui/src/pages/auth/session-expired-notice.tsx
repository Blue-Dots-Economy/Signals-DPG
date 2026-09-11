import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Why the user is on the sign-in screen when they did not choose to be.
 *
 * `auth-context` redirects here with `?reason=expired` when a session ends
 * mid-use. Without this the forced sign-out looks like the app simply dropped
 * them.
 *
 * ## Why this is its own module
 *
 * It has to render on BOTH sign-in screens, and each owns its own `AuthShell`,
 * so there is no single parent to hang it on — `LoginPage` returns one panel or
 * the other. Keeping it here rather than exporting from `login-page.tsx` avoids
 * a circular import, since that file imports the Keycloak panel.
 *
 * Placing it in only one panel is the mistake this file exists to prevent: it
 * was first written inside the OTP screen, which never mounts under
 * `AUTH_PROVIDER=keycloak`, so the notice silently never appeared on exactly
 * the deployments that have it. The `auth_error` notice was missed the same way
 * once already — same branch, same cause.
 *
 * Deliberately NOT a toast. The redirect is a full page navigation
 * (`window.location`), which destroys the context a toast would render into, so
 * on this path only something rendered by the destination can be seen.
 */
export function SessionExpiredNotice() {
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  if (searchParams.get('reason') !== 'expired') return null;

  return (
    // `<output>` rather than a div with role="status" (S6819): it carries the
    // role implicitly and is announced more reliably by assistive tech. Needs
    // `block` because <output> is inline by default.
    <output className="mb-4 block rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      {t('auth.session_expired_desc')}
    </output>
  );
}
