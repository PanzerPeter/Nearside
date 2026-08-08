import { describe, expect, it } from 'vitest';
import { formatTtl, hasExpired, normalizePair, TTL_OPTIONS } from './disappearing';

describe('normalizePair', () => {
  it('gives both participants the same key', () => {
    expect(normalizePair('bbb', 'aaa')).toEqual(normalizePair('aaa', 'bbb'));
  });

  it('sorts ascending', () => {
    expect(normalizePair('bbb', 'aaa')).toEqual(['aaa', 'bbb']);
  });

  it('handles the self-chat, where both sides are the same person', () => {
    expect(normalizePair('aaa', 'aaa')).toEqual(['aaa', 'aaa']);
  });
});

describe('formatTtl', () => {
  it('names off as off', () => {
    expect(formatTtl(null)).toBe('Off');
  });

  it('names every offered duration', () => {
    for (const option of TTL_OPTIONS) {
      expect(formatTtl(option.seconds)).toBe(option.label);
    }
  });

  it('falls back to seconds for a duration the app did not offer', () => {
    expect(formatTtl(90)).toBe('90 seconds');
  });
});

describe('hasExpired', () => {
  const now = Date.parse('2026-08-08T12:00:00.000Z');

  it('treats a row with no expiry as never expiring', () => {
    expect(hasExpired(null, now)).toBe(false);
  });

  it('is true once the moment has passed', () => {
    expect(hasExpired('2026-08-08T11:59:59.000Z', now)).toBe(true);
  });

  it('is false before it', () => {
    expect(hasExpired('2026-08-08T12:00:01.000Z', now)).toBe(false);
  });

  it('treats an unparseable timestamp as not expired', () => {
    // Deleting a message because a timestamp failed to parse is the one
    // failure mode with no undo.
    expect(hasExpired('not a date', now)).toBe(false);
  });
});
