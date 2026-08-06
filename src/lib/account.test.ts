import { describe, expect, it } from 'vitest';
import { confirmsUsername } from './account';

describe('confirmsUsername', () => {
  it('accepts the exact display_name', () => {
    expect(confirmsUsername('peter', 'peter')).toBe(true);
  });

  it('forgives surrounding whitespace', () => {
    expect(confirmsUsername('  peter ', 'peter')).toBe(true);
  });

  it('rejects a different case', () => {
    expect(confirmsUsername('Peter', 'peter')).toBe(false);
    expect(confirmsUsername('PETER', 'peter')).toBe(false);
  });

  it('rejects a prefix, a suffix and the empty string', () => {
    expect(confirmsUsername('pete', 'peter')).toBe(false);
    expect(confirmsUsername('peter_', 'peter')).toBe(false);
    expect(confirmsUsername('', 'peter')).toBe(false);
  });

  it('never confirms against an empty display_name', () => {
    expect(confirmsUsername('', '')).toBe(false);
    expect(confirmsUsername('   ', '')).toBe(false);
  });

  it('rejects internal whitespace rather than collapsing it', () => {
    expect(confirmsUsername('pe ter', 'peter')).toBe(false);
  });
});
