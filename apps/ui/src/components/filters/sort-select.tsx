import { useTranslation } from 'react-i18next';
import { ArrowDownUp } from 'lucide-react';
import { OptionSelect } from './option-select';
import type { BrowseSort } from '@/lib/browse-discover';

export interface SortSelectProps {
  /** What the user asked for. */
  value: BrowseSort;
  /**
   * What the server ACTUALLY applied (`meta.sort_applied`). The trigger label
   * renders from this, not from `value`: a `relevance` request with neither an
   * anchor nor typed text degrades to `newest` server-side, and labelling from
   * the request would claim an order we did not get (#644 §3.2).
   */
  applied?: BrowseSort;
  /**
   * A response arrived and reported NO order (`meta.sort_applied` absent),
   * which means the search service predates the explicit sort and ignored what
   * we asked for. The order is therefore unknowable from here, so the trigger
   * names none — showing the requested value would be the exact claim this
   * control exists to avoid, and merge order is not deploy order, so the two
   * halves can genuinely run at different ages.
   *
   * The choice itself stays discoverable: the popover still ticks it.
   */
  appliedUnreported?: boolean;
  /** False when no viewer location resolves — `nearest` then has no centre. */
  nearestAvailable: boolean;
  /**
   * Which quantity `relevance` means here: 'profile' when an anchor is sent
   * (the score is profile↔item cosine, spec D14), 'search' when there is no
   * anchor and the typed text is the query vector, or null when neither
   * applies.
   */
  basis: 'profile' | 'search' | null;
  /**
   * False when the server cannot rank by relevance for this request — no
   * anchor and no typed text, or signals-search is unreachable and the BFF
   * degraded to the native path (`meta.source: 'native_fallback'`). The option
   * is then OMITTED rather than offered: picking it produced a menu that
   * ticked "Relevance to your profile" while the trigger read "Newest",
   * because the server reported `sort_applied: newest` (Q2).
   */
  relevanceAvailable?: boolean;
  /**
   * Which centre `nearest` would measure from, already localized. Shown as a
   * READ-ONLY hint: Sort deliberately says nothing selectable about location,
   * because the source is chosen in exactly one place — the Location control
   * (#644 QA redesign).
   */
  nearestFromLabel?: string;
  onChange: (next: BrowseSort) => void;
}

/**
 * The sort selector (#644/#645 §4.5). List view only — it is ABSENT on the
 * map (spec D26), because ordering is meaningless for a marker layer and a
 * disabled control would invite the question rather than answer it.
 *
 * This control is also what makes the card pill able to stay icon-only
 * (spec D22/D23): it states the ranking basis once, and the toolbar it sits in
 * is sticky, so that statement is on screen at every scroll position instead
 * of being repeated on all twenty cards.
 */
export function SortSelect({
  value,
  applied,
  appliedUnreported = false,
  nearestAvailable,
  basis,
  relevanceAvailable = true,
  nearestFromLabel,
  onChange,
}: Readonly<SortSelectProps>) {
  const { t } = useTranslation();

  const relevanceLabel =
    basis === 'search'
      ? t('browse.sort_relevance_search')
      : t('browse.sort_relevance_profile');

  const labelFor = (sort: BrowseSort): string => {
    switch (sort) {
      case 'relevance':
        return relevanceLabel;
      case 'nearest':
        return t('browse.sort_nearest');
      default:
        return t('browse.sort_newest');
    }
  };

  // Label from what happened, falling back to the request only before the
  // first response has arrived.
  // `undefined` when the server reported nothing — the trigger then shows its
  // name with no value rather than echoing the request back as fact.
  const effective = appliedUnreported ? undefined : (applied ?? value);

  /**
   * The server asked for relevance and got something else.
   *
   * `relevanceAvailable` above is a CLIENT-SIDE PREDICTION — "is there a query
   * vector at all", i.e. an anchor is being sent or text was typed. It cannot
   * see whether signals-search could actually USE that anchor. On the test
   * cluster it could not (the profile was not indexed yet), so the BFF retried
   * anchor-less and honestly reported `sort_applied: 'newest'` with
   * `degraded: false` — the prediction said available, the response said
   * newest, and nothing reconciled the two.
   *
   * Two visible bugs followed. The trigger labelled from `applied` while the
   * menu ticked `value`, so the control claimed "Newest" and "Relevance" at
   * once; and because `sort` state ALREADY held 'relevance' (its default),
   * choosing relevance again was a no-op that fired no refetch, so the option
   * looked broken.
   */
  const relevanceRefused =
    // Unreported counts as refused: we cannot claim relevance was applied, and
    // this is the "listed, with a reason" state that already exists for it.
    appliedUnreported ||
    (value === 'relevance' && applied !== undefined && applied !== 'relevance');

  return (
    <OptionSelect<BrowseSort>
      name={t('browse.sort_label')}
      displayLabel={effective ? labelFor(effective) : ''}
      icon={ArrowDownUp}
      // The APPLIED order, not the requested one — otherwise the trigger and
      // the tick can disagree, which is exactly the bug above. When the server
      // reported nothing, fall back to the request for the TICK only: the
      // popover should still show what was chosen, while the trigger above
      // stays silent about what was actually applied.
      value={effective ?? value}
      onChange={onChange}
      options={[
        // Listed-with-a-reason rather than omitted when the server refuses it:
        // omitting would silently drop a row the viewer had already chosen,
        // and the same idiom already carries `nearest`'s explanation below.
        ...(relevanceAvailable
          ? [
              {
                value: 'relevance' as const,
                label: relevanceLabel,
                available: !relevanceRefused,
                reason: relevanceRefused
                  ? t('browse.sort_relevance_unavailable')
                  : undefined,
              },
            ]
          : []),
        // Names its basis (`items.created_at`) so a card's "6 days ago" is not
        // ambiguous between posting date and last-edit date (Q3).
        {
          value: 'newest' as const,
          label: t('browse.sort_newest'),
          hint: t('browse.sort_newest_hint'),
        },
        {
          value: 'nearest',
          label: t('browse.sort_nearest'),
          available: nearestAvailable,
          reason: nearestAvailable ? undefined : t('browse.sort_nearest_unavailable'),
          hint:
            nearestAvailable && nearestFromLabel
              ? t('browse.sort_nearest_from', { source: nearestFromLabel })
              : undefined,
        },
      ]}
    />
  );
}
