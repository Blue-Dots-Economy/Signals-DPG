import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { resolveTheme, type NetworkTheme } from './network-themes';
import { resolveBrand } from './resolve-brand';
import { resolveBrandMeta, type BrandMeta } from './brand-meta';
import { getServedScope } from '@/lib/served-binding';
import { clearSchemaCache } from '@/engine';

interface NetworkThemeContextValue {
  themeId: string;
  theme: NetworkTheme;
  brand: string;
}

const NetworkThemeContext = React.createContext<NetworkThemeContextValue>({
  themeId: 'blue_dot',
  theme: resolveTheme('blue_dot'),
  brand: 'standard',
});

export function useNetworkTheme(): NetworkThemeContextValue {
  return React.useContext(NetworkThemeContext);
}

function getInitialNetworkId(): string {
  const url = new URLSearchParams(window.location.search).get('network');
  if (url) return url;
  // Runtime config (window.__DPG_UI_CONFIG__) is injected by the chart at
  // deploy time via /config.js (loaded in index.html before the bundle).
  // It wins over the Vite build-time default, so a single image can be
  // re-used across networks — the chart decides which brand renders.
  const runtimeNet =
    typeof window !== 'undefined'
      ? (window as Window).__DPG_UI_CONFIG__?.VITE_NETWORK_NAME
      : undefined;
  if (runtimeNet) return runtimeNet;
  // __DEFAULT_NETWORK_THEME__ is injected by Vite define at build time
  const fromEnv =
    typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
  return fromEnv || 'blue_dot';
}

function kebab(id: string): string {
  return id.replaceAll('_', '-');
}

