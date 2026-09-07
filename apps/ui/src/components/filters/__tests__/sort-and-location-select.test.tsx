import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortSelect } from '../sort-select';
import { LocationSelect } from '../location-select';

/**
 * #644 §3.1/§3.2. Two controls that had no home before: the list's order and
 * its (opt-in) area filter.
 */

describe('SortSelect', () => {
  const open = async () => userEvent.click(screen.getByRole('button', { name: /sort/i }));

  it('offers all three orders', async () => {
    render(
      <SortSelect value="relevance" nearestAvailable basis="profile" onChange={vi.fn()} />,
    );
    await open();
    expect(screen.getByRole('option', { name: /your profile/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /newest/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /nearest/i })).toBeInTheDocument();
  });

  it('marks nearest unavailable WITH a reason when no location resolves', async () => {
    render(
      <SortSelect
        value="relevance"
        nearestAvailable={false}
        basis="profile"
        onChange={vi.fn()}
      />,
    );
    await open();
    const nearest = screen.getByRole('option', { name: /nearest/i });
    expect(nearest).toHaveAttribute('aria-disabled', 'true');
    expect(nearest).toHaveAccessibleDescription(/location/i);
  });

  it('does not emit a change for an unavailable option', async () => {
    const onChange = vi.fn();
    render(
      <SortSelect value="relevance" nearestAvailable={false} basis="profile" onChange={onChange} />,
    );
    await open();
    await userEvent.click(screen.getByRole('option', { name: /nearest/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits the picked order', async () => {
    const onChange = vi.fn();
    render(<SortSelect value="relevance" nearestAvailable basis="profile" onChange={onChange} />);
    await open();
    await userEvent.click(screen.getByRole('option', { name: /newest/i }));
    expect(onChange).toHaveBeenCalledWith('newest');
  });

  it('labels the relevance basis as PROFILE when an anchor is present', () => {
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="profile"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your profile/i);
  });

  it('labels the relevance basis as SEARCH when there is no anchor', () => {
    // After the #148 fix the score is still profile-based whenever an anchor
    // exists (spec D14), so "your search" is reserved for the genuinely
    // text-ranked case.
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="search"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /sort/i })).toHaveTextContent(/your search/i);
  });

  it('shows what the SERVER applied, not what was requested', () => {
    // relevance requested, but with no anchor and no text the BFF returns
    // newest. Showing "Relevance" would claim an order we did not get.
    render(
      <SortSelect
        value="relevance"
        applied="newest"
        nearestAvailable
        basis={null}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: /sort/i });
    expect(trigger).toHaveTextContent(/newest/i);
    expect(trigger).not.toHaveTextContent(/your profile/i);
  });
});

describe('SortSelect — relevance availability', () => {
  it('OMITS relevance when the server cannot rank by it (Q2)', async () => {
    // Signed out with no typed text, or signals-search down and the BFF
    // degraded to its native path: the request comes back
    // `sort_applied: 'newest'`. Offering the option produced a menu that
    // ticked "Relevance to your profile" while the trigger read "Newest".
    render(
      <SortSelect
        value="newest"
        applied="newest"
        nearestAvailable
        basis={null}
        relevanceAvailable={false}
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.queryByRole('option', { name: /relevance/i })).toBeNull();
    expect(screen.getByRole('option', { name: /newest/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /nearest/i })).toBeInTheDocument();
  });

  it('offers relevance when it is available', async () => {
    render(
      <SortSelect
        value="relevance"
        applied="relevance"
        nearestAvailable
        basis="profile"
        relevanceAvailable
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.getByRole('option', { name: /relevance/i })).toBeInTheDocument();
  });

  it('names what Newest sorts on, so a card age is unambiguous (Q3)', async () => {
    render(
      <SortSelect
        value="newest"
        applied="newest"
        nearestAvailable
        basis={null}
        onChange={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /sort/i }));

    expect(screen.getByRole('option', { name: /newest/i })).toHaveTextContent(/when it was posted/i);
  });
});

/**
 * The ONE control that mentions where the viewer is (#644 QA redesign).
 * Replaces `AreaSelect` plus the standalone "Search near" toggle, which
 * between them asked the same question in two places.
 */
