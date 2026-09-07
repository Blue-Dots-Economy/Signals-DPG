import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { DrawerTitle } from '@/components/ui/drawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { DotNetworkDomain, ViewMode } from '@/engine/types';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import type { EnumFilterField } from '@/lib/enum-filters';
import { MultiSelectGroup, CHIP_THRESHOLD } from '@/components/filters/multi-select-group';

/**
 * The facet editor for BOTH browse views.
 *
 * Renamed from `MapFiltersPanel` and moved out of `components/map/` (#645):
 * it has served the list view as well since #394, so the old name and location
 * misdescribed it to every reader. It is the EDITOR — the applied-filter chip
 * bar is the read-out (spec §7.1), and the two must not both try to own the
 * state.
 */
export interface BrowseFiltersPanelProps {
  /** All visible domains (from the network config) to show as filter options. */
  domains: DotNetworkDomain[];
  /**
   * Domains whose schema fields drive the enum filter groups. Defaults to
   * `domains`. Supplied separately so the enum filters can reflect the
   * counterpart being selected (e.g. a provider browsing seekers filters by
   * seeker fields) while the domain chip selector still lists every visible
   * domain.
   */
  filterFieldDomains?: DotNetworkDomain[];
  /**
   * Currently selected enum-field filter values.
   * Map of fieldKey → selected option values. Empty array = all.
   */
  selectedFields: Record<string, string[]>;
  /** Called when any enum field filter selection changes. */
  onFieldsChange: (fields: Record<string, string[]>) => void;
  /** Current browse view — tailors the help text (map markers vs listings). */
  viewMode?: ViewMode;
  /**
   * Where the trigger is mounted, which decides its chrome.
   *
   * `'toolbar'` (default) matches the Sort and Location pills it now sits
   * beside — same radius, border and padding, no shadow. `'overlay'` keeps the
   * raised, blurred chip the map needs, since there it floats over tiles
   * rather than sitting in a row.
   */
  trigger?: 'toolbar' | 'overlay';
}

// ─── Chip toggle button ────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  title?: string;
  ariaLabel?: string;
}

