import { describe, it, expect } from 'vitest';
import { resolveDefaultDomain, collapseToSingleDomain } from './browse-domain';
import type { NetworkInteractionActions } from './browse-discover';

/**
 * #644 / spec D19 + D27. The All tab is removed, so `null` no longer means
 * "every domain" — a domain is always selected. Two rules follow:
 *
 *  - something must replace the All tab as the no-`?domain=` default (D19)
 *  - the map allows several domains but one `/discover` call takes exactly
 *    one, so map → list must collapse the selection (D27)
 */

const visible = [{ id: 'provider' }, { id: 'trainer' }];
const actions: NetworkInteractionActions = {
  connect: { interactions: [{ from_domain: 'seeker', to_domain: 'provider' }] },
};

describe('resolveDefaultDomain (spec D19)', () => {
  it('honours an explicit ?domain= param', () => {
    expect(
      resolveDefaultDomain({
        fromParam: 'trainer',
        visibleDomains: visible,
        viewerDomain: 'seeker',
        actions,
      }),
    ).toBe('trainer');
  });

  it('ignores a param naming a domain that is not visible', () => {
    // A stale bookmark, or a domain the viewer may not browse. Falling back is
    // correct; honouring it would fetch a domain the interaction matrix hides.
    expect(
      resolveDefaultDomain({
        fromParam: 'ghost',
        visibleDomains: visible,
        viewerDomain: 'seeker',
        actions,
      }),
    ).toBe('provider');
  });

  it('picks the first INTERACTING counterpart domain for a signed-in viewer', () => {
    // trainer is listed first but seeker only interacts with provider, so
    // provider wins — landing a seeker on a domain where every card would hide
    // its Connect button is worse than reordering.
    expect(
      resolveDefaultDomain({
        fromParam: null,
        visibleDomains: [{ id: 'trainer' }, { id: 'provider' }],
        viewerDomain: 'seeker',
        actions,
      }),
    ).toBe('provider');
  });

  it('falls back to the first visible domain when none interact', () => {
    expect(
      resolveDefaultDomain({
        fromParam: null,
        visibleDomains: visible,
        viewerDomain: 'nobody',
        actions,
      }),
    ).toBe('provider');
  });

  it('falls back to the first visible domain for a signed-out viewer', () => {
    expect(
      resolveDefaultDomain({
        fromParam: null,
        visibleDomains: visible,
        viewerDomain: null,
        actions,
      }),
    ).toBe('provider');
  });

  it('returns null only when nothing is visible', () => {
    expect(
      resolveDefaultDomain({
        fromParam: null,
        visibleDomains: [],
        viewerDomain: 'seeker',
        actions,
      }),
    ).toBeNull();
  });

  it('is invisible for a viewer with exactly one visible domain', () => {
    expect(
      resolveDefaultDomain({
        fromParam: null,
        visibleDomains: [{ id: 'provider' }],
        viewerDomain: 'seeker',
        actions,
      }),
    ).toBe('provider');
  });
});

describe('collapseToSingleDomain (spec D27)', () => {
  it('keeps the first selected domain', () => {
    expect(collapseToSingleDomain(['trainer', 'provider'], visible)).toBe('trainer');
  });

  it('falls back to the first visible when the selection is empty', () => {
    expect(collapseToSingleDomain([], visible)).toBe('provider');
  });

  it('drops a selection that is no longer visible', () => {
    expect(collapseToSingleDomain(['ghost'], visible)).toBe('provider');
  });

  it('keeps the first STILL-VISIBLE selection, not simply the first', () => {
    expect(collapseToSingleDomain(['ghost', 'trainer'], visible)).toBe('trainer');
  });

  it('returns null when nothing is visible', () => {
    expect(collapseToSingleDomain(['provider'], [])).toBeNull();
  });
});
