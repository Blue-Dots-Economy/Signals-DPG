import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoSuggestion } from '@/lib/geo/types';

interface LocationFormContext {
  onLocationsResolved?: (
    coords: Array<{ lat: number; lng: number; label?: string }>,
  ) => void;
}

interface LocationRow {
  id: string;
  name: string;
  coord: { lat: number; lng: number; label?: string } | null;
}

interface RowSearchState {
  suggestions: GeoSuggestion[];
  open: boolean;
}

// Per-row abort + debounce refs stored outside component state to avoid
// re-renders. Keyed by row index; rebuilt when row count changes.
interface RowRefs {
  debounce: number | undefined;
  abort: AbortController | null;
  blur: number | undefined;
}

let __rowId = 0;
function nextRowId(): string {
  return `r${__rowId++}`;
}

function makeRow(name = ''): LocationRow {
  return { id: nextRowId(), name, coord: null };
}

function rowsFromValue(value: string[]): LocationRow[] {
  if (value.length === 0) return [makeRow()];
  return value.map((name) => makeRow(name));
}

/** Derive a stable string from rows for comparison so we don't clobber edits. */
function rowNames(rows: LocationRow[]): string[] {
  return rows.map((r) => r.name);
}

interface RowComboboxProps {
  id: string;
  value: string;
  disabled: boolean;
  hasError: boolean;
  suggestions: GeoSuggestion[];
  open: boolean;
  onInput: (next: string) => void;
  onOpenChange: (open: boolean) => void;
  onBlurClose: () => void;
  onChoose: (suggestion: GeoSuggestion) => void;
}

/**
 * One city row's text input and its suggestion list.
 *
 * Extracted from the row loop for one reason: `useSuggestionKeyboard` holds the
 * active-option state, and a hook cannot be called inside `rows.map()`. Each
 * row therefore needs its own component instance — which is also the right
 * shape, since each row's highlight is independent of its siblings'.
 */
