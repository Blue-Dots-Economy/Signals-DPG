import * as React from 'react';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea } from '@/lib/browse-discover';
import type { AppliedChip } from '@/components/filters/applied-filter-chips';

export interface UseAppliedFilterChipsInput {
  search: string;
  setSearch: (next: string) => void;
  activeFieldFilters: Record<string, string[]>;
  /**
   * Applies a COMPLETE replacement facet set. Deliberately a plain setter and
   * not `Dispatch<SetStateAction<…>>`: the caller has to be the handler that
   * also rewrites the `?f_*` query params, and an updater-function form let a
   * caller satisfy the type with the bare `useState` setter — which is exactly
   * the bug this replaces (facets cleared in state, left in the URL, restored
   * on the next reload).
   */
  setFieldFilters: (next: Record<string, string[]>) => void;
  /**
   * Human labels for facet keys, `field.key` → `field.label`, from
   * `getEnumFilterFieldsForDomains`. Chips previously printed the raw schema
   * key (`workExperienceYearsConditional`) while the filter panel showed the
   * resolved title ("Years of Work Experience") for the same field.
   */
  fieldLabels: Record<string, string>;
  area: BrowseArea;
  setArea: (next: BrowseArea) => void;
}

export interface UseAppliedFilterChipsResult {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
  onClearAll: () => void;
  /**
   * Whether anything at all is non-default. Deliberately NOT
   * `chips.length > 0`: the area can be non-default while producing no chip,
   * and clear-all must stay reachable then. Sort is excluded on purpose — see
   * `onClearAll`.
   */
  canClearAll: boolean;
}

/**
 * The browse toolbar's applied-filter state (#645 §4.1).
 *
 * Lives in a hook rather than inside `HomePage` because it is one cohesive
 * unit — the chip list, the per-chip removal, the reset, and "is anything
 * applied" all have to agree, and adding a constraint means touching this file
 * and nowhere else. It also keeps a loop, a switch and a boolean chain out of
 * an already-large page component.
 *
 * Chips cover only constraints whose EDITOR is elsewhere: search text (the
 * app-bar box) and facets (the filter panel). `sort` and `area` get no chip —
 * their own controls sit in the same toolbar row already showing their value,
 * so a chip repeating it renders as a visible duplicate.
 */
export function useAppliedFilterChips(
  input: UseAppliedFilterChipsInput,
): UseAppliedFilterChipsResult {
  const {
    search,
    setSearch,
    activeFieldFilters,
    setFieldFilters,
    fieldLabels,
    area,
    setArea,
  } = input;

  const chips = React.useMemo<AppliedChip[]>(() => {
    const out: AppliedChip[] = [];

    const q = search.trim();
    if (q) out.push({ kind: 'search', id: 'q', label: `"${q}"`, removable: true });

    for (const [field, values] of Object.entries(activeFieldFilters)) {
      if (values.length === 0) continue;
      out.push({
        kind: 'facet',
        id: `facet:${field}`,
        label: `${fieldLabels[field] ?? field}: ${values.join(', ')}`,
        removable: true,
      });
    }

    return out;
  }, [search, activeFieldFilters, fieldLabels]);

  const onRemove = React.useCallback(
    (chip: AppliedChip) => {
      switch (chip.kind) {
        // Spec D25: this chip's editor is the app-bar box. Dropping the query
        // while leaving the typed text sitting in that box would be a lie.
        case 'search':
          setSearch('');
          break;
        case 'facet': {
          const field = chip.id.slice('facet:'.length);
          const next = { ...activeFieldFilters };
          delete next[field];
          setFieldFilters(next);
          break;
        }
        case 'area':
          setArea(DEFAULT_BROWSE_AREA);
          break;
        default:
          // 'domain' is not removable — the list always needs exactly one.
          break;
      }
    },
    [setSearch, setFieldFilters, activeFieldFilters, setArea],
  );

  const onClearAll = React.useCallback(() => {
    setSearch('');
    setFieldFilters({});
    setArea(DEFAULT_BROWSE_AREA);
    // Sort is deliberately NOT reset. Clearing is about which results you
    // get — text, facets, location. A list always has SOME order, so there is
    // no "no sort" state to return to, and silently reordering the results
    // while clearing filters is a change the user did not ask for.
  }, [setSearch, setFieldFilters, setArea]);

  // Sort does not count. Changing the order left "Clear all" sitting there
  // offering to undo a choice that removed nothing — and there is no unsorted
  // state to clear back to.
  const canClearAll = chips.length > 0 || area.mode !== 'anywhere';

  return { chips, onRemove, onClearAll, canClearAll };
}
