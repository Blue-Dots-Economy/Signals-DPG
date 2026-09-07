import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WidgetProps } from '@rjsf/utils';
import type { GeoSuggestion } from '@/lib/geo/types';

// The multi-location widget resolves a geo provider on mount and calls
// `suggest()` on every (debounced) keystroke. Stub the module so no geocoding
// network call is ever made. `vi.hoisted` keeps the mock fn reachable from the
// factory without touching a plain top-level binding.
const geo = vi.hoisted(() => ({
  suggest: vi.fn(
    (_query: string, _signal?: AbortSignal): Promise<GeoSuggestion[]> =>
      Promise.resolve([]),
  ),
}));

vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: geo.suggest }),
}));

import { ReferenceAutocompleteWidget } from '@/components/forms/custom-widgets/reference-autocomplete-widget';
import { MultiLocationAutocompleteWidget } from '@/components/forms/custom-widgets/multi-location-autocomplete-widget';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof makeFetchMock>;

function makeFetchMock(payload: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  return vi.fn((_url: string) =>
    Promise.resolve({
      ok,
      status: init?.status ?? (ok ? 200 : 404),
      json: () => Promise.resolve(payload),
    } as unknown as Response),
  );
}

function stubFetch(payload: unknown, init?: { ok?: boolean; status?: number }): FetchMock {
  const fetchMock = makeFetchMock(payload, init);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setRuntimeConfig(cfg: Record<string, string>) {
  (window as unknown as { __DPG_UI_CONFIG__: unknown }).__DPG_UI_CONFIG__ = cfg;
}

function referenceProps(overrides: Partial<WidgetProps> = {}): WidgetProps {
  return {
    id: 'root_college',
    value: '',
    onChange: vi.fn(),
    schema: { type: 'string' },
    options: {},
    label: 'College',
    name: 'college',
    disabled: false,
    readonly: false,
    required: false,
    formContext: {},
    ...overrides,
  } as unknown as WidgetProps;
}

function renderReference(overrides: Partial<WidgetProps> = {}) {
  const onChange = vi.fn((_next: unknown) => undefined);
  const props = referenceProps({ onChange, ...overrides });
  const utils = render(<ReferenceAutocompleteWidget {...props} />);
  return { onChange, ...utils, props };
}

/** Fresh dataset id per test — the widget's dataset cache is module-level. */
let dsCounter = 0;
function uniqueSource(prefix = 'ds'): string {
  dsCounter += 1;
  return `${prefix}-${dsCounter}`;
}

const FLAT_ONE = [
  { name: 'Alpha Engineering College', district: 'Bengaluru Urban', state: 'Karnataka' },
];

function renderMultiLocation(overrides: Partial<WidgetProps> = {}) {
  const onChange = vi.fn((_next: unknown) => undefined);
  const onLocationsResolved = vi.fn(
    (_coords: Array<{ lat: number; lng: number; label?: string }>) => undefined,
  );
  const props = {
    id: 'root_cities',
    value: undefined,
    onChange,
    schema: { type: 'array', items: { type: 'string' } },
    options: { isPrimaryLocation: true },
    label: 'Cities',
    name: 'cities',
    disabled: false,
    readonly: false,
    required: false,
    formContext: { onLocationsResolved },
    ...overrides,
  } as unknown as WidgetProps;
  const utils = render(<MultiLocationAutocompleteWidget {...props} />);
  return { onChange, onLocationsResolved, ...utils, props };
}

beforeEach(() => {
  vi.clearAllMocks();
  geo.suggest.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { __DPG_UI_CONFIG__?: unknown }).__DPG_UI_CONFIG__;
});

// ===========================================================================
// ReferenceAutocompleteWidget — dataset resolution (#433)
// ===========================================================================

