import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import { cn } from '@/lib/utils';

/** Whole numbers only, in a range a real search could mean (#644 QA). */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 500;

export interface LocationSelectProps {
  value: BrowseArea;
  /**
   * The sort in force. Read ONLY to decide whether the "measured from" section
   * is doing anything — `nearest` needs a centre even with no radius set.
   */
  sort: BrowseSort;
  /** Which of the two sources is in force. Also the `nearest` ordering centre. */
  source: PreferredLocationSource;
  onSourceChange: (next: PreferredLocationSource) => void;
  /** Whether each source can supply a coordinate at all. */
  profileAvailable: boolean;
  browserAvailable: boolean;
  /** The coordinate the chosen source currently resolves to; null when none does. */
  center: { lat: number; lng: number } | null;
  onChange: (next: BrowseArea) => void;
}

/**
 * The ONE control that mentions where the viewer is (#644 QA redesign).
 *
 * It replaces two controls that between them asked the same question twice:
 * the old `AreaSelect` (scope + distance) and the standalone "Search near"
 * toggle (which source). Users read that as "choosing location somewhere and
 * adding a radius somewhere else", and they were right — the distance and the
 * point it is measured from are one thought, so they belong in one menu, read
 * as one sentence: *within 5 km of me, measured from my profile*.
 *
 * `Sort` deliberately says nothing about location; it only shows a read-only
 * hint naming the centre `nearest` will use.
 *
 * WHY SORT AND LOCATION STAY INDEPENDENT. It is tempting to have `nearest`
 * auto-select a radius, so that "nearest + anywhere" cannot happen. That
 * would make choosing an ORDER silently delete results, which is precisely
 * the #644 bug: the pre-#644 code fed one resolved location into the spatial
 * clause and every signed-in viewer got a hard ~30 km bound nobody asked for.
 * `nearest + anywhere` is the headline feature — "all of them, closest first".
 * So: Sort decides the order, this control decides which items exist, and
 * neither implies the other.
 */
