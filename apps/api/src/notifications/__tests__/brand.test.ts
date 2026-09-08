import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND_COLOR, buildCtaUrl, createCtaUrlResolver, resolveBrandColor, resolveBrandName } from '../brand';

describe('buildCtaUrl', () => {
  // The trailing-slash trim is a loop rather than a regex (backtracking). These
  // pin the exact behaviour so a future rewrite back to a regex — or to a
  // different loop — cannot quietly change what a CTA link resolves to.
  it.each([
    ['https://app.example.com', 'https://app.example.com/auth/login'],
    ['https://app.example.com/', 'https://app.example.com/auth/login'],
    ['https://app.example.com///', 'https://app.example.com/auth/login'],
    ['https://app.example.com/sub/', 'https://app.example.com/sub/auth/login'],
    // Only TRAILING slashes go: the path's own separators are untouched.
    ['https://app.example.com//a//', 'https://app.example.com//a/auth/login'],
    // Degenerate inputs still produce a string rather than throwing.
    ['/', '/auth/login'],
    ['', '/auth/login'],
  ])('trims trailing slashes only: %s', (input, expected) => {
    expect(buildCtaUrl(input)).toBe(expected);
  });

  it('appends /auth/login to the base url', () => {
    expect(buildCtaUrl('https://app.example.com')).toBe(
      'https://app.example.com/auth/login',
    );
  });

  it('does not double the slash when the base has a trailing slash', () => {
    expect(buildCtaUrl('https://app.example.com/')).toBe(
      'https://app.example.com/auth/login',
    );
  });
});

describe('resolveBrandName', () => {
  it('prefers the network display name when present', () => {
    expect(
      resolveBrandName({ networkDisplayName: 'Blue Dot', instanceName: 'blue_dot_api' }),
    ).toBe('Blue Dot');
  });

  it('falls back to the instance name when no display name', () => {
    expect(resolveBrandName({ instanceName: 'blue_dot_api' })).toBe('blue_dot_api');
  });

  it('treats a blank display name as absent', () => {
    expect(
      resolveBrandName({ networkDisplayName: '   ', instanceName: 'blue_dot_api' }),
    ).toBe('blue_dot_api');
  });
});

describe('resolveBrandColor', () => {
  it('returns the network brand colour', () => {
    expect(resolveBrandColor('blue_dot')).toBe('#2563eb');
    expect(resolveBrandColor('green_dot')).toBe('#16a34a');
    expect(resolveBrandColor('orange_dot')).toBe('#ea580c');
  });

  it('falls back to the default for unknown / missing networks', () => {
    expect(resolveBrandColor('mystery_dot')).toBe(DEFAULT_BRAND_COLOR);
    expect(resolveBrandColor(null)).toBe(DEFAULT_BRAND_COLOR);
  });
});

describe('createCtaUrlResolver', () => {
  const byDomain = {
    seeker: 'https://seeker.example.org',
    provider: 'https://provider.example.org',
  };

  it('resolves each domain to its own portal login URL', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('seeker')).toBe('https://seeker.example.org/auth/login');
    expect(resolve('provider')).toBe('https://provider.example.org/auth/login');
  });

  it('falls back to FRONTEND_BASE_URL for an unmapped domain', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('unmapped')).toBe('https://old.example.org/auth/login');
  });

  it('uses the fallback for every domain when the map is empty (single-host install)', () => {
    const resolve = createCtaUrlResolver({ byDomain: {}, fallbackBaseUrl: 'https://old.example.org/' });
    expect(resolve('seeker')).toBe('https://old.example.org/auth/login');
  });

  it('returns undefined when neither the map nor the fallback has an answer', () => {
    const resolve = createCtaUrlResolver({ byDomain: {} });
    expect(resolve('seeker')).toBeUndefined();
  });

  it('prefers the map over the fallback even when both could answer', () => {
    const resolve = createCtaUrlResolver({ byDomain, fallbackBaseUrl: 'https://old.example.org' });
    expect(resolve('seeker')).not.toContain('old.example.org');
  });
});
