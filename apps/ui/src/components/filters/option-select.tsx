import * as React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** When false the option is listed but not choosable, with `reason` explaining why. */
  available?: boolean;
  /** Required when `available` is false — already localized. */
  reason?: string;
  /**
   * Sub-label for a CHOOSABLE option, explaining what it sorts/filters on
   * (e.g. "By date posted"). Distinct from `reason`, which explains why an
   * option cannot be picked; an option never shows both.
   */
  hint?: string;
}

export interface OptionSelectProps<T extends string> {
  /** Short prefix shown before the current value, e.g. "Sort". */
  name: string;
  /** The value to DISPLAY. May differ from the requested one — see SortSelect. */
  displayLabel: string;
  /**
   * Icon shown INSTEAD of the text below `sm`.
   *
   * On a phone the prefix plus the value is far too wide — "Sort Relevance to
   * your profile" alone consumed a whole row, pushing Location, Filters and the
   * count onto rows of their own. The value is not lost: the note directly
   * under the toolbar states the ranking basis and the applied radius in
   * words, and the popover ticks the current choice.
   */
  icon: React.ComponentType<{ className?: string }>;
  options: SelectOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * Optional caption above the list, for when `name` alone is too terse to
   * say what picking an option DOES. The map's location-source select needs
   * it: its trigger reads "Location — My profile", which on a map could be
   * misread as a filter, so the list is headed "Centre the map on".
   *
   * When present it labels the listbox instead of `name`, since it is the
   * more specific of the two — so it carries `aria-hidden`, or a reader would
   * hear the same words twice.
   */
  heading?: string;
}

/**
 * Single-choice dropdown shared by the sort and area selectors.
 *
 * Extracted rather than duplicated because both need the same three things
 * that a plain `<select>` does not give: an option that is listed but
 * unavailable *with a reason* (a `<select>` can disable an option but cannot
 * explain it), a trigger label that may differ from the selected value, and
 * the coarse-pointer touch targets used across this app.
 *
 * Follows the Popover + option-list shape of `MultiSelectGroup` and
 * `BrowseFiltersPanel` so keyboard behaviour matches the rest of the filters.
 */
export function OptionSelect<T extends string>({
  name,
  displayLabel,
  icon: Icon,
  options,
  value,
  onChange,
  heading,
}: Readonly<OptionSelectProps<T>>) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Carries the value too, because below `sm` the text is hidden and
          // this is the only name a screen reader or a long-press gets.
          aria-label={`${name}: ${displayLabel}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background text-xs font-semibold text-foreground',
            // Square while icon-only, so it matches the Filters trigger beside it.
            'h-9 w-9 justify-center px-0 sm:h-auto sm:w-auto sm:justify-start sm:px-2.5 sm:py-1.5',
            'pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:pointer-coarse:min-w-0',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <Icon className="h-4 w-4 shrink-0 sm:hidden" />
          <span className="hidden font-normal text-muted-foreground sm:inline">{name}</span>
          <span className="hidden truncate sm:inline">{displayLabel}</span>
          <ChevronDown className="hidden h-3 w-3 shrink-0 opacity-60 sm:block" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {heading && (
          <p
            aria-hidden="true"
            className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {heading}
          </p>
        )}
        <div role="listbox" aria-label={heading ?? name}>
          {options.map((o) => {
            const unavailable = o.available === false;
            const reasonId = unavailable && o.reason ? `opt-why-${name}-${o.value}` : undefined;
            return (
              <React.Fragment key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  // aria-disabled rather than `disabled`: a disabled button is
                  // removed from the a11y tree, which would hide the very
                  // reason we are trying to surface.
                  aria-disabled={unavailable}
                  aria-describedby={reasonId}
                  onClick={() => {
                    if (unavailable) return;
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs',
                    'pointer-coarse:min-h-11',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    unavailable
                      ? 'cursor-not-allowed text-muted-foreground/50'
                      : 'hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3 w-3 shrink-0',
                      o.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <span className="flex-1">
                    <span className="block font-semibold">{o.label}</span>
                    {unavailable && o.reason && (
                      <span id={reasonId} className="mt-0.5 block font-normal">
                        {o.reason}
                      </span>
                    )}
                    {!unavailable && o.hint && (
                      <span className="mt-0.5 block font-normal text-muted-foreground">
                        {o.hint}
                      </span>
                    )}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
