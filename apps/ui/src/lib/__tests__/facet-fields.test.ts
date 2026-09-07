import { describe, it, expect } from 'vitest';
import { resolveFacetFieldLabels } from '../facet-fields';
import type { DotNetworkDomain } from '@/engine/types';

function domain(id: string, properties: Record<string, unknown>): DotNetworkDomain {
  return {
    id,
    description: `${id} domain`,
    card: { title_field: 'name' },
    item_schemas: { [`${id}_1.0`]: { type: 'object', properties } },
  } as unknown as DotNetworkDomain;
}

describe('resolveFacetFieldLabels', () => {
  it('prefers the schema title and humanizes a key that has none', () => {
    const labels = resolveFacetFieldLabels([
      domain('seeker', {
        workExperience: { type: 'string', title: 'Work Experience' },
        workExperienceYearsConditional: { type: 'string' },
      }),
    ]);

    expect(labels.workExperience).toBe('Work Experience');
    // The chip bar printed the raw key here (Q5); the panel showed a title.
    expect(labels.workExperienceYearsConditional).toBe('Work Experience Years Conditional');
  });

  it('excludes private fields, matching the server allowlist', () => {
    const labels = resolveFacetFieldLabels([
      domain('seeker', {
        gender: { type: 'string', title: 'Gender' },
        phone: { type: 'string', title: 'Phone', private: true },
      }),
    ]);

    expect(labels).toHaveProperty('gender');
    expect(labels).not.toHaveProperty('phone');
  });

  it('includes NON-enum declared fields', () => {
    // Deliberately broader than `getEnumFilterFieldsForDomains`. The server
    // honours any declared, non-private field, so pruning against the
    // enum-only set would discard a legitimate facet — e.g. one seeded from
    // a `?f_*` param.
    const labels = resolveFacetFieldLabels([
      domain('provider', { company: { type: 'string', title: 'Company' } }),
    ]);

    expect(labels.company).toBe('Company');
  });

  it('keeps each domain to its OWN fields, which is what makes pruning work', () => {
    // blue_dot's seeker and provider schemas share zero field names, so a
    // facet carried across a domain switch is silently dropped server-side
    // and that domain returns unfiltered (Q6).
    const seeker = resolveFacetFieldLabels([
      domain('seeker', { gender: { type: 'string' }, workExperience: { type: 'string' } }),
    ]);
    const provider = resolveFacetFieldLabels([
      domain('provider', { candidateExperienceType: { type: 'string' } }),
    ]);

    expect(Object.keys(seeker)).toEqual(['gender', 'workExperience']);
    expect(provider).not.toHaveProperty('gender');
    expect(provider).toHaveProperty('candidateExperienceType');
  });

  it('unions across domains, for the multi-domain map selection', () => {
    const labels = resolveFacetFieldLabels([
      domain('seeker', { gender: { type: 'string', title: 'Gender' } }),
      domain('provider', { natureOfJob: { type: 'string', title: 'Nature of Job' } }),
    ]);

    expect(Object.keys(labels).sort()).toEqual(['gender', 'natureOfJob']);
  });

  it('tolerates a domain with no schemas', () => {
    expect(resolveFacetFieldLabels([{ id: 'x' } as unknown as DotNetworkDomain])).toEqual({});
    expect(resolveFacetFieldLabels([])).toEqual({});
  });
});
