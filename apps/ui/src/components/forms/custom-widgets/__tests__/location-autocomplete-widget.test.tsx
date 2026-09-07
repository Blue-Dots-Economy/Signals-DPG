import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WidgetProps } from '@rjsf/utils';

// Geo provider is called on every keystroke — stub it so no network/geocoding runs.
vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: vi.fn().mockResolvedValue([]) }),
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

describe('LocationAutocompleteWidget — required validity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits the typed string while there is text', () => {
    const { onChange } = renderWidget();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Bengaluru' } });
    expect(onChange).toHaveBeenLastCalledWith('Bengaluru');
  });

  it('emits undefined (not "") when cleared, so a required location goes back to invalid', () => {
    // Regression guard: an empty string counts as "present" for JSON-Schema
    // `required`, which previously let an emptied location publish an invalid profile.
    const { onChange } = renderWidget({ value: 'Bengaluru' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
