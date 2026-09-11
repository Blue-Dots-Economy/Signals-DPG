import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  effectiveLocationSource: 'profile' as const,
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

  it('carries no action of its own — bulk-select sits over the results', () => {
    // Select acts ON the results rather than choosing them, so grouping it
    // with sort/location/filters implied it was another way to narrow.
    render(<BrowseToolbar {...base} />);
    expect(screen.queryByRole('button', { name: /select items/i })).toBeNull();
  });

  it('omits the count while it is still loading', () => {
    render(<BrowseToolbar {...base} count={undefined} />);
    expect(screen.queryByText(/248/)).toBeNull();
  });

  it('rules off the filter state from the count without a separate element', () => {
    // "No filters applied" and "2 listings" are adjacent same-size text, so
    // they read as one phrase without a divider between them.
    //
    // Found in mobile QA: as its own element the rule wrapped independently of
    // the count, so at 390px it dangled at the end of the "Clear all" line
    // while the count sat on the line below. Carrying it as a BORDER on the
    // count means it cannot separate from what it divides — so the assertion
    // is that no standalone rule exists to strand.
    const { rerender } = render(<BrowseToolbar {...base} />);
    expect(screen.getByTestId('toolbar-count')).toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-count-separator')).toBeNull();

    // No count at all → nothing rendered, so nothing to divide.
    rerender(<BrowseToolbar {...base} count={undefined} />);
    expect(screen.queryByTestId('toolbar-count')).toBeNull();
  });

  it('OMITS sort and the RADIUS on the map — absent, not disabled (spec D26)', () => {
    // Area was rendered here originally, which was wrong twice over: the map
    // fetch never received `area` (it scopes by viewport), so the control was
    // inert; and a radius layered on a bbox is a contradictory second spatial
    // filter. On the map the viewport IS the area.
    render(<BrowseToolbar {...base} viewMode="map" />);
    expect(screen.queryByRole('button', { name: /sort/i })).toBeNull();
    // The full control — the one whose value is the radius — is gone.
    expect(screen.queryByRole('button', { name: /location: anywhere/i })).toBeNull();
  });

  it('KEEPS the location source on the map, which centres it', () => {
    // D26 removed the whole Location control, but its reasoning only covered
    // the radius. The source decides where the map opens, where "You are
    // here" sits, and re-centres it on change — so the map had no way to say
    // "centre on where I am now" at all.
    render(<BrowseToolbar {...base} viewMode="map" />);
    expect(
      screen.getByRole('button', { name: /location: my profile/i }),
    ).toBeInTheDocument();
  });

  it('shows only the two sources on the map, with no distance field', async () => {
    render(<BrowseToolbar {...base} viewMode="map" />);
    await userEvent.click(screen.getByRole('button', { name: /location: my profile/i }));

    // Headed by what picking one DOES, since "Location — My profile" over a
    // map would otherwise read as a filter on which pins are shown.
    expect(screen.getByRole('listbox', { name: /centre the map on/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /my profile/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: /current location/i })).toBeInTheDocument();
    // No radius: the viewport is the map's area.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/anywhere/i)).toBeNull();
  });

  it('switches the map source through the same callback the list uses', async () => {
    const onLocationSourceChange = vi.fn();
    render(
      <BrowseToolbar
        {...base}
        viewMode="map"
        onLocationSourceChange={onLocationSourceChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /location: my profile/i }));
    await userEvent.click(screen.getByRole('option', { name: /current location/i }));

    // One shared `preferredSource`, so the two views can never disagree.
    expect(onLocationSourceChange).toHaveBeenCalledWith('browser');
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
