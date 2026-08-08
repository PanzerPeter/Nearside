import sodium from 'libsodium-wrappers';
// @scure/bip39 v2 exports wordlists only under their exact `.js` subpath.
import { wordlist } from '@scure/bip39/wordlists/english.js';

const GRID = 5;
/** Columns 0-2 are independent; 3 and 4 are 1 and 0 reflected. */
const INDEPENDENT_COLUMNS = 3;
const WORDS = 4;
const HASH_BYTES = 32;

export interface SafetyArt {
  /** 25 entries, row-major, 5 per row. Mirrored about the centre column. */
  cells: boolean[];
  /** Degrees on the colour wheel, 0-359. */
  hue: number;
  accentHue: number;
  /** Four words to read aloud. Never typed back — there is no input for them. */
  words: string[];
}

/**
 * A picture and four words for a safety number, so two people can compare
 * something in a second instead of reading sixty digits to each other.
 *
 * Derived from the digits and nothing else, so it is exactly as strong as the
 * number and no stronger — matching art means matching digits, and the UI must
 * not imply it is a second, independent check.
 *
 * The digits are hashed again rather than read positionally: `safetyNumber`
 * renders 16-bit values zero-padded to five characters, so every fifth digit
 * only ever reaches 6 and art read straight off the string inherits that bias.
 *
 * Mirroring is what makes the grid read as an object rather than noise, which
 * is what makes a mismatch obvious across a table.
 */
export async function safetyArt(safetyNumber: string): Promise<SafetyArt> {
  await sodium.ready;
  const digits = safetyNumber.replace(/\D/g, '');
  // Unkeyed: an explicit null key, matching `safety.ts`. There is no secret to
  // hash under; both devices must reach the same picture.
  const d = sodium.crypto_generichash(HASH_BYTES, sodium.from_string(digits), null);

  const cells = new Array<boolean>(GRID * GRID).fill(false);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < INDEPENDENT_COLUMNS; col++) {
      const on = (d[row * INDEPENDENT_COLUMNS + col] & 1) === 1;
      cells[row * GRID + col] = on;
      cells[row * GRID + (GRID - 1 - col)] = on;
    }
  }

  const hue = ((d[15] << 8) | d[16]) % 360;
  // Offset by at least 90 degrees so the two colours never collapse into one
  // another for a viewer with reduced colour discrimination.
  const accentHue = (hue + 90 + (((d[17] << 8) | d[18]) % 180)) % 360;

  const words: string[] = [];
  for (let i = 0; i < WORDS; i++) {
    const at = 19 + i * 2;
    words.push(wordlist[((d[at] << 8) | d[at + 1]) % wordlist.length]);
  }

  return { cells, hue, accentHue, words };
}
