import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationSourceSelect } from '../location-source-select';

const base = {
  value: 'profile' as const,
  onChange: vi.fn(),
  profileAvailable: true,
  browserAvailable: true,
};

describe('LocationSourceSelect', () => {
  it('names the current source on the trigger, since the label is the only text below sm', async () => {
    const { rerender } = render(<LocationSourceSelect {...base} />);
    expect(screen.getByRole('button', { name: 'Location: My profile' })).toBeInTheDocument();

    rerender(<LocationSourceSelect {...base} value="browser" />);
    expect(screen.getByRole('button', { name: 'Location: Current location' })).toBeInTheDocument();
  });

  it('heads the list with what choosing does, not with the field name', async () => {
    // "Location — My profile" sitting over a map reads as a constraint on
    // which pins are shown. It is not one; the viewport is. The heading is
    // what says so, and it labels the listbox for a screen reader too.
    render(<LocationSourceSelect {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /location/i }));

    expect(screen.getByRole('listbox', { name: 'Centre the map on' })).toBeInTheDocument();
  });

  it('ticks the source in force and reports the other one on pick', async () => {
    const onChange = vi.fn();
    render(<LocationSourceSelect {...base} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /location/i }));

    expect(screen.getByRole('option', { name: /my profile/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: /current location/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    await userEvent.click(screen.getByRole('option', { name: /current location/i }));
    expect(onChange).toHaveBeenCalledWith('browser');
  });

  it('says what each source IS, so the choice is not two bare names', async () => {
    render(<LocationSourceSelect {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /location/i }));

    expect(screen.getByText('Where your active profile is')).toBeInTheDocument();
    expect(screen.getByText('Where your device is now')).toBeInTheDocument();
  });

  it('lists an unavailable source WITH its reason rather than hiding it', async () => {
    // Hiding the row would leave a viewer whose profile has no location
    // wondering why there is nothing to switch to. `aria-disabled`, not
    // `disabled`, so the reason stays in the accessibility tree.
    const onChange = vi.fn();
    render(
      <LocationSourceSelect {...base} value="browser" profileAvailable={false} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /location/i }));

    const profile = screen.getByRole('option', { name: /my profile/i });
    expect(profile).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Your profile has no location')).toBeInTheDocument();
    // The reason replaces the hint — an option never shows both.
    expect(screen.queryByText('Where your active profile is')).toBeNull();

    await userEvent.click(profile);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('explains an unavailable browser source the same way', async () => {
    render(<LocationSourceSelect {...base} browserAvailable={false} />);
    await userEvent.click(screen.getByRole('button', { name: /location/i }));

    expect(screen.getByRole('option', { name: /current location/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Your browser cannot provide a location')).toBeInTheDocument();
  });
});
