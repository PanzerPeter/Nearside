import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION,
  applyMotionPreference,
  expressiveMotion,
  isMotionReduced,
  motionDuration,
  prefersReducedMotion,
  setMotionReduced,
} from './motion';

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

describe('motion tokens', () => {
  it('defines a duration and an easing for every token', () => {
    for (const token of ['enter', 'exit', 'emphasis', 'seal'] as const) {
      expect(MOTION[token].duration).toBeGreaterThan(0);
      expect(MOTION[token].easing).toMatch(/^cubic-bezier\(/);
    }
  });

  it('reports a token duration when motion is allowed', () => {
    // The vitest environment is node: no matchMedia, so prefersReducedMotion
    // answers false and the full duration is returned.
    expect(motionDuration('seal')).toBe(MOTION.seal.duration);
  });

  it('keeps its duration when only the in-app switch asks for less motion', () => {
    // The restrained set still runs the seal sweep, so the timer that strips
    // the class must not collapse to zero with the switch on. Only the OS
    // setting means "no animation".
    stubLocalStorage({ 'nearside.motion.reduced': '1' });
    expect(motionDuration('seal')).toBe(MOTION.seal.duration);
  });
});

function stubLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

describe('the in-app reduce-motion preference', () => {
  it('defaults to off, so a fresh install gets the expressive set', () => {
    stubLocalStorage();
    expect(isMotionReduced()).toBe(false);
  });

  it('round-trips through storage', () => {
    const store = stubLocalStorage();
    setMotionReduced(true);
    expect(store.get('nearside.motion.reduced')).toBe('1');
    expect(isMotionReduced()).toBe(true);

    setMotionReduced(false);
    expect(isMotionReduced()).toBe(false);
  });

  it('answers off rather than throwing when storage is unavailable', () => {
    // Private-mode Safari and a locked-down WebView both throw on access.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(isMotionReduced()).toBe(false);
    expect(() => setMotionReduced(true)).not.toThrow();
  });
});

describe('expressiveMotion', () => {
  it('is on when neither the switch nor the OS asks for less', () => {
    stubLocalStorage();
    stubWindowMatchMedia(false);
    expect(expressiveMotion()).toBe(true);
  });

  it('is off with the in-app switch on', () => {
    stubLocalStorage({ 'nearside.motion.reduced': '1' });
    stubWindowMatchMedia(false);
    expect(expressiveMotion()).toBe(false);
  });

  it('is off with the OS setting on, whatever the switch says', () => {
    // The OS setting is the stricter of the two and cannot be overridden from
    // inside the app.
    stubLocalStorage();
    stubWindowMatchMedia(true);
    expect(expressiveMotion()).toBe(false);
  });
});

describe('applyMotionPreference', () => {
  it('does nothing rather than throwing without a document', () => {
    // No `document` in the node environment — same guard a worker would hit.
    stubLocalStorage();
    expect(() => applyMotionPreference()).not.toThrow();
  });

  it('stamps the tier the rest of the app reads', () => {
    stubLocalStorage();
    const root = { setAttribute: vi.fn() };
    vi.stubGlobal('document', { documentElement: root });

    applyMotionPreference();
    expect(root.setAttribute).toHaveBeenCalledWith('data-motion', 'expressive');

    setMotionReduced(true);
    expect(root.setAttribute).toHaveBeenLastCalledWith('data-motion', 'reduced');
  });
});
