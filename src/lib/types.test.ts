import { describe, expect, it } from 'vitest';
import { initial } from './types';

describe('initial', () => {
  it('uppercases the first character', () => {
    expect(initial('peter')).toBe('P');
  });

  it('ignores leading whitespace', () => {
    expect(initial('  ada')).toBe('A');
  });

  it('falls back to a question mark for empty or missing names', () => {
    expect(initial('')).toBe('?');
    expect(initial('   ')).toBe('?');
    expect(initial(null)).toBe('?');
    expect(initial(undefined)).toBe('?');
  });
});