describe('LocationSelect', () => {
  const base = {
    value: { mode: 'anywhere' } as const,
    sort: 'relevance' as const,
    source: 'profile' as const,
    onSourceChange: vi.fn(),
    profileAvailable: true,
    browserAvailable: true,
    center: { lat: 17.385, lng: 78.486 },
    onChange: vi.fn(),
  };
  const open = () => userEvent.click(screen.getByRole('button', { name: /location/i }));
  const field = () => screen.getByRole('textbox', { name: /distance in kilometres/i });

  it('reads as one sentence: a distance, of me', async () => {
    render(<LocationSelect {...base} />);
    await open();

    expect(screen.getByRole('option', { name: /anywhere/i })).toBeInTheDocument();
    expect(field()).toBeInTheDocument();
    expect(screen.getByText(/of me/i)).toBeInTheDocument();
  });

  it('HIDES "measured from" when nothing uses a centre', async () => {
    // Relevance + anywhere: no distance and no distance-ordering, so asking
    // which point to measure from is pure noise. This is the specific thing
    // the redesign removes.
    render(<LocationSelect {...base} />);
    await open();

    expect(screen.queryByText(/measured from/i)).toBeNull();
  });

  it('shows "measured from" for `nearest` even with no distance set', async () => {
    render(<LocationSelect {...base} sort="nearest" />);
    await open();

    expect(screen.getByText(/measured from/i)).toBeInTheDocument();
    // And says WHY it is being asked.
    expect(screen.getByText(/nearest/i)).toBeInTheDocument();
  });

  it('shows "measured from" once when BOTH a distance and nearest use it', async () => {
    render(
      <LocationSelect
        {...base}
        sort="nearest"
        value={{ mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 }}
      />,
    );
    await open();

    expect(screen.getAllByText(/measured from/i)).toHaveLength(1);
  });

  it('applies a typed distance on the tick, using the resolved centre', async () => {
    const onChange = vi.fn();
    render(<LocationSelect {...base} onChange={onChange} />);
    await open();
    await userEvent.type(field(), '7');
    expect(onChange).not.toHaveBeenCalled(); // nothing until commit

    await userEvent.click(screen.getByRole('button', { name: /apply this distance/i }));
    expect(onChange).toHaveBeenCalledWith({
      mode: 'radius',
      center: { lat: 17.385, lng: 78.486 },
      meters: 7000,
    });
  });

  it('BLOCKS decimals rather than rounding them', async () => {
    render(<LocationSelect {...base} />);
    await open();
    await userEvent.type(field(), '12.5');

    // Rounding would leave the field and the request disagreeing mid-edit.
    expect(field()).toHaveValue('125');
  });

  it('refuses a distance outside 1–500 and says so', async () => {
    const onChange = vi.fn();
    render(<LocationSelect {...base} onChange={onChange} />);
    await open();
    await userEvent.type(field(), '999');

    expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 500/i);
    expect(screen.getByRole('button', { name: /apply this distance/i })).toBeDisabled();
    await userEvent.type(field(), '{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the field from the in-field cross without applying', async () => {
    const onChange = vi.fn();
    render(<LocationSelect {...base} onChange={onChange} />);
    await open();
    await userEvent.type(field(), '42');
    await userEvent.click(screen.getByRole('button', { name: /clear the distance/i }));

    expect(field()).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('switches the source from inside the same menu', async () => {
    const onSourceChange = vi.fn();
    render(<LocationSelect {...base} sort="nearest" onSourceChange={onSourceChange} />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: /current location/i }));

    expect(onSourceChange).toHaveBeenCalledWith('browser');
  });

  it('disables a source that cannot supply a coordinate', async () => {
    render(<LocationSelect {...base} sort="nearest" browserAvailable={false} />);
    await open();

    expect(screen.getByRole('button', { name: /current location/i })).toBeDisabled();
  });

  it('replaces the whole section with one line when NO source is available', async () => {
    // Signed out with location denied. Rows that cannot act read as a broken
    // control, so they are not rendered at all (spec D7a reasoning).
    render(
      <LocationSelect {...base} profileAvailable={false} browserAvailable={false} center={null} />,
    );
    await open();

    expect(screen.queryByRole('textbox', { name: /distance/i })).toBeNull();
    expect(screen.queryByText(/measured from/i)).toBeNull();
    expect(screen.getByText(/allow location access/i)).toBeInTheDocument();
    // Anywhere stays reachable, so the control is never empty.
    expect(screen.getByRole('option', { name: /anywhere/i })).toBeInTheDocument();
  });

  it('does not offer the viewport as a choice', async () => {
    render(<LocationSelect {...base} />);
    await open();

    expect(screen.queryByText(/area shown on the map/i)).toBeNull();
  });

  it('shows the viewport as an active, non-selectable row once it arrives', async () => {
    // It only ever arrives from the map's "Search this area" — picking it from
    // a list view, where no map is on screen, would be meaningless.
    render(
      <LocationSelect
        {...base}
        value={{
          mode: 'viewport',
          bounds: { minLat: 12.8, minLng: 77.4, maxLat: 13.1, maxLng: 77.8 },
        }}
      />,
    );
    await open();

    // The trigger names it too, so scope to the menu.
    const menu = screen.getByRole('listbox', { name: /location/i });
    const row = within(menu).getByRole('option', { selected: true });
    expect(row).toHaveTextContent(/area shown on the map/i);
    expect(row).toHaveTextContent(/came from the map/i);
    // Not a button: there is nothing to pick here.
    expect(within(menu).queryByRole('button', { name: /area shown on the map/i })).toBeNull();
  });

  it('labels the trigger with the distance and the source', () => {
    render(
      <LocationSelect
        {...base}
        value={{ mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 }}
      />,
    );

    expect(screen.getByRole('button', { name: /location/i })).toHaveTextContent(
      /5 km of my profile/i,
    );
  });

  it('cannot apply a distance while no centre has resolved', async () => {
    // `browserAvailable` only means the browser SUPPORTS geolocation —
    // permission can still be denied. The tick used to look enabled and do
    // nothing.
    render(<LocationSelect {...base} center={null} />);
    await open();
    await userEvent.type(field(), '5');

    expect(screen.getByRole('button', { name: /apply this distance/i })).toBeDisabled();
    expect(screen.getByText(/waiting for a location/i)).toBeInTheDocument();
  });
});
