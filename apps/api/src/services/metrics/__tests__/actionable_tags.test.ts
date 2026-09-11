import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

describe('compute_actionable_tags', () => {
  it('returns empty when all required fields are populated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme', phone: '+91...' },
        schema: { required: ['name', 'phone'], properties: { name: {}, phone: {} } },
      }),
    ).toEqual([]);
  });

  it('emits missing_<slugified_field> for each unpopulated required field', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme' },
        schema: { required: ['name', 'Phone Number', 'email_address'], properties: {} },
      }),
    ).toEqual(['missing_phone_number', 'missing_email_address']);
  });

  // The underscore trim is an index walk rather than /^_+|_+$/g (backtracking).
  // These pin the slug boundaries: a tag name is consumed downstream, so a
  // silent change here changes data, not just formatting.
  it.each([
    ['  Phone Number  ', 'missing_phone_number'],
    ['!!!weird!!!', 'missing_weird'],
    ['___leading', 'missing_leading'],
    ['trailing___', 'missing_trailing'],
    ['___both___', 'missing_both'],
    // Inner separators collapse to one underscore but are NOT trimmed.
    ['a  b', 'missing_a_b'],
    ['a___b', 'missing_a_b'],
    // A name with nothing slug-able left collapses to the bare prefix.
    ['___', 'missing_'],
  ])('slugifies %s', (field, expected) => {
    expect(
      compute_actionable_tags({
        payload: {},
        schema: { required: [field], properties: {} },
      }),
    ).toEqual([expected]);
  });

  it('treats empty strings and empty arrays as unpopulated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: '', tags: [] },
        schema: { required: ['name', 'tags'], properties: {} },
      }),
    ).toEqual(['missing_name', 'missing_tags']);
  });

  it('returns empty when schema has no required fields', () => {
    expect(compute_actionable_tags({ payload: {}, schema: {} })).toEqual([]);
  });
});
