import * as React from 'react';
import { RefreshCw, AlertCircle, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { formatScorePercentage } from '@/utils/match-score-cache';

export interface MatchScoreModalProps {
  isOpen: boolean;
  onClose: () => void;
  score: MatchScoreResult | null;
  isLoading: boolean;
  localItemName: string;
  networkItemName: string;
  onRecalculate: () => void;
  onProceed?: () => void;
  /**
   * #646 C4: the "why this result, in this position" panel. Optional so the
   * modal still works where the caller has no schema/sort context to build it
   * from (a public profile, My Actions).
   */
  explanation?: React.ReactNode;
}

export function MatchScoreModal({
  isOpen,
  onClose,
  score,
  isLoading,
  localItemName,
  networkItemName,
  onRecalculate,
  onProceed,
  explanation,
}: MatchScoreModalProps) {
  const { t } = useTranslation();
  const scoreValue = score?.score ?? 0;
  const [progressValue, setProgressValue] = React.useState(0);

  // Animate progress bar when score changes
  React.useEffect(() => {
    if (score?.score !== undefined && !isLoading) {
      // #646 §5.2: scores are 0-100 end to end now, so the percent IS the
      // score. The previous /10 normalization existed because the provider
      // divided by 10 on the way in.
      const targetValue = Math.round(score.score);
      const duration = 600;
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out function
        const easeOut = 1 - Math.pow(1 - progress, 3);
        setProgressValue(Math.round(targetValue * easeOut));

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    }
  }, [score?.score, isLoading]);

  return (
    <ResponsiveDialog
      open={isOpen}
      onOpenChange={onClose}
      title={t('match.modal_title')}
      contentClassName="sm:max-w-lg max-h-[90dvh] overflow-hidden p-0"
    >
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <span>{t('match.modal_title')}</span>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90dvh-180px)]">
          <div className="px-6 py-4 space-y-6">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground animate-pulse">
                  {t('match.calculating')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('match.comparing', { localName: localItemName, networkName: networkItemName })}
                </p>
              </div>
            ) : score ? (
              <>
                {/* Score Header */}
                <div className="text-center space-y-4">
                  {/* #646 §5.5: one neutral treatment. The colour used to come
                      from an Excellent/Good/Moderate/Low band whose
                      0.85/0.70/0.50 thresholds implied a calibration BGE-M3
                      similarities do not have — the band read as near-constant
                      across a result set, so colouring by it told the user
                      nothing while looking authoritative. */}
                  <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary text-primary-foreground">
                    <Star className="h-10 w-10 fill-current" />
                  </div>

                  <div>
                    <div className="text-4xl font-bold tracking-tight">
                      {formatScorePercentage(scoreValue)}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full max-w-xs mx-auto space-y-2">
                    <Progress
                      value={progressValue}
                      className="h-2"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>0%</span>
                      <span>50%</span>
                      <span>100%</span>
                    </div>
                  </div>

                </div>

                {explanation}

                {/* #646 §5.5: the Matching Factors and AI Reasoning panels
                    are gone. They rendered `score.signals` and
                    `score.reasoning`, dpg-scoring-era fields the
                    signals_search provider never populates — so the modal
                    advertised explanations that were always absent. The
                    relevance explanation below replaces them with something
                    derivable from the schema. */}
              </>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t('match.no_score')}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onRecalculate}
            disabled={isLoading}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            {t('match.btn_recalculate')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('match.btn_close')}
            </Button>
            {onProceed && (
              <Button size="sm" onClick={onProceed}>
                {t('match.btn_proceed')}
              </Button>
            )}
          </div>
        </div>
    </ResponsiveDialog>
  );
}
