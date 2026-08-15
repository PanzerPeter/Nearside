// The recovery phrase is the only copy of the seed that ever leaves the
// device, and it leaves it onto paper rather than onto a network.
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
// @scure/bip39 v2 exports wordlists only under their exact `.js` subpath; the
// extensionless form resolves in neither Vite nor node.
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** 128 bits of entropy — twelve words. */
const ENTROPY_BITS = 128;
const SEED_BYTES = 32;

export function generateMnemonic(): string {
  return bip39Generate(wordlist, ENTROPY_BITS);
}

/**
 * The one reading of a typed or pasted phrase, shared by everything that
 * validates or derives from one.
 *
 * bip39 splits on a single U+0020 and compares against the wordlist directly,
 * so anything else the clipboard brought along makes twelve correct words
 * unrecognisable. That is not a cosmetic failure: the phrase is the only way
 * back into an account, and the screen that rejects it tells the user their
 * words are wrong. A phone is typed into and a desktop is pasted into, which
 * is why this surfaced there first.
 *
 * NFKD runs before the collapse so a non-breaking space has already become a
 * space; the strip covers the characters that survive NFKD and render as
 * nothing — zero-width space/joiner/non-joiner, the directional marks, word
 * joiner, soft hyphen and a leading BOM.
 *
 * Widening this can only rescue phrases that were being rejected. Every string
 * that already validated contains twelve wordlist entries separated by single
 * spaces, so it passes through unchanged and derives the seed it always did —
 * `crypto.test.ts` pins that against a fixed vector, because a normalizer that
 * moved an existing seed would lock every account out of its own messages.
 */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic
    .normalize('NFKD')
    .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/**
 * BIP-39 produces 64 bytes; libsodium's seeded keygen takes 32. The first
 * half is used, which is the conventional choice and is fixed forever by the
 * fact that real users' phrases depend on it.
 */
export async function seedFromMnemonic(mnemonic: string): Promise<Uint8Array> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(normalized)) throw new Error('invalid recovery phrase');
  return mnemonicToSeedSync(normalized).slice(0, SEED_BYTES);
}
