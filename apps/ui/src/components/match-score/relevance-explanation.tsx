import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { readFieldValue } from '@/lib/vectorize-fields';
import type { VectorizeField } from '@/lib/vectorize-fields';
import type { CardMetric } from '@/lib/metric-display';

export interface RelevanceExplanationProps {
  /** The metric that drove this card's position, already resolved. */
  metric: CardMetric;
  /** Formatted metric value, e.g. "62%", "4.2 km", "5d ago". */
  metricLabel: string | null;
  /** Which quantity `relevance` means, when that is the metric. */
  basis: 'profile' | 'search' | null;
  /** `vectorize: true` fields of the browsed domain's schema, with weights. */
  vectorizeFields: VectorizeField[];
  /** The viewer's own profile state, for the side-by-side comparison. */
  viewerState?: Record<string, unknown>;
  /** The browsed item's public state. */
  itemState?: Record<string, unknown>;
  /** Constraints that shaped the SET but not the order — domain, facets, area. */
  setConstraints: string[];
}

/**
 * "Why this result, in this position" (#646 C4).
 *
 * HONESTY CONSTRAINT — the hard rule of this component. The cosine score is
 * computed over a SINGLE POOLED EMBEDDING of the serialized `vectorize` fields
 * (`serializeItemText` repeats each line `vector_weight` times), so it
 * **cannot be decomposed into per-field contributions**. That number does not
 * exist.
 *
 * So this panel may show WHICH fields feed relevance, their weights, and the
 * viewer's values beside the item's — but the overlap is computed by comparing
 * attributes, NOT derived from the score, and is labelled illustrative. Never
 * render a per-field percentage or a contribution bar: inventing one would
 * fabricate a number users would reasonably trust.
 *
 * Constraints that shaped the SET (domain, facets, area) are shown separately,
 * because they decide membership rather than position — conflating the two is
 * most of what made the old badge feel arbitrary.
 */
export function RelevanceExplanation({
  metric,
  metricLabel,
  basis,
  vectorizeFields,
  viewerState,
  itemState,
  setConstraints,
}: Readonly<RelevanceExplanationProps>) {
  const { t } = useTranslation();

  // One label per metric kind. Written as a switch rather than a ternary chain
  // because the relevance arm itself branches on the basis, and nesting that
  // made the whole thing unreadable (Sonar S3358).
  const sortLabel = ((): string | null => {
    switch (metric?.kind) {
      case 'relevance':
        return basis === 'search'
          ? t('browse.sort_relevance_search')
          : t('browse.sort_relevance_profile');
      case 'distance':
        return t('browse.sort_nearest');
      case 'age':
        return t('browse.sort_newest');
      default:
        return null;
    }
  })();

  // The vectorized-field table explains a COSINE score. Under `nearest` or
  // `newest` nothing about those fields determined the position, so showing
  // them would imply a relevance basis the list did not use.
  const showFields = metric?.kind === 'relevance' && vectorizeFields.length > 0;

  return (
    <div className="space-y-4" data-testid="relevance-explanation">
      {sortLabel && (
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-semibold">{t('match.explain_position_heading')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {sortLabel}
            {metricLabel ? ` · ${metricLabel}` : ''}
          </p>
        </div>
      )}

      {showFields && (
        <div className="rounded-lg border p-3">
          <h3 className="text-sm font-semibold">{t('match.explain_fields_heading')}</h3>
          <div className="mt-2 divide-y divide-border">
            {vectorizeFields.map((field) => (
              <div key={field.name} data-testid="vectorize-field" className="py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{field.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('match.explain_weight', { weight: field.weight })}
                  </span>
                </div>
                <dl className="mt-1 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t('match.explain_yours')}</dt>
                    <dd>{readFieldValue(viewerState, field.name) ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('match.explain_theirs')}</dt>
                    <dd>{readFieldValue(itemState, field.name) ?? '—'}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          {/* Load-bearing, not boilerplate: see the honesty constraint above. */}
          <p
            data-testid="illustrative-note"
            className="mt-3 flex gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('match.explain_illustrative')}
          </p>
        </div>
      )}

      {setConstraints.length > 0 && (
        <div className="rounded-lg border p-3" data-testid="set-constraints">
          <h3 className="text-sm font-semibold">{t('match.explain_set_heading')}</h3>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {setConstraints.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
