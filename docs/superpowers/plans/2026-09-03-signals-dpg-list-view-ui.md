# Signals-DPG (UI): remove the All tab, sticky filter bar, card metric follows the sort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repo:** `Signals-DPG` · **Branch:** `feat/644-list-view-sort-filters` · **Worktree:** `../Signals-DPG.worktrees/644-list-view`
**Goal:** Delete the All tab and the client-side re-sort that discards the server's ranking; move domain selection out of the sidebar into a sticky bar that also shows sort, area and every applied filter; make each card's metric the reason it is in that position.

**Architecture:** Three movements. **(1) Subtraction:** removing the All tab deletes ~70 references in a 2685-line `home-page.tsx` — `DomainPagedFetch`, the lifted `allDomainPages` state, the `selectByDomainScope` forks and `sortItemsByNearest` — and takes P6 with it, because there is no merged multi-domain union left to re-sort. **(2) A new surface:** small focused components under `components/filters/` (domain control, chip bar, sort and area selectors) composed into one sticky container, so `home-page.tsx` gains wiring rather than markup. **(3) The card:** one wire scale, an icon-only pill whose content follows `meta.sort_applied`, and the dead dpg-scoring-era fields removed.

**Tech Stack:** React 18, TypeScript, TanStack Query, Tailwind, shadcn/ui, react-i18next, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-03-list-view-sort-domain-and-card-metric-design.md` — **read §7 (approved UI design) before Task 1.**
**Prerequisite plan:** `2026-09-03-signals-dpg-list-view-api.md` — **must be complete first.** Its Task 6 intentionally leaves `home-page.tsx` failing typecheck; Task 1 here fixes it.
**Sibling:** `2026-09-03-signals-search-sort-paging-text.md` (other repo, parallel session).

**Closes:** #644, #645, #646 (with the deviations recorded in Task 13). Same PR as the API plan.

## Global Constraints

- **The All tab is removed, not hidden.** `selectedDomain` is never `null` on the list. Delete the dead code; do not leave it behind a flag.
- **The server's order is final.** After Task 1 no code may reorder a fetched feed. `sortItemsByNearest` is deleted, not called conditionally.
- **Label from `meta.sort_applied`, never from the requested sort.** `relevance` with no anchor and no text degrades to `newest`; labelling from the request would claim an order the user did not get.
- **List = single-select domain. Map = multi-select.** One `/discover` call takes exactly one `item_domain`.
- **No sort control on the map** — absent, not disabled (spec D26).
- **Map → list collapses to the first selected domain silently** (D27). No notice.
- **`VITE_FREETEXT_MATCH_SCORE_ENABLED` is KEPT** (D15). Do not retire it. It means: does this deployment show a score for free-text matches?
- **Card pill is icon-only** (D22). The basis label lives in the sticky bar, the tooltip and the explanation panel — never repeated per card.
- **The explanation panel must not imply a per-field score breakdown** (spec §5.4). A single pooled embedding cannot be decomposed. Any overlap display is computed from attribute comparison and labelled illustrative.
- **Three consumers of the renamed panel:** `home-page.tsx:2123`, `home-page.tsx:2146`, **and `apps/ui/src/tourist/tourist-app.tsx:97`**, plus ~30 references across four test files.
- **All copy goes through i18n** in `en`, `hi` and `kn`. No hardcoded English in JSX.
- **Preserve `pointer-coarse:min-h-11`** touch targets on every new interactive element.
- **Test commands:** `pnpm --filter ui test`, `pnpm typecheck`. **Low-RAM machine (8 GB):** append `-- --pool=forks --maxWorkers=2`.
- **Base branch is `feature`.** PR must be a **draft**.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `apps/ui/src/pages/home-page.tsx` | Page orchestration | Remove All tab (~70 refs); wire the sticky bar; delete `sortItemsByNearest` |
| `apps/ui/src/lib/browse-domain.ts` | **New** — default/collapse domain rules | Pure functions |
| `apps/ui/src/components/filters/browse-filters-panel.tsx` | Facet editor | Moved + renamed from `components/map/map-filters-panel.tsx` |
| `apps/ui/src/components/filters/domain-control.tsx` | **New** — domain selector | Single- and multi-select modes |
| `apps/ui/src/components/filters/applied-filter-chips.tsx` | **New** — chip read-out | Removable chips + clear-all |
| `apps/ui/src/components/filters/sort-select.tsx` | **New** — sort selector | List only |
| `apps/ui/src/components/filters/area-select.tsx` | **New** — area selector | `anywhere` / `radius` |
| `apps/ui/src/components/filters/browse-toolbar.tsx` | **New** — sticky composition | Two rows; owns the sticky wrapper |
| `apps/ui/src/lib/metric-display.ts` | **New** — metric formatting | Pure: sort → pill content |
| `apps/ui/src/utils/match-score-cache.ts` | Score cache | `v2` prefix; `v1` sweep; 0–100 scale |
| `apps/ui/src/components/match-score/match-score-badge.tsx` | The pill | Icon-only, sort-driven; bands deleted |
| `apps/ui/src/components/match-score/match-score-modal.tsx` | Detail modal | Explanation panel; dead fields removed |
| `apps/ui/src/hooks/use-match-score.ts` | Score state | Delete the `×10` seed conversion |
| `packages/match_score/src/match_score.types.ts` | Provider types | Delete dead LLM-era fields |
| `packages/match_score/src/providers/signals_search/client.ts` | Provider | Delete the `÷10` conversion |
| `apps/ui/src/components/map/marker-popup-card.tsx` | Map popup | Metric consistency |
| `apps/ui/src/hooks/use-map-markers.ts` | Marker fan-out | Selection drives which queries run |
| `apps/ui/src/i18n/locales/{en,hi,kn}.json` | Copy | New keys |

Pure logic (default domain, collapse, metric formatting) lives in small `lib/` modules so it is testable without rendering. Components stay small and single-purpose; `browse-toolbar.tsx` is the only composition point.

---

## Task 1: Remove the All tab, `DomainPagedFetch` and `sortItemsByNearest`

Largest task, and everything else gets simpler after it. Do it first.

**Files:**
- Create: `apps/ui/src/lib/browse-domain.ts`, `apps/ui/src/lib/browse-domain.test.ts`
- Modify: `apps/ui/src/pages/home-page.tsx` (delete ~70 refs; rewrite the Task-6 call sites from the API plan)
- Modify: `apps/ui/src/pages/__tests__/home-page*.test.tsx` (remove All-tab cases, add single-domain ones)

**Interfaces:**
- Produces:
  ```ts
  export function resolveDefaultDomain(input: {
    fromParam: string | null;
    visibleDomains: { id: string }[];
    viewerDomain: string | null;
    actions: NetworkInteractionActions;
  }): string | null;   // null only when there are no visible domains at all

  export function collapseToSingleDomain(selected: string[], visibleDomains: { id: string }[]): string | null;
  ```

- [ ] **Step 1: Write the failing test for the pure rules**

```ts
import { describe, it, expect } from 'vitest';
import { resolveDefaultDomain, collapseToSingleDomain } from '../browse-domain';

const visible = [{ id: 'provider' }, { id: 'trainer' }];
const actions = { connect: { interactions: [{ from_domain: 'seeker', to_domain: 'provider' }] } };

describe('resolveDefaultDomain (spec D19)', () => {
  it('honours an explicit ?domain= param', () => {
    expect(resolveDefaultDomain({ fromParam: 'trainer', visibleDomains: visible, viewerDomain: 'seeker', actions })).toBe('trainer');
  });

  it('ignores a param naming a domain that is not visible', () => {
    expect(resolveDefaultDomain({ fromParam: 'ghost', visibleDomains: visible, viewerDomain: 'seeker', actions })).toBe('provider');
  });

  it('picks the first INTERACTING counterpart domain for a signed-in viewer', () => {
    // seeker interacts with provider only, so provider wins even though
    // trainer is also visible.
    expect(resolveDefaultDomain({ fromParam: null, visibleDomains: [{ id: 'trainer' }, { id: 'provider' }], viewerDomain: 'seeker', actions })).toBe('provider');
  });

  it('falls back to the first visible domain when none interact', () => {
    expect(resolveDefaultDomain({ fromParam: null, visibleDomains: visible, viewerDomain: 'nobody', actions })).toBe('provider');
  });

  it('falls back to the first visible domain for a signed-out viewer', () => {
    expect(resolveDefaultDomain({ fromParam: null, visibleDomains: visible, viewerDomain: null, actions })).toBe('provider');
  });

  it('returns null only when nothing is visible', () => {
    expect(resolveDefaultDomain({ fromParam: null, visibleDomains: [], viewerDomain: 'seeker', actions })).toBeNull();
  });
});

