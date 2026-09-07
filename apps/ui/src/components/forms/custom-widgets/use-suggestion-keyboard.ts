/**
 * Keyboard navigation for the autocomplete widgets' suggestion lists.
 *
 * Those lists were mouse-only: an input, and a list of clickable items with no
 * key handling, no roles and no active-option tracking. A keyboard user could
 * type a query, watch suggestions appear, and have no way to reach them —
 * arrow keys did nothing at all.
 *
 * One hook rather than three copies, because the three widgets (location,
 * multi-location, reference) differ only in what selecting does.
 *
 * The ARIA half is not decoration: `aria-activedescendant` is how a screen
 * reader announces the option the arrow keys moved to, and it only works when
 * the referenced element is a `role="option"` inside a `role="listbox"`. Wiring
 * the keys without it would look fixed for a sighted keyboard user while
 * staying silent for assistive tech, which is why the widgets' items changed
 * from `<button>` to `role="option"` at the same time.
 *
 * @module components/forms/custom-widgets/use-suggestion-keyboard
 */
import * as React from 'react';

interface UseSuggestionKeyboardArgs {
  /**
   * The suggestions currently listed, in display order.
   *
   * The array itself, not its length: the highlight has to be dropped whenever
   * the RESULTS change, and a new result set is frequently the same size as the
   * one it replaced. Callers must pass a referentially stable array (all three
   * do — `useState` or `useMemo`), because a fresh identity every render would
   * clear the highlight on every render.
   */
  items: readonly unknown[];
  /** Whether the list is showing. */
  open: boolean;
  /** Reveal the list — ArrowDown/ArrowUp on a closed list with results. */
  onOpen: () => void;
  /** Dismiss the list — Escape, or Tab away. */
  onClose: () => void;
  /** Commit the suggestion at `index` — Enter. */
  onSelect: (index: number) => void;
  /** Stable prefix for the generated option ids; must be unique per field. */
  idPrefix: string;
}

interface UseSuggestionKeyboardResult {
  /** Index of the option the keyboard is on, or -1 for none. */
  activeIndex: number;
  /** Set by pointer hover so mouse and keyboard don't disagree about the highlight. */
  setActiveIndex: (index: number) => void;
  /** The DOM id for option `index`, for the option element itself. */
  optionId: (index: number) => string;
  /**
   * What the input's `aria-activedescendant` should be — the active option's
   * id, or `undefined`.
   *
   * Undefined whenever the list is closed, not merely when nothing is active:
   * the list is unmounted while closed, so pointing `aria-activedescendant` at
   * one of its options would reference an element that isn't in the document.
   */
  activeDescendantId: string | undefined;
  /** The listbox's own id, for the input's `aria-controls`. */
  listboxId: string;
  /** Attach to the text input. */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function useSuggestionKeyboard({
  items,
  open,
  onOpen,
  onClose,
  onSelect,
  idPrefix,
}: UseSuggestionKeyboardArgs): UseSuggestionKeyboardResult {
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const count = items.length;

  const listboxId = `${idPrefix}-listbox`;
  const optionId = React.useCallback((index: number) => `${idPrefix}-option-${index}`, [idPrefix]);

  // A new set of results has no active option. Keyed on the results themselves,
  // which is load-bearing in two ways that an earlier `[count, open]` got wrong:
  //
  //   - Not on `count`. A replacement set is often the same size, and a stale
  //     index then points at whichever suggestion now occupies that slot — so
  //     Enter committed something the reader had never moved to. That is the
  //     exact failure this reset exists to prevent.
  //   - Not on `open`. Revealing the list from a keypress sets the entry index
  //     and flips `open` in the same commit, so an `open` dependency wiped the
  //     highlight the keypress had just set: ArrowDown on a closed list opened
  //     it with nothing highlighted and had to be pressed twice.
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Keep the highlighted option in view: the list scrolls (`max-h-60`), so
  // holding ArrowDown otherwise walks the highlight out of sight.
  React.useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, optionId]);

  // A closed list responds to exactly two keys: either arrow reveals it, and
  // entering at the near end (top for Down, bottom for Up) is what a native
  // combobox does.
  const handleClosedKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      onOpen();
      setActiveIndex(event.key === 'ArrowDown' ? 0 : count - 1);
    },
    [count, onOpen],
  );

  const handleOpenKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          // Clamped, not wrapped: a list that jumps back to the top when you
          // reach the bottom hides the fact that you have seen everything.
          setActiveIndex((i) => Math.min(i + 1, count - 1));
          return;

        case 'ArrowUp':
          event.preventDefault();
          // From nothing, ArrowUp enters the list at its END. Clamping from -1
          // would have entered at the start instead, making ArrowUp and
          // ArrowDown do the same thing.
          setActiveIndex((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
          return;

        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          return;

        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          return;

        case 'Enter':
          // Only swallowed when it actually commits a suggestion — otherwise
          // Enter must still reach the form and submit it.
          if (activeIndex < 0) return;
          event.preventDefault();
          onSelect(activeIndex);
          return;

        case 'Escape':
          event.preventDefault();
          onClose();
          setActiveIndex(-1);
          return;

        case 'Tab':
          // Not prevented: moving on should move on. The list just shouldn't
          // be left hanging over the next field.
          onClose();
          return;

        default:
          return;
      }
    },
    [count, activeIndex, onClose, onSelect],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (count === 0) return;
      if (open) handleOpenKey(event);
      else handleClosedKey(event);
    },
    [count, open, handleOpenKey, handleClosedKey],
  );

  return {
    activeIndex,
    setActiveIndex,
    optionId,
    activeDescendantId: open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
    listboxId,
    onKeyDown,
  };
}
