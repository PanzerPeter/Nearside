import { describe, expect, it } from 'vitest';
import { findMentions, mentionsMe } from './mentions';

describe('findMentions', () => {
  it('matches a handle that is present in the room', () => {
    expect(findMentions('morning @anna', ['anna', 'bob'])).toEqual([
      { handle: 'anna', start: 8, end: 13 },
    ]);
  });

  // A handle nobody in the room has is text somebody typed, not a mention.
  it('ignores a handle nobody here holds', () => {
    expect(findMentions('mail me @example', ['anna'])).toEqual([]);
  });

  // An email address is not a mention. The `@` there is preceded by a word
  // character, which is the whole difference.
  it('ignores an @ inside an email address', () => {
    expect(findMentions('write to anna@example.com', ['anna'])).toEqual([]);
  });

  it('is case-insensitive, because handles are displayed as chosen', () => {
    expect(mentionsMe('hi @Anna', 'anna')).toBe(true);
    expect(findMentions('hi @ANNA', ['anna'])).toEqual([{ handle: 'anna', start: 3, end: 8 }]);
  });

  // Display names are not unique and are not word-shaped: `profiles` allows
  // any single-line string up to 32 characters. Longest first, or "@Anna Lee"
  // renders as a mention of "Anna" with a stray surname after it.
  it('prefers the longest matching name', () => {
    expect(findMentions('ping @Anna Lee now', ['Anna', 'Anna Lee'])).toEqual([
      { handle: 'Anna Lee', start: 5, end: 14 },
    ]);
  });

  // Otherwise "@ann" would light up inside "@anna", and the highlight would
  // stop halfway through somebody's name.
  it('requires the name to end at a boundary', () => {
    expect(findMentions('@annabel', ['anna'])).toEqual([]);
    expect(findMentions('@anna, hello', ['anna'])).toEqual([
      { handle: 'anna', start: 0, end: 5 },
    ]);
  });

  it('finds several mentions in one message', () => {
    expect(findMentions('@anna and @bob', ['anna', 'bob'])).toEqual([
      { handle: 'anna', start: 0, end: 5 },
      { handle: 'bob', start: 10, end: 14 },
    ]);
  });

  it('returns nothing for a message with no @ in it', () => {
    expect(findMentions('anna said hello', ['anna'])).toEqual([]);
  });
});

describe('mentionsMe', () => {
  it('is false without a handle to match', () => {
    expect(mentionsMe('hi @anna', '')).toBe(false);
  });

  it('is false when somebody else was named', () => {
    expect(mentionsMe('hi @bob', 'anna')).toBe(false);
  });
});
