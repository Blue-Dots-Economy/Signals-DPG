import * as React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type ChipKind = 'domain' | 'facet' | 'search' | 'sort' | 'area';

export interface AppliedChip {
  kind: ChipKind;
  /** Stable identity for the React key and the caller's removal switch. */
  id: string;
  /** Already-localized display text — this component does no formatting. */
  label: string;
  /**
   * False for a constraint that cannot be dropped — the domain chip, since the
   * list always needs exactly one domain to fetch.
   */
  removable: boolean;
}

export interface AppliedFilterChipsProps {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
}

const KIND_STYLES: Record<ChipKind, string> = {
  domain: 'bg-primary text-primary-foreground border-primary',
  facet: 'bg-accent text-accent-foreground border-border',
  // Dashed: this chip's EDITOR is the app-bar search box (spec D24/D25), not
  // this bar. The dashed border signals "remove here, edit above".
  search: 'bg-accent text-accent-foreground border-border border-dashed',
  sort: 'bg-muted text-muted-foreground border-border',
  area: 'bg-accent text-accent-foreground border-border',
};

/**
 * The applied-filter read-out (#645 §4.1).
 *
 * Before this there was no single place answering "what is currently filtering
 * this list?" — domain lived in the sidebar, a second domain picker lived in
 * the facet panel, search lived in the app bar, and one rule hid whole domains
 * silently. This is that place.
 *
 * Chips are the READ-OUT; the facet panel and the app-bar search box remain
 * the EDITORS (spec §7.1). So this component formats nothing, owns no filter
 * state, and reports removals back to the caller rather than acting on them.
 *
 * It carries chips ONLY for constraints whose editor is elsewhere — search
 * text and facets. `sort` and `area` have their own controls sitting inches
 * away in the same row, and a chip repeating their value read as a duplicate
 * on screen ("Area Within 25 km | Within 25 km ×"). Clear-all lives in the
 * toolbar rather than here, because it must be reachable when sort or area is
 * non-default even though neither produces a chip.
 */
export function AppliedFilterChips({
  chips,
  onRemove,
}: Readonly<AppliedFilterChipsProps>) {
  const { t } = useTranslation();
  const groupRef = React.useRef<HTMLFieldSetElement>(null);
  const pendingFocus = React.useRef(false);

  // Focus returns to the group after a removal (spec §4.6). The button the
  // user activated unmounts along with its chip, so without this focus falls
  // to <body> and a keyboard user loses their place in the bar entirely.
  //
  // Gated on `pendingFocus` rather than firing on every `chips` change, so an
  // unrelated re-render (a new array with the same contents) does not yank
  // focus away from whatever the user is actually on.
  React.useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    groupRef.current?.focus();
  }, [chips]);

  if (chips.length === 0) return null;

  return (
    // <fieldset> rather than <div role="group"> — implicit group role, native
    // element, identical to assistive tech (Sonar S6819). UA chrome reset.
    <fieldset
      ref={groupRef}
      tabIndex={-1}
      aria-label={t('browse.applied_filters')}
      className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0 outline-none"
    >
      {chips.map((chip) => (
        <span
          key={`${chip.kind}:${chip.id}`}
          data-testid="applied-chip"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
            'pointer-coarse:min-h-11',
            KIND_STYLES[chip.kind],
          )}
        >
          {chip.label}
          {chip.removable && (
            <button
              type="button"
              aria-label={t('browse.remove_filter', { label: chip.label })}
              onClick={() => {
                pendingFocus.current = true;
                onRemove(chip);
              }}
              className="rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
    </fieldset>
  );
}
