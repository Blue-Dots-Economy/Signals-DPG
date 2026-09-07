// @vitest-environment jsdom
// RJSF v6's form submission does not fire under happy-dom (the suite default),
// and the focus/validation paths exercised here all hang off a real submit, so
// this file overrides the environment per-file (same reason as
// ../schema-form.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { GeoSuggestion } from '@/lib/geo/types';
import { SchemaForm } from '../schema-form';

// Both location widgets resolve a geo provider on mount and call `suggest()` on
// every (debounced) keystroke. Stub the module so no geocoding request is made.
// `vi.hoisted` keeps the spy reachable from the factory without referencing a
// plain top-level binding (which would not yet be initialised).
const geo = vi.hoisted(() => ({
  suggest: vi.fn(
    (_query: string, _signal?: AbortSignal): Promise<GeoSuggestion[]> =>
      Promise.resolve([]),
  ),
}));
vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: geo.suggest }),
}));

/** Reference datasets are fetched over HTTP by ReferenceAutocompleteWidget. */
function stubReferenceFetch(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      } as unknown as Response),
    ),
  );
}

beforeEach(() => {
  geo.suggest.mockReset();
  geo.suggest.mockResolvedValue([]);
  // jsdom does not implement scrollIntoView, which focusOnFirstError calls on a
  // blocked submit. Without this the handler throws instead of focusing.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoViewStub() {};
  }
  // cmdk (behind the multi-select) observes its list container on open.
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Custom widget registry wiring (which widget generateUiSchema picks)
// ---------------------------------------------------------------------------

describe('SchemaForm custom widget registry', () => {
  it('renders a date field with the DatePickerWidget instead of a text input', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { dob: { type: 'string', format: 'date', title: 'Date of Birth' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    // DatePickerWidget renders a popover button trigger, not a text input.
    const trigger = screen.getByLabelText('Date of Birth');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveTextContent('Pick a date');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders a single location field with the single-value autocomplete (no add-row control)', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        city: { type: 'string', title: 'City', location: 'primary' },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('City')).toBeInstanceOf(HTMLInputElement);
    // The multi-location widget is the only one with an add-row affordance.
    expect(screen.queryByRole('button', { name: /add city/i })).not.toBeInTheDocument();
  });

  it('renders an ARRAY location field with the multi-location widget (add + remove rows)', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        cities: {
          type: 'array',
          title: 'Cities Served',
          location: 'secondary',
          items: { type: 'string' },
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByRole('button', { name: /add city/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search for a city…')).toBeInTheDocument();
    // RJSF's default array widget (which this replaces) numbers rows with its
    // own "Add"/move buttons — none of those are present.
    expect(screen.queryByRole('button', { name: /^move/i })).not.toBeInTheDocument();
  });

  it('fills a location field from a picked geo suggestion and submits the label', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Bengaluru, Karnataka', lat: 12.97, lng: 77.59, components: { city: 'Bengaluru' } },
    ]);
    const onSubmit = vi.fn((_data: Record<string, unknown>) => undefined);
    const schema: RJSFSchema = {
      type: 'object',
      properties: { city: { type: 'string', title: 'City', location: 'primary' } },
    } as unknown as RJSFSchema;

    render(<SchemaForm schema={schema} onSubmit={onSubmit} submitButtonText="Save" />);
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Beng' } });

    const option = await screen.findByRole('option', { name: 'Bengaluru, Karnataka' });
    fireEvent.mouseDown(option);

    await waitFor(() => expect(screen.getByLabelText('City')).toHaveValue('Bengaluru, Karnataka'));

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Only the human-readable label is stored on the item; the coordinate is a
    // side channel (see the formContext test below).
    expect(onSubmit.mock.calls[0][0]).toEqual({ city: 'Bengaluru, Karnataka' });
  });

  it('does NOT reach the formContext location callbacks — RJSF v6 drops the widget formContext prop', async () => {
    // Documents ACTUAL behaviour, which contradicts the widget/page code:
    // profile-form-page passes `onLocationResolved` through SchemaForm's
    // `formContext`, and the location widgets read a `formContext` PROP — but
    // RJSF v6 only exposes it as `registry.formContext` and no longer spreads it
    // onto widget props, so the picked coordinate never reaches the page.
    geo.suggest.mockResolvedValue([
      { label: 'Mysuru, Karnataka', lat: 12.29, lng: 76.63, components: { city: 'Mysuru' } },
    ]);
    const onLocationResolved = vi.fn((_place: unknown) => undefined);
    const schema: RJSFSchema = {
      type: 'object',
      properties: { city: { type: 'string', title: 'City', location: 'primary' } },
    } as unknown as RJSFSchema;

    render(
      <SchemaForm schema={schema} onSubmit={vi.fn()} formContext={{ onLocationResolved }} />,
    );
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Mysu' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Mysuru, Karnataka' }));

    await waitFor(() => expect(screen.getByLabelText('City')).toHaveValue('Mysuru, Karnataka'));
    expect(onLocationResolved).not.toHaveBeenCalled();
  });

  it('adds and removes rows on the multi-location widget', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        cities: {
          type: 'array',
          title: 'Cities Served',
          location: 'secondary',
          items: { type: 'string' },
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getAllByPlaceholderText('Search for a city…')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /add city/i }));
    expect(screen.getAllByPlaceholderText('Search for a city…')).toHaveLength(2);

    await userEvent.click(screen.getAllByRole('button', { name: /^Remove city/ })[0]);
    expect(screen.getAllByPlaceholderText('Search for a city…')).toHaveLength(1);
  });

  it('renders an x-reference-source field with the reference autocomplete (bare-string marker)', async () => {
    stubReferenceFetch([
      { name: 'Alpha Institute', district: 'Mandya', state: 'Karnataka' },
      { name: 'Beta College', district: 'Hassan', state: 'Karnataka' },
    ]);
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        college: { type: 'string', title: 'College', 'x-reference-source': 'refsrc-bare' },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('College'), { target: { value: 'Alph' } });

    const option = await screen.findByRole('option', { name: /Alpha Institute/ });
    // Default subtitle config is ["district"] — the state must NOT be shown.
    expect(option).toHaveTextContent('Mandya');
    expect(option).not.toHaveTextContent('Karnataka');

    fireEvent.mouseDown(option);
    await waitFor(() => expect(screen.getByLabelText('College')).toHaveValue('Alpha Institute'));
  });

  it('passes the object-form marker subtitle list through to the reference widget', async () => {
    stubReferenceFetch([{ name: 'Gamma Polytechnic', district: 'Kolar', state: 'Karnataka' }]);
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        institute: {
          type: 'string',
          title: 'Institute',
          // Non-string subtitle entries are dropped by generateUiSchema.
          'x-reference-source': { source: 'refsrc-object', subtitle: ['state', 7] },
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Institute'), { target: { value: 'Gamm' } });

    const option = await screen.findByRole('option', { name: /Gamma Polytechnic/ });
    expect(option).toHaveTextContent('Karnataka');
    expect(option).not.toHaveTextContent('Kolar');
  });

  it('ignores an x-reference-source marker with no usable source (plain input, no fetch)', () => {
    const fetchSpy = vi.fn((_url: string) => Promise.resolve({} as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        trade: { type: 'string', title: 'Trade', 'x-reference-source': { subtitle: ['district'] } },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('Trade')).toBeInstanceOf(HTMLInputElement);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Placeholders: format defaults, enum default, field-level override
// ---------------------------------------------------------------------------

describe('SchemaForm placeholder derivation', () => {
  it('gives an email field the sample-address placeholder', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { email: { type: 'string', format: 'email', title: 'Email Address' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Email Address')).toHaveAttribute(
      'placeholder',
      'email@example.com',
    );
  });

  it('lets a schema-supplied placeholder win over the format default', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          format: 'email',
          title: 'Email Address',
          placeholder: 'you@school.edu',
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Email Address')).toHaveAttribute(
      'placeholder',
      'you@school.edu',
    );
  });

  it('shows the generic Select… prompt on a string enum field', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { grade: { type: 'string', title: 'Grade', enum: ['9', '10'] } },
    };
    const { container } = render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    // Radix Select dropdowns are unreliable to open in a test DOM; assert the
    // user-visible placeholder on the closed trigger instead.
    expect(container).toHaveTextContent('Select...');
  });

  it('keeps a property literally NAMED "placeholder" as a real field', () => {
    // The strip guard is `typeof value === 'string'`, so a property whose NAME
    // is "placeholder" (value = a schema object) must survive.
    const schema: RJSFSchema = {
      type: 'object',
      properties: { placeholder: { type: 'string', title: 'Placeholder Text' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Placeholder Text')).toBeInTheDocument();
  });

  it('keeps a property literally NAMED "location" as a real field', () => {
    // The `location` marker strip only applies when the VALUE is
    // "primary"/"secondary"; a property named "location" is a normal field and
    // must not get the autocomplete widget or be removed.
    const schema: RJSFSchema = {
      type: 'object',
      properties: { location: { type: 'string', title: 'Location Notes' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Location Notes')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// $ref resolution + array-of-enum normalisation
// ---------------------------------------------------------------------------

describe('SchemaForm $ref normalisation', () => {
  it('resolves a local $ref array-of-enum into a single multi-select (not a stack of rows)', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      $defs: {
        support_category: { type: 'string', enum: ['Tuition', 'Counselling', 'Mentoring'] },
      },
      properties: {
        services: {
          type: 'array',
          title: 'Services',
          items: { $ref: '#/$defs/support_category' },
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByText('Services')).toBeInTheDocument();
    // One FancyMultiSelect combobox input for the whole array — RJSF's default
    // array UI would instead render an "Add" button plus one control per row.
    const combo = screen.getByPlaceholderText('Select ...');
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument();

    // The options come from the $ref'd $defs enum, proving the ref resolved.
    fireEvent.focus(combo);
    expect(await screen.findByText('Counselling')).toBeInTheDocument();
  });

  it('leaves an array whose $ref target has no enum as a plain array field', () => {
    const schema: RJSFSchema = {
      type: 'object',
      $defs: { free_text: { type: 'string' } },
      properties: {
        notes: { type: 'array', title: 'Notes', items: { $ref: '#/$defs/free_text' } },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByText('Notes')).toBeInTheDocument();
    // No enum → no multi-select conversion → RJSF's array UI with an add control.
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('accepts a $ref that carries sibling keywords (siblings win over the target)', () => {
    const schema: RJSFSchema = {
      type: 'object',
      $defs: { base_text: { type: 'string', title: 'Base Title' } },
      properties: {
        nickname: { $ref: '#/$defs/base_text', title: 'Nickname' },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText('Nickname')).toBeInTheDocument();
    expect(screen.queryByText('Base Title')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// compact mode hides `private` fields
// ---------------------------------------------------------------------------

describe('SchemaForm compact mode', () => {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Full Name' },
      phone: { type: 'string', title: 'Phone Number', private: true },
    },
  } as unknown as RJSFSchema;

  it('hides a private field in compact mode', () => {
    render(<SchemaForm schema={schema} mode="compact" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Full Name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Phone Number')).not.toBeInTheDocument();
  });

  it('shows the same private field in full mode (the default)', () => {
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Phone Number')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sectioned layout (x-form-layout / resolveFormLayout)
// ---------------------------------------------------------------------------

const layoutSchema = {
  type: 'object',
  'x-form-layout': {
    sections: [
      { title: 'About You', fields: ['name', 'phone', 'email'] },
      { title: 'Academics', fields: ['grade'] },
    ],
    twoColumn: ['phone', 'email'],
  },
  properties: {
    name: { type: 'string', title: 'Full Name' },
    phone: { type: 'string', title: 'Phone Number' },
    email: { type: 'string', title: 'Email Address' },
    grade: { type: 'string', title: 'Grade' },
    // Deliberately absent from every section — must still render.
    referral: { type: 'string', title: 'Referral Code' },
  },
} as unknown as RJSFSchema;

describe('SchemaForm sectioned layout', () => {
  it('renders numbered section headers at h3 by default', () => {
    render(<SchemaForm schema={layoutSchema} onSubmit={vi.fn()} />);

    const about = screen.getByRole('heading', { level: 3, name: 'About You' });
    const academics = screen.getByRole('heading', { level: 3, name: 'Academics' });
    expect(about).toBeInTheDocument();
    expect(academics).toBeInTheDocument();
    // Each section is numbered in order.
    expect(about.previousSibling).toHaveTextContent('1');
    expect(academics.previousSibling).toHaveTextContent('2');
  });

  it('renders section headers at h2 when sectionHeadingLevel is 2', () => {
    render(<SchemaForm schema={layoutSchema} onSubmit={vi.fn()} sectionHeadingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'About You' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'About You' })).not.toBeInTheDocument();
  });

  it('pairs consecutive twoColumn fields into one responsive row', () => {
    const { container } = render(<SchemaForm schema={layoutSchema} onSubmit={vi.fn()} />);

    const rows = container.querySelectorAll('div.grid.grid-cols-1.sm\\:grid-cols-2');
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByLabelText('Phone Number')).toBeInTheDocument();
    expect(within(row).getByLabelText('Email Address')).toBeInTheDocument();
    // A non-twoColumn field is never pulled into the pair row.
    expect(within(row).queryByLabelText('Full Name')).not.toBeInTheDocument();
  });

  it('still renders fields that no section lists', () => {
    render(<SchemaForm schema={layoutSchema} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Referral Code')).toBeInTheDocument();
  });

  it('skips an empty section and keeps the visible numbering contiguous', () => {
    const schema = {
      type: 'object',
      'x-form-layout': {
        sections: [
          { title: 'About You', fields: ['name'] },
          // `secret` is hidden by x-show-if below, so this section is empty.
          { title: 'Hidden Section', fields: ['secret'] },
          { title: 'Academics', fields: ['grade'] },
        ],
        twoColumn: [],
      },
      properties: {
        name: { type: 'string', title: 'Full Name' },
        secret: { type: 'string', title: 'Secret', 'x-show-if': { name: ['open'] } },
        grade: { type: 'string', title: 'Grade' },
      },
    } as unknown as RJSFSchema;

    render(<SchemaForm schema={schema} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('heading', { name: 'Hidden Section' })).not.toBeInTheDocument();
    // Academics is the SECOND rendered section, so it is badged "2", not "3".
    expect(screen.getByRole('heading', { level: 3, name: 'Academics' }).previousSibling)
      .toHaveTextContent('2');
  });

  it('falls back to the code-side layout map when the schema has no x-form-layout', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        'Full Name': { type: 'string', title: 'Full Name' },
        Grade: { type: 'string', title: 'Grade' },
      },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} domainId="student" />);

    expect(screen.getByRole('heading', { name: 'About You' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Academics' })).toBeInTheDocument();
  });

  it('renders a plain column with no section headings when no layout resolves', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { name: { type: 'string', title: 'Full Name' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} domainId="no_such_domain" />);

    expect(screen.getByLabelText('Full Name')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Submit / validation errors / onError / focusOnFirstError
// ---------------------------------------------------------------------------

describe('SchemaForm submit and validation', () => {
  const requiredSchema: RJSFSchema = {
    type: 'object',
    required: ['name', 'email'],
    properties: {
      name: { type: 'string', title: 'Full Name', minLength: 1 },
      email: { type: 'string', title: 'Email Address', format: 'email' },
    },
  };

  it('blocks submit, reports errors to onError and shows the message in the field', async () => {
    const onSubmit = vi.fn((_data: Record<string, unknown>) => undefined);
    const onError = vi.fn((_errors: unknown[]) => undefined);
    render(
      <SchemaForm
        schema={requiredSchema}
        onSubmit={onSubmit}
        onError={onError}
        submitButtonText="Save"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const errors = onError.mock.calls[0][0];
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    // Messages are shown inline per field (showErrorList is false, so there is
    // no summary block — each field must carry its own message).
    expect(await screen.findByText("must have required property 'Full Name'")).toBeInTheDocument();
    expect(screen.getByText("must have required property 'Email Address'")).toBeInTheDocument();
  });

  it('focuses the first offending field so the user is taken to the problem', async () => {
    render(
      <SchemaForm schema={requiredSchema} onSubmit={vi.fn()} submitButtonText="Save" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const nameInput = screen.getByLabelText(/Full Name/);
    await waitFor(() => expect(document.activeElement).toBe(nameInput));
  });

  it('focuses a widget whose id sits on a wrapping button (date picker)', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      required: ['dob'],
      properties: { dob: { type: 'string', format: 'date', title: 'Date of Birth' } },
    };
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} submitButtonText="Save" />);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const trigger = screen.getByLabelText(/Date of Birth/);
    expect(trigger.tagName).toBe('BUTTON');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('focuses a widget that owns no element with the exact error id (prefix fallback)', async () => {
    // The multi-location widget puts ids on its ROWS (`root_cities_0`), so the
    // error id derived from `.cities` (`root_cities`) matches nothing exactly —
    // the prefix fallback must still take the user to the first row.
    const schema: RJSFSchema = {
      type: 'object',
      required: ['cities'],
      properties: {
        cities: {
          type: 'array',
          title: 'Cities Served',
          location: 'secondary',
          minItems: 2,
          items: { type: 'string', minLength: 1 },
        },
      },
    } as unknown as RJSFSchema;
    render(<SchemaForm schema={schema} onSubmit={vi.fn()} submitButtonText="Save" />);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const firstRow = screen.getAllByPlaceholderText('Search for a city…')[0];
    expect(firstRow).toHaveAttribute('id', 'root_cities_0');
    await waitFor(() => expect(document.activeElement).toBe(firstRow));
  });

  it('focuses a required field nested inside an array item', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          title: 'Contacts',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', title: 'Contact Name' } },
          },
        },
      },
    };
    render(
      <SchemaForm
        schema={schema}
        formData={{ contacts: [{}] }}
        onSubmit={vi.fn()}
        submitButtonText="Save"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const nested = screen.getByLabelText(/Contact Name/);
    expect(nested).toHaveAttribute('id', 'root_contacts_0_name');
    await waitFor(() => expect(document.activeElement).toBe(nested));
  });

  it('submits the collected data (and drops keys the schema does not declare)', async () => {
    const onSubmit = vi.fn((_data: Record<string, unknown>) => undefined);
    const onError = vi.fn((_errors: unknown[]) => undefined);
    render(
      <SchemaForm
        schema={requiredSchema}
        formData={{ name: 'Asha', email: 'asha@example.com', stray: 'drop me' }}
        onSubmit={onSubmit}
        onError={onError}
        submitButtonText="Save"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'Asha', email: 'asha@example.com' });
    expect(payload).not.toHaveProperty('stray');
  });

  it('survives a blocked submit with no onError handler wired', async () => {
    const onSubmit = vi.fn((_data: Record<string, unknown>) => undefined);
    render(<SchemaForm schema={requiredSchema} onSubmit={onSubmit} submitButtonText="Save" />);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("must have required property 'Full Name'")).toBeInTheDocument();
  });

  it('re-seeds the form when the formData prop identity changes (async edit load)', async () => {
    const { rerender } = render(
      <SchemaForm schema={requiredSchema} onSubmit={vi.fn()} submitButtonText="Save" />,
    );
    expect(screen.getByLabelText(/Full Name/)).toHaveValue('');

    rerender(
      <SchemaForm
        schema={requiredSchema}
        formData={{ name: 'Loaded Later' }}
        onSubmit={vi.fn()}
        submitButtonText="Save"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/Full Name/)).toHaveValue('Loaded Later'));
  });

  it('disables every input (and the submit) when disabled is set', () => {
    render(
      <SchemaForm
        schema={requiredSchema}
        onSubmit={vi.fn()}
        disabled
        submitButtonText="Save"
      />,
    );
    expect(screen.getByLabelText(/Full Name/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('puts the given id on the rendered form element so an external submit can target it', () => {
    const { container } = render(
      <SchemaForm schema={requiredSchema} onSubmit={vi.fn()} id="profile-form" hideSubmit />,
    );
    expect(container.querySelector('form')).toHaveAttribute('id', 'profile-form');
  });
});
