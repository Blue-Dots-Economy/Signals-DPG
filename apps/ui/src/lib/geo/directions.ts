import type { LatLng } from './types';

export type PlatformKind = 'android' | 'ios' | 'other';

/** Classify the platform from a user-agent string (pure). */
export function detectPlatform(userAgent: string): PlatformKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'other';
}

/**
 * Build a directions deep-link to `dest` for the given platform:
 *  - android: `geo:` URI → triggers the OS "open with…" map-app chooser.
 *  - ios:     Apple Maps universal link (opens the Maps app with destination set).
 *  - other:   Google Maps directions URL (web/app).
 */
export function directionsUrl(dest: LatLng, label: string | undefined, platform: PlatformKind): string {
  const { lat, lng } = dest;
  switch (platform) {
    case 'android': {
      const encodedLabel = label
        ? encodeURIComponent(label).replaceAll(/\(/g, '%28').replaceAll(/\)/g, '%29')
        : '';
      const q = label ? `${lat},${lng}(${encodedLabel})` : `${lat},${lng}`;
      return `geo:${lat},${lng}?q=${q}`;
    }
    case 'ios':
      return `https://maps.apple.com/?daddr=${lat},${lng}`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
}

/** Build a `tel:` href. A bare 10-digit number gets the default country code. */
export function telHref(phone: string, defaultCountryCode = '+91'): string {
  const cleaned = phone.replaceAll(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return `tel:${cleaned}`;
  if (/^\d{10}$/.test(cleaned)) return `tel:${defaultCountryCode}${cleaned}`;
  return `tel:${cleaned}`;
}

/** Ensure a website URL has a scheme so it opens as an absolute link. */
export function normalizeWebsiteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Open directions to `dest`. On mobile we navigate the current tab (so the OS
 * can hand off to a native maps app); on desktop we open a new tab.
 * `win` is injectable for testing.
 */
export function openDirections(dest: LatLng, label: string | undefined, win: Window = window): void {
  const platform = detectPlatform(win.navigator.userAgent);
  const url = directionsUrl(dest, label, platform);
  if (platform === 'other') {
    win.open(url, '_blank', 'noopener,noreferrer');
  } else {
    win.location.assign(url);
  }
}
