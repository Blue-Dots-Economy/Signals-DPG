import { describe, it, expect, beforeEach, vi } from 'vitest';
import { purgeLegacyAuthStorage } from '../purge-legacy-auth-storage';

/**
 * The cleanup half of AUTH-VULN-03/04: the tokens already in users' browsers.
 */

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('purgeLegacyAuthStorage', () => {
  it('removes the access token the old client wrote', () => {
    localStorage.setItem('auth_token', 'a-real-token');
    sessionStorage.setItem('auth_token', 'a-real-token');

    purgeLegacyAuthStorage();

    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(sessionStorage.getItem('auth_token')).toBeNull();
  });

  it("removes oidc-client-ts's store, which held the REFRESH token", () => {
    // The key varies per deployment (authority + client id), so it cannot be
    // named — and this is the more valuable of the two tokens, because it
    // mints new access tokens on demand.
    localStorage.setItem('oidc.user:http://kc/realms/bluedots:signals-ui', '{"refresh_token":"x"}');
    localStorage.setItem('oidc.abc', 'x');

    purgeLegacyAuthStorage();

    expect(Object.keys(localStorage).filter((k) => k.startsWith('oidc.'))).toEqual([]);
  });

  it('removes every stale key, not every other one', () => {
    // Removing while iterating reindexes the store and skips entries; with
    // three keys a naive loop leaves the middle one behind.
    for (const n of [1, 2, 3, 4, 5]) localStorage.setItem(`oidc.k${n}`, 'x');

    purgeLegacyAuthStorage();

    expect(Object.keys(localStorage).filter((k) => k.startsWith('oidc.'))).toEqual([]);
  });

  it('leaves everything else alone', () => {
    localStorage.setItem('i18nextLng', 'hi');
    localStorage.setItem('dpg-theme-mode', 'dark');
    localStorage.setItem('activeProfileId:blue_dot', 'item-1');

    purgeLegacyAuthStorage();

    expect(localStorage.getItem('i18nextLng')).toBe('hi');
    expect(localStorage.getItem('dpg-theme-mode')).toBe('dark');
    expect(localStorage.getItem('activeProfileId:blue_dot')).toBe('item-1');
  });

  it('does not throw when storage is unavailable', () => {
    // Safari private mode and blocked third-party contexts both throw here;
    // the app has to boot anyway.
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(() => purgeLegacyAuthStorage()).not.toThrow();

    spy.mockRestore();
  });
});
