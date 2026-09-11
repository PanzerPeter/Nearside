import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appTitle, APP_TITLE } from './app-title';

describe('appTitle', () => {
  it('is the product name alone when there is nothing unread', () => {
    expect(appTitle(0)).toBe(APP_TITLE);
  });

  it('carries the count when there is one', () => {
    expect(appTitle(3)).toBe('Nearside (3)');
  });

  it('never reports a negative count', () => {
    expect(appTitle(-1)).toBe(APP_TITLE);
  });
});

/**
 * The half of the contract that lives in the other build.
 *
 * `electron/main.ts` has its own tsconfig and its own node_modules and cannot
 * import anything from `src`, so the only way to hold the two together is to
 * read its source and run its own parser against what this side writes. A
 * change to either format fails here rather than silently leaving the desktop
 * badge stuck on whatever it last understood.
 */
describe('the desktop shell reads it back', () => {
  const shell = readFileSync('electron/main.ts', 'utf8');

  /** The literal out of `unreadFromTitle`. */
  const pattern = /const match = (\/.+\/)\.exec\(title\)/.exec(shell);

  it('still has a parser to check against', () => {
    expect(pattern).not.toBeNull();
  });

  function parse(title: string): number {
    const [, literal] = pattern!;
    const body = literal.slice(1, literal.lastIndexOf('/'));
    const flags = literal.slice(literal.lastIndexOf('/') + 1);
    const match = new RegExp(body, flags).exec(title);
    if (!match) return 0;
    const count = Number(match[1]);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  it('reads back every count this side writes', () => {
    for (const unread of [1, 2, 9, 10, 99, 1000]) {
      expect(parse(appTitle(unread))).toBe(unread);
    }
  });

  it('reads nothing unread as nothing unread', () => {
    expect(parse(appTitle(0))).toBe(0);
  });

  it('does not invent a count from a title that has none', () => {
    expect(parse('Nearside')).toBe(0);
    expect(parse('')).toBe(0);
  });
});