describe('collapseToSingleDomain (spec D27)', () => {
  it('keeps the first selected domain', () => {
    expect(collapseToSingleDomain(['trainer', 'provider'], visible)).toBe('trainer');
  });
  it('falls back to the first visible when the selection is empty', () => {
    expect(collapseToSingleDomain([], visible)).toBe('provider');
  });
  it('drops a selection that is no longer visible', () => {
    expect(collapseToSingleDomain(['ghost'], visible)).toBe('provider');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test browse-domain -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure rules**

Create `apps/ui/src/lib/browse-domain.ts`:

```ts
import { domainsInteract, type NetworkInteractionActions } from '@/lib/browse-discover';

/**
 * Which domain the list shows when the URL does not say (#644, spec D19).
 *
 * The All tab used to be the no-domain default; removing it (spec D8) means
 * something must replace it. A signed-in viewer is sent to the first domain
 * their own domain can actually interact with — a seeker lands on providers,
 * not on a domain where every card would hide its Connect button. Invisible
 * for a viewer with only one visible domain.
 */
export function resolveDefaultDomain(input: {
  fromParam: string | null;
  visibleDomains: { id: string }[];
  viewerDomain: string | null;
  actions: NetworkInteractionActions;
}): string | null {
  const visibleIds = input.visibleDomains.map((d) => d.id);
  if (input.fromParam && visibleIds.includes(input.fromParam)) return input.fromParam;

  if (input.viewerDomain) {
    const interacting = visibleIds.find((id) => domainsInteract(input.actions, input.viewerDomain!, id));
    if (interacting) return interacting;
  }
  return visibleIds[0] ?? null;
}

/**
 * Map → list transition (spec D27). The map allows several domains; one
 * `/discover` call takes exactly one, so keep the first still-visible
 * selection. Silent by design — the domain control itself is the read-out.
 */
export function collapseToSingleDomain(
  selected: string[],
  visibleDomains: { id: string }[],
): string | null {
  const visibleIds = visibleDomains.map((d) => d.id);
  return selected.find((id) => visibleIds.includes(id)) ?? visibleIds[0] ?? null;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test browse-domain -- --pool=forks --maxWorkers=2`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the regression test that P6 is gone**

Add to `apps/ui/src/pages/__tests__/home-page.test.tsx`:

```ts
describe('#644 P6 — the rendered order must equal the server order', () => {
  it('renders cards in the API order even with a viewer location resolved', async () => {
    // Server returns DESCENDING relevance. Pre-fix, home-page re-sorted the
    // "All" feed by haversine distance (home-page.tsx:2396), so the rendered
    // order diverged from the badges — observed live as 49%, 62%, 49%.
    // Seeded so a distance sort would produce a DIFFERENT order than the
    // server's, and the test would fail if any client re-sort survived.
    vi.mocked(fetchDiscover).mockResolvedValue({
      items: [
        makeItem({ id: 'far-best',   score: 62, lat: 20.0, lng: 80.0 }),
        makeItem({ id: 'near-worse', score: 58, lat: 12.97, lng: 77.59 }),
        makeItem({ id: 'mid',        score: 49, lat: 15.0, lng: 78.0 }),
      ],
      meta: { total: 3, limit: 20, offset: 0, source: 'signals_search', degraded: false, sort_applied: 'relevance' },
    });

    renderHomePage({ userLocation: { lat: 12.97, lng: 77.59 } });

    const rendered = await screen.findAllByTestId('domain-card');
    expect(rendered.map((el) => el.getAttribute('data-item-id')))
      .toEqual(['far-best', 'near-worse', 'mid']);
  });
});
```

- [ ] **Step 6: Run to confirm it fails**

Run: `pnpm --filter ui test home-page -- --pool=forks --maxWorkers=2`
Expected: FAIL — order comes back distance-sorted (`near-worse` first).

- [ ] **Step 7: Delete the All tab**

In `home-page.tsx`, remove **all** of the following. Search each name and confirm zero remaining references before moving on:

- `sortItemsByNearest` (definition `:141-152`, call `:2396`)
- `getItemLocations` — **only if** it has no other caller after the above
- `selectByDomainScope` (`:558-560`), `singleDomainSentinelEnabled` (`:563`), `allDomainsSentinelEnabled` (`:568`)
- `DomainPagedFetch` and its component definition, `handleDomainItems`, `allDomainPages`, `DomainPageState`
- `allDomainItemsFiltered`, `filteredAllDomainItems`, `allDomainsTotalCount`, `anyAllDomainHasMore`, `allDomainsLoading`, `allDomainsListDegraded`, `allDomainsListPartial`
- the entire `selectedDomain === null ? (...) : (...)` branch at `:2359` — keep only the single-domain arm

Change `selectedDomain` to be non-nullable in effect. Initialise from the new rule:

```ts
  // #644 (spec D8): the All tab is gone, so a domain is ALWAYS selected. `null`
  // no longer means "all" — it is only a transient pre-network state.
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    () => searchParams.get('domain'),
  );

  // Resolve the default once the network and visible domains are known.
  React.useEffect(() => {
    if (!network || visibleDomains.length === 0) return;
    const resolved = resolveDefaultDomain({
      fromParam: selectedDomain,
      visibleDomains,
      viewerDomain: myItem?.item_domain ?? null,
      actions: network.actions ?? {},
    });
    if (resolved && resolved !== selectedDomain) setSelectedDomain(resolved);
  }, [network, visibleDomains, myItem, selectedDomain]);
```

Then simplify every `selectByDomainScope(selectedDomain, single, all)` call to just `single`, and every `selectedDomain !== null` guard to `true` (removing the guard).

Rewrite the browse hook call to the API plan's new shape:

```ts
  const singleDomainList = useInfiniteBrowseItems(
    network,
    selectedDomainObj,
    userLocation,               // ORDERING centre only now — never a filter
    {
      enabled: selectedDomain !== null,
      ...browseHookOpts,        // q, filters, relevance, area, sort
      anchorItemId: selectedDomain ? anchorFor(selectedDomain) : undefined,
    },
  );
```

- [ ] **Step 8: Run to confirm pass**

Run: `pnpm --filter ui test home-page -- --pool=forks --maxWorkers=2` then `pnpm typecheck`
Expected: PASS, and the API plan's known typecheck failure is now resolved.
Delete All-tab-specific test cases outright — do not adapt them to assert new behaviour they were not written for.

- [ ] **Step 9: Verify the deletion is complete**

```bash
grep -rn "sortItemsByNearest\|DomainPagedFetch\|allDomainPages\|selectByDomainScope\|allDomainItemsFiltered\|anyAllDomainHasMore" apps/ui/src
```
Expected: **no output.** Any hit is an incomplete deletion.

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/lib/browse-domain.ts apps/ui/src/lib/browse-domain.test.ts apps/ui/src/pages
git commit -m "refactor(ui): remove the All tab and the client-side distance re-sort

The All tab merged N per-domain feeds client-side and re-sorted the union by
haversine distance, discarding the server's cosine ranking while each card
still showed the server's score. Cosine is not comparable across domains, so
no correct merge order existed. Removing the tab deletes both the wrong order
and the unanswerable question, and the list keeps the server's order verbatim."
```

---

## Task 2: Rename `MapFiltersPanel` → `BrowseFiltersPanel`

Mechanical, and doing it before the new components means they import the final name.

**Files:**
- Move: `apps/ui/src/components/map/map-filters-panel.tsx` → `apps/ui/src/components/filters/browse-filters-panel.tsx`
- Modify: `apps/ui/src/pages/home-page.tsx`, `apps/ui/src/tourist/tourist-app.tsx:97`
- Modify: `apps/ui/src/components/map/__tests__/map_container_and_filters.test.tsx` + 3 other test files

- [ ] **Step 1: Move the file and rename the exports**

```bash
mkdir -p apps/ui/src/components/filters
git mv apps/ui/src/components/map/map-filters-panel.tsx apps/ui/src/components/filters/browse-filters-panel.tsx
```

Rename `MapFiltersPanel` → `BrowseFiltersPanel` and `MapFiltersPanelProps` → `BrowseFiltersPanelProps`. Update the header comment to state it serves **both** views (it has since #394 — the old name misled every reader).

- [ ] **Step 2: Find every consumer**

```bash
grep -rn "MapFiltersPanel\|map-filters-panel" apps/ui/src
```
Expected: `home-page.tsx` (2 renders + 4 comment mentions), `tourist/tourist-app.tsx:97`, `use-map-markers.ts:127` (comment), `network-api.ts:147,195` (comments), and 4 test files.

- [ ] **Step 3: Update them all**

Update imports, JSX tags, and the prose in comments. **Do not skip `tourist-app.tsx`** — it is the consumer most easily missed and it is not covered by the home-page tests.

- [ ] **Step 4: Verify**

```bash
grep -rn "MapFiltersPanel\|map-filters-panel" apps/ui/src   # expect no output
pnpm --filter ui test -- --pool=forks --maxWorkers=2
pnpm typecheck
```
Expected: no output, all green.

- [ ] **Step 5: Commit**

```bash
git add -A apps/ui/src
git commit -m "refactor(ui): rename MapFiltersPanel to BrowseFiltersPanel and move it under components/filters

It has served both the list and map views since #394; the old name misdescribed
it. Includes the easily-missed tourist-app consumer."
```

---

## Task 3: `DomainControl` — single-select on list, multi-select on map

**Files:**
- Create: `apps/ui/src/components/filters/domain-control.tsx`, `.../__tests__/domain-control.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface DomainOption { id: string; label: string; available: boolean; unavailableReason?: string }
  export interface DomainControlProps {
    options: DomainOption[];
    mode: 'single' | 'multi';
    selected: string[];
    onChange: (next: string[]) => void;
  }
  export function DomainControl(props: DomainControlProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DomainControl } from '../domain-control';

const opts = [
  { id: 'provider', label: 'Provider', available: true },
  { id: 'trainer', label: 'Trainer', available: true },
  { id: 'seeker', label: 'Seeker', available: false, unavailableReason: "you can't connect with other seekers" },
];

describe('DomainControl — single mode (list)', () => {
  it('replaces the selection rather than adding to it', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['trainer']);
  });

  it('marks the selected option pressed', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Provider/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Trainer/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('never deselects the last domain — the list always needs exactly one', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — multi mode (map)', () => {
  it('adds to the selection', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider', 'trainer']);
  });

  it('removes from the selection', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="multi" selected={['provider', 'trainer']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider']);
  });

  it('never empties the selection', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — unavailable domains (spec D7 / #645)', () => {
  it('lists an unavailable domain WITH its reason instead of hiding it', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    const seeker = screen.getByRole('button', { name: /Seeker/ });
    expect(seeker).toBeDisabled();
    expect(seeker).toHaveAccessibleDescription(/can't connect with other seekers/);
  });

  it('cannot be selected', async () => {
    const onChange = vi.fn();
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Seeker/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test domain-control -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DomainOption {
  id: string;
  label: string;
  /** False for a domain the viewer's own domain cannot initiate toward. */
  available: boolean;
  /** Shown when `available` is false — one short human sentence. */
  unavailableReason?: string;
}

export interface DomainControlProps {
  options: DomainOption[];
  /** 'single' on the list (one /discover call = one domain); 'multi' on the map. */
  mode: 'single' | 'multi';
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * The one domain control (spec D10/D11). Replaces the sidebar Browse tab AND
 * the old panel domain multi-select — domain IS a filter, so it lives with the
 * other filters.
 *
 * Unavailable domains are LISTED and explained rather than hidden (spec D7):
 * `computeVisibleDomains` silently removed entire domains for signed-in
 * viewers, which users experienced as those domains not existing. The
 * interaction matrix is unchanged here — only made visible.
 *
 * Neither mode can reach an empty selection: the list needs exactly one domain
 * to fetch, and an empty map selection would render a blank map with no way to
 * recover.
 */
export function DomainControl({ options, mode, selected, onChange }: Readonly<DomainControlProps>) {
  const toggle = (id: string, available: boolean) => {
    if (!available) return;
    if (mode === 'single') {
      if (selected.length === 1 && selected[0] === id) return;
      onChange([id]);
      return;
    }
    const isOn = selected.includes(id);
    if (isOn && selected.length === 1) return;
    onChange(isOn ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div
      role="group"
      className="inline-flex overflow-x-auto rounded-lg border border-border bg-background"
    >
      {options.map((o) => {
        const on = selected.includes(o.id);
        const reasonId = o.unavailableReason ? `domain-why-${o.id}` : undefined;
        return (
          <React.Fragment key={o.id}>
            <button
              type="button"
              disabled={!o.available}
              aria-pressed={on}
              aria-describedby={reasonId}
              onClick={() => toggle(o.id, o.available)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border px-3 py-1.5 text-xs font-semibold last:border-r-0',
                'pointer-coarse:min-h-11',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                on && 'bg-primary text-primary-foreground',
                !on && o.available && 'text-muted-foreground hover:bg-accent',
                !o.available && 'cursor-not-allowed text-muted-foreground/40',
              )}
            >
              {mode === 'multi' && on && <Check className="h-3 w-3 shrink-0" />}
              {o.label}
            </button>
            {reasonId && (
              <span id={reasonId} className="sr-only">
                {o.unavailableReason}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
```

> The reason is `sr-only` + `aria-describedby` so it is always available to assistive tech; the visible treatment is a tooltip on mobile (spec §7.5) added in Task 6's composition.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test domain-control -- --pool=forks --maxWorkers=2`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/filters
git commit -m "feat(ui): one domain control, single-select on the list and multi-select on the map, with unavailable domains explained"
```

---

## Task 4: `AppliedFilterChips` — the read-out

**Files:**
- Create: `apps/ui/src/components/filters/applied-filter-chips.tsx`, `.../__tests__/applied-filter-chips.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type ChipKind = 'domain' | 'facet' | 'search' | 'sort' | 'area';
  export interface AppliedChip { kind: ChipKind; id: string; label: string; removable: boolean }
  export interface AppliedFilterChipsProps {
    chips: AppliedChip[];
    onRemove: (chip: AppliedChip) => void;
    onClearAll: () => void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```tsx
const chips = [
  { kind: 'search' as const, id: 'q', label: '"solar installer"', removable: true },
  { kind: 'facet' as const, id: 'sector:energy', label: 'Sector: Energy', removable: true },
  { kind: 'area' as const, id: 'area', label: 'Within 25 km', removable: true },
];

describe('AppliedFilterChips', () => {
  it('renders exactly one chip per constraint', () => {
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.getAllByTestId('applied-chip')).toHaveLength(3);
  });

  it('renders no chips and no clear-all when nothing is applied', () => {
    render(<AppliedFilterChips chips={[]} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.queryAllByTestId('applied-chip')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull();
  });

  it('passes the removed chip back to the caller', async () => {
    const onRemove = vi.fn();
    render(<AppliedFilterChips chips={chips} onRemove={onRemove} onClearAll={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /remove Sector: Energy/i }));
    expect(onRemove).toHaveBeenCalledWith(chips[1]);
  });

  it('clears everything', async () => {
    const onClearAll = vi.fn();
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={onClearAll} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onClearAll).toHaveBeenCalled();
  });

  it('is a labelled group', () => {
    render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.getByRole('group', { name: /applied filters/i })).toBeInTheDocument();
  });

  it('returns focus to the group after a removal (spec §4.6)', async () => {
    const { rerender } = render(<AppliedFilterChips chips={chips} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /remove Sector: Energy/i }));
    rerender(<AppliedFilterChips chips={[chips[0], chips[2]]} onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.getByRole('group', { name: /applied filters/i })).toHaveFocus();
  });

  it('omits the remove affordance on a non-removable chip', () => {
    render(<AppliedFilterChips
      chips={[{ kind: 'domain', id: 'd', label: 'Provider', removable: false }]}
      onRemove={vi.fn()} onClearAll={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /remove Provider/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test applied-filter-chips -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import * as React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type ChipKind = 'domain' | 'facet' | 'search' | 'sort' | 'area';

export interface AppliedChip {
  kind: ChipKind;
  /** Stable identity for keys and for the caller's removal switch. */
  id: string;
  /** Already-localized display text — this component does no formatting. */
  label: string;
  /**
   * False for a constraint that cannot be dropped — e.g. the domain chip,
   * since the list always needs exactly one domain.
   */
  removable: boolean;
}

export interface AppliedFilterChipsProps {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
  onClearAll: () => void;
}

const KIND_STYLES: Record<ChipKind, string> = {
  domain: 'bg-primary text-primary-foreground border-primary',
  facet: 'bg-accent text-accent-foreground border-border',
  // Dashed: the search chip's EDITOR is the app-bar box, not this bar
  // (spec D24/D25) — the dashed border signals "remove here, edit above".
  search: 'bg-accent text-accent-foreground border-border border-dashed',
  sort: 'bg-muted text-muted-foreground border-border',
  area: 'bg-accent text-accent-foreground border-border',
};

/**
 * The applied-filter read-out (#645). One removable chip per active
 * constraint, plus clear-all. Chips are the READ-OUT; the facet panel and the
 * app-bar search box remain the EDITORS (spec §7.1) — so this component
 * formats nothing and owns no filter state.
 */
export function AppliedFilterChips({ chips, onRemove, onClearAll }: Readonly<AppliedFilterChipsProps>) {
  const { t } = useTranslation();
  const groupRef = React.useRef<HTMLDivElement>(null);
  const pendingFocus = React.useRef(false);

  // Focus returns to the group after a removal (spec §4.6): the button the
  // user activated has unmounted, so without this focus falls to <body> and
  // keyboard users lose their place.
  React.useEffect(() => {
    if (pendingFocus.current) {
      pendingFocus.current = false;
      groupRef.current?.focus();
    }
  }, [chips]);

  if (chips.length === 0) return null;

  return (
    <div
      ref={groupRef}
      role="group"
      tabIndex={-1}
      aria-label={t('browse.applied_filters')}
      className="flex flex-wrap items-center gap-2 outline-none"
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
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs font-bold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      >
        {t('browse.clear_all')}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test applied-filter-chips -- --pool=forks --maxWorkers=2`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/filters
git commit -m "feat(ui): applied-filter chip bar with clear-all and focus return"
```

---

## Task 5: `SortSelect` and `AreaSelect`

**Files:**
- Create: `apps/ui/src/components/filters/sort-select.tsx`, `area-select.tsx`, and their tests

**Interfaces:**
- Produces:
  ```ts
  export interface SortSelectProps {
    value: BrowseSort;
    applied?: BrowseSort;              // meta.sort_applied — what the server DID
    nearestAvailable: boolean;         // false when no location resolves
    basis: 'profile' | 'search' | null;
    onChange: (next: BrowseSort) => void;
  }
  export interface AreaSelectProps {
    value: BrowseArea;
    defaultCenter: { lat: number; lng: number } | null;
    radiusOptionsMeters?: number[];    // default [5000, 10000, 25000, 50000]
    onChange: (next: BrowseArea) => void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
describe('SortSelect', () => {
  it('offers all three orders', async () => {
    render(<SortSelect value="relevance" nearestAvailable basis="profile" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));
    for (const label of [/relevance/i, /newest/i, /nearest/i]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('disables nearest with a reason when no location resolves', async () => {
    render(<SortSelect value="relevance" nearestAvailable={false} basis="profile" onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));
    const nearest = screen.getByRole('option', { name: /nearest/i });
    expect(nearest).toHaveAttribute('aria-disabled', 'true');
    expect(nearest).toHaveAccessibleDescription(/location/i);
  });

  it('labels the relevance basis as PROFILE when an anchor is present', () => {
    render(<SortSelect value="relevance" applied="relevance" nearestAvailable basis="profile" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your profile/i);
  });

  it('labels the relevance basis as SEARCH when there is no anchor', () => {
    render(<SortSelect value="relevance" applied="relevance" nearestAvailable basis="search" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your search/i);
  });

  it('shows what the SERVER applied, not what was requested', () => {
    // relevance requested, but with no anchor and no text the BFF returns
    // newest. Showing "Relevance" here would claim an order we did not get.
    render(<SortSelect value="relevance" applied="newest" nearestAvailable basis={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/newest/i);
  });
});

describe('AreaSelect', () => {
  it('defaults to Anywhere, making the unbounded default visible', () => {
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /area/i })).toHaveTextContent(/anywhere/i);
  });

  it('emits a radius area seeded with the viewer location as the centre', async () => {
    const onChange = vi.fn();
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={{ lat: 12.97, lng: 77.59 }} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /area/i }));
    await userEvent.click(screen.getByRole('option', { name: /25 km/i }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'radius', center: { lat: 12.97, lng: 77.59 }, meters: 25000 });
  });

  it('disables the radius options when no centre is available', async () => {
    render(<AreaSelect value={{ mode: 'anywhere' }} defaultCenter={null} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /area/i }));
    expect(screen.getByRole('option', { name: /25 km/i })).toHaveAttribute('aria-disabled', 'true');
  });

  it('can return to Anywhere', async () => {
    const onChange = vi.fn();
    render(<AreaSelect value={{ mode: 'radius', center: { lat: 1, lng: 2 }, meters: 25000 }} defaultCenter={{ lat: 1, lng: 2 }} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /area/i }));
    await userEvent.click(screen.getByRole('option', { name: /anywhere/i }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'anywhere' });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test "sort-select|area-select" -- --pool=forks --maxWorkers=2`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `sort-select.tsx`**

Build on the existing `Popover` + option-list pattern used by `BrowseFiltersPanel` so keyboard behaviour matches the rest of the app.

```tsx
import { useTranslation } from 'react-i18next';
import type { BrowseSort } from '@/lib/browse-discover';

export interface SortSelectProps {
  /** What the user asked for. */
  value: BrowseSort;
  /**
   * What the server actually applied (`meta.sort_applied`). The trigger label
   * renders from THIS, not from `value`: `relevance` with no anchor and no
   * text degrades to `newest`, and labelling from the request would claim an
   * order we did not get.
   */
  applied?: BrowseSort;
  /** False when no viewer location resolves — `nearest` has no centre. */
  nearestAvailable: boolean;
  /**
   * Which quantity `relevance` means here: 'profile' when an anchor is sent
   * (the score is profile↔item cosine, spec D14) or 'search' when there is no
   * anchor and typed text is the query vector.
   */
  basis: 'profile' | 'search' | null;
  onChange: (next: BrowseSort) => void;
}

export function SortSelect({ value, applied, nearestAvailable, basis, onChange }: Readonly<SortSelectProps>) {
  const { t } = useTranslation();
  const effective = applied ?? value;

  const triggerLabel =
    effective === 'relevance'
      ? basis === 'search'
        ? t('browse.sort_relevance_search')   // "Relevance to your search"
        : t('browse.sort_relevance_profile')  // "Relevance to your profile"
      : effective === 'nearest'
        ? t('browse.sort_nearest')
        : t('browse.sort_newest');

  // Render with Popover + role="listbox"/role="option"; `nearest` carries
  // aria-disabled + aria-describedby pointing at a reason node when
  // !nearestAvailable. Keep `pointer-coarse:min-h-11` on the trigger and every
  // option. Full markup follows BrowseFiltersPanel's MultiSelectGroup pattern.
  // ...
}
```

Implement `area-select.tsx` with the same shape: trigger shows `Anywhere` or `Within N km`; options are `Anywhere` plus each radius; radius options carry `aria-disabled` when `defaultCenter` is null; selecting a radius emits `{ mode: 'radius', center: defaultCenter, meters }`.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test "sort-select|area-select" -- --pool=forks --maxWorkers=2`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/filters
git commit -m "feat(ui): sort and area selectors, labelled from the sort the server actually applied"
```

---

## Task 6: `BrowseToolbar` — the sticky composition

**Files:**
- Create: `apps/ui/src/components/filters/browse-toolbar.tsx`, `.../__tests__/browse-toolbar.test.tsx`
- Modify: `apps/ui/src/components/layout/page-shell.tsx` (single sticky container)

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces: `BrowseToolbar` taking domain/sort/area/chips props plus `viewMode`.

- [ ] **Step 1: Write the failing test**

```tsx
describe('BrowseToolbar', () => {
  it('renders two rows: domain + count, then sort/area/chips', () => {
    render(<BrowseToolbar {...listProps} />);
    expect(screen.getByRole('group', { name: /domain/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /area/i })).toBeInTheDocument();
  });

  it('OMITS the sort control on the map (spec D26) — not disabled, absent', () => {
    render(<BrowseToolbar {...listProps} viewMode="map" />);
    expect(screen.queryByRole('button', { name: /sort/i })).toBeNull();
  });

  it('shows the sort control on the list', () => {
    render(<BrowseToolbar {...listProps} viewMode="list" />);
    expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument();
  });

  it('uses single-select domain on the list and multi on the map', () => {
    const { rerender } = render(<BrowseToolbar {...listProps} viewMode="list" />);
    expect(screen.getByRole('button', { name: /Provider/ })).toHaveAttribute('aria-pressed', 'true');
    rerender(<BrowseToolbar {...listProps} viewMode="map" selectedDomains={['provider', 'trainer']} />);
    expect(screen.getByRole('button', { name: /Trainer/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a stable height between empty and populated chip states (spec §7.2)', () => {
    const { rerender } = render(<BrowseToolbar {...listProps} chips={[]} />);
    expect(screen.getByTestId('toolbar-row-2')).toBeInTheDocument();
    expect(screen.getByText(/no filters applied/i)).toBeInTheDocument();
    rerender(<BrowseToolbar {...listProps} chips={[{ kind: 'facet', id: 'a', label: 'Sector: Energy', removable: true }]} />);
    expect(screen.getByTestId('toolbar-row-2')).toBeInTheDocument();
    expect(screen.queryByText(/no filters applied/i)).toBeNull();
  });

  it('is sticky', () => {
    render(<BrowseToolbar {...listProps} />);
    expect(screen.getByTestId('browse-toolbar').className).toMatch(/sticky/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test browse-toolbar -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the toolbar**

```tsx
/**
 * The sticky browse toolbar (spec §7.2). Row 1: domain control + result count.
 * Row 2: sort (list only), area, applied chips, clear-all.
 *
 * Division of labour (spec §7.1): the APP BAR owns the editors — the search
 * box and the facet-panel trigger, neither of which moves here. This toolbar
 * owns the STATE read-out plus the two controls that had no previous home,
 * `sort` and `area`.
 *
 * Sticky is load-bearing, not decoration (spec D23): it is what lets the card
 * pill stay icon-only. The ranking basis is stated once, permanently on
 * screen, instead of being repeated on all 20 cards.
 *
 * Row 2 always renders — showing "No filters applied" when empty — so the bar
 * keeps a stable height and the list does not shift under the user's thumb as
 * chips come and go.
 */
export function BrowseToolbar(props: Readonly<BrowseToolbarProps>) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="browse-toolbar"
      // NOTE: no `top-N` here on purpose — see Step 4. The offset cannot be
      // hardcoded because the app bar wraps at narrow widths.
      className="sticky z-30 border-b bg-background/95 px-4 py-2 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-2">
        <DomainControl
          options={props.domainOptions}
          mode={props.viewMode === 'map' ? 'multi' : 'single'}
          selected={props.selectedDomains}
          onChange={props.onDomainsChange}
        />
        <span className="flex-1" />
        {props.count !== undefined && (
          <span className="text-xs font-semibold text-muted-foreground">
            {t('browse.count_listings', { count: props.count })}
          </span>
        )}
      </div>

      <div data-testid="toolbar-row-2" className="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
        {/* Sort is ABSENT on the map (spec D26): ordering is meaningless for a
            marker layer, and a disabled control invites the question rather
            than answering it. */}
        {props.viewMode !== 'map' && (
          <SortSelect
            value={props.sort}
            applied={props.sortApplied}
            nearestAvailable={props.nearestAvailable}
            basis={props.relevanceBasis}
            onChange={props.onSortChange}
          />
        )}
        <AreaSelect value={props.area} defaultCenter={props.defaultCenter} onChange={props.onAreaChange} />
        {props.chips.length > 0 ? (
          <AppliedFilterChips chips={props.chips} onRemove={props.onRemoveChip} onClearAll={props.onClearAll} />
        ) : (
          <span className="text-xs italic text-muted-foreground">{t('browse.no_filters')}</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Solve the sticky offset properly**

**Do not add `top-14`.** `top-bar.tsx:78` is `sticky top-0 z-40 min-h-14` **and `flex-wrap`** — at narrow widths it wraps to two lines, so its height is not fixed and a hardcoded offset gaps or overlaps (spec §7.3).

In `page-shell.tsx`, wrap the top bar and the toolbar slot in **one** sticky container so they stack naturally:

```tsx
{/* One sticky container for both bars. The app bar is flex-wrap, so its
    height varies with viewport width — a hardcoded `top-14` on the toolbar
    would gap or overlap. Stacking them inside a single sticky element lets
    normal flow do the arithmetic. */}
<div className="sticky top-0 z-40">
  <TopBar {...topBarProps} />
  {browseToolbar}
</div>
```

Then remove `sticky top-0 z-40` from `top-bar.tsx`'s own `<header>` (it is now inside a sticky parent) and drop the `z-30`/`sticky` from the toolbar. **Verify by resizing to 320px** that the toolbar sits flush under a two-line app bar.

- [ ] **Step 5: Run to confirm pass**

Run: `pnpm --filter ui test "browse-toolbar|page-shell|top-bar" -- --pool=forks --maxWorkers=2`
Expected: PASS. Update the sticky assertion in Step 1 if you moved the class to the parent — assert the composed behaviour, not the literal class.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/filters apps/ui/src/components/layout
git commit -m "feat(ui): sticky browse toolbar composing domain, sort, area and chips

Both bars share one sticky container: the app bar is flex-wrap, so its height
varies with viewport width and a hardcoded offset would gap or overlap."
```

---

## Task 7: Wire the toolbar into `home-page`, retire the sidebar Browse tab

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`, the sidebar component that renders Browse tabs
- Test: `apps/ui/src/pages/__tests__/home-page.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
describe('home-page — domain moves out of the sidebar (spec D10)', () => {
  it('renders the domain control in the toolbar, not the sidebar', async () => {
    renderHomePage();
    const toolbar = await screen.findByTestId('browse-toolbar');
    expect(within(toolbar).getByRole('group', { name: /domain/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('sidebar')).queryByRole('group', { name: /domain/i })).toBeNull();
  });

  it('changing the domain updates ?domain= and refetches', async () => {
    const spy = vi.mocked(fetchDiscover);
    renderHomePage();
    await userEvent.click(await screen.findByRole('button', { name: /Trainer/ }));
    await waitFor(() => expect(spy.mock.calls.at(-1)?.[0].item_domain).toBe('trainer'));
  });

  it('removing the search chip clears the app-bar box too (spec D25)', async () => {
    renderHomePage({ initialSearch: 'solar' });
    const box = screen.getByRole('searchbox');
    expect(box).toHaveValue('solar');
    await userEvent.click(await screen.findByRole('button', { name: /remove .*solar/i }));
    expect(box).toHaveValue('');
  });

  it('removing the area chip re-queries UNBOUNDED', async () => {
    const spy = vi.mocked(fetchDiscover);
    renderHomePage({ initialArea: { mode: 'radius', center: { lat: 1, lng: 2 }, meters: 25000 } });
    await userEvent.click(await screen.findByRole('button', { name: /remove .*25 km/i }));
    await waitFor(() => {
      const last = spy.mock.calls.at(-1)?.[0];
      expect(last?.item_latitude).toBeUndefined();
      expect(last?.distance_meters).toBeUndefined();
    });
  });

  it('map → list collapses a multi-domain selection silently (spec D27)', async () => {
    renderHomePage({ viewMode: 'map', selectedDomains: ['trainer', 'provider'] });
    await userEvent.click(screen.getByRole('button', { name: /list/i }));
    expect(screen.getByRole('button', { name: /Trainer/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Provider/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/showing .* only/i)).toBeNull();   // no notice
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test home-page -- --pool=forks --maxWorkers=2`
Expected: FAIL — toolbar not mounted; domain still in the sidebar.

- [ ] **Step 3: Build the chip list from state**

Add to `home-page.tsx`:

```ts
  // Single source of truth for the chip read-out. Every active constraint
  // appears exactly once, and each chip's `id` is what `handleRemoveChip`
  // switches on — so adding a constraint means adding it in both places and
  // nowhere else.
  const appliedChips = React.useMemo<AppliedChip[]>(() => {
    const out: AppliedChip[] = [];
    if (search.trim()) {
      out.push({ kind: 'search', id: 'q', label: `"${search.trim()}"`, removable: true });
    }
    for (const [field, values] of Object.entries(activeFieldFilters)) {
      if (values.length === 0) continue;
      out.push({
        kind: 'facet', id: `facet:${field}`,
        label: t('browse.chip_facet', { field: labelForField(field), values: values.join(', ') }),
        removable: true,
      });
    }
    if (area.mode === 'radius') {
      out.push({
        kind: 'area', id: 'area',
        label: t('browse.chip_area_radius', { km: Math.round(area.meters / 1000) }),
        removable: true,
      });
    }
    // Sort appears only when non-default, so the common case stays uncluttered.
    if (sort !== 'relevance') {
      out.push({ kind: 'sort', id: 'sort', label: t(`browse.sort_${sort}`), removable: true });
    }
    return out;
  }, [search, activeFieldFilters, area, sort, t]);

  const handleRemoveChip = React.useCallback((chip: AppliedChip) => {
    switch (chip.kind) {
      // D25: the chip is a read-out whose editor is the app-bar box. Clearing
      // only the query while leaving text in the box would be a lie.
      case 'search': setSearch(''); break;
      case 'facet': {
        const field = chip.id.slice('facet:'.length);
        setActiveFieldFilters((prev) => { const next = { ...prev }; delete next[field]; return next; });
        break;
      }
      case 'area': setArea(DEFAULT_BROWSE_AREA); break;
      case 'sort': setSort('relevance'); break;
      case 'domain': break;   // not removable — the list always needs one
    }
  }, []);

  const handleClearAll = React.useCallback(() => {
    setSearch('');
    setActiveFieldFilters({});
    setArea(DEFAULT_BROWSE_AREA);
    setSort('relevance');
  }, []);
```

- [ ] **Step 4: Mount the toolbar and remove the sidebar Browse tab**

Pass `<BrowseToolbar>` into `PageShell`'s new sticky slot. Build `domainOptions` from **every** domain in the network — not just `visibleDomains` — marking non-interacting ones unavailable with their reason (spec D7):

```ts
  // Spec D7: list EVERY domain and explain the ones the viewer cannot browse.
  // `computeVisibleDomains` is unchanged — the interaction matrix still governs
  // what is fetchable; we only stop making entire domains silently vanish.
  const domainOptions = React.useMemo<DomainOption[]>(() => {
    const visibleIds = new Set(visibleDomains.map((d) => d.id));
    return (network?.domains ?? []).map((d) => ({
      id: d.id,
      label: formatDomainLabel(d.id, [d]) ?? d.id,
      available: visibleIds.has(d.id),
      unavailableReason: visibleIds.has(d.id)
        ? undefined
        : t('browse.domain_unavailable', { domain: formatDomainLabel(d.id, [d]) ?? d.id }),
    }));
  }, [network, visibleDomains, t]);
```

Then delete the sidebar's Browse-tab domain list and its handler wiring.

- [ ] **Step 5: Run to confirm pass**

Run: `pnpm --filter ui test home-page -- --pool=forks --maxWorkers=2` and `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src
git commit -m "feat(ui): mount the browse toolbar and retire the sidebar Browse tab"
```

---

## Task 8: Map fan-out driven by the domain selection (spec D12)

**Files:**
- Modify: `apps/ui/src/hooks/use-map-markers.ts:140-146`, `apps/ui/src/pages/home-page.tsx:1176-1192`
- Test: `apps/ui/src/hooks/__tests__/use-map-markers.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
describe('use-map-markers — selection decides which queries RUN (spec D12)', () => {
  it('issues one request per SELECTED domain, not per visible domain', async () => {
    const spy = vi.mocked(fetchMarkers).mockResolvedValue(emptyMarkers);
    renderHook(() => useMapMarkers(network, [providerDomain, trainerDomain], viewport, zoom, {
      selectedDomains: ['provider'],
    }), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.map((c) => c[0].item_domain)).toEqual(['provider']);
  });

  it('fetches every visible domain when the selection is empty', async () => {
    const spy = vi.mocked(fetchMarkers).mockResolvedValue(emptyMarkers);
    renderHook(() => useMapMarkers(network, [providerDomain, trainerDomain], viewport, zoom, {
      selectedDomains: [],
    }), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('stops requesting a domain that is deselected', async () => {
    const spy = vi.mocked(fetchMarkers).mockResolvedValue(emptyMarkers);
    const { rerender } = renderHook(
      ({ sel }) => useMapMarkers(network, [providerDomain, trainerDomain], viewport, zoom, { selectedDomains: sel }),
      { wrapper, initialProps: { sel: ['provider', 'trainer'] } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    spy.mockClear();
    rerender({ sel: ['provider'] });
    await waitFor(() => {
      expect(spy.mock.calls.every((c) => c[0].item_domain === 'provider')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test use-map-markers -- --pool=forks --maxWorkers=2`
Expected: FAIL — both domains fetched regardless of the selection.

- [ ] **Step 3: Implement**

In `use-map-markers.ts`, narrow the `active` list:

```ts
  // Spec D12: the domain selection decides WHICH queries run. Previously all
  // visible domains were fetched and unwanted markers were discarded
  // afterwards in home-page — so deselecting a domain saved no request. An
  // empty selection still means "all", matching the control's own semantics.
  const selected = opts?.selectedDomains ?? [];
  const scoped = selected.length > 0 ? domains.filter((d) => selected.includes(d.id)) : domains;
  const active = network && viewport ? scoped : [];
```

Then delete the now-redundant post-fetch filter in `home-page.tsx:1180-1185`, keeping only the own-item filter:

```ts
  const mapItems = React.useMemo(
    () =>
      mapMarkers.markers
        .filter((m) => !ownMapItemIds.has(m.item_id))
        // The domain filter is gone: use-map-markers no longer fetches
        // unselected domains, so there is nothing left to discard (spec D12).
        .map((m) => ({ id: m.item_id, domain: m.item_domain, data: { item_locations: m.item_locations } })),
    [mapMarkers.markers, ownMapItemIds],
  );
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test "use-map-markers|home-page" -- --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src
git commit -m "perf(ui): the map domain selection now decides which marker requests run instead of discarding fetched markers"
```

---

## Task 9: One score scale end to end, cache `v2` + `v1` sweep

**Files:**
- Modify: `packages/match_score/src/providers/signals_search/client.ts`, `apps/ui/src/hooks/use-match-score.ts`, `apps/ui/src/utils/match-score-cache.ts`
- Test: `apps/ui/src/utils/__tests__/match-score-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('match-score cache — 0-100 scale migration (spec §5.2)', () => {
  beforeEach(() => localStorage.clear());

  it('formats a 0-100 score directly', () => {
    expect(formatScorePercentage(62)).toBe('62%');
    expect(formatScorePercentage(100)).toBe('100%');
    expect(formatScorePercentage(0)).toBe('0%');
  });

  it('uses a v2 key prefix', () => {
    expect(generateCacheKey('a', 'b')).toBe('dpg:matchScore:v2:a:b');
  });

  it('does NOT read a v1 entry — a stale 0-10 value would render 10x too small', () => {
    // 6.2 on the old scale is a 62% match. Read with the new formatter it
    // would print "6%". Unreachability is the fix.
    localStorage.setItem('dpg:matchScore:v1:a:b', JSON.stringify({
      score: { provider: 'discover', score: 6.2, source: 'discover' },
      timestamp: Date.now(), localItemId: 'a', networkItemId: 'b',
    }));
    expect(getCachedMatchScore('a', 'b')).toBeNull();
  });

  it('sweeps v1 entries away rather than orphaning them', () => {
    localStorage.setItem('dpg:matchScore:v1:a:b', '{}');
    localStorage.setItem('dpg:matchScore:v1:c:d', '{}');
    localStorage.setItem('unrelated:key', 'keep me');
    sweepLegacyMatchScoreCache();
    expect(localStorage.getItem('dpg:matchScore:v1:a:b')).toBeNull();
    expect(localStorage.getItem('dpg:matchScore:v1:c:d')).toBeNull();
    expect(localStorage.getItem('unrelated:key')).toBe('keep me');
  });

  it('round-trips a v2 entry', () => {
    setCachedMatchScore('a', 'b', { provider: 'signals_search', score: 62, raw_response: null });
    expect(getCachedMatchScore('a', 'b')?.score.score).toBe(62);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test match-score-cache -- --pool=forks --maxWorkers=2`
Expected: FAIL — prefix is `v1`, `formatScorePercentage` divides by 10, no sweep exists.

- [ ] **Step 3: Implement**

In `match-score-cache.ts`:

```ts
/**
 * v2 (#646 §5.2): the wire scale became 0-100 end to end, matching what
 * /v1/relevance already emitted, and both conversion points were deleted.
 *
 * The prefix bump is mandatory, not hygiene. A user who viewed a score in the
 * 24 hours before the deploy has a 0-10 value cached; read by the new 0-100
 * formatter, a 62% match prints as "6%" — silently, with no error. Migrating
 * the values is impossible: nothing in the payload identifies which scale a
 * stored number is on, so the version prefix IS the marker.
 */
const CACHE_KEY_PREFIX = 'dpg:matchScore:v2';
const LEGACY_CACHE_KEY_PREFIXES = ['dpg:matchScore:v1'];

/**
 * Delete pre-v2 entries. Required because localStorage has no expiry of its
 * own — the 24-hour TTL is enforced in code, on read, and nothing will ever
 * read a v1 key again. `clearMatchScoreCache` only sweeps the CURRENT prefix,
 * so without this the old entries would persist in every user's browser
 * forever; `setCachedMatchScore` already fails silently when storage is full,
 * so leaking quota is not free.
 *
 * Call once at app startup. Idempotent.
 */
export function sweepLegacyMatchScoreCache(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LEGACY_CACHE_KEY_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Storage unavailable (private mode, quota) — nothing to clean up.
  }
}

/** Scores are 0-100 on the wire and in the cache; format directly. */
export function formatScorePercentage(score: number): string {
  return `${Math.round(score)}%`;
}
```

Delete `getMatchScoreBand` entirely (Task 11 removes its last consumer; if anything still imports it, that import is dead too).

In `providers/signals_search/client.ts`: delete `PERCENTAGE_TO_SCORE_DIVISOR` and its comment, and return `score: percentage` unchanged.

In `use-match-score.ts`: `seedFromDiscoverScore` returns `score: networkItem.score` with no `* 10`.

Call the sweep once at startup (`apps/ui/src/main.tsx` or the app root):

```ts
// One-time cleanup of pre-v2 (0-10 scale) cached scores — see
// sweepLegacyMatchScoreCache.
sweepLegacyMatchScoreCache();
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter ui test match-score -- --pool=forks --maxWorkers=2
pnpm --filter @dpg/match_score test -- --pool=forks --maxWorkers=2
```
Expected: PASS. Provider tests asserting `÷10` are now wrong — update them to expect the raw 0–100 value.

- [ ] **Step 5: Commit**

```bash
git add packages/match_score apps/ui/src
git commit -m "fix(match-score): one 0-100 scale end to end, with a v2 cache prefix and a sweep of v1 entries

Two conversions (provider divide-by-10, discover seed times-10) meant three
scales for one quantity. Cached 0-10 values would render 10x too small under
the new formatter, and nothing in the payload identifies a stored number's
scale, so the prefix bump is the only correct invalidation."
```

---

## Task 10: The pill follows the sort

**Files:**
- Create: `apps/ui/src/lib/metric-display.ts`, `apps/ui/src/lib/metric-display.test.ts`
- Modify: `apps/ui/src/components/match-score/match-score-badge.tsx`, `match-score-button.tsx`, `apps/ui/src/components/map/marker-popup-card.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type CardMetric =
    | { kind: 'relevance'; percent: number }
    | { kind: 'distance'; meters: number }
    | { kind: 'age'; createdAt: Date }
    | null;
  export function resolveCardMetric(input: {
    sortApplied: BrowseSort | undefined;
    score?: number | null;
    distanceMeters?: number | null;
    createdAt?: Date | null;
    freeTextScoreEnabled: boolean;
    hasProfile: boolean;
  }): CardMetric;
  export function formatCardMetric(m: CardMetric, t: TFunction): string | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
const base = { freeTextScoreEnabled: true, hasProfile: true };

describe('resolveCardMetric — the metric IS the ranking basis (#646 C1)', () => {
  it('relevance → percent', () => {
    expect(resolveCardMetric({ ...base, sortApplied: 'relevance', score: 62 })).toEqual({ kind: 'relevance', percent: 62 });
  });

  it('nearest → distance, ignoring any score present', () => {
    expect(resolveCardMetric({ ...base, sortApplied: 'nearest', score: 62, distanceMeters: 4200 }))
      .toEqual({ kind: 'distance', meters: 4200 });
  });

  it('newest → age, ignoring any score present', () => {
    const createdAt = new Date('2026-08-29T00:00:00Z');
    expect(resolveCardMetric({ ...base, sortApplied: 'newest', score: 62, createdAt }))
      .toEqual({ kind: 'age', createdAt });
  });

  it('shows nothing when the driving quantity is missing', () => {
    expect(resolveCardMetric({ ...base, sortApplied: 'relevance', score: null })).toBeNull();
    expect(resolveCardMetric({ ...base, sortApplied: 'nearest', distanceMeters: null })).toBeNull();
    expect(resolveCardMetric({ ...base, sortApplied: 'newest', createdAt: null })).toBeNull();
  });

  it('hides a free-text score when the deployment disables it (spec D15)', () => {
    // No profile means the score is text-vs-item, which this deployment opts
    // out of. Sorting still works; only the number is withheld.
    expect(resolveCardMetric({
      sortApplied: 'relevance', score: 62, hasProfile: false, freeTextScoreEnabled: false,
    })).toBeNull();
  });

  it('still shows a PROFILE score when free-text scores are disabled', () => {
    expect(resolveCardMetric({
      sortApplied: 'relevance', score: 62, hasProfile: true, freeTextScoreEnabled: false,
    })).toEqual({ kind: 'relevance', percent: 62 });
  });

  it('shows nothing when the server reported no sort', () => {
    expect(resolveCardMetric({ ...base, sortApplied: undefined, score: 62 })).toBeNull();
  });
});

describe('formatCardMetric', () => {
  it('formats a percentage', () => expect(formatCardMetric({ kind: 'relevance', percent: 62 }, t)).toBe('62%'));
  it('formats km above 1000 m', () => expect(formatCardMetric({ kind: 'distance', meters: 4200 }, t)).toBe('4.2 km'));
  it('formats metres below 1000', () => expect(formatCardMetric({ kind: 'distance', meters: 850 }, t)).toBe('850 m'));
  it('formats a relative age', () => {
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    expect(formatCardMetric({ kind: 'age', createdAt: new Date('2026-08-29T00:00:00Z') }, t)).toBe('5d ago');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test metric-display -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `metric-display.ts`**

```ts
/**
 * The card metric IS the ranking basis (#646 C1). Users conflated the list's
 * ORDER with the number on each card; they look like they should agree, and
 * under an explicit sort they visibly would not — an item would be ordered by
 * one quantity and badged with another.
 *
 * So the metric shown is always whatever drove the position, and is never
 * shown when it did not determine the order. Keyed off the sort the SERVER
 * applied, never the requested one.
 */
export function resolveCardMetric(input: {
  sortApplied: BrowseSort | undefined;
  score?: number | null;
  distanceMeters?: number | null;
  createdAt?: Date | null;
  /** VITE_FREETEXT_MATCH_SCORE_ENABLED — kept as a real product choice (D15). */
  freeTextScoreEnabled: boolean;
  hasProfile: boolean;
}): CardMetric {
  switch (input.sortApplied) {
    case 'relevance': {
      if (input.score == null) return null;
      // With no profile the score is typed-text↔item, not profile↔item — a
      // different quantity, which some deployments choose not to surface.
      if (!input.hasProfile && !input.freeTextScoreEnabled) return null;
      return { kind: 'relevance', percent: input.score };
    }
    case 'nearest':
      return input.distanceMeters == null ? null : { kind: 'distance', meters: input.distanceMeters };
    case 'newest':
      return input.createdAt == null ? null : { kind: 'age', createdAt: input.createdAt };
    default:
      return null;
  }
}

export function formatCardMetric(m: CardMetric, t: TFunction): string | null {
  if (!m) return null;
  switch (m.kind) {
    case 'relevance': return `${Math.round(m.percent)}%`;
    case 'distance':
      return m.meters >= 1000
        ? t('card.metric_km', { km: (m.meters / 1000).toFixed(1) })
        : t('card.metric_m', { m: Math.round(m.meters) });
    case 'age': {
      const days = Math.floor((Date.now() - m.createdAt.getTime()) / 86_400_000);
      if (days < 1) return t('card.metric_today');
      return t('card.metric_days_ago', { count: days });
    }
  }
}
```

- [ ] **Step 4: Make the badge icon-only and sort-driven**

Rewrite `match-score-badge.tsx` to take a `CardMetric` plus an icon per kind (`Star` / `Navigation` / `Clock`), delete `getScoreStyles` and its four bands, and render `formatCardMetric(...)` alone — **no basis label** (spec D22; the sticky bar carries it). Keep the tooltip and put the full basis sentence there. `MatchScoreButton` already passes `showLabel={false}`, so remove that prop rather than keeping a no-op.

Thread `sortApplied` from `useInfiniteBrowseItems` down through `home-page` → `DomainCard` → the badge, and apply the same metric to `marker-popup-card.tsx`.

- [ ] **Step 5: Run to confirm pass**

Run: `pnpm --filter ui test "metric-display|match-score|domain-card|marker-popup" -- --pool=forks --maxWorkers=2`
Expected: PASS. `match-score-badge.test.tsx` asserts band labels — those bands are deliberately gone, so rewrite those cases for the three metric kinds.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src
git commit -m "feat(ui): the card pill shows the ranking basis — percent, distance or age

Keyed off the sort the server reported, so the number and the order can never
disagree. Icon-only: the basis is stated once in the sticky toolbar rather than
repeated on every card. Drops the uncalibrated Excellent/Good/Moderate/Low
bands, whose thresholds implied a calibration BGE-M3 similarities do not have."
```

---

## Task 11: Delete the dead dpg-scoring surface

**Files:**
- Modify: `packages/match_score/src/match_score.types.ts`, `apps/ui/src/lib/match-score-api.ts`, `apps/ui/src/components/match-score/match-score-modal.tsx`

- [ ] **Step 1: Write the failing test**

```ts
describe('MatchScoreResult — dead dpg-scoring fields are gone (#646 C5)', () => {
  it('does not accept the retired fields', () => {
    // Type-level guard: these were never populated by the signals_search
    // provider, so the modal offered affordances that could never fill.
    const r: MatchScoreResult = { provider: 'signals_search', score: 62, raw_response: null };
    // @ts-expect-error band was removed
    r.band = 'Excellent';
    // @ts-expect-error confidence was removed
    r.confidence = 0.9;
    // @ts-expect-error reasoning was removed
    r.reasoning = 'x';
    // @ts-expect-error signals was removed
    r.signals = [];
  });
});

describe('MatchScoreModal', () => {
  it('renders no confidence or reasoning section', () => {
    render(<MatchScoreModal isOpen score={{ provider: 'signals_search', score: 62, raw_response: null }} {...rest} />);
    expect(screen.queryByText(/confidence/i)).toBeNull();
    expect(screen.queryByText(/reasoning/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test match-score-modal -- --pool=forks --maxWorkers=2` and `pnpm typecheck`
Expected: FAIL — the `@ts-expect-error` directives are unused because the fields still exist.

- [ ] **Step 3: Implement**

Reduce `MatchScoreResult` to:

```ts
export interface MatchScoreResult {
  provider: string;
  /** 0-100 (#646 §5.2 — one scale end to end). */
  score?: number;
  version?: string;
  raw_response: unknown;
}
```

`band`, `confidence`, `reasoning`, `signals`, `prompt_version`, `model_provider` and `model` are dpg-scoring-era fields the `signals_search` provider never populates. Remove the mirror in `match-score-api.ts`, and delete the modal's confidence/reasoning/signals blocks (including the badge tooltip's `score.confidence` and `score.reasoning` branches at `match-score-badge.tsx:118-130`).

> The provider's 404/409 path currently sets `reasoning: 'not_indexed' | 'not_comparable'` (`client.ts:65`). Replace it with a dedicated `unavailable_reason?: 'not_indexed' | 'not_comparable'` field so that genuine signal is not lost with the dead ones.

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter ui test match-score -- --pool=forks --maxWorkers=2
pnpm --filter @dpg/match_score test -- --pool=forks --maxWorkers=2
pnpm typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/match_score apps/ui/src
git commit -m "refactor(match-score): remove dpg-scoring-era fields the signals_search provider never populates

Keeps the 404/409 signal as an explicit unavailable_reason rather than
smuggling it through the removed reasoning field."
```

---

## Task 12: The explanation panel

**Files:**
- Create: `apps/ui/src/components/match-score/relevance-explanation.tsx` + test
- Modify: `apps/ui/src/components/match-score/match-score-modal.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
const props = {
  sortApplied: 'relevance' as const,
  metricLabel: '62%',
  basis: 'profile' as const,
  vectorizeFields: [
    { name: 'skills', weight: 3, viewerValue: 'solar, wiring', itemValue: 'solar, plumbing' },
    { name: 'sector', weight: 2, viewerValue: 'energy', itemValue: 'energy' },
  ],
  setConstraints: [{ label: 'Domain: Provider' }, { label: 'Within 25 km' }],
};

describe('RelevanceExplanation (#646 C4)', () => {
  it('states the sort in force and the metric it used', () => {
    render(<RelevanceExplanation {...props} />);
    expect(screen.getByText(/relevance/i)).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();
  });

  it('lists exactly the vectorize fields with their weights', () => {
    render(<RelevanceExplanation {...props} />);
    const rows = screen.getAllByTestId('vectorize-field');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/skills/);
    expect(rows[0]).toHaveTextContent(/3/);
  });

  it('shows viewer and item values side by side', () => {
    render(<RelevanceExplanation {...props} />);
    expect(screen.getByText('solar, wiring')).toBeInTheDocument();
    expect(screen.getByText('solar, plumbing')).toBeInTheDocument();
  });

  it('separates set-shaping constraints from ordering', () => {
    render(<RelevanceExplanation {...props} />);
    const section = screen.getByTestId('set-constraints');
    expect(section).toHaveTextContent(/Domain: Provider/);
    expect(section).toHaveTextContent(/Within 25 km/);
  });

  it('LABELS the overlap illustrative and shows no per-field contribution', () => {
    // HONESTY CONSTRAINT (spec §5.4): the cosine comes from a single pooled
    // embedding of the serialized vectorize fields, so it cannot be
    // decomposed. Implying otherwise would be a fabrication.
    render(<RelevanceExplanation {...props} />);
    expect(screen.getByTestId('illustrative-note')).toHaveTextContent(/illustrative/i);
    expect(screen.queryByTestId('field-contribution')).toBeNull();
    expect(screen.queryByText(/%\s*(of|from)\s+(this|the)\s+score/i)).toBeNull();
  });

  it('omits the relevance fields entirely under a non-relevance sort', () => {
    render(<RelevanceExplanation {...props} sortApplied="newest" metricLabel="5d ago" basis={null} />);
    expect(screen.queryAllByTestId('vectorize-field')).toHaveLength(0);
    expect(screen.getByTestId('set-constraints')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter ui test relevance-explanation -- --pool=forks --maxWorkers=2`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
/**
 * "Why this result, in this position" (#646 C4).
 *
 * HONESTY CONSTRAINT (spec §5.4) — the hard rule of this component: the
 * cosine score is computed over a SINGLE POOLED EMBEDDING of the serialized
 * `vectorize` fields (`serializeItemText` repeats each line `vector_weight`
 * times), so it CANNOT be decomposed into per-field contributions.
 *
 * Therefore this panel may show which fields feed relevance, their weights,
 * and the viewer's values beside the item's — but the overlap is computed by
 * comparing attributes, NOT derived from the score, and must be labelled
 * illustrative. Never render a per-field percentage or a "contribution" bar:
 * that number does not exist and inventing it would be a fabrication users
 * would reasonably trust.
 *
 * Constraints that shaped the SET (facets, area, domain) are shown in a
 * separate section, because they decide membership, not position.
 */
export function RelevanceExplanation(props: Readonly<RelevanceExplanationProps>) {
  // Render: sort + metric header; the vectorize table (relevance sort only);
  // the illustrative note; the set-constraints section.
  // ...
}
```

Mount it in `match-score-modal.tsx` in place of the deleted reasoning/signals blocks. Source `vectorizeFields` from the domain's network schema (`vectorize: true` + `vector_weight`), the same declaration signals-search indexes from.

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter ui test "relevance-explanation|match-score-modal" -- --pool=forks --maxWorkers=2`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/match-score
git commit -m "feat(ui): relevance explanation panel, explicit that a pooled embedding cannot be decomposed per field"
```

---

## Task 13: i18n, full verification, draft PR

**Files:**
- Modify: `apps/ui/src/i18n/locales/{en,hi,kn}.json`

- [ ] **Step 1: Add every new key to all three locales**

```jsonc
// en.json — add under the existing structure
"browse.applied_filters": "Applied filters",
"browse.remove_filter": "Remove {{label}}",
"browse.clear_all": "Clear all",
"browse.no_filters": "No filters applied",
"browse.count_listings": "{{count}} listings",
"browse.chip_facet": "{{field}}: {{values}}",
"browse.chip_area_radius": "Within {{km}} km",
"browse.domain_unavailable": "You can't connect with {{domain}}",
"browse.sort_label": "Sort",
"browse.sort_relevance_profile": "Relevance to your profile",
"browse.sort_relevance_search": "Relevance to your search",
"browse.sort_newest": "Newest",
"browse.sort_nearest": "Nearest",
"browse.sort_nearest_unavailable": "Needs your location to sort by distance",
"browse.area_label": "Area",
"browse.area_anywhere": "Anywhere",
"browse.area_radius": "Within {{km}} km",
"card.metric_km": "{{km}} km",
"card.metric_m": "{{m}} m",
"card.metric_today": "Today",
"card.metric_days_ago": "{{count}}d ago",
"match.explain_basis_profile": "Matches your profile",
"match.explain_basis_search": "Matches your search",
"match.explain_fields_heading": "Fields that feed this relevance",
"match.explain_weight": "Weight {{weight}}",
"match.explain_illustrative": "Shown for illustration. The model produces one combined score, so we can't say how much each field contributed.",
"match.explain_set_heading": "Also narrowing these results"
```

Translate for `hi` and `kn`. **Do not leave English placeholders** — an untranslated key is worse than a missing one because it never gets caught.

- [ ] **Step 2: Verify no key is missing from any locale**

```bash
node -e "
const en=require('./apps/ui/src/i18n/locales/en.json');
for (const l of ['hi','kn']) {
  const o=require('./apps/ui/src/i18n/locales/'+l+'.json');
  const flat=(x,p='')=>Object.entries(x).flatMap(([k,v])=>typeof v==='object'&&v?flat(v,p+k+'.'):[p+k]);
  const missing=flat(en).filter(k=>!flat(o).includes(k));
  console.log(l, missing.length?('MISSING: '+missing.join(', ')):'complete');
}"
```
Expected: `hi complete`, `kn complete`.

- [ ] **Step 3: Full verification — run it, do not assume it**

```bash
pnpm typecheck
pnpm --filter ui test -- --pool=forks --maxWorkers=2
pnpm --filter api test -- --pool=forks --maxWorkers=2
pnpm --filter @dpg/match_score test -- --pool=forks --maxWorkers=2
```

Then confirm the deletions are complete:

```bash
grep -rn "sortItemsByNearest\|DomainPagedFetch\|MapFiltersPanel\|getMatchScoreBand\|getScoreStyles\|PERCENTAGE_TO_SCORE_DIVISOR" apps/ui/src packages
```
Expected: **no output.**

- [ ] **Step 4: Manual check in a browser**

Run the app (`/run-signals-dpg` or `pnpm dev:ui`) and verify:
1. Signed in with a profile location, the list shows items **beyond 30 km** — the bug is fixed.
2. Switching sort changes both the order **and** the card pill.
3. Scroll far down: the toolbar stays, so the basis stays explained.
4. Resize to **320px**: the toolbar sits flush under a two-line app bar (spec §7.3), no gap or overlap.
5. On the map, there is **no** sort control; multi-select works; going back to list collapses to one domain with no notice.
6. `hi` and `kn` render without truncation.

- [ ] **Step 5: Commit and open the DRAFT PR**

```bash
git add apps/ui/src/i18n
git commit -m "i18n(ui): copy for the browse toolbar, card metric and relevance explanation in en, hi and kn"
git push -u origin feat/644-list-view-sort-filters
gh pr create --draft --base feature \
  --title "feat: list view pages the whole network with an explicit sort, one domain control, and a card metric that matches the order" \
  --body "..."
```

**PR body must contain** (describe WHAT changed — never "review fixes"):

1. **What changed**, in the three movements: fetch contract, filter surface, card metric.
2. **Closes #644, #645, #646.**
3. **Deviations from the issues as written** — required, or a reviewer sees unticked boxes and assumes something was missed:
   - **#644:** `viewport` area mode skipped. signals-search has no bbox operator, so a map rectangle would be approximated by its circumscribed circle and the list would include items off the edges of the map. `radius` serves the need.
   - **#644/#645:** the All tab is **removed** rather than kept as a client-merged union. Cosine is not comparable across domains, so no correct merge order existed; removing the tab deletes the question and the mixed-domain confusion, and takes P6 with it.
   - **#646:** `VITE_FREETEXT_MATCH_SCORE_ENABLED` is **kept**, not retired. It encodes a real per-deployment choice; labelling the badge removes the ambiguity the flag was working around.
4. **Depends on** the signals-search PR for `intent.sort` — note that this PR's client schema treats `meta.sort_applied` as **optional**, so the two can merge in either order without an outage, but full sort behaviour needs both deployed.
5. **Migration note:** the match-score localStorage prefix moves to `v2` and `v1` entries are swept at startup. Cached scores are recomputed once.
6. Real `pnpm typecheck` / test output.

---

## Self-Review

**Spec coverage** — the UI half of spec §6:

| Spec item | Task |
| --- | --- |
| Remove All tab; delete `sortItemsByNearest` (D8, P6) | 1 |
| Default domain (D19) + silent collapse (D27) | 1, 7 |
| Rename to `BrowseFiltersPanel`, 3 consumers (§4.4) | 2 |
| One domain control, single/multi (D10, D11) | 3, 7 |
| Unavailable domains explained (D7, §4.3) | 3, 7 |
| Chip bar + clear-all + a11y (§4.1, §4.6) | 4 |
| Search chip clears the app-bar box (D25) | 7 |
| Sort selector, list only (D26, §4.5) | 5, 6 |
| Area selector, `anywhere` default (§3.1) | 5 |
| Sticky toolbar + the flex-wrap offset trap (D23, §7.2, §7.3) | 6 |
| Map fan-out driven by selection (D12) | 8 |
| One 0–100 scale; cache `v2` + sweep (§5.2) | 9 |
| Metric follows the sort; icon-only pill (D18, D22, §5.1) | 10 |
| Free-text flag kept (D15) | 10 |
| Map popup consistency (§5.1) | 10 |
| Dead LLM fields + bands deleted (§5.5) | 10, 11 |
| Explanation panel + honesty constraint (D20, §5.4) | 12 |
| i18n in en/hi/kn (§6) | 13 |

**Placeholder scan:** Tasks 5, 12 and part of 10 carry component skeletons with the props, contracts, invariants and full test suites specified, but not every line of JSX — the layout is approved in spec §7 and the markup follows `BrowseFiltersPanel`'s existing `Popover` + `MultiSelectGroup` pattern, which the plan names. This is deliberate: writing speculative pixel-level JSX would be false precision. Every behavioural requirement is pinned by a test.

**Type consistency:** `BrowseSort` / `BrowseArea` / `DEFAULT_BROWSE_AREA` come from `browse-discover.ts` (API plan Task 5) and are imported, never redeclared. `AppliedChip.kind` values (`domain|facet|search|sort|area`) are identical in Task 4's component, Task 7's builder and Task 7's removal switch. `DomainOption` is declared in Task 3 and built in Task 7. `CardMetric` is declared in Task 10 and consumed by the badge and the map popup. `sortApplied` is the same name in the hook (API plan Task 6), `SortSelectProps`, `resolveCardMetric` and `RelevanceExplanationProps`. `sweepLegacyMatchScoreCache` is defined in Task 9 and called once at startup in the same task.
