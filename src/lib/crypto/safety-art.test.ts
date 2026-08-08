import { describe, expect, it } from 'vitest';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { safetyArt } from './safety-art';

const NUMBER = '12345 67890 11111 22222 33333 44444 55555 66666 77777 88888 99999 00000';
const OTHER = '99999 88888 77777 66666 55555 44444 33333 22222 11111 00000 12345 67890';

describe('safetyArt', () => {
  it('is deterministic for the same number', async () => {
    expect(await safetyArt(NUMBER)).toEqual(await safetyArt(NUMBER));
  });

  it('ignores the grouping whitespace', async () => {
    expect(await safetyArt(NUMBER)).toEqual(await safetyArt(NUMBER.replace(/\s+/g, '')));
  });

  it('mirrors every row about the centre column', async () => {
    const { cells } = await safetyArt(NUMBER);
    expect(cells).toHaveLength(25);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 2; col++) {
        expect(cells[row * 5 + col]).toBe(cells[row * 5 + (4 - col)]);
      }
    }
  });

  it('separates the two hues by at least 90 degrees around the wheel', async () => {
    const { hue, accentHue } = await safetyArt(NUMBER);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    const gap = Math.abs(hue - accentHue);
    expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(90);
  });

  it('yields four words that are all in the BIP-39 English list', async () => {
    const { words } = await safetyArt(NUMBER);
    expect(words).toHaveLength(4);
    for (const word of words) expect(wordlist).toContain(word);
  });

  it('gives a different number different art', async () => {
    const a = await safetyArt(NUMBER);
    const b = await safetyArt(OTHER);
    expect(a).not.toEqual(b);
  });
});
