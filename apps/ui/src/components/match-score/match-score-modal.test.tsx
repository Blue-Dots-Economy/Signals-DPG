import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { MatchScoreModal } from './match-score-modal';

const score = (overrides: Partial<MatchScoreResult> = {}): MatchScoreResult => ({
  provider: 'signals_search',
  score: 71,
  ...overrides,
});

describe('MatchScoreModal', () => {
  beforeEach(() => {
    // The progress bar animates over 600ms via requestAnimationFrame; stub it
    // to resolve in one synchronous frame well past the animation duration so
    // the test observes the settled value without waiting on real time.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 10_000);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #394: the backend's internal scale is 0-10; the progress bar's target
  // value used to be `score.score * 100` (e.g. 710 for a score of 7.1)
  // instead of a 0-100 percent. The indicator's inline transform is driven
  // directly by the `value` prop passed down from `progressValue`
  // (`components/ui/progress.tsx`'s indicator style, independent of the
  // underlying Radix root's own aria-valuenow computation), so it's the most
  // direct way to assert the settled percent.
  it('sets the progress bar to the score itself, now that scores are 0-100', () => {
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({ score: 71 })}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    const progressbar = screen.getByRole('progressbar');
    const indicator = progressbar.querySelector('div') as HTMLElement;
    // #646 §5.2: the score IS the percent — no normalization step left.
    expect(indicator.style.transform).toBe('translateX(-29%)');
  });

  // #646 §5.5: confidence, reasoning, signals and the band are gone. The
  // `signals_search` provider never populated them, so the modal advertised a
  // confidence line and a reasoning paragraph that were always absent in
  // practice. These two cases replace the pair that asserted them.
  it('renders no confidence line at all', () => {
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({ source: 'discover' })}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    expect(screen.queryByText(/Confidence/i)).toBeNull();
  });

  it('renders no band label', () => {
    // The Excellent/Good/Moderate/Low thresholds implied a calibration BGE-M3
    // similarities do not have.
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({})}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    expect(screen.queryByText(/excellent|moderate match|low match/i)).toBeNull();
  });
});
