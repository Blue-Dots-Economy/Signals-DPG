import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { useMatchScore } from './use-match-score';

vi.mock('@/lib/match-score-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/match-score-api')>(
    '@/lib/match-score-api',
  );
  return { ...actual, calculateMatchScore: vi.fn() };
});
import { calculateMatchScore } from '@/lib/match-score-api';

const item = (id: string, overrides: Partial<Item> = {}): Item =>
  ({
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile',
    item_instance_url: null,
    item_schema_url: null,
    item_state: {},
    item_locations: [],
    ...overrides,
  }) as unknown as Item;

const result = (score: number): MatchScoreResult => ({
  provider: 'test',
  score,
});

const dest = item('dest-1');

describe('useMatchScore', () => {
  beforeEach(() => {
    vi.mocked(calculateMatchScore).mockReset();
    localStorage.clear();
  });

  it('clears the score when the active (local) profile changes', async () => {
    vi.mocked(calculateMatchScore).mockResolvedValue(result(0.7));

    const { result: hook, rerender } = renderHook(
      ({ local }: { local: Item }) =>
        useMatchScore({ localItem: local, networkItem: dest, skipCache: true }),
      { initialProps: { local: item('profile-A') } },
    );

    await act(async () => {
      await hook.current.calculate();
    });
    await waitFor(() => expect(hook.current.score?.score).toBe(0.7));

    // Switch the active profile → the score for the previous pair must clear,
    // so the card doesn't show a score computed against a different profile.
    rerender({ local: item('profile-B') });
    expect(hook.current.score).toBeNull();
  });

  it('does not clear the score on a re-render with the same pair', async () => {
    vi.mocked(calculateMatchScore).mockResolvedValue(result(0.42));
    const sameLocal = item('profile-A');

    const { result: hook, rerender } = renderHook(
      ({ local }: { local: Item }) =>
        useMatchScore({ localItem: local, networkItem: dest, skipCache: true }),
      { initialProps: { local: sameLocal } },
    );

    await act(async () => {
      await hook.current.calculate();
    });
    await waitFor(() => expect(hook.current.score?.score).toBe(0.42));

    // New object identity, same item_id → the pair is unchanged, keep the score.
    rerender({ local: item('profile-A') });
    expect(hook.current.score?.score).toBe(0.42);
  });

  // #394: `/discover` already returns a raw ~0-1 relevance score on the item
  // (`Item.score`) — the SAME quantity `/v1/relevance` computes. Seed the
  // badge from it, scaled to the 0-10 internal scale, without a click.
  it('seeds the score straight from networkItem.score (one 0-100 scale) without calling the match-score API', () => {
    const discoverDest = item('dest-2', { score: 71 } as Partial<Item>);

    const { result: hook } = renderHook(() =>
      useMatchScore({ localItem: item('profile-A'), networkItem: discoverDest }),
    );

    expect(hook.current.score).toEqual(
      expect.objectContaining({ score: 71, source: 'discover' }),
    );
    expect(calculateMatchScore).not.toHaveBeenCalled();
  });

  it('does not seed a score when networkItem.score is absent (current click-to-fetch flow)', () => {
    const { result: hook } = renderHook(() =>
      useMatchScore({ localItem: item('profile-A'), networkItem: dest }),
    );

    expect(hook.current.score).toBeNull();
    expect(calculateMatchScore).not.toHaveBeenCalled();
  });

  it('re-seeds the discover score when the (local, network) pair changes', () => {
    // #646 §5.2: /discover already returns 0-100, so the seed passes it
    // through — these used to be 0.4/0.9 multiplied by 10 on the way in.
    const destA = item('dest-a', { score: 40 } as Partial<Item>);
    const destB = item('dest-b', { score: 90 } as Partial<Item>);

    const { result: hook, rerender } = renderHook(
      ({ networkItem }: { networkItem: Item }) =>
        useMatchScore({ localItem: item('profile-A'), networkItem }),
      { initialProps: { networkItem: destA } },
    );

    expect(hook.current.score?.score).toBe(40);

    rerender({ networkItem: destB });
    expect(hook.current.score?.score).toBe(90);
  });
});
