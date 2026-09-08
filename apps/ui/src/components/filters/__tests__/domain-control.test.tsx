import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DomainControl } from '../domain-control';

/**
 * The one domain control (#645, spec D10/D11). Replaces the sidebar Browse tab
 * AND the facet panel's own domain multi-select — domain IS a filter, so it
 * lives with the other filters.
 *
 * Single-select on the list (one `/discover` call takes exactly one
 * `item_domain`); multi-select on the map (one `/markers` call per domain).
 */

// All three are BROWSABLE. Callers filter non-browsable domains out before
// they reach this component (reversing spec D7), so there is no such thing as
// an unavailable option here any more.
const opts = [
  { id: 'provider', label: 'Provider' },
  { id: 'trainer', label: 'Trainer' },
  { id: 'seeker', label: 'Seeker' },
];

describe('DomainControl — single mode (list)', () => {
  it('replaces the selection rather than adding to it', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['trainer']);
  });

  it('marks the selected option pressed and the others not', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Provider/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Trainer/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('never deselects the last domain — the list always needs exactly one', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="single" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — multi mode (map)', () => {
  it('adds to the selection', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider', 'trainer']);
  });

  it('removes from the selection', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl
        options={opts}
        mode="multi"
        selected={['provider', 'trainer']}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Trainer/ }));
    expect(onChange).toHaveBeenCalledWith(['provider']);
  });

  it('never empties the selection — a blank map with no way back is worse', async () => {
    const onChange = vi.fn();
    render(
      <DomainControl options={opts} mode="multi" selected={['provider']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Provider/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DomainControl — accessibility', () => {
  it('is a labelled group', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /domain/i })).toBeInTheDocument();
  });

  it('keeps a coarse-pointer touch target on every option', () => {
    render(<DomainControl options={opts} mode="single" selected={['provider']} onChange={vi.fn()} />);
    for (const name of [/Provider/, /Trainer/, /Seeker/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('pointer-coarse:min-h-11');
    }
  });
});

describe('DomainControl — single selectable domain', () => {
  it('states the domain instead of rendering a control (Q1)', () => {
    // A seeker in a network with no seeker->seeker edge can browse exactly one
    // domain. The caller filters the non-browsable ones out (reversing spec
    // D7), so a single option arrives and there is no choice to render.
    render(
      <DomainControl
        options={[{ id: 'provider', label: 'Provider', pluralLabel: 'Providers' }]}
        mode="single"
        selected={['provider']}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId('domain-single-label')).toHaveTextContent('Providers');
    // A real heading, not small muted text: with the page-header title removed
    // (#645) this is the browse page's only statement of what is on screen, so
    // it carries the document's heading rank too.
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute(
      'data-testid',
      'domain-single-label',
    );
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('renders the control when two domains are browsable', () => {
    render(
      <DomainControl
        options={[
          { id: 'provider', label: 'Provider' },
          { id: 'seeker', label: 'Seeker' },
        ]}
        mode="single"
        selected={['provider']}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByTestId('domain-single-label')).toBeNull();
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('renders nothing when there is no browsable domain', () => {
    const { container } = render(
      <DomainControl options={[]} mode="single" selected={[]} onChange={() => {}} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('never renders a disabled tab — a non-browsable domain is simply absent', () => {
    // Reverses spec D7. Listing the domain and disabling it put a permanently
    // dead button in the middle of the primary browse control, which reads as
    // a broken toggle rather than as an explanation of the interaction matrix.
    render(
      <DomainControl
        options={[
          { id: 'provider', label: 'Provider' },
          { id: 'service_provider', label: 'Service Provider' },
        ]}
        mode="multi"
        selected={['provider']}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /Seeker/ })).toBeNull();
    for (const b of screen.getAllByRole('button')) expect(b).not.toBeDisabled();
  });
});
