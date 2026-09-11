/**
 * Brand / URL resolution for action emails. Pure helpers — the dispatcher
 * supplies the values from network config + env (the same sources OTP reads).
 */

/** Generic Phase-1 CTA: the frontend base URL + the UI login route. */
export function buildCtaUrl(baseUrl: string): string {
  // Trailing slashes are trimmed by a loop rather than /\/+$/: that pattern
  // backtracks quadratically on a long run of slashes that does not end in a
  // match. `baseUrl` is operator-set config today, so this is not a reachable
  // DoS — but the linear form costs nothing and does not rely on that staying
  // true if the helper is ever handed a caller-supplied value.
  let base = baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/auth/login`;
}

/**
 * Brand display name for the sign-off: the network display name when set,
 * otherwise the instance name (matches the OTP path).
 */
export function resolveBrandName(opts: {
  networkDisplayName?: string;
  instanceName: string;
}): string {
  const display = opts.networkDisplayName?.trim();
  return display ? display : opts.instanceName;
}

/**
 * Per-network CTA button colour for action emails. Emails can't use CSS
 * variables, so the colour is inlined per-send. Keyed by network id; unknown
 * networks fall back to the neutral blue. (Phase-2 NS-owned templates can move
 * this into per-network config.)
 */
const BRAND_COLOR: Record<string, string> = {
  blue_dot: '#2563eb',
  purple_dot: '#7c3aed',
  yellow_dot: '#d97706',
  onest_yellow_dot: '#d97706',
  pink_dot: '#db2777',
  green_dot: '#16a34a',
  orange_dot: '#ea580c',
};

export const DEFAULT_BRAND_COLOR = '#2563eb';

export function resolveBrandColor(networkId: string | null | undefined): string {
  if (!networkId) return DEFAULT_BRAND_COLOR;
  return BRAND_COLOR[networkId] ?? DEFAULT_BRAND_COLOR;
}

/**
 * Builds the per-recipient CTA resolver.
 *
 * Which portal a mail should link to depends on the RECIPIENT's own domain —
 * the seeker's "your application was sent" mail belongs on the seeker portal
 * and the provider's "a seeker applied" mail on the provider portal — so this
 * cannot be resolved once per process the way it used to be (#569).
 *
 * Falls back to the single `FRONTEND_BASE_URL` front-door on a miss. On a split
 * deployment that host is blocked, so the fallback is a link that does not
 * work; it is kept anyway because the alternative for a CTA-shell mail is
 * sending no email at all or changing the template. The boot-time
 * unknown-domain warning is what tells an operator a mapping is missing.
 *
 * @param byDomain - Inverted host bindings; `{}` on a single-host install.
 * @param fallbackBaseUrl - `FRONTEND_BASE_URL`, when set.
 * @returns A resolver returning the login URL, or undefined when nothing is configured.
 */
export function createCtaUrlResolver(opts: {
  byDomain: Record<string, string>;
  fallbackBaseUrl?: string;
}): (domain: string) => string | undefined {
  const { byDomain, fallbackBaseUrl } = opts;
  return (domain: string) => {
    const origin = byDomain[domain] ?? fallbackBaseUrl;
    return origin ? buildCtaUrl(origin) : undefined;
  };
}
