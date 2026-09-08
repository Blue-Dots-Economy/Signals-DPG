import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapCountPill } from './map-count-pill';

/**
 * This pill is the VIEWPORT count, and since #644 QA N5 it is the only place
 * that number appears: the browse toolbar above shows the FILTER total
 * instead ("102 listings · 8 not on the map"), which is deliberately not
 * viewport-scoped.
 *
 * It used to hide its plain-count variant for signed-in visitors, on the
 * grounds that `ContentHeader` already showed them a count. That header count
 * was removed in #645 as a duplicate of the toolbar, which left signed-in
 * users with no viewport count anywhere — so the auth gate is gone.
 */
describe('MapCountPill', () => {
  it('shows the over-dense "N zoom in" message with the TRUE total when truncated', () => {
    render(<MapCountPill total={1500} shown={1000} truncated />);
    expect(screen.getByText('1500 in this area — zoom in')).toBeInTheDocument();
  });

  it('shows the plain count when not truncated — no auth gate any more', () => {
    // The regression this replaces: `!truncated && signedIn` returned null,
    // so a signed-in visitor saw nothing here.
    render(<MapCountPill total={42} shown={42} truncated={false} />);
    expect(screen.getByText('42 listings')).toBeInTheDocument();
  });

  it('says "Showing X of Y" when some matches in view are not rendered', () => {
    // e.g. the viewer's own pins are excluded from the map.
    render(<MapCountPill total={42} shown={10} truncated={false} />);
    expect(screen.getByText('Showing 10 of 42')).toBeInTheDocument();
  });

  it('renders nothing when there are no results in view', () => {
    render(<MapCountPill total={0} shown={0} truncated={false} />);
    expect(screen.queryByText(/in this area/)).not.toBeInTheDocument();
    expect(screen.queryByText(/listing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it('prefers the over-dense variant over the plain count', () => {
    // Mutually exclusive: a truncated viewport must not also claim an exact
    // figure, because the marker set it would count is incomplete.
    render(<MapCountPill total={1500} shown={1000} truncated />);
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^1500 listings/)).not.toBeInTheDocument();
  });
});
