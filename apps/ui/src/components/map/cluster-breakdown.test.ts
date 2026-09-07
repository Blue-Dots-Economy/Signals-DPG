import { describe, it, expect } from 'vitest';
import {
  tallyDomains,
  countDistinctListings,
  listingIdOfMarker,
  type ClusterEntry,
} from './cluster-breakdown';

const pin = (domain: string, itemId: string): ClusterEntry => ({ domain, itemId });

describe('listingIdOfMarker', () => {
  it('strips the location index from a multi-location pin id', () => {
    expect(listingIdOfMarker('abc-123#1')).toBe('abc-123');
  });

  it('passes a plain id through unchanged', () => {
    expect(listingIdOfMarker('abc-123')).toBe('abc-123');
  });
});

describe('tallyDomains — counts LISTINGS, not pins', () => {
  /**
   * The bug this exists for: a service provider serving two areas draws two
   * pins, so 110 such listings drew 220. The cluster bubble read 220 while the
   * pill directly beneath it read 110 listings — both looking like "listings"
   * to anyone comparing them.
   */
  it('counts one listing once however many of its pins are in the cluster', () => {
    const entries = [
      pin('service_provider', 'sp-1'),
      pin('service_provider', 'sp-1'), // same listing, its second service area
      pin('service_provider', 'sp-2'),
    ];
    expect(tallyDomains(entries)).toEqual([{ domain: 'service_provider', count: 2 }]);
    expect(countDistinctListings(entries)).toBe(2);
  });

  it('keeps domains separate and orders by count descending', () => {
    const entries = [
      pin('seeker', 's-1'),
      pin('service_provider', 'sp-1'),
      pin('seeker', 's-2'),
      pin('seeker', 's-3'),
    ];
    expect(tallyDomains(entries)).toEqual([
      { domain: 'seeker', count: 3 },
      { domain: 'service_provider', count: 1 },
    ]);
  });

  it('does not merge distinct listings that share an id across domains', () => {
    // Ids are per-item so this should not happen, but the tally must not
    // collapse two domains' counts if it ever did.
    const entries = [pin('seeker', 'x'), pin('service_provider', 'x')];
    expect(tallyDomains(entries)).toEqual([
      { domain: 'seeker', count: 1 },
      { domain: 'service_provider', count: 1 },
    ]);
    // Across all domains it IS one distinct listing id.
    expect(countDistinctListings(entries)).toBe(1);
  });

  it('preserves insertion order for equal counts', () => {
    const entries = [pin('b', 'b-1'), pin('a', 'a-1')];
    expect(tallyDomains(entries).map((d) => d.domain)).toEqual(['b', 'a']);
  });

  it('handles an empty cluster', () => {
    expect(tallyDomains([])).toEqual([]);
    expect(countDistinctListings([])).toBe(0);
  });
});