describe('ReferenceAutocompleteWidget — dataset URL resolution', () => {
  it('maps the bare "colleges" source to the default ka region dataset', async () => {
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: { source: 'colleges' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      new URL('/reference/colleges-ka.json', window.location.origin).toString(),
    );
  });

  it('honours VITE_COLLEGE_DATASET so one build can serve another region', async () => {
    setRuntimeConfig({ VITE_COLLEGE_DATASET: 'up' });
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: { source: 'colleges' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain('/reference/colleges-up.json');
  });

  it('uses any non-colleges source id verbatim', async () => {
    const source = uniqueSource('trades');
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain(`/reference/${source}.json`);
  });

  it('resolves a relative VITE_REFERENCE_BASE_URL against the UI origin, adding the missing slash', async () => {
    const source = uniqueSource('base-rel');
    setRuntimeConfig({ VITE_REFERENCE_BASE_URL: '/cdn/lists' });
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      new URL(`/cdn/lists/${source}.json`, window.location.origin).toString(),
    );
  });

  it('uses an absolute VITE_REFERENCE_BASE_URL as-is (datasets hosted off-origin)', async () => {
    const source = uniqueSource('base-abs');
    setRuntimeConfig({ VITE_REFERENCE_BASE_URL: 'https://registry.example.org/ref/' });
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://registry.example.org/ref/${source}.json`,
    );
  });

  it('does not fetch anything when no source is configured', async () => {
    const fetchMock = stubFetch(FLAT_ONE);
    renderReference({ options: {} });

    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ReferenceAutocompleteWidget — suggestions + the plain-string invariant
// ===========================================================================

describe('ReferenceAutocompleteWidget — suggestions and stored value', () => {
  it('suppresses suggestions until at least 2 characters are typed', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'A' } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Al' } });
    expect(
      await screen.findByRole('option', { name: /Alpha Engineering College/ }),
    ).toBeInTheDocument();
  });

  it('stores the plain option NAME as a string when a suggestion is picked', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    const { onChange } = renderReference({ options: { source } });

    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.type(input, 'alpha');

    const option = await screen.findByRole('option', { name: /Alpha Engineering College/ });
    await user.click(option);

    // The key #433 invariant: the field stays `type: "string"`, so the widget
    // must emit the bare name — never an id, object or index.
    expect(onChange).toHaveBeenLastCalledWith('Alpha Engineering College');
    expect(typeof onChange.mock.lastCall?.[0]).toBe('string');
    expect(input).toHaveValue('Alpha Engineering College');
    // Picking closes the list.
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('keeps free-text values working — unmatched typing is still emitted verbatim', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    const { onChange } = renderReference({ options: { source } });

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'Some Unlisted Polytechnic' },
    });

    expect(onChange).toHaveBeenLastCalledWith('Some Unlisted Polytechnic');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('prefills an existing free-text value and resyncs when RJSF pushes a new one', () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    const props = referenceProps({ options: { source }, value: 'Legacy Free Text' });
    const { rerender } = render(<ReferenceAutocompleteWidget {...props} />);

    expect(screen.getByRole('combobox')).toHaveValue('Legacy Free Text');

    rerender(
      <ReferenceAutocompleteWidget {...referenceProps({ ...props, value: 'Edited Elsewhere' })} />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('Edited Elsewhere');
  });

  it('matches case-insensitively on a substring, not just a prefix', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ENGINEERING' } });
    expect(
      await screen.findByRole('option', { name: /Alpha Engineering College/ }),
    ).toBeInTheDocument();
  });

  it('caps the rendered suggestion list at 50 entries', async () => {
    const source = uniqueSource();
    const many = Array.from({ length: 62 }, (_, i) => ({
      name: `Engineering College ${i}`,
      district: 'Somewhere',
    }));
    stubFetch(many);
    renderReference({ options: { source } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'engineering' } });

    await screen.findByRole('option', { name: /Engineering College 0/ });
    expect(screen.getAllByRole('option')).toHaveLength(50);
  });

  it('closes the list shortly after blur', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'alpha' } });
    await screen.findByRole('option', { name: /Alpha Engineering College/ });

    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });

  it('reopens the list on focus when the current text still matches', async () => {
    const source = uniqueSource();
    stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'alpha' } });
    await screen.findByRole('option', { name: /Alpha Engineering College/ });

    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());

    fireEvent.focus(input);
    expect(
      await screen.findByRole('option', { name: /Alpha Engineering College/ }),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
// ReferenceAutocompleteWidget — dataset shapes
// ===========================================================================

describe('ReferenceAutocompleteWidget — dataset shapes', () => {
  it('flattens a hierarchical dataset, inheriting district/state from the parents', async () => {
    const source = uniqueSource('hier');
    stubFetch({
      states: [
        {
          name: 'Karnataka',
          districts: [
            {
              name: 'Mysuru',
              organizations: [
                { name: 'Beta Institute' },
                { name: 'Gamma Institute', district: 'Mandya', state: 'Karnataka-South' },
                { code: 'no-name-so-skipped' },
              ],
            },
          ],
        },
      ],
    });
    renderReference({ options: { source, subtitleFields: ['district', 'state'] } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'institute' } });

    // Parent district/state inherited.
    expect(await screen.findByText('Mysuru, Karnataka')).toBeInTheDocument();
    // Organization-level fields win over the parents'.
    expect(screen.getByText('Mandya, Karnataka-South')).toBeInTheDocument();
    // The nameless entry is dropped entirely.
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('drops flat-dataset entries whose name is missing or not a string', async () => {
    const source = uniqueSource('flat');
    stubFetch([
      { name: 'Valid Institute' },
      { code: 'nameless Institute' },
      { name: 42, district: 'Institute' },
    ]);
    renderReference({ options: { source } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'institute' } });

    expect(await screen.findByRole('option', { name: 'Valid Institute' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('degrades to a plain text input when the dataset fetch 404s', async () => {
    const source = uniqueSource('missing');
    const fetchMock = stubFetch(null, { ok: false, status: 404 });
    const { onChange } = renderReference({ options: { source } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Alpha Engineering' } });

    // No suggestions, but the typed value is still captured.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('Alpha Engineering');
  });

  it('degrades to a plain text input when the dataset body is unparseable', async () => {
    const source = uniqueSource('badjson');
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { onChange } = renderReference({ options: { source } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anything' } });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith('anything');
  });
});

// ===========================================================================
// ReferenceAutocompleteWidget — subtitle config
// ===========================================================================

describe('ReferenceAutocompleteWidget — subtitle config', () => {
  it('defaults to district-only when the marker carries no subtitle list', async () => {
    const source = uniqueSource('sub-default');
    stubFetch(FLAT_ONE);
    renderReference({ options: { source } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alpha' } });

    expect(await screen.findByText('Bengaluru Urban')).toBeInTheDocument();
    expect(screen.queryByText(/Karnataka/)).not.toBeInTheDocument();
  });

  it('renders the configured subtitle fields in the configured order', async () => {
    const source = uniqueSource('sub-order');
    stubFetch(FLAT_ONE);
    renderReference({ options: { source, subtitleFields: ['state', 'district'] } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alpha' } });

    expect(await screen.findByText('Karnataka, Bengaluru Urban')).toBeInTheDocument();
  });

  it('treats an explicit empty subtitle list as name-only', async () => {
    const source = uniqueSource('sub-empty');
    stubFetch(FLAT_ONE);
    renderReference({ options: { source, subtitleFields: [] } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alpha' } });

    await screen.findByRole('option', { name: 'Alpha Engineering College' });
    expect(screen.queryByText('Bengaluru Urban')).not.toBeInTheDocument();
    expect(screen.queryByText(/Karnataka/)).not.toBeInTheDocument();
  });

  it('drops subtitle fields outside the allowed set', async () => {
    const source = uniqueSource('sub-unknown');
    stubFetch(FLAT_ONE);
    renderReference({ options: { source, subtitleFields: ['postcode', 'state'] } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'alpha' } });

    // `postcode` is not a supported option field, so only `state` survives.
    expect(await screen.findByText('Karnataka')).toBeInTheDocument();
  });

  it('omits the subtitle line when the option has no values for it', async () => {
    const source = uniqueSource('sub-none');
    stubFetch([{ name: 'Bare Institute' }]);
    renderReference({ options: { source, subtitleFields: ['district', 'state'] } });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bare' } });

    const option = await screen.findByRole('option', { name: 'Bare Institute' });
    expect(option.textContent).toBe('Bare Institute');
  });
});

// ===========================================================================
// ReferenceAutocompleteWidget — disabled / errors
// ===========================================================================

describe('ReferenceAutocompleteWidget — disabled state and errors', () => {
  it('disables the input when RJSF marks the field readonly', () => {
    stubFetch(FLAT_ONE);
    renderReference({ options: { source: uniqueSource() }, readonly: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('disables the input when RJSF marks the field disabled', () => {
    stubFetch(FLAT_ONE);
    renderReference({ options: { source: uniqueSource() }, disabled: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('renders the joined validation errors under the field', () => {
    stubFetch(FLAT_ONE);
    renderReference({
      options: { source: uniqueSource() },
      rawErrors: ['is a required property', 'must be a string'],
    });
    expect(
      screen.getByText('is a required property, must be a string'),
    ).toBeInTheDocument();
  });

  it('renders the schema placeholder on the input', () => {
    stubFetch(FLAT_ONE);
    renderReference({
      options: { source: uniqueSource() },
      placeholder: 'Search your college…',
    });
    expect(screen.getByPlaceholderText('Search your college…')).toBeInTheDocument();
  });
});

// ===========================================================================
// MultiLocationAutocompleteWidget
// ===========================================================================

describe('MultiLocationAutocompleteWidget — rows', () => {
  it('starts with one empty row on a fresh form', () => {
    renderMultiLocation();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('');
  });

  it('renders one prefilled row per incoming value', () => {
    renderMultiLocation({ value: ['Bengaluru', 'Mysuru'] });
    const inputs = screen.getAllByRole('combobox');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue('Bengaluru');
    expect(inputs[1]).toHaveValue('Mysuru');
  });

  it('ignores non-string entries in the incoming value', () => {
    renderMultiLocation({ value: ['Bengaluru', 7, null, 'Mysuru'] });
    const inputs = screen.getAllByRole('combobox');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toHaveValue('Mysuru');
  });

  it('adds a row and emits only the non-empty names', async () => {
    const { onChange } = renderMultiLocation({ value: ['Bengaluru'] });

    await userEvent.setup().click(screen.getByRole('button', { name: '+ Add city' }));

    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    // The blank new row must not leak an empty string into the stored array.
    expect(onChange).toHaveBeenLastCalledWith(['Bengaluru']);
  });

  it('removes the clicked row and emits the shortened list', async () => {
    const { onChange } = renderMultiLocation({ value: ['Bengaluru', 'Mysuru'] });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove city Bengaluru' }));

    const inputs = screen.getAllByRole('combobox');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveValue('Mysuru');
    expect(onChange).toHaveBeenLastCalledWith(['Mysuru']);
  });

  it('leaves no rows at all when the only row is removed, recoverable via "+ Add city"', async () => {
    // Documents actual behaviour: the remove button is deliberately shown on
    // every row ("so all rows can be cleared"), so clearing the last one really
    // does empty the list — the user re-adds a row rather than getting a blank
    // one back automatically.
    const { onChange } = renderMultiLocation({ value: ['Bengaluru'] });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove city Bengaluru' }));
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(onChange).toHaveBeenLastCalledWith([]);

    await user.click(screen.getByRole('button', { name: '+ Add city' }));
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('labels an unnamed row by its position', () => {
    renderMultiLocation();
    expect(screen.getByRole('button', { name: 'Remove city 1' })).toBeInTheDocument();
  });

  it('disables the add button once schema.maxItems rows exist', () => {
    renderMultiLocation({
      value: ['Bengaluru', 'Mysuru'],
      schema: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    });
    expect(screen.getByRole('button', { name: '+ Add city' })).toBeDisabled();
  });

  it('allows adding while below maxItems', () => {
    renderMultiLocation({
      value: ['Bengaluru'],
      schema: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    });
    expect(screen.getByRole('button', { name: '+ Add city' })).toBeEnabled();
  });

  it('resyncs rows when RJSF pushes a different value', () => {
    const { rerender, props } = renderMultiLocation({ value: ['Bengaluru'] });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    rerender(
      <MultiLocationAutocompleteWidget
        {...({ ...props, value: ['Bengaluru', 'Hubballi'] } as unknown as WidgetProps)}
      />,
    );

    const inputs = screen.getAllByRole('combobox');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toHaveValue('Hubballi');
  });

  it('disables every control when the widget is disabled', () => {
    renderMultiLocation({ value: ['Bengaluru'], disabled: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove city Bengaluru' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add city' })).toBeDisabled();
  });

  it('renders the joined validation errors once for the whole field', () => {
    renderMultiLocation({ value: ['Bengaluru'], rawErrors: ['must NOT have fewer than 1 items'] });
    expect(screen.getByText('must NOT have fewer than 1 items')).toBeInTheDocument();
  });
});

describe('MultiLocationAutocompleteWidget — geocoding', () => {
  it('skips the geo lookup below 3 characters and debounces the rest', async () => {
    geo.suggest.mockResolvedValue([]);
    renderMultiLocation();

    const input = screen.getAllByRole('combobox')[0];
    fireEvent.change(input, { target: { value: 'Be' } });
    fireEvent.change(input, { target: { value: 'Bengaluru' } });

    await waitFor(() => expect(geo.suggest).toHaveBeenCalledTimes(1));
    expect(geo.suggest.mock.calls[0][0]).toBe('Bengaluru');
  });

  it('emits the typed text immediately, before any geocoding resolves', () => {
    const { onChange } = renderMultiLocation();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Bengaluru' } });
    expect(onChange).toHaveBeenLastCalledWith(['Bengaluru']);
  });

  it('reports the picked coordinate to the page for a primary location field', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 },
    ]);
    const { onChange, onLocationsResolved } = renderMultiLocation();

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Bengaluru' } });
    const option = await screen.findByRole('option', {
      name: 'Bengaluru, Karnataka, India',
    });
    fireEvent.mouseDown(option);

    expect(screen.getAllByRole('combobox')[0]).toHaveValue('Bengaluru, Karnataka, India');
    expect(onChange).toHaveBeenLastCalledWith(['Bengaluru, Karnataka, India']);
    expect(onLocationsResolved).toHaveBeenLastCalledWith([
      { lat: 12.97, lng: 77.59, label: 'Bengaluru, Karnataka, India' },
    ]);
    // Picking closes the suggestion list.
    await waitFor(() =>
      expect(
        screen.queryByRole('option', { name: 'Bengaluru, Karnataka, India' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('never reports coordinates for a secondary (non-primary) location field', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Mysuru, Karnataka, India', lat: 12.29, lng: 76.63 },
    ]);
    const { onChange, onLocationsResolved } = renderMultiLocation({
      options: { isPrimaryLocation: false },
    });

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Mysuru' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Mysuru, Karnataka, India' }));

    expect(onChange).toHaveBeenLastCalledWith(['Mysuru, Karnataka, India']);
    expect(onLocationsResolved).not.toHaveBeenCalled();
  });

  it('drops a resolved coordinate once the user edits the text again', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 },
    ]);
    const { onLocationsResolved } = renderMultiLocation();

    const input = screen.getAllByRole('combobox')[0];
    fireEvent.change(input, { target: { value: 'Bengaluru' } });
    fireEvent.mouseDown(
      await screen.findByRole('option', { name: 'Bengaluru, Karnataka, India' }),
    );
    expect(onLocationsResolved).toHaveBeenLastCalledWith([
      { lat: 12.97, lng: 77.59, label: 'Bengaluru, Karnataka, India' },
    ]);

    fireEvent.change(input, { target: { value: 'Bengal' } });
    expect(onLocationsResolved).toHaveBeenLastCalledWith([]);
  });

  it('keeps a resolved coordinate from an earlier row when a later row is edited', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 },
    ]);
    const { onLocationsResolved } = renderMultiLocation();
    const user = userEvent.setup();

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Bengaluru' } });
    fireEvent.mouseDown(
      await screen.findByRole('option', { name: 'Bengaluru, Karnataka, India' }),
    );

    await user.click(screen.getByRole('button', { name: '+ Add city' }));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'Hu' } });

    expect(onLocationsResolved).toHaveBeenLastCalledWith([
      { lat: 12.97, lng: 77.59, label: 'Bengaluru, Karnataka, India' },
    ]);
  });

  it('shows no dropdown when the provider returns no matches', async () => {
    geo.suggest.mockResolvedValue([]);
    renderMultiLocation();

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Zzzzzz' } });
    await waitFor(() => expect(geo.suggest).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the dropdown shortly after the input blurs', async () => {
    geo.suggest.mockResolvedValue([
      { label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 },
    ]);
    renderMultiLocation();

    const input = screen.getAllByRole('combobox')[0];
    fireEvent.change(input, { target: { value: 'Bengaluru' } });
    await screen.findByRole('option', { name: 'Bengaluru, Karnataka, India' });

    fireEvent.blur(input);
    await waitFor(() =>
      expect(
        screen.queryByRole('option', { name: 'Bengaluru, Karnataka, India' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('searches each row independently', async () => {
    geo.suggest.mockImplementation((query: string) =>
      Promise.resolve(
        query.startsWith('Mysuru')
          ? [{ label: 'Mysuru, Karnataka, India', lat: 12.29, lng: 76.63 }]
          : [{ label: 'Bengaluru, Karnataka, India', lat: 12.97, lng: 77.59 }],
      ),
    );
    const { onChange } = renderMultiLocation({ value: ['Bengaluru, Karnataka, India'] });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '+ Add city' }));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'Mysuru' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Mysuru, Karnataka, India' }));

    expect(onChange).toHaveBeenLastCalledWith([
      'Bengaluru, Karnataka, India',
      'Mysuru, Karnataka, India',
    ]);
  });
});
