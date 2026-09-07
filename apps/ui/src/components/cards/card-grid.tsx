import type React from 'react';
import type { BrowseSort } from '@/lib/browse-discover';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, DotCardConfig } from '@/engine/types';
import { DomainCard } from './domain-card';
import { MatchScoreCard } from '@/components/match-score';
import { EmptyState } from '@/components/empty-state';
import type { Item } from '@/lib/item-api';
import { shouldRenderMatchScoreCard } from '@/lib/match-score-config';
import { SelectableCard } from '@/components/selection/selectable-card';
import { useEqualRowHeights } from '@/hooks/use-equal-row-heights';

interface CardGridProps {
  schema: RJSFSchema;
  schemaName?: string;
  schemaDescription?: string;
  cardConfig?: DotCardConfig | null;
  items: Array<{ id: string; data: Record<string, unknown> }>;
  fullItems?: Item[];
  actions?: DotActionSchema[];
  onAction?: (itemId: string, type: string, schema: DotActionSchema) => void;
  onItemClick?: (itemId: string) => void;
  loading?: boolean;
  emptyMessage?: string;
  emptyState?: React.ReactNode;
  // Match score props
  localItem?: Item | null;
  networkId?: string;
  selectedDomain?: string | null;
  /**
   * Item ids the active profile already has an OPEN action with (either
   * direction). Their CTA is disabled — one open action per pair (#370/#422).
   */
  openActionItemIds?: Set<string>;
  openActionReason?: string;
  /**
   * #646 C1: the sort the SERVER applied. Threaded down so each card's pill
   * shows the quantity that actually drove its position, rather than a cosine
   * score badged onto a distance- or date-ordered list.
   */
  sortApplied?: BrowseSort;
  relevanceBasis?: 'profile' | 'search' | null;
  /** Selection mode passthrough (browse bulk connect). */
  selection?: {
    selectMode: boolean;
    isSelected: (id: string) => boolean;
    canSelect: (groupKey?: string) => boolean;
    toggle: (id: string, groupKey?: string) => void;
  };
}

export function CardGrid({
  schema,
  schemaName,
  schemaDescription,
  cardConfig,
  items,
  fullItems = [],
  actions = [],
  onAction,
  onItemClick,
  loading = false,
  emptyMessage = 'No items found',
  emptyState,
  localItem,
  networkId = '',
  selectedDomain,
  openActionItemIds,
  openActionReason,
  selection,
  sortApplied,
  relevanceBasis,
}: Readonly<CardGridProps>) {
  const gridRef = useEqualRowHeights<HTMLDivElement>();

  if (loading) {
    return (
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <DomainCard
            key={i}
            schema={schema}
            data={{}}
            loading
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return emptyState ? <>{emptyState}</> : <EmptyState message={emptyMessage} />;
  }

  return (
    <div ref={gridRef} className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        // Find the full Item object if available
        const fullItem = fullItems.find((i) => i.item_id === item.id);

        // Create a fallback item if full item not available
        const networkItem = fullItem || {
          item_id: item.id,
          item_network: networkId,
          item_domain: selectedDomain || '',
          item_type: 'profile',
          item_instance_url: null,
          item_schema_url: null,
          item_state: item.data,
          item_locations: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const actionsDisabled = openActionItemIds?.has(item.id) ?? false;

        const cardElement =
          shouldRenderMatchScoreCard(localItem, networkItem) ? (
            <MatchScoreCard
              schema={schema}
              schemaName={schemaName}
              schemaDescription={schemaDescription}
              cardConfig={cardConfig}
              data={item.data}
              actions={actions}
              selectionMode={selection?.selectMode ?? false}
              onAction={(type, actionSchema) => onAction?.(item.id, type, actionSchema)}
              onClick={() => onItemClick?.(item.id)}
              localItem={localItem ?? null}
              networkItem={networkItem}
              actionsDisabled={actionsDisabled}
              actionsDisabledReason={openActionReason}
              sortApplied={sortApplied}
              relevanceBasis={relevanceBasis}
            />
          ) : (
            <DomainCard
              schema={schema}
              schemaName={schemaName}
              schemaDescription={schemaDescription}
              cardConfig={cardConfig}
              data={item.data}
              actions={actions}
              selectionMode={selection?.selectMode ?? false}
              onAction={(type, actionSchema) => onAction?.(item.id, type, actionSchema)}
              onClick={() => onItemClick?.(item.id)}
              shareItem={networkItem}
              actionsDisabled={actionsDisabled}
              actionsDisabledReason={openActionReason}
              // #646 C1: this is the branch a viewer WITHOUT a profile gets.
              // It still needs the sort, so a distance or an age can render —
              // neither is a match score, so neither should require an account.
              networkItem={networkItem}
              localItem={localItem ?? null}
              sortApplied={sortApplied}
              relevanceBasis={relevanceBasis}
            />
          );

        return (
          <SelectableCard
            key={item.id}
            id={item.id}
            selectMode={selection?.selectMode ?? false}
            selected={selection?.isSelected(item.id) ?? false}
            // Not selectable in bulk mode if an action is already open for this
            // pair — same one-open-per-pair rule as the CTA (#370/#422); the card
            // dims and shows no checkbox.
            selectable={(selection?.canSelect(selectedDomain ?? '') ?? true) && !actionsDisabled}
            onToggle={(id) => selection?.toggle(id, selectedDomain ?? '')}
          >
            {cardElement}
          </SelectableCard>
        );
      })}
    </div>
  );
}
