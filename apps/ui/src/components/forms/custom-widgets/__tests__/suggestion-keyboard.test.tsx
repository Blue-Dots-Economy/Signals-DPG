/**
 * Keyboard navigation of the autocomplete suggestion lists.
 *
 * These lists were mouse-only: arrow keys did nothing, so a keyboard user could
 * type a query, see suggestions appear, and have no way to reach them. Driven
 * through the real widget rather than the hook in isolation, because the bug
 * was the wiring (no handler, no roles), not the arithmetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { WidgetProps } from '@rjsf/utils';

const SUGGESTIONS = [
  { label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 },
  { label: 'Bengaluru Rural, Karnataka, India', lat: 13.2, lng: 77.7 },
  { label: 'Bengaluru Urban, Karnataka, India', lat: 12.9, lng: 77.6 },
];

const suggest = vi.fn();
vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: (...args: unknown[]) => suggest(...args) }),
}));

import { LocationAutocompleteWidget } from '@/components/forms/custom-widgets/location-autocomplete-widget';

function renderWidget(overrides: Partial<WidgetProps> = {}) {
  const onChange = vi.fn();
  const props = {
    id: 'root_location',
    value: '',
    onChange,
    schema: {},
    options: {},
    label: 'Location',
    name: 'location',
    disabled: false,
    readonly: false,
    required: true,
    formContext: {},
    ...overrides,
  } as unknown as WidgetProps;
  render(<LocationAutocompleteWidget {...props} />);
  return { onChange };
}

/**
 * Types a query and lets the 300ms debounce + the provider promise settle.
 *
 * `query` matters when called twice in one test: React ignores a `change` event
 * whose value equals the current one, so re-typing the same text runs no search
 * at all and the assertions silently test nothing.
 */
async function openList(input: HTMLElement, query = 'Bengaluru') {
  fireEvent.change(input, { target: { value: query } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

describe('autocomplete suggestions — keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    suggest.mockResolvedValue(SUGGESTIONS);
    // The list scrolls, so the hook keeps the active option in view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('moves the active option with ArrowDown/ArrowUp and marks it for screen readers', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);

    // Nothing is active until a key is pressed — arriving suggestions must not
    // preselect one, or Enter would commit a choice never made.
    expect(input).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', 'root_location-option-0');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('clamps at both ends rather than wrapping around', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);

    // ArrowUp from nothing enters the list at its end, like a native combobox.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('commits the active option on Enter', async () => {
    const { onChange } = renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('Bengaluru Rural, Karnataka, India');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('leaves Enter alone when no option is active, so the form can still submit', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);

    const enter = fireEvent.keyDown(input, { key: 'Enter' });
    // `fireEvent` returns false when a handler called preventDefault.
    expect(enter).toBe(true);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('closes the list on Escape without discarding what was typed', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Bengaluru');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('drops the highlight when a fresh set of suggestions arrives', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    suggest.mockResolvedValue([SUGGESTIONS[0]!]);
    await openList(input, 'Bengaluru Ur');

    // A stale index would point at whichever suggestion now sits in that slot,
    // so Enter would commit something the reader never moved to.
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('enters at the first option when ArrowDown reveals a closed list', async () => {
    // Regression (review of #648): revealing the list sets the entry index and
    // flips `open` in the same commit, so a reset keyed on `open` wiped the
    // highlight the keypress had just set — ArrowDown had to be pressed twice.
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'root_location-option-0');
  });

  it('drops the highlight when a fresh result set is the SAME LENGTH', async () => {
    // Regression (review of #648): the reset was keyed on the result COUNT, so
    // a replacement set of equal size kept the stale index — Enter then
    // committed whichever suggestion had moved into that slot.
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    suggest.mockResolvedValue([
      { label: 'Mysuru, Karnataka, India', lat: 12.3, lng: 76.6 },
      { label: 'Mysuru Rural, Karnataka, India', lat: 12.4, lng: 76.7 },
      { label: 'Mysuru Urban, Karnataka, India', lat: 12.2, lng: 76.5 },
    ]);
    await openList(input, 'Mysuru');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('claims no active option while the list is closed', async () => {
    // The list is unmounted while closed, so an `aria-activedescendant` left
    // pointing into it would reference an element that is not in the document.
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'root_location-option-0');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('exposes the list as a listbox the input owns', async () => {
    renderWidget();
    const input = screen.getByRole('combobox');
    await openList(input);

    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input.getAttribute('aria-controls')).toBe(
      screen.getByRole('listbox').getAttribute('id'),
    );
  });
});
