import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { MatchScoreBadge } from './match-score-badge';
import type { CardMetric } from '@/lib/metric-display';

export interface MatchScoreButtonProps {
  localItem: Item | null;
  networkItem: Item;
  score: MatchScoreResult | null;
  /**
   * The card's ranking basis (#646 C1), resolved by the caller from the sort
   * the SERVER applied. Null when nothing determined this card's position —
   * the calculate CTA then shows instead.
   *
   * OMIT it outside a sorted list (the detail modal trigger, a public profile,
   * My Actions): there is no sort there, so the only meaningful metric is the
   * profile relevance score, and that is what the default below uses. Passing
   * it explicitly is required only on the browse list, where the sort decides.
   */
  metric?: CardMetric;
  /** Which quantity `relevance` means; only used for the tooltip. */
  basis?: 'profile' | 'search' | null;
  isLoading: boolean;
  error: Error | null;
  onCalculate: () => void;
  onViewDetails?: () => void;
  disabled?: boolean;
}

export function MatchScoreButton({
  localItem,
  score,
  metric,
  basis,
  isLoading,
  error,
  onCalculate,
  onViewDetails,
  disabled = false,
}: MatchScoreButtonProps) {
  const { t } = useTranslation();
  // #646 C1: the pill shows the RANKING BASIS, resolved by the caller from
  // the sort the server applied — so under `nearest`/`newest` it is a distance
  // or an age rather than a score badged onto a differently-ordered list.
  // `undefined` means the caller had no sort context (a share preview, a
  // public profile), so fall back to the profile relevance score. An explicit
  // `null` means the caller HAS a sort and it produced no metric — respect it.
  let effectiveMetric: CardMetric = metric ?? null;
  if (metric === undefined && score?.score != null) {
    effectiveMetric = { kind: 'relevance', percent: score.score };
  }

  if (effectiveMetric && !error) {
    // Only a RELEVANCE pill opens the score modal. Under `newest`/`nearest`
    // the pill is an age or a distance, and that modal explains a cosine
    // score — so clicking a "Today" pill opened "Match Score Details" and,
    // with no score computed, an empty "No match score available" dialog.
    // Passing no handler also makes the badge render as plain text, so it
    // stops advertising "Tap for details" for a metric that has none.
    const opensDetails = effectiveMetric.kind === 'relevance';
    return (
      <MatchScoreBadge
        metric={effectiveMetric}
        basis={basis ?? 'profile'}
        onClick={opensDetails ? onViewDetails : undefined}
      />
    );
  }

  // If there was an error, show error state
  if (error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCalculate}
              className="gap-1.5 text-muted-foreground hover:text-destructive"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="text-xs">{t('match.btn_unable')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="max-w-xs text-xs">
              {t('match.tooltip_retry')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="gap-1.5 min-w-0"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="truncate">{t('match.calculating_short')}</span>
      </Button>
    );
  }

  // Default state - calculate button
  const isDisabled = disabled || !localItem;
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onCalculate}
            disabled={isDisabled}
            className="gap-1.5 min-w-0 max-w-full"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('match.btn_see_score')}</span>
          </Button>
        </TooltipTrigger>
        {isDisabled && (
          <TooltipContent side="top">
            <p className="max-w-xs text-xs">
                {!localItem
                ? t('match.tooltip_need_profile')
                : t('match.tooltip_need_signin')
              }
            </p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