export function LocationSelect({
  value,
  sort,
  source,
  onSourceChange,
  profileAvailable,
  browserAvailable,
  center,
  onChange,
}: Readonly<LocationSelectProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);

  const anySource = profileAvailable || browserAvailable;
  const km = (meters: number) => Math.round(meters / 1000);
  const sourceLabel = t(
    source === 'browser' ? 'browse.location_from_browser' : 'browse.location_from_profile',
  );

  /**
   * Is a centre actually being used right now? The "measured from" section is
   * shown only when the answer is yes — asking which point to measure from
   * while nothing measures is the noise this redesign removes.
   */
  const usesCenter = value.mode === 'radius' || sort === 'nearest';

  const displayLabel = (() => {
    switch (value.mode) {
      case 'radius':
        return t('browse.area_radius_of', { km: km(value.meters), source: sourceLabel });
      case 'viewport':
        return t('browse.area_viewport');
      default:
        return t('browse.area_anywhere');
    }
  })();

  const currentKm = value.mode === 'radius' ? String(km(value.meters)) : '';
  const shown = draft ?? currentKm;
  const parsed = shown === '' ? null : Number(shown);
  const valid = parsed !== null && parsed >= MIN_RADIUS_KM && parsed <= MAX_RADIUS_KM;
  // A distance needs a point to measure from. `browserAvailable` only means the
  // browser *supports* geolocation — permission can still be denied, leaving no
  // resolved centre. Without this the tick looked enabled and silently did
  // nothing, which is worse than being visibly unavailable.
  const canApply = valid && center !== null;

  const commit = () => {
    if (!canApply || !center) return;
    onChange({ mode: 'radius', center, meters: parsed * 1000 });
    setDraft(null);
    setOpen(false);
  };

  const rowClass =
    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  // Which consumers the source feeds, for the explanatory line. Naming them is
  // the point: it answers "why am I being asked this?".
  const usedBy = [
    value.mode === 'radius' ? t('browse.location_used_by_distance') : null,
    sort === 'nearest' ? t('browse.location_used_by_nearest') : null,
  ].filter(Boolean) as string[];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A half-typed distance must not survive into the next opening.
        if (!next) setDraft(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-normal text-muted-foreground">{t('browse.location_label')}</span>
          <span className="truncate font-semibold">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[19rem] p-1">
        <div role="listbox" aria-label={t('browse.location_label')}>
          <button
            type="button"
            role="option"
            aria-selected={value.mode === 'anywhere'}
            className={rowClass}
            onClick={() => {
              onChange(DEFAULT_BROWSE_AREA);
              setOpen(false);
            }}
          >
            <Check
              className={cn('h-3 w-3 shrink-0', value.mode === 'anywhere' ? 'opacity-100' : 'opacity-0')}
            />
            <span>
              <span className="font-semibold">{t('browse.area_anywhere')}</span>
              <span className="block font-normal text-muted-foreground">
                {t('browse.area_anywhere_hint')}
              </span>
            </span>
          </button>

          {/* Present ONLY while active. A viewport arrives from the map's
              "Search this area" — it is not something to choose from a list
              view, where there is no map on screen to refer to. */}
          {value.mode === 'viewport' && (
            <div className={cn(rowClass, 'cursor-default hover:bg-transparent')} role="option" aria-selected>
              <Check className="h-3 w-3 shrink-0" />
              <span>
                <span className="font-semibold">{t('browse.area_viewport')}</span>
                <span className="block font-normal text-muted-foreground">
                  {t('browse.area_viewport_hint')}
                </span>
              </span>
            </div>
          )}

          {anySource ? (
            <>
              {/* Scope and distance on one line, reading as a sentence. */}
              <div
                className={cn(rowClass, 'cursor-default hover:bg-transparent')}
                role="option"
                aria-selected={value.mode === 'radius'}
              >
                <Check
                  className={cn('h-3 w-3 shrink-0', value.mode === 'radius' ? 'opacity-100' : 'opacity-0')}
                />
                <span className="flex flex-wrap items-center gap-1">
                  <span>{t('browse.area_within')}</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-1.5 focus-within:ring-2 focus-within:ring-ring">
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={t('browse.area_custom_label', {
                        min: MIN_RADIUS_KM,
                        max: MAX_RADIUS_KM,
                      })}
                      value={shown}
                      placeholder={String(MIN_RADIUS_KM)}
                      onChange={(e) =>
                        // Digits only. Decimals are BLOCKED, not rounded:
                        // rounding 12.5 to 13 would leave the field and the
                        // request disagreeing mid-edit.
                        setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commit();
                        }
                      }}
                      className="h-7 w-10 bg-transparent text-xs outline-none"
                    />
                    <span className="text-muted-foreground">{t('browse.area_km_unit')}</span>
                    <button
                      type="button"
                      aria-label={t('browse.area_custom_clear')}
                      onClick={() => setDraft('')}
                      disabled={shown === ''}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('browse.area_custom_apply')}
                      onClick={commit}
                      disabled={!canApply}
                      className="rounded p-0.5 text-primary hover:bg-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </span>
                  <span>{t('browse.area_of_me')}</span>
                </span>
              </div>
              {shown !== '' && !valid && (
                <p role="alert" className="px-2 pb-2 pl-7 text-[10px] text-destructive">
                  {t('browse.area_custom_range', { min: MIN_RADIUS_KM, max: MAX_RADIUS_KM })}
                </p>
              )}
              {center === null && (
                <p className="px-2 pb-2 pl-7 text-[10px] text-muted-foreground">
                  {t('browse.location_no_centre_yet')}
                </p>
              )}

              {/* The source question — asked ONCE, here, and only when
                  something uses it. */}
              {usesCenter && (
                <>
                  <div className="my-1 h-px bg-border" role="none" />
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('browse.location_measured_from')}
                  </p>
                  <div className="px-2 pb-1">
                    <fieldset
                      aria-label={t('browse.location_measured_from')}
                      className="m-0 inline-flex min-w-0 rounded-md border border-border p-0"
                    >
                      {(
                        [
                          ['profile', profileAvailable, 'browse.location_from_profile'],
                          ['browser', browserAvailable, 'browse.location_from_browser'],
                        ] as const
                      ).map(([src, ok, key]) => (
                        <button
                          key={src}
                          type="button"
                          aria-pressed={source === src}
                          disabled={!ok}
                          onClick={() => onSourceChange(src)}
                          className={cn(
                            'px-2.5 py-1 text-[11px] font-semibold transition-colors first:rounded-l-md last:rounded-r-md pointer-coarse:min-h-11',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            source === src
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-accent',
                            !ok && 'cursor-not-allowed opacity-40',
                          )}
                        >
                          {t(key)}
                        </button>
                      ))}
                    </fieldset>
                  </div>
                  {usedBy.length > 0 && (
                    <p className="px-2 pb-2 text-[10px] text-muted-foreground">
                      {t('browse.location_used_by', { consumers: usedBy.join(t('browse.and')) })}
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            // No profile and no browser location: one line saying why, rather
            // than rows that cannot do anything (spec D7a's hide-don't-disable
            // reasoning, applied here).
            <p className="px-2 pb-2 pt-1 text-[11px] text-muted-foreground">
              {t('browse.location_none_available')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