function Chip({ label, selected, onToggle, title, ariaLabel }: Readonly<ChipProps>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={ariaLabel ?? label}
      aria-pressed={selected}
      className={cn(
        'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-xs font-medium leading-none transition-all duration-150',
        'pointer-coarse:min-h-11',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        selected
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-muted text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {label}
    </button>
  );
}

// ─── Filter group (always expanded, chip-based) ───────────────────────────────

interface FilterGroupProps {
  title: string;
  children: React.ReactNode;
}

function FilterGroup({ title, children }: Readonly<FilterGroupProps>) {
  return (
    <div className="space-y-2">
      <span className="block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </span>
      <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2">{children}</div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

/**
 * A "Filters" pill button that opens a polished popover with chip-based filter
 * groups:
 *   1. Domain  — multi-select chips, one per visible domain.
 *   2+. Schema enum fields — one chip group per enum / array-of-enum property
 *       found in the visible domains' item schemas (derived generically).
 *
 * Groups with no options are hidden. All groups are always-expanded since chips
 * are compact. The panel scrolls when content exceeds max-height.
 *
 * Active-filter count is shown as a badge on the trigger pill.  A "Clear all"
 * link in the header resets all groups. An X button closes the popover.
 */
export function BrowseFiltersPanel({
  domains,
  filterFieldDomains,
  selectedFields,
  onFieldsChange,
  viewMode = 'map',
  trigger = 'toolbar',
}: Readonly<BrowseFiltersPanelProps>) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);

  // Derive enum filter fields generically from the filter-field domains
  // (defaults to the visible domains) so the filters can reflect the
  // counterpart being browsed independently of the domain chip selector.
  //
  // #394: the MAP and the LIST now offer the SAME full set of declared,
  // non-private enum fields (restoring pre-Map-PR behavior) — the server's
  // facet guard (`resolveAllowedFacetFields`) applies every one of them, not
  // just a `filterable: true`-marked subset (that marker has been removed;
  // see #360 for the proper long-term schema-driven declaration).
  const enumFilterFields: EnumFilterField[] = React.useMemo(
    () => getEnumFilterFieldsForDomains(filterFieldDomains ?? domains),
    [filterFieldDomains, domains],
  );

  const showEnumGroups = enumFilterFields.length > 0;

  // Count of active selections across all enum fields
  const enumActiveCount = Object.values(selectedFields).reduce(
    (sum, vals) => sum + vals.length,
    0,
  );

  // Facets ONLY. Domain used to be counted here, which made a single facet
  // read as "2" on the trigger badge — domain moved out to the toolbar's
  // DomainControl (#645 D10) and is no longer one of this panel's groups.
  const activeCount = enumActiveCount;

  const handleClearAll = () => {
    onFieldsChange({});
  };

  const toggleEnumValue = (fieldKey: string, value: string) => {
    const current = selectedFields[fieldKey] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    const updated = { ...selectedFields };
    if (next.length === 0) {
      delete updated[fieldKey];
    } else {
      updated[fieldKey] = next;
    }
    onFieldsChange(updated);
  };

  // Nothing to filter — don't render the pill at all. Facets are now the only
  // group (domain moved to the toolbar's DomainControl), so this is the sole
  // condition.
  if (!showEnumGroups) return null;

  const renderTrigger = (onClick?: () => void) => (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className={cn(
        'gap-1.5 text-xs',
        // Toolbar: identical chrome to the Sort and Location pills beside it.
        // The raised/blurred treatment below was for floating over map tiles
        // and read as a different KIND of control once it joined the row.
        trigger === 'toolbar'
          ? 'h-auto rounded-lg border-border bg-background px-2.5 py-1.5 font-semibold shadow-none'
        // Square on touch like the icon-only Sort and Location beside it —
        // three icon buttons in a row that are not the same size read as a
        // mistake. Released from `sm` up, where all three show their text.
        + ' pointer-coarse:min-h-11 pointer-coarse:min-w-11 sm:pointer-coarse:min-w-0'
          : 'h-8 border-input bg-background/95 shadow-md backdrop-blur-sm',
        activeCount > 0 && 'border-primary/50 bg-primary/5',
      )}
      aria-label={t('filters.open')}
    >
      <SlidersHorizontal className="size-3.5" />
      {/* Icon-only below sm so the mobile top bar's control row fits on one
          line (the button keeps its aria-label for accessibility); the label
          returns from sm up. */}
      <span className="hidden sm:inline">{t('filters.title')}</span>
      {activeCount > 0 && (
        <Badge
          variant="default"
          className="size-4 rounded-full p-0 text-[10px] leading-none"
          aria-label={t('filters.selected', { count: activeCount })}
        >
          {activeCount}
        </Badge>
      )}
    </Button>
  );

  // ── Header + scrollable groups — shared between the desktop popover and the
  // mobile bottom sheet; only the surrounding chrome (Popover vs Drawer) differs.
  const panelBody = (
    <>
      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl border-b border-border bg-popover px-4 py-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('filters.title')}
        </span>
        <div className="flex items-center gap-2 pointer-coarse:gap-4">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('filters.clear_all')}
            >
              {t('filters.clear_all')}
            </button>
          )}
          {/* X close button */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full',
              'bg-muted text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              // Transparent, centered hit-area expansion for touch — mirrors the
              // Button variant technique so the visual size-5 circle is unchanged.
              "pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']",
            )}
            aria-label={t('filters.close')}
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* ── Scrollable filter groups ────────────────────────────────────────── */}
      <div className="max-h-[75dvh] space-y-5 overflow-y-auto px-4 py-4">
        {enumFilterFields.map((field) => {
          const fieldSelected = selectedFields[field.key] ?? [];

          // Many options → compact searchable dropdown; few → inline chips.
          if (field.options.length > CHIP_THRESHOLD) {
            return (
              <MultiSelectGroup
                key={field.key}
                title={field.label}
                options={field.options}
                selected={fieldSelected}
                onToggle={(value) => toggleEnumValue(field.key, value)}
              />
            );
          }

          return (
            <FilterGroup key={field.key} title={field.label}>
              {field.options.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  selected={fieldSelected.includes(option)}
                  onToggle={() => toggleEnumValue(field.key, option)}
                  ariaLabel={`Filter by ${field.label}: ${option}`}
                />
              ))}
            </FilterGroup>
          );
        })}

        {activeCount === 0 && (
          <p className="text-[10px] text-muted-foreground">
            {t(viewMode === 'list' ? 'filters.help_list' : 'filters.help')}
          </p>
        )}
      </div>
    </>
  );

  // Mobile: the pill opens a bottom sheet (ResponsiveDialog renders a Drawer)
  // instead of a popover — same header/groups markup, different chrome.
  if (isMobile) {
    return (
      <>
        {renderTrigger(() => setOpen(true))}
        {/* The panel's own sticky header already has an X (below, in panelBody)
            — suppress ResponsiveDialog's own close button so mobile doesn't
            show two overlapping "Close" controls. */}
        <ResponsiveDialog
          open={open}
          onOpenChange={setOpen}
          contentClassName="p-0"
          showCloseButton={false}
        >
          {/* Radix's underlying Dialog requires an accessible name; the visible
              "Filters" label lives in the panel's own sticky header (a plain
              <span>, not a Dialog primitive), so give the sheet itself a
              visually-hidden title rather than duplicating visible text. */}
          <DrawerTitle className="sr-only">{t('filters.title')}</DrawerTitle>
          {panelBody}
        </ResponsiveDialog>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 rounded-xl border border-border bg-popover p-0 shadow-lg"
        // Must sit above the maximized map wrapper (z-[2000]) so the dropdown is
        // visible/clickable in maximized mode, and above normal overlays otherwise.
        style={{ zIndex: 2100 }}
      >
        {panelBody}
      </PopoverContent>
    </Popover>
  );
}