function RowCombobox({
  id,
  value,
  disabled,
  hasError,
  suggestions,
  open,
  onInput,
  onOpenChange,
  onBlurClose,
  onChoose,
}: Readonly<RowComboboxProps>) {
  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => onOpenChange(true),
      onClose: () => onOpenChange(false),
      onSelect: (index) => {
        const suggestion = suggestions[index];
        if (suggestion) onChoose(suggestion);
      },
      idPrefix: id,
    });

  return (
    <div className="relative flex-1">
      <Input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder="Search for a city…"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        className={cn(hasError && 'border-destructive')}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => onOpenChange(suggestions.length > 0)}
        onBlur={onBlurClose}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md"
        >
          {suggestions.map((s, si) => (
            // `role="option"` on the item itself rather than a nested <button>:
            // an option is what `aria-activedescendant` can point at, and a
            // listbox may only contain options.
            <li
              key={`${s.lat},${s.lng},${si}`}
              id={optionId(si)}
              role="option"
              aria-selected={si === activeIndex}
              className={cn(
                'cursor-pointer px-3 py-2 text-sm',
                si === activeIndex ? 'bg-accent' : 'hover:bg-accent',
              )}
              // onMouseDown so selection fires before the input's blur;
              // preventDefault keeps focus from flicking away.
              onMouseDown={(e) => {
                e.preventDefault();
                onChoose(s);
              }}
              onMouseEnter={() => setActiveIndex(si)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MultiLocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  schema,
  rawErrors,
  formContext,
  options,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;

  // Coerce incoming value to string[]. RJSF passes `undefined` on a fresh form.
  const incoming = React.useMemo<string[]>(() => {
    if (Array.isArray(value)) {
      return (value as unknown[]).filter((v): v is string => typeof v === 'string');
    }
    return [];
  }, [value]);

  const maxItems: number | undefined =
    typeof schema.maxItems === 'number' ? schema.maxItems : undefined;

  // ---------- row state ----------
  const [rows, setRows] = React.useState<LocationRow[]>(() => rowsFromValue(incoming));

  // Per-row search state (suggestions + open flag). We keep this in a separate
  // array so editing one row doesn't re-render unrelated rows. Length is always
  // kept in sync with `rows`.
  const [searches, setSearches] = React.useState<RowSearchState[]>(() =>
    rows.map(() => ({ suggestions: [], open: false })),
  );

  // Mutable per-row refs (debounce timers, abort controllers, blur timers).
  // These live in a ref-of-arrays so they are never part of state/rendering.
  const refsArray = React.useRef<RowRefs[]>([]);

  const provider = React.useMemo(() => getGeoProvider(), []);

  // Ensure refsArray length matches rows length.
  function ensureRefs(count: number) {
    while (refsArray.current.length < count) {
      refsArray.current.push({ debounce: undefined, abort: null, blur: undefined });
    }
  }
  ensureRefs(rows.length);

  // ---------- value-sync effect ----------
  // When RJSF pushes a new value externally (e.g. edit-mode prefill or a reset),
  // resync rows — but only if the external list actually differs from what we
  // already have (to avoid clobbering an in-progress edit).
  React.useEffect(() => {
    setRows((prev) => {
      const prevNames = rowNames(prev).filter(Boolean);
      const nextNames = incoming.filter(Boolean);

      // If lengths and all names match, nothing to do.
      if (
        prevNames.length === nextNames.length &&
        prevNames.every((n, i) => n === nextNames[i])
      ) {
        return prev;
      }

      return rowsFromValue(incoming);
    });
  }, [incoming]);

  // Keep searches array length in sync with rows length.
  React.useEffect(() => {
    ensureRefs(rows.length);
    setSearches((prev) => {
      if (prev.length === rows.length) return prev;
      if (prev.length < rows.length) {
        return [...prev, ...Array.from({ length: rows.length - prev.length }, () => ({ suggestions: [], open: false }))];
      }
      // Shrank — cancel refs for the removed trailing rows.
      for (let i = rows.length; i < prev.length; i++) {
        const r = refsArray.current[i];
        if (r) {
          window.clearTimeout(r.debounce);
          window.clearTimeout(r.blur);
          r.abort?.abort();
        }
      }
      return prev.slice(0, rows.length);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  // Cancel all pending work on unmount.
  React.useEffect(
    () => () => {
      for (const r of refsArray.current) {
        window.clearTimeout(r.debounce);
        window.clearTimeout(r.blur);
        r.abort?.abort();
      }
    },
    [],
  );

  // ---------- helpers ----------

  function emitChanges(nextRows: LocationRow[]) {
    // Write the string[] back to RJSF (only non-empty names).
    onChange(nextRows.map((r) => r.name).filter(Boolean));
    // Report resolved coordinates to the page.
    const coords = nextRows
      .filter((r) => r.coord !== null)
      .map((r) => r.coord as { lat: number; lng: number; label?: string });
    if (isPrimary) ctx.onLocationsResolved?.(coords);
  }

  function updateRow(index: number, patch: Partial<LocationRow>) {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    setRows(next);
    emitChanges(next);
  }

  function updateSearch(index: number, patch: Partial<RowSearchState>) {
    setSearches((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }

  function runSearch(index: number, query: string) {
    const ref = refsArray.current[index];
    if (!ref) return;

    window.clearTimeout(ref.debounce);
    ref.abort?.abort();

    const q = query.trim();
    if (q.length < 3) {
      updateSearch(index, { suggestions: [], open: false });
      return;
    }

    ref.debounce = window.setTimeout(() => {
      const controller = new AbortController();
      ref.abort = controller;
      void provider.suggest(q, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        updateSearch(index, { suggestions: results, open: results.length > 0 });
      });
    }, 300);
  }

  function handleInput(index: number, next: string) {
    // Update the row name; clear the coord since the typed text is unresolved.
    updateRow(index, { name: next, coord: null });
    runSearch(index, next);
  }

  function choose(index: number, s: GeoSuggestion) {
    const ref = refsArray.current[index];
    if (ref) {
      window.clearTimeout(ref.debounce);
      ref.abort?.abort();
    }
    updateRow(index, {
      name: s.label,
      coord: { lat: s.lat, lng: s.lng, label: s.label },
    });
    updateSearch(index, { suggestions: [], open: false });
  }

  function addRow() {
    if (maxItems !== undefined && rows.length >= maxItems) return;
    const next = [...rows, makeRow()];
    setRows(next);
    emitChanges(next);
  }

  function removeRow(index: number) {
    const ref = refsArray.current[index];
    if (ref) {
      window.clearTimeout(ref.debounce);
      window.clearTimeout(ref.blur);
      ref.abort?.abort();
    }
    refsArray.current.splice(index, 1);

    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    emitChanges(next);
    setSearches((prev) => prev.filter((_, i) => i !== index));
  }

  const isDisabled = disabled === true || readonly === true;
  const atMax = maxItems !== undefined && rows.length >= maxItems;

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const search = searches[index] ?? { suggestions: [], open: false };
        return (
          <div key={row.id} className="relative flex items-start gap-2">
            <RowCombobox
              id={`${id}_${index}`}
              value={row.name}
              disabled={isDisabled}
              hasError={Boolean(rawErrors && rawErrors.length > 0)}
              suggestions={search.suggestions}
              open={search.open}
              onInput={(next) => handleInput(index, next)}
              onOpenChange={(next) => updateSearch(index, { open: next })}
              onBlurClose={() => {
                const ref = refsArray.current[index];
                if (ref) {
                  ref.blur = window.setTimeout(() => updateSearch(index, { open: false }), 150);
                }
              }}
              onChoose={(s) => choose(index, s)}
            />
            {/* Remove button — always show so all rows can be cleared */}
            <button
              type="button"
              aria-label={`Remove city ${row.name || index + 1}`}
              disabled={isDisabled}
              className="mt-2 text-muted-foreground hover:text-destructive disabled:opacity-50"
              onClick={() => removeRow(index)}
            >
              ×
            </button>
          </div>
        );
      })}

      <button
        type="button"
        disabled={isDisabled || atMax}
        className="text-sm text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        onClick={addRow}
      >
        + Add city
      </button>

      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
