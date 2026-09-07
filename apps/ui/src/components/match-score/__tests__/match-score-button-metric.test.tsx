import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MatchScoreButton } from '../match-score-button';
import type { Item } from '@/lib/item-api';

// The pill under test renders from `metric` alone; these two only satisfy the
// component's required props.
const anyItem = { item_id: 'x', item_domain: 'provider' } as unknown as Item;

/**
 * #646 C1 + QA P1: the pill shows whatever drove the card's position, but only
 * a RELEVANCE pill has an explanation behind it. Under `newest`/`nearest` the
 * pill is an age or a distance, and the details modal explains a cosine score
 * — so wiring `onViewDetails` for those opened "Match Score Details" on a
 * "Today" pill and, with no score computed, an empty dialog.
 */
describe('MatchScoreButton — details only for relevance', () => {
  it('opens details from a relevance pill', async () => {
    const onViewDetails = vi.fn();
    render(
      <MatchScoreButton
        metric={{ kind: 'relevance', percent: 62 }}
        basis="profile"
        localItem={anyItem}
        networkItem={anyItem}
        score={null}
        isLoading={false}
        error={null}
        onCalculate={() => {}}
        onViewDetails={onViewDetails}
      />,
    );

    await userEvent.click(screen.getByTestId('card-metric-pill'));
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });

  it('does NOT open details from an age pill', async () => {
    const onViewDetails = vi.fn();
    render(
      <MatchScoreButton
        metric={{ kind: 'age', createdAt: new Date('2026-08-29T00:00:00Z') }}
        basis={null}
        localItem={anyItem}
        networkItem={anyItem}
        score={null}
        isLoading={false}
        error={null}
        onCalculate={() => {}}
        onViewDetails={onViewDetails}
      />,
    );

    const pill = screen.getByTestId('card-metric-pill');
    expect(pill.tagName).toBe('SPAN');
    await userEvent.click(pill);
    expect(onViewDetails).not.toHaveBeenCalled();
  });

  it('does NOT open details from a distance pill', async () => {
    const onViewDetails = vi.fn();
    render(
      <MatchScoreButton
        metric={{ kind: 'distance', meters: 4200 }}
        basis={null}
        localItem={anyItem}
        networkItem={anyItem}
        score={null}
        isLoading={false}
        error={null}
        onCalculate={() => {}}
        onViewDetails={onViewDetails}
      />,
    );

    await userEvent.click(screen.getByTestId('card-metric-pill'));
    expect(onViewDetails).not.toHaveBeenCalled();
  });
});
