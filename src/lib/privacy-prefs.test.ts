import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRIVACY_PREFS,
  parsePrivacyPrefs,
  privacyPrefs,
  resetPrivacyPrefsCache,
  setPrivacyPref,
  subscribePrivacyPrefs,
} from './privacy-prefs';

describe('reading stored privacy prefs', () => {
  it('is everything on when nothing has been stored', () => {
    expect(parsePrivacyPrefs(null)).toEqual(DEFAULT_PRIVACY_PREFS);
  });

  it('keeps every signal on when the stored value is unreadable', () => {
    // A half-written or corrupted blob must not read as "turn it all off":
    // that looks to both sides of a conversation like the app breaking.
    expect(parsePrivacyPrefs('{ not json')).toEqual(DEFAULT_PRIVACY_PREFS);
    expect(parsePrivacyPrefs('"a string"')).toEqual(DEFAULT_PRIVACY_PREFS);
    expect(parsePrivacyPrefs('null')).toEqual(DEFAULT_PRIVACY_PREFS);
  });

  it('takes the keys it recognises and defaults the rest', () => {
    // A pref added in a later release is missing from a blob written by an
    // earlier one, and has to arrive switched on rather than absent.
    expect(parsePrivacyPrefs('{"typing":false}')).toEqual({
      ...DEFAULT_PRIVACY_PREFS,
      typing: false,
    });
  });

  it('ignores a value of the wrong type', () => {
    expect(parsePrivacyPrefs('{"presence":"no"}').presence).toBe(true);
  });
});

/** A node run has no `localStorage`; the same stub `motion.test.ts` uses. */
function stubLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

describe('changing a privacy pref', () => {
  beforeEach(() => {
    stubLocalStorage();
    resetPrivacyPrefsCache();
  });

  it('remembers the change and tells whoever is listening', () => {
    let told = 0;
    const stop = subscribePrivacyPrefs(() => told++);
    setPrivacyPref('presence', false);

    expect(told).toBe(1);
    expect(privacyPrefs().presence).toBe(false);
    resetPrivacyPrefsCache();
    expect(privacyPrefs().presence).toBe(false);
    stop();
  });

  it('answers with everything on rather than throwing when storage is denied', () => {
    // Private mode and a locked-down WebView both throw on access.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    resetPrivacyPrefsCache();
    expect(privacyPrefs()).toEqual(DEFAULT_PRIVACY_PREFS);
    // And the toggle still applies for this run.
    setPrivacyPref('typing', false);
    expect(privacyPrefs().typing).toBe(false);
  });

  it('leaves the other signals alone', () => {
    setPrivacyPref('typing', false);
    expect(privacyPrefs().readReceipts).toBe(true);
    expect(privacyPrefs().presence).toBe(true);
  });
});
