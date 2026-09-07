import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Check, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Option-count above which an enum filter field renders as a compact,
 * collapsible, searchable dropdown instead of an inline list/chips. Shared by
 * the map/list filter panel (`browse-filters-panel.tsx`) and the My Actions
 * filters sheet (`action-filters-sheet.tsx`) so both treat "large" fields the
 * same way and stay compact.
 */
export const CHIP_THRESHOLD = 8;

export interface MultiSelectGroupProps {
  title: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}

/**
 * A collapsible group with a search box and a scrollable checklist. Used for
 * enum filter fields with many options (> `CHIP_THRESHOLD`) so a long option
 * list doesn't blow out the filter panel's height.
 */
export function MultiSelectGroup({ title, options, selected, onToggle }: Readonly<MultiSelectGroupProps>) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const count = selected.length;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none"
      >
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {count > 0 ? t('filters.selected', { count }) : t('filters.any')}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filters.search_placeholder', { field: title.toLowerCase() })}
              className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
              aria-label={t('filters.search_placeholder', { field: title })}
            />
          </div>
          <div className="max-h-44 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('filters.no_matches')}</p>
            ) : (
              filtered.map((option) => {
                const isSelected = selected.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onToggle(option)}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                      )}
                    >
                      {isSelected && <Check className="size-2.5" />}
                    </span>
                    <span className="truncate">{option}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
