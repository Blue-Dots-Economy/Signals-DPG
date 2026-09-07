import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface DomainOption {
  id: string;
  /** Singular, for the toggle buttons — each names one domain. */
  label: string;
  /**
   * Plural, for the collapsed single-domain label, which names the SET on
   * screen ("Showing Providers"). Falls back to `label`.
   */
  pluralLabel?: string;
}

export interface DomainControlProps {
  options: DomainOption[];
  /**
   * 'single' on the list — one `/discover` call takes exactly one
   * `item_domain`. 'multi' on the map, which already issues one `/markers`
   * request per domain, so several cost nothing structural.
   */
  mode: 'single' | 'multi';
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * The one domain control (#645, spec D10/D11).
 *
 * Replaces THREE things: the sidebar Browse tab, the facet panel's own domain
 * multi-select, and the invisible scoping that silently removed domains from a
 * signed-in viewer's world. Domain IS a filter, so it belongs with the other
 * filters rather than in navigation.
 *
 * REVERSES spec D7. D7 listed every domain in the network and marked the
 * non-interacting ones disabled-with-a-reason, on the theory that hiding them
 * made those domains feel non-existent. In practice a signed-in seeker got a
 * permanently dead `Seeker` button sitting in the primary browse control,
 * which reads as a broken toggle rather than as an explanation — and who can
 * interact with whom is conveyed better elsewhere than by a greyed-out tab.
 * Callers now pass only the domains the viewer can actually browse.
 *
 * The interaction matrix is untouched either way: `computeVisibleDomains`
 * still governs what is fetchable, and this component only renders what it is
 * given.
 *
 * Neither mode can reach an empty selection: the list needs exactly one domain
 * to fetch at all, and an empty map selection would render a blank map with no
 * obvious way back.
 */
export function DomainControl({
  options,
  mode,
  selected,
  onChange,
}: Readonly<DomainControlProps>) {
  const { t } = useTranslation();

  const toggle = (id: string) => {
    if (mode === 'single') {
      // Re-picking the only selection is a no-op, not a deselection.
      if (selected.length === 1 && selected[0] === id) return;
      onChange([id]);
      return;
    }

    const isOn = selected.includes(id);
    if (isOn && selected.length === 1) return;
    onChange(isOn ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  // Exactly one browsable domain → there is no choice to offer, so state the
  // domain instead of rendering a control (Q1).
  if (options.length <= 1) {
    const only = options[0];
    if (!only) return null;
    return (
      // An <h1>: with the old page-header title removed (#645) this is the
      // browse page's only statement of what is on screen, so it should carry
      // the document's heading rank as well as the visual weight. Matches the
      // type scale the removed ContentHeader title used.
      <h1
        data-testid="domain-single-label"
        className="text-xl font-semibold tracking-tight text-foreground"
      >
        {t('browse.domain_only', { domain: only.pluralLabel ?? only.label })}
      </h1>
    );
  }

  return (
    // <fieldset> rather than <div role="group">: it carries an IMPLICIT group
    // role, so assistive tech and `getByRole('group')` behave identically while
    // using the native element (Sonar S6819). `min-w-0 p-0 m-0 border-0` resets
    // the UA's default fieldset chrome so the border below is ours.
    <fieldset
      aria-label={t('browse.domain_group')}
      // Horizontal scroll rather than wrap: wrapping a 4+ domain network would
      // eat a phone screen. up-gzb (production) has three.
      //
      // `h-9` on the buttons below is chosen to match the "Search near"
      // toggle it sits opposite, measured at 36px — these are peers in the
      // same row, so they should not be two different heights.
      className="m-0 inline-flex min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-background p-0"
    >
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(o.id)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border px-3 text-sm font-semibold transition-colors last:border-r-0',
              'pointer-coarse:min-h-11',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              on
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {mode === 'multi' && on && <Check className="h-3.5 w-3.5 shrink-0" />}
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
