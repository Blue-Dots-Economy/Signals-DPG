import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getGeoProvider } from '@/lib/geo/provider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import type { GeoComponents, GeoSuggestion } from '@/lib/geo/types';

/** A selected place reported to the form: the exact point plus the address
 * components, so the page can coarsen a private field to its city centroid
 * (using the components) before submit. */
export interface ResolvedPlace {
  lat: number;
  lng: number;
  components?: GeoComponents;
}

interface LocationFormContext {
  onLocationResolved?: (place: ResolvedPlace | null) => void;
}

export function LocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
  formContext,
  options,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  // Open the list upward when the input is near the bottom of the viewport
  // (e.g. sitting just above the pinned action-bar footer), so the suggestions
  // aren't hidden below the fold.
  const [dropUp, setDropUp] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const provider = React.useMemo(() => getGeoProvider(), []);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const blurRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  // Keep the input in sync when RJSF pushes a new value (e.g. edit-mode
  // prefill). This intentionally does NOT trigger a search — searching is
  // driven only by user typing (see runSearch in handleInput), so selecting a
  // suggestion (which calls onChange and updates `value`) never re-opens the
  // dropdown.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  // Cancel any pending work on unmount.
  React.useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(blurRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function runSearch(query: string) {
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      void provider.suggest(q, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setOpen(results.length > 0);
        if (results.length > 0) {
          // ~260px covers the list height + the footer; if there's less room
          // below the input than that, flip the list upward.
          const r = inputRef.current?.getBoundingClientRect();
          setDropUp(!!r && window.innerHeight - r.bottom < 260);
        }
      });
    }, 300);
  }

  function handleInput(next: string) {
    setText(next);
    // Emit `undefined` (not "") when cleared, so a required location field goes
    // back to invalid — an empty string counts as "present" for JSON-Schema
    // `required`, which let an emptied location slip past validation (a normal
    // text widget clears to undefined, which is why other required fields did
    // invalidate on clear but this one didn't).
    onChange(next === '' ? undefined : next);
    // The freshly typed text is no longer a resolved place — drop prior coords
    // so the submit-time fallback re-geocodes (or the next selection sets them).
    // Only the primary field feeds item_locations.
    if (isPrimary) ctx.onLocationResolved?.(null);
    runSearch(next);
  }

  async function choose(s: GeoSuggestion) {
    // Cancel any pending/in-flight search so selecting never re-opens the list.
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setText(s.label);
    onChange(s.label);
    setSuggestions([]);
    // Close the dropdown immediately — before any async work — so the UI stays
    // responsive regardless of how long the coarse geocode takes.
    setOpen(false);

    // Report the selected place — exact point plus its address components. The
    // page decides how to use it: for a public field the exact point is stored;
    // for a PRIVATE field the page coarsens to the city centroid (via the
    // components) at submit time, so the exact point never leaves the browser.
    if (isPrimary) {
      ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng, components: s.components });
    }
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const s = suggestions[index];
        if (s) void choose(s);
      },
      idPrefix: id,
    });

  return (
    <div className="relative space-y-2">
      <Input
        ref={inputRef}
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        className={cn(rawErrors && rawErrors.length > 0 && 'border-destructive')}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // Delay the close so a suggestion mousedown still registers.
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute left-0 z-50 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-md',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {suggestions.map((s, i) => (
            // `role="option"` on the item itself, not a nested <button>: an
            // option is what `aria-activedescendant` above can point at, and a
            // listbox may only contain options. It keeps its own click handler,
            // so a mouse behaves exactly as before.
            <li
              key={`${s.lat},${s.lng},${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={cn(
                'cursor-pointer px-3 py-2 text-sm',
                i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
              )}
              // onMouseDown (not onClick) so selection runs before the input's
              // blur fires; preventDefault keeps focus from flicking away.
              onMouseDown={(e) => {
                e.preventDefault();
                void choose(s);
              }}
              // Hovering moves the keyboard highlight too, so the two never
              // disagree about which option Enter would take.
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
