import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from './motion';

// This suite runs under Vitest's `node` environment (see vitest.config.ts),
// so `window` doesn't exist unless a test stubs it in — which doubles as
// coverage for the "no browser" guard whenever a test leaves it unstubbed.
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWindowMatchMedia(matches: boolean) {
  vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches }) });
}

describe('prefersReducedMotion', () => {
  it('returns true when the OS setting is on', () => {
    stubWindowMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when the OS setting is off', () => {
    stubWindowMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false rather than throwing when window/matchMedia is unavailable', () => {
    // No `window` stubbed at all — the `node` test environment leaves it
    // undefined, exactly like a non-browser context would.
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns false rather than throwing when window exists but matchMedia does not', () => {
    vi.stubGlobal('window', {});
    expect(() => prefersReducedMotion()).not.toThrow();
    expect(prefersReducedMotion()).toBe(false);
  });
});
