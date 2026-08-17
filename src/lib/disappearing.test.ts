import { describe, expect, it } from 'vitest';
import {
  describeTimerChange,
  formatTtl,
  hasExpired,
  normalizePair,
  timerChangeIndex,
  TTL_OPTIONS,
} from './disappearing';

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

  it('names every offered duration without falling through to seconds', () => {
    for (const seconds of TTL_OPTIONS) {
      expect(formatTtl(seconds)).not.toMatch(/seconds$/);
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

describe('describeTimerChange', () => {
  const at = '2026-08-08T12:00:00.000Z';

  it('says nothing when the pair has never set a timer', () => {
    expect(describeTimerChange(null, 'me', '@peter')).toBeNull();
  });

  it('names the duration and credits you when you set it', () => {
    const timer = { ttlSeconds: 3600, setBy: 'me', updatedAt: at };
    expect(describeTimerChange(timer, 'me', '@peter')).toEqual({
      label: 'You set messages to disappear after 1 hour',
      at,
    });
  });

  it('credits the peer by the name the reader knows them under', () => {
    const timer = { ttlSeconds: 300, setBy: 'them', updatedAt: at };
    expect(describeTimerChange(timer, 'me', 'Mum')?.label).toBe(
      'Mum set messages to disappear after 5 minutes'
    );
  });

  it('reads as a change, not a setting, when the timer is turned off', () => {
    const timer = { ttlSeconds: null, setBy: 'them', updatedAt: at };
    expect(describeTimerChange(timer, 'me', 'Mum')?.label).toBe(
      'Mum turned off disappearing messages'
    );
  });
});

describe('timerChangeIndex', () => {
  const sent = [
    '2026-08-08T10:00:00.000Z',
    '2026-08-08T12:00:00.000Z',
    '2026-08-08T14:00:00.000Z',
  ];

  it('sits before the first message sent after the change', () => {
    expect(timerChangeIndex(sent, '2026-08-08T11:00:00.000Z')).toBe(1);
  });

  it('sits at the end when the change is newer than every message', () => {
    expect(timerChangeIndex(sent, '2026-08-08T15:00:00.000Z')).toBe(3);
  });

  it('sits at the top when the change predates the loaded window', () => {
    expect(timerChangeIndex(sent, '2026-08-01T00:00:00.000Z')).toBe(0);
  });

  it('keeps a message stamped at the same instant above the line', () => {
    expect(timerChangeIndex(sent, '2026-08-08T10:00:00.000Z')).toBe(1);
  });

  it('has somewhere to go in an empty thread', () => {
    expect(timerChangeIndex([], '2026-08-08T10:00:00.000Z')).toBe(0);
  });

  it('falls to the end rather than disappearing on an unparseable stamp', () => {
    expect(timerChangeIndex(sent, 'not a date')).toBe(3);
  });
});
