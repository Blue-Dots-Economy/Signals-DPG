/**
 * Tests for the clear affordance on single-value enum fields.
 *
 * Driven through `SchemaForm` rather than by rendering the widget directly:
 * the point of the widget is that RJSF routes every enum field to it and that
 * clearing actually removes the key from the submitted data, and neither is
 * observable from the widget in isolation.
 *
 * jsdom, not the suite's default happy-dom — RJSF v6's form submit does not
 * fire under happy-dom (same reason `schema-form.test.tsx` overrides it).
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import { SchemaForm } from '../../schema-form';

// Radix's Select calls these on the trigger; neither jsdom nor happy-dom
// implements them, and without the stubs opening the dropdown throws.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const CLEAR = 'Clear selection';

const schema = {
  type: 'object',
  required: ['fruit'],
  properties: {
    fruit: { type: 'string', title: 'Fruit', enum: ['apple', 'banana'] },
    gender: { type: 'string', title: 'Gender', enum: ['male', 'female'] },
    tags: {
      type: 'array',
      title: 'Tags',
      items: { type: 'string', enum: ['a', 'b'] },
      uniqueItems: true,
    },
  },
} as RJSFSchema;

describe('clearable enum fields', () => {
  it('clears an optional field back out of the submitted data', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', gender: 'male' }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: CLEAR }));
    await user.click(screen.getByRole('button', { name: /save|submit/i }));

    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    // The key is gone, not set to an empty string — that is what "not
    // answered" means to everything downstream.
    expect('gender' in submitted).toBe(false);
    // ...and only the field that was cleared.
    expect(submitted.fruit).toBe('apple');
  });

  it('offers no clear button on a required field, however it is filled', () => {
    render(
      <SchemaForm schema={schema} formData={{ fruit: 'apple', gender: 'male' }} onSubmit={vi.fn()} />,
    );
    // One button only — `gender`'s. `fruit` is required, so emptying it is not
    // a state it may hold and the button would invite an error, not a choice.
    expect(screen.getAllByRole('button', { name: CLEAR })).toHaveLength(1);
  });

  it('offers no clear button on an empty field — there is nothing to clear', () => {
    render(<SchemaForm schema={schema} formData={{ fruit: 'apple' }} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('offers no clear button when the form is disabled', () => {
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', gender: 'male' }}
        onSubmit={vi.fn()}
        disabled
      />,
    );
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('leaves array-of-enum fields alone — their chips are already removable', () => {
    render(
      <SchemaForm
        schema={schema}
        formData={{ fruit: 'apple', tags: ['a'] }}
        onSubmit={vi.fn()}
      />,
    );
    // `tags` holds a value and is optional, but multi-selects route to
    // FancyMultiSelect and must fall through untouched.
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('shows the placeholder again after clearing, on the cleared field itself', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SchemaForm schema={schema} formData={{ fruit: 'apple', gender: 'male' }} onSubmit={vi.fn()} />,
    );
    const gender = () => container.querySelector('#root_gender')!;
    expect(gender()).toHaveTextContent('male');

    await user.click(screen.getByRole('button', { name: CLEAR }));

    // Scoped to this field's own trigger: an unscoped `getByText('Select…')`
    // also matches the multi-select's placeholder and passes either way.
    expect(gender()).toHaveTextContent('Select');
    expect(gender()).not.toHaveTextContent('male');
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument();
  });

  it('picks a value with the arrow keys and Enter, without a mouse', async () => {
    // The reason this widget exists on Radix rather than the theme's cmdk
    // select: there, arrows moved an invisible cursor and the trigger's own
    // handler swallowed Enter, so a keyboard user could open the dropdown and
    // never choose from it.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <SchemaForm schema={schema} formData={{ fruit: 'apple' }} onSubmit={onSubmit} />,
    );

    (container.querySelector('#root_gender') as HTMLElement).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(container.querySelector('#root_gender')).toHaveTextContent(/male|female/);

    await user.click(screen.getByRole('button', { name: /save|submit/i }));
    expect(onSubmit).toHaveBeenCalled();
    const submitted = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(submitted.gender).toBeDefined();
  });
});
