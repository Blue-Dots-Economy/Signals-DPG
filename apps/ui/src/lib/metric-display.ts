import type { TFunction } from 'i18next';
import type { BrowseSort } from '@/lib/browse-discover';

export type CardMetric =
  | { kind: 'relevance'; percent: number }
  | { kind: 'distance'; meters: number }
  | { kind: 'age'; createdAt: Date }
  | null;

/**
 * The card metric IS the ranking basis (#646 C1).
 *
 * Users conflated the list's ORDER with the number on each card. They look
 * like they should agree, and under an explicit sort they visibly would not —
 * an item would be ordered by one quantity (distance, or date) and badged with
 * another (cosine similarity), permanently and on every card.
 *
 * So the metric shown is always whatever drove the position, and it is NEVER
 * shown when it did not determine the order.
 *
 * Keyed off the sort the SERVER applied, never the requested one: a
 * `relevance` request with neither an anchor nor typed text degrades to
 * `newest` server-side, and reading the request would badge a percentage onto
 * a date-ordered list.
 */
export function resolveCardMetric(input: {
  sortApplied: BrowseSort | undefined;
  score?: number | null;
  distanceMeters?: number | null;
  createdAt?: Date | null;
  /**
   * `VITE_FREETEXT_MATCH_SCORE_ENABLED` — kept as a real per-deployment
   * product choice (spec D15): does this instance show a score for free-text
   * matches, or only for profile matches?
   */
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
      return input.distanceMeters == null
        ? null
        : { kind: 'distance', meters: input.distanceMeters };
    case 'newest':
      return input.createdAt == null ? null : { kind: 'age', createdAt: input.createdAt };
    default:
      // No reported sort (e.g. before the first response) — show nothing
      // rather than guess at a basis.
      return null;
  }
}

/** Renders a `CardMetric` as the short string the pill displays. */
export function formatCardMetric(metric: CardMetric, t: TFunction): string | null {
  if (!metric) return null;
  switch (metric.kind) {
    case 'relevance':
      return `${Math.round(metric.percent)}%`;
    case 'distance':
      return metric.meters >= 1000
        ? t('card.metric_km', { km: (metric.meters / 1000).toFixed(1) })
        : t('card.metric_m', { m: Math.round(metric.meters) });
    case 'age': {
      const days = Math.floor((Date.now() - metric.createdAt.getTime()) / 86_400_000);
      return days < 1 ? t('card.metric_today') : t('card.metric_days_ago', { count: days });
    }
  }
}

/**
 * The full basis sentence — for the pill tooltip and the explanation panel,
 * NOT the pill itself. The pill stays icon-only (spec D22) because the sticky
 * toolbar states the basis once; repeating it on twenty cards would add
 * nothing and would not survive translation into the footer's shared space.
 */
export function describeCardMetric(
  metric: CardMetric,
  basis: 'profile' | 'search' | null,
  t: TFunction,
): string | null {
  if (!metric) return null;
  switch (metric.kind) {
    case 'relevance':
      return basis === 'search'
        ? t('browse.sort_relevance_search')
        : t('browse.sort_relevance_profile');
    case 'distance':
      return t('card.metric_distance_desc');
    case 'age':
      return t('card.metric_age_desc');
  }
}
