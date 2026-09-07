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

describe('Sort and Location go icon-only on a phone', () => {
  /**
   * Reported from a real phone: "Sort Relevance to your profile" is so wide it
   * took a whole row on its own, pushing Location, Filters and the count onto
   * rows of their own — four rows of chrome before the first card. Below `sm`
   * both controls now show only their icon.
   *
   * The value is not lost. The note directly under the toolbar states the
   * ranking basis and any applied radius in words, the popover ticks the
   * current choice, and the trigger's accessible name carries it — which is
   * what these assert, because the visible text is hidden by a CSS breakpoint
   * that jsdom does not evaluate.
   */
  it('names the sort trigger with its VALUE, since the text is hidden at that width', () => {
    render(
      <SortSelect value="nearest" applied="nearest" nearestAvailable basis={null} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /sort: nearest/i })).toBeInTheDocument();
  });

  it('names the sort trigger from what the SERVER applied, not the request', () => {
    render(
      <SortSelect value="relevance" applied="newest" nearestAvailable basis={null} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /sort: newest/i })).toBeInTheDocument();
  });

  it('names the location trigger with its value', () => {
    render(
      <LocationSelect
        value={{ mode: 'anywhere' }}
        sort="newest"
        source="profile"
        onSourceChange={vi.fn()}
        profileAvailable
        browserAvailable
        center={{ lat: 12.97, lng: 77.59 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /location: anywhere/i })).toBeInTheDocument();
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

  // Found on the test cluster, where signals-search actually runs (#644 QA).
  // The client PREDICTS relevance is available — the viewer has a profile that
  // interacts with the browsed domain, so an anchor is sent — but the anchor
  // is not usable (not yet indexed, or no interaction edge), so the BFF
  // retries anchor-less and honestly reports `sort_applied: 'newest'` with
  // `degraded: false`. The client-side prediction cannot see any of that, so
  // `relevanceAvailable` stays true and only `applied` carries the truth.
  describe('when the server REFUSES a relevance request', () => {
    const refused = (
      <SortSelect
        value="relevance"
        applied="newest"
        nearestAvailable
        basis="profile"
        relevanceAvailable
        onChange={() => {}}
      />
    );

    it('ticks the order the server applied, not the one requested', async () => {
      // The bug: the trigger read "Newest" while the open menu ticked
      // "Relevance to your profile" — two contradictory claims on screen.
      render(refused);
      await userEvent.click(screen.getByRole('button', { name: /sort/i }));

      expect(screen.getByRole('option', { name: /newest/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('option', { name: /your profile/i })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });

    it('marks relevance unavailable WITH a reason, so re-picking it is not inert', async () => {
      // `sort` state already holds 'relevance' (it is the default), so
      // choosing it again changed nothing and triggered no refetch — the
      // control looked broken. Listed-with-a-reason is the same idiom
      // `nearest` already uses.
      render(refused);
      await userEvent.click(screen.getByRole('button', { name: /sort/i }));

      const relevance = screen.getByRole('option', { name: /your profile/i });
      expect(relevance).toHaveAttribute('aria-disabled', 'true');
      expect(relevance).toHaveTextContent(/not available/i);
    });

    it('still ticks relevance when the server DID apply it', async () => {
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

      const relevance = screen.getByRole('option', { name: /your profile/i });
      expect(relevance).toHaveAttribute('aria-selected', 'true');
      expect(relevance).toHaveAttribute('aria-disabled', 'false');
    });
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

  it('lets the whole distance row be clicked and hovered, not just the field', async () => {
    // It used to be inert: only the input responded, so the row read as
    // unselectable next to "Anywhere", which hovers and clicks.
    render(<LocationSelect {...base} />);
    await open();

    const menu = screen.getByRole('listbox', { name: /location/i });
    const rows = within(menu).getAllByRole('option');
    const distanceRow = rows.find((r) => r.textContent?.match(/of me/i));

    expect(distanceRow).toBeDefined();
    expect(distanceRow).toHaveClass('cursor-pointer');
    // Same hover treatment as the other rows.
    expect(distanceRow?.className).toMatch(/hover:bg-accent/);
    // Reachable by keyboard.
    expect(distanceRow).toHaveAttribute('tabindex', '0');

    // Clicking the row focuses the field, so typing works immediately.
    await userEvent.click(distanceRow!);
    expect(field()).toHaveFocus();
  });

  it('selects the row and reveals "Measured from" as soon as it is clicked', async () => {
    // It used to need a COMMITTED value: clicking the row appeared to do
    // nothing, and the source question only turned up on the next opening of
    // the menu. Intent is enough.
    render(<LocationSelect {...base} />);
    await open();

    const menu = screen.getByRole('listbox', { name: /location/i });
    expect(within(menu).queryByText(/measured from/i)).toBeNull();

    const distanceRow = within(menu)
      .getAllByRole('option')
      .find((r) => r.textContent?.match(/of me/i))!;
    await userEvent.click(distanceRow);

    expect(distanceRow).toHaveAttribute('aria-selected', 'true');
    expect(within(menu).getByText(/measured from/i)).toBeInTheDocument();
    // Anywhere gives up its tick the moment a distance is being set.
    const anywhere = within(menu).getByRole('option', { name: /anywhere/i });
    expect(anywhere).toHaveAttribute('aria-selected', 'false');
  });

  it('prefills a usable distance on engage, so the tick is live immediately', async () => {
    render(<LocationSelect {...base} />);
    await open();
    await userEvent.click(
      within(screen.getByRole('listbox', { name: /location/i }))
        .getAllByRole('option')
        .find((r) => r.textContent?.match(/of me/i))!,
    );

    expect(field()).toHaveValue('5');
    expect(screen.getByRole('button', { name: /apply this distance/i })).toBeEnabled();
  });

  it('drops the pending intent when Anywhere is chosen instead', async () => {
    const onChange = vi.fn();
    render(<LocationSelect {...base} onChange={onChange} />);
    await open();
    const menu = screen.getByRole('listbox', { name: /location/i });
    await userEvent.click(
      within(menu).getAllByRole('option').find((r) => r.textContent?.match(/of me/i))!,
    );
    expect(within(menu).getByText(/measured from/i)).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole('option', { name: /anywhere/i }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'anywhere' });
  });

  it('hints with an example, not the minimum', async () => {
    // "1" read as a prefilled value rather than a hint — and it is not the
    // number the row prefills on engage either, so it was doubly misleading.
    render(<LocationSelect {...base} />);
    await open();

    expect(field()).toHaveAttribute('placeholder', 'ex: 5');
    // Still empty until the row is engaged.
    expect(field()).toHaveValue('');
  });
});
