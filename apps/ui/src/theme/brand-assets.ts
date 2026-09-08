/**
 * Maps a network id (e.g. `purple_dot`) to logo URLs that live under
 * /public/brand/<kebab>/. Designer-shipped assets are copied verbatim
 * from aggregator-dpg into apps/ui/public/brand/.
 *
 * Variants mirror the keys in `brand.json.logo`:
 *   - default          : neutral logo (light bg)
 *   - withStrapline    : adds "Seeded by …" wordmark
 *   - light            : light text/marks for dark backgrounds
 *   - onBrand          : tuned for hero / coloured backgrounds
 *
 * If a network has no logo folder, returns null and callers should fall
 * back to text-only branding.
 */
export type BrandLogoVariant =
  | 'default'
  | 'withStrapline'
  | 'light'
  | 'withStraplineLight'
  | 'onBrand';

const VARIANT_FILE: Record<BrandLogoVariant, string> = {
  default: 'logo.png',
  withStrapline: 'logo-with-strapline.png',
  light: 'logo-light.png',
  withStraplineLight: 'logo-with-strapline-light.png',
  onBrand: 'logo-on-brand.png',
};

function kebabFromNetworkId(networkId: string): string {
  return networkId.replaceAll('_', '-');
}

export function networkLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
): string | null {
  if (!networkId) return null;
  return `/brand/${kebabFromNetworkId(networkId)}/${VARIANT_FILE[variant]}`;
}

export function brandLogoUrl(
  networkId: string | null | undefined,
  variant: BrandLogoVariant = 'default',
  brandSlug?: string | null,
): string | null {
  if (!networkId) return null;
  const slug = (brandSlug ?? '').trim();
  if (slug && slug !== 'standard') {
    return `/brand/${kebabFromNetworkId(networkId)}/${slug}/${VARIANT_FILE[variant]}`;
  }
  return networkLogoUrl(networkId, variant);
}
