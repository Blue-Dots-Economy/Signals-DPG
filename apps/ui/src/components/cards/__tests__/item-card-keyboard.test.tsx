import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemCard } from '../item-card';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

const schema = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
} as const;

function renderCard(props: { onClick?: () => void; actions?: React.ReactNode } = {}) {
  const { container } = render(
    <ItemCard schema={schema} data={{ name: 'Asha' }} title="Asha" {...props} />,
  );
  return container.firstElementChild as HTMLElement;
}

describe('ItemCard whole-card activation', () => {
  it('activates on Enter from the keyboard', async () => {
    const onClick = vi.fn();
    renderCard({ onClick });

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Asha' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Space from the keyboard', async () => {
    const onClick = vi.fn();
    renderCard({ onClick });

    screen.getByRole('button', { name: 'Asha' }).focus();
    await userEvent.keyboard(' ');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on click, and names itself after the card title rather than the whole record', async () => {
    const onClick = vi.fn();
    renderCard({ onClick });

    // A short, useful accessible name — not "Asha Name Asha …" read as one control.
    const activator = screen.getByRole('button', { name: 'Asha' });
    expect(activator).toHaveAttribute('type', 'button');
    await userEvent.click(activator);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the activator free of focusable descendants, so it is not a nested interactive', () => {
    renderCard({ onClick: vi.fn(), actions: <button type="button">Connect</button> });

    const activator = screen.getByRole('button', { name: 'Asha' });
    expect(activator.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0);
  });

  it('adds nothing focusable or role-bearing when no onClick is given', () => {
    const card = renderCard();

    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
    expect(card.querySelector('[role]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not fire when one of the card own controls is activated', async () => {
    const onClick = vi.fn();
    renderCard({ onClick, actions: <button type="button">Connect</button> });

    const nested = screen.getByRole('button', { name: 'Connect' });
    nested.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(nested);

    expect(onClick).not.toHaveBeenCalled();
  });
});
