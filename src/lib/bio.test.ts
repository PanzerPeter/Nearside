import { describe, expect, it } from 'vitest';
import { MAX_BIO_LENGTH, bioLength, normalizeBio } from './bio';

describe('normalizeBio', () => {
  it('keeps an ordinary bio as written', () => {
    expect(normalizeBio('Designer. Cyclist. Perpetually mid-book.')).toBe(
      'Designer. Cyclist. Perpetually mid-book.',
    );
  });

  it('keeps newlines, unlike a display name or a nickname', () => {
    // The whole reason this has a normalizer of its own: a bio renders in a
    // block, so a paragraph break is content rather than a broken line.
    expect(normalizeBio('one\ntwo')).toBe('one\ntwo');
  });

  it('normalizes Windows and classic-Mac line endings', () => {
    expect(normalizeBio('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('strips control characters that are not newlines', () => {
    expect(normalizeBio('one\ttwo three')).toBe('one two three');
  });

  it('collapses a run of blank lines', () => {
    // Otherwise a bio is one word at the top of the card and one at the
    // bottom, which is a layout somebody chose for everyone else's screen.
    expect(normalizeBio('top\n\n\n\n\n\nbottom')).toBe('top\n\nbottom');
  });

  it('truncates rather than refusing an over-long paste', () => {
    expect(normalizeBio('a'.repeat(MAX_BIO_LENGTH + 50))).toHaveLength(MAX_BIO_LENGTH);
  });

  it('does not let leading whitespace eat the allowance', () => {
    const value = normalizeBio(`${' '.repeat(20)}${'b'.repeat(MAX_BIO_LENGTH)}`);
    expect(value).toHaveLength(MAX_BIO_LENGTH);
  });

  it('reads whitespace-only input as no bio at all', () => {
    // Null, not '': the column's CHECK refuses a blank string, so a client
    // that sent one would fail the write rather than clear the field.
    expect(normalizeBio('   \n\n  ')).toBeNull();
    expect(normalizeBio('')).toBeNull();
  });
});

describe('bioLength', () => {
  it('counts what would be stored, not what was typed', () => {
    expect(bioLength('  hello  ')).toBe(5);
    expect(bioLength('   ')).toBe(0);
  });
});
