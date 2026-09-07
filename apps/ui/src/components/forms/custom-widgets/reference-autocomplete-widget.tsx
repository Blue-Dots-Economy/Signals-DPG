import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * A schema-driven autocomplete backed by an EXTERNAL reference dataset rather
 * than an inline JSON-Schema `enum`. A field opts in via the custom
 * `x-reference-source` marker in network.json (e.g. `"colleges"`), which
 * `generateUiSchema` maps to this widget with `ui:options.source`. The widget
 * fetches `<base>/<dataset>.json` — `base` is `VITE_REFERENCE_BASE_URL`
 * (default the UI's own `/reference/`) and `dataset` is resolved from the source
 * (see `resolveDatasetId`) — so the — potentially huge — option list lives
 * outside network.json and can be updated without a schema change or redeploy.
 *
 * The stored value is the plain option NAME (a string), so the field stays a
 * simple `type: "string"` and existing free-text values keep working.
 *
 * The marker may be a bare string (`"colleges"`) or an object carrying display
 * config: `{ source: "colleges", subtitle: ["district"] }`. `subtitle` is an
 * ordered list of option fields (`district` | `state`) rendered under the name;
 * omit or use `[]` for name-only. Defaults to `["district"]`.
 *
 * Supported dataset shapes (both flattened to `{ name, district?, state? }`):
 *   1. Hierarchical: `{ states: [{ name, districts: [{ name, organizations:
 *      [{ name, district, state, ... }] }] }] }` (the KA/UP institute lists).
 *   2. Flat: `[{ name, district?, state? }, ...]`.
 */

interface ReferenceOption {
  name: string;
  district?: string;
  state?: string;
}

/** Option fields the marker's `subtitle` may reference. */
const SUBTITLE_FIELDS = ['district', 'state'] as const;
type SubtitleField = (typeof SUBTITLE_FIELDS)[number];
const DEFAULT_SUBTITLE: SubtitleField[] = ['district'];

type HierarchicalDataset = {
  states?: Array<{
    name?: string;
    districts?: Array<{
      name?: string;
      organizations?: Array<Record<string, unknown>>;
    }>;
  }>;
};

const MAX_SUGGESTIONS = 50;

// Module-level cache so switching fields / re-mounting the form doesn't refetch
// the (large) dataset. Keyed by source id; stores the in-flight promise.
const datasetCache = new Map<string, Promise<ReferenceOption[]>>();

function flatten(raw: unknown): ReferenceOption[] {
  if (Array.isArray(raw)) {
    const flat: ReferenceOption[] = [];
    for (const r of raw) {
      const o = r as Record<string, unknown>;
      if (typeof o.name !== 'string') continue;
      flat.push({
        name: o.name,
        district: typeof o.district === 'string' ? o.district : undefined,
        state: typeof o.state === 'string' ? o.state : undefined,
      });
    }
    return flat;
  }

  const ds = raw as HierarchicalDataset;
  const out: ReferenceOption[] = [];
  for (const st of ds.states ?? []) {
    for (const d of st.districts ?? []) {
      for (const org of d.organizations ?? []) {
        const name = typeof org.name === 'string' ? org.name : undefined;
        if (!name) continue;
        out.push({
          name,
          district:
            typeof org.district === 'string' ? org.district : d.name,
          state: typeof org.state === 'string' ? org.state : st.name,
        });
      }
    }
  }
  return out;
}

/**
 * Resolve a network.json `x-reference-source` value to the concrete dataset
 * file id (served from `public/reference/<id>.json`). `colleges` is
 * region-scoped: the state is chosen PER-DEPLOYMENT via `VITE_COLLEGE_DATASET`,
 * a short region code (`ka` | `up`), which maps to `colleges-<code>`. So one
 * build serves any state without a schema change. Any other source id is used
 * verbatim. Defaults to region `ka` when the env var is unset.
 */
function resolveDatasetId(source: string): string {
  if (source === 'colleges') {
    const region = getRuntimeEnv('VITE_COLLEGE_DATASET') || 'ka';
    return `colleges-${region}`;
  }
  return source;
}

/**
 * Base URL the reference datasets are served from. Defaults to the UI's own
 * `/reference/` (files baked into the image), but is overridable per-deployment
 * via `VITE_REFERENCE_BASE_URL` — set from a ConfigMap through
 * `window.__DPG_UI_CONFIG__` — so the lists can be hosted alongside network.json
 * (registry / CDN / API) and updated without a UI rebuild. Absolute URLs are
 * used as-is; a relative value resolves against the UI origin. Remote hosts must
 * send permissive CORS headers since the browser fetches directly.
 */
function referenceUrl(id: string): string {
  const raw = getRuntimeEnv('VITE_REFERENCE_BASE_URL') || '/reference/';
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return new URL(`${id}.json`, new URL(base, window.location.origin)).toString();
}

function loadDataset(source: string): Promise<ReferenceOption[]> {
  const cached = datasetCache.get(source);
  if (cached) return cached;
  const pending = fetch(referenceUrl(source))
    .then((res) => {
      if (!res.ok) throw new Error(`reference dataset ${source} → ${res.status}`);
      return res.json();
    })
    .then(flatten)
    .catch((err) => {
      // Drop the failed promise from the cache so a later mount can retry.
      datasetCache.delete(source);
      throw err;
    });
  datasetCache.set(source, pending);
  return pending;
}

export function ReferenceAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
  placeholder,
  options,
}: WidgetProps) {
  const opts = options as
    | { source?: string; subtitleFields?: string[] }
    | undefined;
  const source = opts?.source;
  // Validate configured fields against the allowed set (unknown values dropped);
  // an explicit (possibly empty) list wins, a missing config falls back to the
  // default. `[]` therefore means name-only.
  const subtitleFields: SubtitleField[] = Array.isArray(opts?.subtitleFields)
    ? opts.subtitleFields.filter((f): f is SubtitleField =>
        (SUBTITLE_FIELDS as readonly string[]).includes(f),
      )
    : DEFAULT_SUBTITLE;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [dataset, setDataset] = React.useState<ReferenceOption[]>([]);
  const [open, setOpen] = React.useState(false);
  const blurRef = React.useRef<number | undefined>(undefined);

  // Keep the input in sync when RJSF pushes a new value (edit-mode prefill).
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  React.useEffect(() => {
    if (!source) return;
    let live = true;
    void loadDataset(resolveDatasetId(source))
      .then((opts) => {
        if (live) setDataset(opts);
      })
      .catch(() => {
        // Load failure leaves the field as a plain text input (dataset stays
        // empty, no suggestions) — the typed value is still captured.
        if (live) setDataset([]);
      });
    return () => {
      live = false;
    };
  }, [source]);

  React.useEffect(
    () => () => window.clearTimeout(blurRef.current),
    [],
  );

  const suggestions = React.useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < 2) return [];
    return dataset
      .filter((o) => o.name.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [text, dataset]);

  function handleInput(next: string) {
    setText(next);
    onChange(next);
    setOpen(next.trim().length >= 2);
  }

  function choose(o: ReferenceOption) {
    window.clearTimeout(blurRef.current);
    setText(o.name);
    onChange(o.name);
    setOpen(false);
  }

  function subtitle(o: ReferenceOption): string | null {
    // Ordered per the marker's `subtitle` config (default: district only). Note
    // that when the dataset is state-scoped by deployment, `state` is constant
    // across options, so `["district"]` is usually the useful choice.
    const parts = subtitleFields
      .map((f) => o[f])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const option = suggestions[index];
        if (option) choose(option);
      },
      idPrefix: id,
    });

  return (
    <div className="relative space-y-2">
      <Input
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        placeholder={placeholder}
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
          blurRef.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
        >
          {suggestions.map((o, i) => {
            const sub = subtitle(o);
            return (
              // `role="option"` on the item itself rather than a nested
              // <button>: an option is what `aria-activedescendant` can point
              // at, and a listbox may only contain options.
              <li
                key={`${o.name}-${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  i === activeIndex ? 'bg-accent' : 'hover:bg-accent',
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="block">{o.name}</span>
                {sub && (
                  <span className="block text-xs text-muted-foreground">{sub}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
