import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { Item } from '@/lib/item-api';
import { MatchScoreCard } from './match-score-card';

vi.mock('@/lib/match-score-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/match-score-api')>(
    '@/lib/match-score-api',
  );
  return { ...actual, calculateMatchScore: vi.fn() };
});
import { calculateMatchScore } from '@/lib/match-score-api';

const schema: RJSFSchema = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
};

const item = (id: string): Item =>
  ({
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'profile',
    item_instance_url: null,
    item_schema_url: null,
    item_state: { name: 'Dest' },
    item_locations: [],
  }) as unknown as Item;

describe('MatchScoreCard', () => {
  beforeEach(() => {
    vi.mocked(calculateMatchScore).mockReset();
    localStorage.clear();
  });

  it('opens the details modal on the first "See Match Score" click (loading state)', async () => {
    const user = userEvent.setup();
    // Keep the calculation pending so the modal is observed in its loading state.
    vi.mocked(calculateMatchScore).mockReturnValue(new Promise(() => {}));

    render(
      <MatchScoreCard
        schema={schema}
        data={{ name: 'Dest' }}
        localItem={item('mine')}
        networkItem={item('dest')}
      />,
    );

    // No modal before the click.
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: /see match score/i }));

    // The full details modal opens on the FIRST click, in its loading state —
    // the same one-click flow as the map (the list previously required a second
    // click on the score badge to reach the details).
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/match score details/i)).toBeInTheDocument();
    expect(screen.getByText(/calculating match score/i)).toBeInTheDocument();
  });

  // #394: `/discover` already returns a per-item relevance score on the
  // network item (`Item.score`), so the card should show the % upfront
  // instead of requiring a click through to `/api/v1/match-score/calculate`.
  it('shows the match-score % upfront when networkItem.score is present, without calling the match-score API', () => {
    render(
      <MatchScoreCard
        schema={schema}
        data={{ name: 'Dest' }}
        localItem={item('mine')}
        networkItem={{ ...item('dest'), score: 71 }}
      />,
    );

    expect(screen.getByRole('button', { name: /71%/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /see match score/i })).toBeNull();
    expect(calculateMatchScore).not.toHaveBeenCalled();
  });

  it('opens the modal pre-filled with the discover score on click (no API call)', async () => {
    const user = userEvent.setup();
    render(
      <MatchScoreCard
        schema={schema}
        data={{ name: 'Dest' }}
        localItem={item('mine')}
        networkItem={{ ...item('dest'), score: 71 }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /71%/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Header score renders immediately — no loading state, no API call.
    expect(screen.queryByText(/calculating match score/i)).toBeNull();
    expect(screen.getAllByText('71%').length).toBeGreaterThan(0);
    expect(calculateMatchScore).not.toHaveBeenCalled();
  });

  it('falls back to the click-to-fetch flow when networkItem.score is absent', async () => {
    const user = userEvent.setup();
    vi.mocked(calculateMatchScore).mockResolvedValue({ provider: 'signals_search', score: 6 });

    render(
      <MatchScoreCard
        schema={schema}
        data={{ name: 'Dest' }}
        localItem={item('mine')}
        networkItem={item('dest')}
      />,
    );

    const seeScoreButton = screen.getByRole('button', { name: /see match score/i });
    expect(calculateMatchScore).not.toHaveBeenCalled();

    await user.click(seeScoreButton);

    expect(calculateMatchScore).toHaveBeenCalledTimes(1);
  });
});
