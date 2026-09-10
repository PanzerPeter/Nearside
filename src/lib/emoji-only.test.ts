import { describe, it, expect } from 'vitest';
import { jumboEmojiCount } from './emoji-only';

describe('jumboEmojiCount', () => {
  it('counts a run of one to three emoji', () => {
    expect(jumboEmojiCount('👍')).toBe(1);
    expect(jumboEmojiCount('🙄🙄')).toBe(2);
    expect(jumboEmojiCount('🎉🎉🎉')).toBe(3);
  });

  it('stops at three, past which a jumbo glyph is a wall', () => {
    expect(jumboEmojiCount('😀😀😀😀')).toBe(0);
  });

  it('leaves a message with words in it alone', () => {
    expect(jumboEmojiCount('with text🙄')).toBe(0);
    expect(jumboEmojiCount('🙄 ok')).toBe(0);
  });

  it('ignores whitespace between and around the emoji', () => {
    expect(jumboEmojiCount(' 👍 🙄 ')).toBe(2);
    expect(jumboEmojiCount('👍\n🙄')).toBe(2);
  });

  it('is empty for an empty body', () => {
    expect(jumboEmojiCount('')).toBe(0);
    expect(jumboEmojiCount('   ')).toBe(0);
  });

  it('counts what is one thing on screen as one thing', () => {
    expect(jumboEmojiCount('👨‍👩‍👧‍👦')).toBe(1);
    expect(jumboEmojiCount('👍🏽')).toBe(1);
    expect(jumboEmojiCount('🇭🇺')).toBe(1);
    expect(jumboEmojiCount('🇭🇺🇬🇧')).toBe(2);
  });

  it('takes an emoji that asked for emoji presentation', () => {
    expect(jumboEmojiCount('❤️')).toBe(1);
    expect(jumboEmojiCount('☺️')).toBe(1);
    expect(jumboEmojiCount('1️⃣')).toBe(1);
  });

  it('leaves the text-default symbols as text', () => {
    expect(jumboEmojiCount('©')).toBe(0);
    expect(jumboEmojiCount('™')).toBe(0);
    expect(jumboEmojiCount('‼')).toBe(0);
    expect(jumboEmojiCount('5')).toBe(0);
    expect(jumboEmojiCount('->')).toBe(0);
  });
});
