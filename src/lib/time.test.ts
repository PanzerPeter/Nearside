import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatListTime, formatLastSeen } from './time';

// Fixed "now": Wed 15 Jul 2026, 12:00 local.
const NOW = new Date(2026, 6, 15, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function at(y: number, m: number, d: number, h = 9, min = 30): string {
  return new Date(y, m, d, h, min).toISOString();
}

describe('formatDate', () => {
  it('labels the current day', () => {
    expect(formatDate(at(2026, 6, 15))).toBe('Today');
  });

  it('labels the previous day', () => {
    expect(formatDate(at(2026, 6, 14))).toBe('Yesterday');
  });

  it('handles the previous day across a month boundary', () => {
    vi.setSystemTime(new Date(2026, 7, 1, 12, 0, 0));
    expect(formatDate(at(2026, 6, 31))).toBe('Yesterday');
  });

  it('falls back to a short date for anything older', () => {
    expect(formatDate(at(2026, 2, 12))).not.toBe('Today');
    expect(formatDate(at(2026, 2, 12))).not.toBe('Yesterday');
  });
});

describe('formatListTime', () => {
  it('shows only a clock time for today', () => {
    expect(formatListTime(at(2026, 6, 15, 14, 32))).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it('shows the word Yesterday for the previous day', () => {
    expect(formatListTime(at(2026, 6, 14, 14, 32))).toBe('Yesterday');
  });

  it('shows a short date for older messages', () => {
    const out = formatListTime(at(2026, 2, 12, 14, 32));
    expect(out).not.toBe('Yesterday');
    expect(out).not.toMatch(/^\d{1,2}[:.]\d{2}$/);
  });
});

describe('formatLastSeen', () => {
  it('includes a clock time for today', () => {
    expect(formatLastSeen(at(2026, 6, 15, 14, 32))).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it('mentions yesterday for the previous day', () => {
    expect(formatLastSeen(at(2026, 6, 14, 14, 32))).toMatch(/yesterday/i);
  });

  it('falls back to a bare date for anything older, with neither yesterday nor a bare clock time', () => {
    const out = formatLastSeen(at(2026, 2, 12, 14, 32));
    expect(out.toLowerCase()).not.toContain('yesterday');
    expect(out).not.toMatch(/^\d{1,2}[:.]\d{2}$/);
  });

  it('returns an empty string for null', () => {
    expect(formatLastSeen(null)).toBe('');
  });
});
