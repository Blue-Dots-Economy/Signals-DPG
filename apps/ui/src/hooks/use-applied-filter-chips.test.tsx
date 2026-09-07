import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppliedFilterChips } from './use-applied-filter-chips';
import type { UseAppliedFilterChipsInput } from './use-applied-filter-chips';

function setup(overrides: Partial<UseAppliedFilterChipsInput> = {}) {
  const input: UseAppliedFilterChipsInput = {
    search: '',
    setSearch: vi.fn(),
    activeFieldFilters: {},
    setFieldFilters: vi.fn(),
    fieldLabels: {},
    area: { mode: 'anywhere' },
    setArea: vi.fn(),
    ...overrides,
  };
  return { input, hook: renderHook(() => useAppliedFilterChips(input)) };
}

describe('useAppliedFilterChips', () => {
  it('labels a facet chip from fieldLabels, not the raw schema key (Q5)', () => {
    const { hook } = setup({
      activeFieldFilters: { workExperienceYearsConditional: ['< 1 Year'] },
      fieldLabels: { workExperienceYearsConditional: 'Years of Work Experience' },
    });

    expect(hook.result.current.chips).toHaveLength(1);
    expect(hook.result.current.chips[0].label).toBe(
      'Years of Work Experience: < 1 Year',
    );
  });

  it('falls back to the key when no label is known', () => {
    const { hook } = setup({ activeFieldFilters: { mystery: ['x'] }, fieldLabels: {} });
    expect(hook.result.current.chips[0].label).toBe('mystery: x');
  });

  it('removes a facet by REPLACING the whole set, so the URL can be rewritten', () => {
    // The setter has to be the handler that also rewrites `?f_*`. It used to
    // be the bare `useState` setter via an updater function, which cleared
    // state but left the params — so a reload restored the filter (Q8).
    const setFieldFilters = vi.fn();
    const { hook } = setup({
      activeFieldFilters: { gender: ['Female'], workExperience: ['Fresher'] },
      setFieldFilters,
    });

    hook.result.current.onRemove({
      kind: 'facet',
      id: 'facet:gender',
      label: 'Gender: Female',
      removable: true,
    });

    expect(setFieldFilters).toHaveBeenCalledWith({ workExperience: ['Fresher'] });
    // A plain object, never an updater function.
    expect(typeof setFieldFilters.mock.calls[0][0]).toBe('object');
  });

  it('clear-all resets every constraint', () => {
    const setSearch = vi.fn();
    const setFieldFilters = vi.fn();
    const setArea = vi.fn();
    const { hook } = setup({
      search: 'welder',
      activeFieldFilters: { gender: ['Female'] },
      area: { mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 },
      setSearch,
      setFieldFilters,
      setArea,
    });

    hook.result.current.onClearAll();

    expect(setSearch).toHaveBeenCalledWith('');
    expect(setFieldFilters).toHaveBeenCalledWith({});
    expect(setArea).toHaveBeenCalledWith({ mode: 'anywhere' });
  });

  it('does NOT reset the sort when clearing', () => {
    // Clearing is about which results you get — text, facets, location. A list
    // always has SOME order, so there is no "no sort" state to return to, and
    // reordering the results while clearing filters is a change the user did
    // not ask for.
    const { hook, input } = setup({ search: 'welder' });
    hook.result.current.onClearAll();

    expect(input).not.toHaveProperty('setSort');
  });

  it('offers clear-all for a non-default area, which produces no chip', () => {
    expect(
      setup({ area: { mode: 'radius', center: { lat: 1, lng: 2 }, meters: 5000 } }).hook.result
        .current.canClearAll,
    ).toBe(true);
    expect(setup().hook.result.current.canClearAll).toBe(false);
  });

  it('chips the search text but never the domain', () => {
    const { hook } = setup({ search: '  welder  ' });
    expect(hook.result.current.chips.map((c) => c.kind)).toEqual(['search']);
    expect(hook.result.current.chips[0].label).toBe('"welder"');
  });
});
