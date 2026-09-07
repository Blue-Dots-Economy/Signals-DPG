import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotActionSchema, DotCardConfig } from '@/engine/types';
import { DomainCard } from '@/components/cards/domain-card';
import { MatchScoreModal } from './match-score-modal';
import { useMatchScore } from '@/hooks/use-match-score';
import type { Item } from '@/lib/item-api';
import type { BrowseSort } from '@/lib/browse-discover';

export interface MatchScoreCardProps {
  schema: RJSFSchema;
  schemaName?: string;
  schemaDescription?: string;
  domainLabel?: string;
  cardConfig?: DotCardConfig | null;
  data: Record<string, unknown>;
  actions?: DotActionSchema[];
  onAction?: (type: string, schema: DotActionSchema) => void;
  loading?: boolean;
  onClick?: () => void;
  localItem: Item | null;
  networkItem: Item;
  selectionMode?: boolean;
  /** Disable the action CTA — an open action already exists for this pair (#370/#422). */
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
  /** #646 C1: decides which quantity the card's pill shows. */
  sortApplied?: BrowseSort;
  relevanceBasis?: 'profile' | 'search' | null;
}

export function MatchScoreCard({
  schema,
  schemaName,
  schemaDescription,
  domainLabel,
  cardConfig,
  data,
  actions = [],
  onAction,
  loading = false,
  onClick,
  localItem,
  networkItem,
  selectionMode = false,
  actionsDisabled = false,
  actionsDisabledReason,
  sortApplied,
  relevanceBasis,
}: Readonly<MatchScoreCardProps>) {
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  
  const {
    score,
    isLoading: matchScoreLoading,
    error: matchScoreError,
    calculate,
    recalculate,
  } = useMatchScore({
    localItem,
    networkItem,
  });

  const handleCalculate = React.useCallback(() => {
    // Open the details modal on the same click that starts the calculation, so
    // the list matches the map's one-click flow: the modal shows its loading
    // state, then the full score + factors. Closing it collapses back to the
    // score badge (rendered by MatchScoreButton once a score exists), which
    // reopens the modal via handleViewDetails.
    calculate();
    setIsModalOpen(true);
  }, [calculate]);

  const handleViewDetails = React.useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const handleCloseModal = React.useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleRecalculate = React.useCallback(() => {
    recalculate();
  }, [recalculate]);

  const handleProceed = React.useCallback(() => {
    setIsModalOpen(false);
    // Blocked while an open action exists for the pair (#370/#422).
    if (actionsDisabled) return;
    // Trigger the first action if available
    if (actions.length > 0 && onAction) {
      onAction(actions[0].action_type, actions[0]);
    }
  }, [actions, onAction, actionsDisabled]);

  // Get title for items
  const titleKey = findTitleField(schema);
  const localItemName = localItem 
    ? (localItem.item_state[titleKey ?? 'name'] as string) ?? 'Your Profile'
    : 'Your Profile';
  const networkItemName = (data[titleKey ?? 'name'] as string) ?? 'Target Profile';

  return (
    <>
      <DomainCard
        schema={schema}
        schemaName={schemaName}
        schemaDescription={schemaDescription}
        domainLabel={domainLabel}
        cardConfig={cardConfig}
        data={data}
        actions={actions}
        onAction={onAction}
        loading={loading}
        onClick={onClick}
        localItem={localItem}
        networkItem={networkItem}
        shareItem={networkItem}
        selectionMode={selectionMode}
        actionsDisabled={actionsDisabled}
        actionsDisabledReason={actionsDisabledReason}
        matchScore={score}
        sortApplied={sortApplied}
        relevanceBasis={relevanceBasis}
        matchScoreLoading={matchScoreLoading}
        matchScoreError={matchScoreError}
        onCalculateMatch={handleCalculate}
        onViewMatchDetails={handleViewDetails}
      />
      <MatchScoreModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        score={score}
        isLoading={matchScoreLoading}
        localItemName={localItemName}
        networkItemName={networkItemName}
        onRecalculate={handleRecalculate}
        onProceed={handleProceed}
      />
    </>
  );
}

function findTitleField(schema: RJSFSchema): string | null {
  if (!schema.properties) return null;
  const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
  for (const key of candidates) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}
