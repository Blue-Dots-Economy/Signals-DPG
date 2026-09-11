import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  emitSessionExpired,
  onSessionExpired,
  resetSessionExpiredForTests,
} from './auth-events';

beforeEach(() => {
  resetSessionExpiredForTests();
});

describe('auth-events — session expiry signal', () => {
  it('notifies every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    onSessionExpired(a);
    onSessionExpired(b);

    emitSessionExpired();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('fires ONCE however many failures report the same dead session', () => {
    // THE reason this module exists. Four queries poll /action/fetch, and a
    // measured expiry produced bursts of nine simultaneous 401s. Each one
    // detects the same dead session; without the latch that is nine logouts and
    // nine navigations.
    const handler = vi.fn();
    onSessionExpired(handler);

    for (let i = 0; i < 9; i++) emitSessionExpired();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('stays latched for the page lifetime — a later emit is a no-op', () => {
    const handler = vi.fn();
    onSessionExpired(handler);
    emitSessionExpired();
    handler.mockClear();

    emitSessionExpired();

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn();
    const off = onSessionExpired(handler);
    off();

    emitSessionExpired();

    expect(handler).not.toHaveBeenCalled();
  });

  it('a subscriber added after the latch is not retro-fired', () => {
    emitSessionExpired();
    const late = vi.fn();
    onSessionExpired(late);

    emitSessionExpired();

    expect(late).not.toHaveBeenCalled();
  });
});
