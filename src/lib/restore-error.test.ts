import { describe, expect, it } from 'vitest';
import { PHRASE_INVALID, restoreErrorMessage } from './restore-error';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('restoreErrorMessage', () => {
  it('blames the phrase only when the phrase is actually wrong', () => {
    expect(restoreErrorMessage(PHRASE.replace('yellow', 'yell'), new Error('nope'))).toBe(
      PHRASE_INVALID
    );
    expect(restoreErrorMessage('', new Error('nope'))).toBe(PHRASE_INVALID);
  });

  it('names the device when the phrase checked out', () => {
    const message = restoreErrorMessage(PHRASE, new Error('sodium is not ready'));
    expect(message).not.toBe(PHRASE_INVALID);
    expect(message).toContain('sodium is not ready');
  });

  // Capacitor plugins reject with a bare string, not an Error — the secure
  // storage web fallback does exactly this. `error.message` on one of those is
  // undefined, and an error screen reading "undefined" is the same dead end as
  // the wrong message.
  it('carries a rejection that is not an Error', () => {
    expect(restoreErrorMessage(PHRASE, 'Item with given key does not exist')).toContain(
      'Item with given key does not exist'
    );
  });

  it('says something useful when there is nothing to report', () => {
    const message = restoreErrorMessage(PHRASE, undefined);
    expect(message).not.toBe(PHRASE_INVALID);
    expect(message).not.toContain('undefined');
    expect(message.length).toBeGreaterThan(20);
  });

  it('accepts a pasted phrase rather than calling it invalid', () => {
    expect(restoreErrorMessage(`  ${PHRASE.replace(/ /g, '\n')}  `, new Error('x'))).not.toBe(
      PHRASE_INVALID
    );
  });
});
