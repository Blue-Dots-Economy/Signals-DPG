import { useTranslation } from 'react-i18next';
import { ZoomIn } from 'lucide-react';

export interface MapCountPillProps {
  /** The true count of matches in the current viewport (`meta.total`), regardless of the fetch cap. */
  total: number;
  /** Number of markers actually rendered into view (after any client-side domain narrowing). */
  shown: number;
  /** Whether `total` exceeds the active zoom-band marker cap (#203 map-serverside-search Task 6, `useMapMarkers`'s `truncated`). */
  truncated: boolean;
}

/**
 * The map's bottom-center count pill (#203 map-serverside-search §7 revised,
 * extended by Task 6).
 *
 * THIS IS THE VIEWPORT COUNT, and it is the only place that number appears.
 * The browse toolbar above states the FILTER total — how many items match,
 * regardless of location (#644 QA N5) — so the two answer different questions
 * and both are needed: "102 listings · 8 not on the map" up there, "94
 * listings" here.
 *
 * Shown to signed-out AND signed-in visitors. It used to hide its plain-count
 * variant when signed in, on the grounds that `ContentHeader` already showed a
 * count for those users. That header count was removed in #645 (it duplicated
 * the toolbar), and the toolbar's replacement is deliberately NOT
 * viewport-scoped — so leaving the gate in place left signed-in users with no
 * viewport count anywhere.
 *
 * Two variants share the slot:
 *
 *  - **Over-dense** ("{{count}}+ in this area — zoom in") whenever the
 *    viewport's true total exceeds the active zoom-band marker cap. Zooming in
 *    (which refetches per Task 5's padded-bbox/truncated-result rule) drops
 *    the count under the cap on its own, so the pill reverts without extra
 *    wiring here — it just stops being told `truncated`.
 *  - **Plain count** — "Showing X of Y" when some matches in view are not
 *    rendered (the viewer's own pins are excluded), else "Y listings".
 */
export function MapCountPill({ total, shown, truncated }: Readonly<MapCountPillProps>) {
  const { t } = useTranslation();

  if (total <= 0) return null;

  const label = truncated
    ? t('home.map_zoom_in_for_more', { count: total })
    : shown < total
      ? t('home.showing_x_of_y', { shown, total })
      : t('header.listings', { count: total });

  // High-contrast solid chip so it's legible over any basemap (the old
  // near-background pill washed out against the light map). The over-dense
  // variant leads with a zoom-in icon to read as an actionable hint.
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[2100] -translate-x-1/2 px-4">
      <div className="flex items-center gap-1.5 rounded-full bg-slate-900/95 px-3.5 py-2 text-xs font-semibold text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm">
        {truncated && <ZoomIn className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        {label}
      </div>
    </div>
  );
}
