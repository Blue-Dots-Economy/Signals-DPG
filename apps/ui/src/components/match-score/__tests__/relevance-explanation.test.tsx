import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RelevanceExplanation } from '../relevance-explanation';
import { vectorizeFieldsOf } from '@/lib/vectorize-fields';
import type { RJSFSchema } from '@rjsf/utils';

/**
 * #646 C4. The panel answers "why is this here, in this position" — and is
 * explicit about the one thing it cannot answer.
 */

const base = {
  metric: { kind: 'relevance' as const, percent: 62 },
  metricLabel: '62%',
  basis: 'profile' as const,
  vectorizeFields: [
    { name: 'skills', label: 'Skills', weight: 3 },
    { name: 'sector', label: 'Sector', weight: 2 },
  ],
  viewerState: { skills: ['solar', 'wiring'], sector: 'energy' },
  itemState: { skills: ['solar', 'plumbing'], sector: 'energy' },
  setConstraints: ['Domain: Provider', 'Within 25 km'],
};

describe('RelevanceExplanation', () => {
  it('states the sort in force and the metric it used', () => {
    render(<RelevanceExplanation {...base} />);
    expect(screen.getByText(/your profile/i)).toBeInTheDocument();
    expect(screen.getByText(/62%/)).toBeInTheDocument();
  });

  it('lists exactly the vectorize fields, with their weights', () => {
    render(<RelevanceExplanation {...base} />);
    const rows = screen.getAllByTestId('vectorize-field');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Skills');
    expect(rows[0]).toHaveTextContent('3');
  });

  it('shows the viewer’s and the item’s values side by side', () => {
    render(<RelevanceExplanation {...base} />);
    expect(screen.getByText('solar, wiring')).toBeInTheDocument();
    expect(screen.getByText('solar, plumbing')).toBeInTheDocument();
  });

  it('renders an em dash for a field neither side filled', () => {
    render(
      <RelevanceExplanation
        {...base}
        viewerState={{}}
        itemState={{}}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('separates set-shaping constraints from ordering', () => {
    // Conflating membership with position is most of what made the old badge
    // feel arbitrary.
    render(<RelevanceExplanation {...base} />);
    const section = screen.getByTestId('set-constraints');
    expect(section).toHaveTextContent('Domain: Provider');
    expect(section).toHaveTextContent('Within 25 km');
  });

  it('labels the overlap ILLUSTRATIVE and shows no per-field contribution', () => {
    // HONESTY CONSTRAINT (spec §5.4): the cosine comes from a single pooled
    // embedding of the serialized vectorize fields, so it cannot be
    // decomposed. Any per-field number would be fabricated.
    render(<RelevanceExplanation {...base} />);
    expect(screen.getByTestId('illustrative-note')).toHaveTextContent(/illustration/i);
    expect(screen.queryByTestId('field-contribution')).toBeNull();
    expect(screen.queryByText(/%\s*(of|from)\s+(this|the)\s+score/i)).toBeNull();
  });

  it('omits the relevance fields entirely under a non-relevance sort', () => {
    // Nothing about those fields determined the position, so showing them
    // would imply a basis the list did not use.
    render(
      <RelevanceExplanation
        {...base}
        metric={{ kind: 'age', createdAt: new Date('2026-08-29') }}
        metricLabel="5d ago"
        basis={null}
      />,
    );
    expect(screen.queryAllByTestId('vectorize-field')).toHaveLength(0);
    expect(screen.queryByTestId('illustrative-note')).toBeNull();
    expect(screen.getByTestId('set-constraints')).toBeInTheDocument();
  });

  it('names the search basis when the typed text was the query vector', () => {
    render(<RelevanceExplanation {...base} basis="search" />);
    expect(screen.getByText(/your search/i)).toBeInTheDocument();
  });

  it('omits the constraints section when nothing shaped the set', () => {
    render(<RelevanceExplanation {...base} setConstraints={[]} />);
    expect(screen.queryByTestId('set-constraints')).toBeNull();
  });
});

describe('vectorizeFieldsOf', () => {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      skills: { type: 'string', title: 'Skills', vectorize: true, vector_weight: 3 },
      sector: { type: 'string', title: 'Sector', vectorize: true },
      phone: { type: 'string', title: 'Phone' },
      notes: { type: 'string', vectorize: true, vector_weight: 2 },
    },
  } as RJSFSchema;

  it('returns only the vectorize:true fields', () => {
    expect(vectorizeFieldsOf(schema).map((f) => f.name)).not.toContain('phone');
  });

  it('defaults an unset weight to 1, matching the ingest default', () => {
    expect(vectorizeFieldsOf(schema).find((f) => f.name === 'sector')?.weight).toBe(1);
  });

  it('sorts heaviest first', () => {
    expect(vectorizeFieldsOf(schema).map((f) => f.name)).toEqual(['skills', 'notes', 'sector']);
  });

  it('falls back to the property name when the schema has no title', () => {
    expect(vectorizeFieldsOf(schema).find((f) => f.name === 'notes')?.label).toBe('notes');
  });

  it('returns nothing for an absent or property-less schema', () => {
    expect(vectorizeFieldsOf(undefined)).toEqual([]);
    expect(vectorizeFieldsOf({ type: 'object' } as RJSFSchema)).toEqual([]);
  });
});