function applyFavicon(id: string, brand: string, meta: BrandMeta): void {
  // Drop any existing icons (PNG remnants etc.) before installing the new one.
  document
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
    .forEach((el) => el.parentNode?.removeChild(el));

  const link = document.createElement('link');
  link.rel = 'icon';
  link.dataset.network = id;

  if (meta.faviconType === 'png') {
    // Designer-shipped square mark — path is brand-slug aware:
    //   non-standard brand: /brand/<network>/<brand>/favicon.png
    //   standard brand:     /brand/<network>/favicon.png
    link.type = 'image/png';
    link.href =
      brand && brand !== 'standard'
        ? `/brand/${kebab(id)}/${brand}/favicon.png`
        : `/brand/${kebab(id)}/favicon.png`;
  } else {
    // brand.json logos are wide wordmarks ("purple dots AI") — useless when
    // downscaled to the tab's 16×16 favicon slot. Generate a square dot-mark
    // SVG from the active network's --brand-cta CSS var so the tab actually
    // shows colour-matched branding for any number of networks.
    const cssVar = getComputedStyle(document.documentElement)
      .getPropertyValue('--brand-cta')
      .trim();
    const colour = cssVar || '#000000';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill="${colour}"/>
      <circle cx="16" cy="16" r="6" fill="white" opacity="0.95"/>
      <circle cx="10" cy="10" r="2.2" fill="white" opacity="0.6"/>
      <circle cx="23" cy="22" r="2" fill="white" opacity="0.55"/>
    </svg>`;
    link.type = 'image/svg+xml';
    link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  document.head.appendChild(link);
}

function applyDocumentTitle(theme: NetworkTheme, brandCopy: Record<string, string>): void {
  // Network brand + "Signal Stack" platform name. When the deployment serves a
  // single domain (VITE_SERVED_BINDINGS with one entry) the domain is woven in
  // so each per-domain UI gets a distinct tab title (e.g. "Purple Dot ·
  // Provider · Signal Stack"). Multiple served domains, or unset, → the plain
  // network title. Generic for any network/domain.
  // Brand copy wins over network defaults when a title key is present.
  const networkName = brandCopy['title'] ?? theme.name;
  const scope = getServedScope();
  const domainLabel =
    scope && scope.domains.length === 1
      ? scope.domains[0].replaceAll('_', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase())
      : null;
  document.title = domainLabel
    ? `${networkName} · ${domainLabel} · Signal Stack`
    : `${networkName} · Signal Stack`;
}

/**
 * Apply the active network + brand to `<html>` (`data-network`/`data-brand`)
 * and install the brand-aware favicon. Returns the resolved brand meta.
 *
 * Exported so non-router entry points (the tourist app) can apply branding
 * after boot: the inline HTML `<script>` only sets first-paint *fallback*
 * values because Vite `define` does NOT replace tokens (`__DEFAULT_BRAND__`,
 * `__BRAND_REGISTRY__`) inside classic inline scripts — only inside JS
 * modules. The signals app re-applies via NetworkThemeProvider; the tourist
 * app calls this directly.
 */
export function applyNetworkBrand(id: string, brand: string): BrandMeta {
  const el = document.documentElement;
  el.dataset.network = id;
  el.dataset.brand = brand;
  // Tokens come from the brand-theme Vite plugin's static <style> block
  // selected by [data-network=<id>][data-brand=<brand>]. Force the browser to
  // apply the selector before applyFavicon reads --brand-cta.
  void el.offsetWidth;
  const meta = resolveBrandMeta(id, brand);
  applyFavicon(id, brand, meta);
  return meta;
}

function applyThemeTokens(id: string, brand: string): void {
  const meta = applyNetworkBrand(id, brand);
  applyDocumentTitle(resolveTheme(id), meta.copy);
}

const ACTIVE_NETWORK_KEY = 'dpg-active-network';

export function NetworkThemeProvider({ children }: { children: React.ReactNode }) {
  const [searchParams] = useSearchParams();
  const networkFromUrl = searchParams.get('network');

  const themeId = React.useMemo(() => {
    // URL wins. Otherwise reuse the last network the user was on (routes like
    // /my-actions carry no ?network=, and falling back to the build default
    // would flip the theme to the wrong brand mid-session).
    if (networkFromUrl) return networkFromUrl;
    // Runtime config (window.__DPG_UI_CONFIG__.VITE_NETWORK_NAME) — written
    // by the chart at deploy time. Must win over localStorage so a fresh
    // visitor lands on the chart-configured brand even without ?network=.
    const runtimeNet =
      typeof window !== 'undefined'
        ? (window as Window).__DPG_UI_CONFIG__?.VITE_NETWORK_NAME
        : undefined;
    if (runtimeNet) return runtimeNet;
    let stored = '';
    try {
      stored = localStorage.getItem(ACTIVE_NETWORK_KEY) ?? '';
    } catch {
      /* localStorage unavailable */
    }
    // Only honor a stored network that this build is actually configured to
    // serve. Otherwise a stale value from a previously-run network (e.g. after
    // switching VITE_NETWORK_ID in local dev) would pin the theme to a brand
    // this build no longer serves. Discard it so the build default wins.
    const configuredNetworks = (import.meta.env.VITE_NETWORK_ID ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (stored && (configuredNetworks.length === 0 || configuredNetworks.includes(stored))) {
      return stored;
    }
    if (stored) {
      try {
        localStorage.removeItem(ACTIVE_NETWORK_KEY);
      } catch {
        /* ignore */
      }
    }
    const fromEnv =
      typeof __DEFAULT_NETWORK_THEME__ !== 'undefined' ? __DEFAULT_NETWORK_THEME__ : '';
    return fromEnv || 'blue_dot';
  }, [networkFromUrl]);

  // Persist the network whenever it's explicitly chosen via the URL so other
  // routes inherit the same brand theme.
  React.useEffect(() => {
    if (!networkFromUrl) return;
    try {
      localStorage.setItem(ACTIVE_NETWORK_KEY, networkFromUrl);
    } catch {
      /* ignore */
    }
  }, [networkFromUrl]);

  const theme = React.useMemo(() => resolveTheme(themeId), [themeId]);

  const activeBrand = React.useMemo(
    () =>
      resolveBrand({
        runtimeConfig:
          typeof window !== 'undefined'
            ? (window as Window).__DPG_UI_CONFIG__?.VITE_BRAND_NAME
            : null,
        buildDefault: typeof __DEFAULT_BRAND__ !== 'undefined' ? __DEFAULT_BRAND__ : null,
      }),
    [],
  );

  React.useLayoutEffect(() => {
    applyThemeTokens(themeId, activeBrand);
  }, [themeId, activeBrand]);

  React.useEffect(() => {
    // Only a network switch (via URL) triggers this at runtime; activeBrand is
    // computed once and doesn't change. Correctness relies on schema resolution
    // being async so this sync clear lands before any post-await cache read.
    clearSchemaCache();
  }, [themeId, activeBrand]);

  const value = React.useMemo(
    () => ({ themeId, theme, brand: activeBrand }),
    [themeId, theme, activeBrand],
  );

  return (
    <NetworkThemeContext.Provider value={value}>{children}</NetworkThemeContext.Provider>
  );
}

// Standalone bootstrap — called by the pre-React inline script via a module
// import (for type safety in tests). The inline script calls the same logic.
export { getInitialNetworkId };
