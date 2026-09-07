import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MatchScoreBadge } from './match-score-badge';

/**
 * #646 C1 — the pill shows the RANKING BASIS, so the number and the order can
 * never disagree. It is icon-only (spec D22): the basis is stated once in the
 * sticky browse toolbar rather than repeated on every card.
 *
 * The previous suite asserted Excellent/Good/Moderate/Low bands. Those are
 * deliberately gone (#646 §5.5) — their 0.85/0.70/0.50 thresholds implied a
 * calibration BGE-M3 similarities do not have.
 */

describe('MatchScoreBadge — metric kinds', () => {
  it('renders a relevance percentage', () => {
    render(<MatchScoreBadge metric={{ kind: 'relevance', percent: 62 }} basis="profile" />);
    expect(screen.getByTestId('card-metric-pill')).toHaveTextContent('62%');
  });

  it('renders a distance in km at or above 1000 m', () => {
    render(<MatchScoreBadge metric={{ kind: 'distance', meters: 4200 }} basis={null} />);
    expect(screen.getByTestId('card-metric-pill')).toHaveTextContent('4.2');
  });

  it('renders a distance in metres below 1000', () => {
    render(<MatchScoreBadge metric={{ kind: 'distance', meters: 850 }} basis={null} />);
    expect(screen.getByTestId('card-metric-pill')).toHaveTextContent('850');
  });

  it('renders a relative age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00Z'));
    render(
      <MatchScoreBadge
        metric={{ kind: 'age', createdAt: new Date('2026-08-29T00:00:00Z') }}
        basis={null}
      />,
    );
    expect(screen.getByTestId('card-metric-pill')).toHaveTextContent('5');
    vi.useRealTimers();
  });

  it('renders nothing when no metric determined the position', () => {
    const { container } = render(<MatchScoreBadge metric={null} basis={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MatchScoreBadge — icon-only, basis in the label', () => {
  it('does NOT print the basis label on the pill itself', () => {
    // It would not survive translation in the footer slot it shares with
    // Connect, and the sticky toolbar already says it once.
    render(<MatchScoreBadge metric={{ kind: 'relevance', percent: 62 }} basis="profile" />);
    const pill = screen.getByTestId('card-metric-pill');
    expect(pill).toHaveTextContent('62%');
    expect(pill.textContent).not.toMatch(/profile/i);
  });

  it('carries the basis in its accessible name', () => {
    render(<MatchScoreBadge metric={{ kind: 'relevance', percent: 62 }} basis="profile" />);
    expect(screen.getByTestId('card-metric-pill').getAttribute('aria-label')).toMatch(/62%/);
  });

  it('distinguishes the search basis from the profile basis', () => {
    const { rerender } = render(
      <MatchScoreBadge metric={{ kind: 'relevance', percent: 62 }} basis="profile" />,
    );
    const profileLabel = screen.getByTestId('card-metric-pill').getAttribute('aria-label');

    rerender(<MatchScoreBadge metric={{ kind: 'relevance', percent: 62 }} basis="search" />);
    expect(screen.getByTestId('card-metric-pill').getAttribute('aria-label')).not.toBe(profileLabel);
  });

  it('shows no band words at all', () => {
    render(<MatchScoreBadge metric={{ kind: 'relevance', percent: 95 }} basis="profile" />);
    expect(screen.getByTestId('card-metric-pill').textContent).not.toMatch(
      /excellent|good|moderate|low/i,
    );
  });
});

describe('MatchScoreBadge — interaction', () => {
  it('invokes onClick', async () => {
    const onClick = vi.fn();
    render(
      <MatchScoreBadge
        metric={{ kind: 'relevance', percent: 62 }}
        basis="profile"
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByTestId('card-metric-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('MatchScoreBadge — only relevance is interactive', () => {
  it('renders a plain span, not a button, when there is nothing to open', () => {
    // A date or a distance pill used to render as a <button> advertising
    // "Tap for details", and clicking it opened "Match Score Details" — a
    // panel that explains a cosine score, so with no score computed it showed
    // an empty "No match score available" dialog.
    render(
      <MatchScoreBadge
        metric={{ kind: 'age', createdAt: new Date('2026-08-29T00:00:00Z') }}
        basis={null}
      />,
    );

    const pill = screen.getByTestId('card-metric-pill');
    expect(pill.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a button when a details handler is supplied', () => {
    render(
      <MatchScoreBadge
        metric={{ kind: 'relevance', percent: 62 }}
        basis="profile"
        onClick={() => {}}
      />,
    );

    expect(screen.getByTestId('card-metric-pill').tagName).toBe('BUTTON');
  });
});
