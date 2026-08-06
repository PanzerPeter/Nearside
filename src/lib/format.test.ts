import { describe, expect, it } from 'vitest';
import { formatUnread } from './receipts';

describe('formatUnread', () => {
  it('renders small counts verbatim', () => {
    expect(formatUnread(1)).toBe('1');
    expect(formatUnread(42)).toBe('42');
  });

  it('renders the boundary exactly', () => {
    expect(formatUnread(99)).toBe('99');
  });

  it('caps anything past the boundary', () => {
    expect(formatUnread(100)).toBe('99+');
    expect(formatUnread(5000)).toBe('99+');
  });
});
