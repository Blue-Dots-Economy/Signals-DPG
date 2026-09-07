import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowseToolbar } from '../browse-toolbar';
import type { BrowseToolbarProps } from '../browse-toolbar';

const base: BrowseToolbarProps = {
  viewMode: 'list',
  count: 248,
  sort: 'relevance',
  sortApplied: 'relevance',
  nearestAvailable: true,
  relevanceBasis: 'profile',
  onSortChange: vi.fn(),
  domainOptions: [
    { id: 'provider', label: 'Provider' },
    { id: 'service_provider', label: 'Service Provider' },
  ],
  selectedDomains: ['provider'],
  onDomainsChange: vi.fn(),
  area: { mode: 'anywhere' },
  locationSource: 'profile' as const,
  onLocationSourceChange: vi.fn(),
  profileLocationAvailable: true,
  browserLocationAvailable: true,
  defaultCenter: { lat: 12.97, lng: 77.59 },
  onAreaChange: vi.fn(),
  chips: [],
  onRemoveChip: vi.fn(),
  onClearAll: vi.fn(),
  canClearAll: false,
};

describe('BrowseToolbar', () => {
  // Domain selection moved OUT of this bar (it renders beside "Search near"
  // over the content now), so its rendering and single-vs-multi behaviour are
  // covered by domain-control.test.tsx rather than duplicated here.
  it('renders sort, location and the result count', () => {
    render(<BrowseToolbar {...base} />);
    expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument();
    // "Area" became "Location" when the distance and its source merged into
    // one control (#644 QA redesign).
    expect(screen.getByRole('button', { name: /location/i })).toBeInTheDocument();
    expect(screen.getByText(/248/)).toBeInTheDocument();
  });

  it('owns the domain control, so the whole browse chrome is two layers', () => {
    // It briefly moved to a row of its own to sit beside "Search near"; once
    // that toggle was absorbed into Location, the row existed for nothing
    // else and the page carried three layers instead of the approved two.
    render(<BrowseToolbar {...base} />);
    expect(screen.getByRole('group', { name: /domain/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Provider' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders a trailing action after the count', () => {
    // The list's "Select" toggle was the last thing keeping the third row.
    render(<BrowseToolbar {...base} trailing={<button type="button">Select</button>} />);
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
  });

  it('omits the count while it is still loading', () => {
    render(<BrowseToolbar {...base} count={undefined} />);
    expect(screen.queryByText(/248/)).toBeNull();
  });

  it('OMITS both sort and area on the map — absent, not disabled (spec D26)', () => {
    // Area was rendered here originally, which was wrong twice over: the map
    // fetch never received `area` (it scopes by viewport), so the control was
    // inert; and a radius layered on a bbox is a contradictory second spatial
    // filter. On the map the viewport IS the area.
    render(<BrowseToolbar {...base} viewMode="map" />);
    expect(screen.queryByRole('button', { name: /sort/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /location/i })).toBeNull();
  });

  it('offers location on the list, where it is the dense-map escape hatch', () => {
    render(<BrowseToolbar {...base} viewMode="list" />);
    expect(screen.getByRole('button', { name: /location/i })).toBeInTheDocument();
  });

  it('offers clear-all when only sort or area is non-default, though neither chips', () => {
    // Found in browser QA: sort and area produce no chip (their own controls
    // already show their value), so gating clear-all on chips.length would
    // leave a user who only changed the area with no way to reset.
    render(<BrowseToolbar {...base} chips={[]} canClearAll />);
    expect(screen.getByRole('button', { name: /clear all/i })).toBeInTheDocument();
    expect(screen.queryByText(/no filters applied/i)).toBeNull();
  });

  it('shows no clear-all when nothing is non-default', () => {
    render(<BrowseToolbar {...base} chips={[]} canClearAll={false} />);
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull();
    expect(screen.getByText(/no filters applied/i)).toBeInTheDocument();
  });

  it('keeps row 2 present in both chip states, so the list below does not shift', () => {
    // A bar that changed height as chips came and went would move the list
    // under the user's thumb mid-scroll (spec §7.2).
    const { rerender } = render(<BrowseToolbar {...base} chips={[]} />);
    expect(screen.getByTestId('toolbar-row-2')).toBeInTheDocument();
    expect(screen.getByText(/no filters applied/i)).toBeInTheDocument();

    rerender(
      <BrowseToolbar
        {...base}
        canClearAll
        chips={[{ kind: 'facet', id: 'facet:sector', label: 'Sector: Energy', removable: true }]}
      />,
    );
    expect(screen.getByTestId('toolbar-row-2')).toBeInTheDocument();
    expect(screen.queryByText(/no filters applied/i)).toBeNull();
    expect(screen.getByTestId('applied-chip')).toHaveTextContent('Sector: Energy');
  });

  it('labels sort from what the server applied, not what was requested', () => {
    render(<BrowseToolbar {...base} sort="relevance" sortApplied="newest" relevanceBasis={null} />);
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/newest/i);
  });

  it('is not sticky itself — PageShell pins it structurally', () => {
    // A `sticky` class here would need an offset equal to the top bar's
    // height, and that bar is flex-wrap so its height varies by viewport.
    render(<BrowseToolbar {...base} />);
    expect(screen.getByTestId('browse-toolbar').className).not.toMatch(/sticky/);
  });

});
