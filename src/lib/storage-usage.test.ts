import { describe, expect, it } from 'vitest';
import { formatBytes, plural, totalPinBytes } from './storage-usage';

describe('formatBytes', () => {
  it('shows whole bytes without a decimal point', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('climbs a unit at 1024, not at 1000', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('drops the decimal once it is noise', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB');
  });

  it('never invents a size for a number it cannot use', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('totalPinBytes', () => {
  it('sums what it could measure', () => {
    expect(totalPinBytes([100, 200, 300])).toEqual({ files: 3, bytes: 600, unmeasured: 0 });
  });

  it('counts an unreadable file apart rather than as a zero', () => {
    // A pin row whose file is gone from the sandbox. Folding it in as zero
    // would report a total that is silently short.
    expect(totalPinBytes([100, null])).toEqual({ files: 1, bytes: 100, unmeasured: 1 });
  });

  it('treats a nonsense size as unmeasured', () => {
    expect(totalPinBytes([Number.NaN, -5])).toEqual({ files: 0, bytes: 0, unmeasured: 2 });
  });

  it('is zero for no pins at all', () => {
    expect(totalPinBytes([])).toEqual({ files: 0, bytes: 0, unmeasured: 0 });
  });
});

describe('plural', () => {
  it('keeps one message singular', () => {
    expect(plural(1, 'message')).toBe('1 message');
    expect(plural(2, 'message')).toBe('2 messages');
    expect(plural(0, 'message')).toBe('0 messages');
  });

  it('takes an irregular plural', () => {
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});
