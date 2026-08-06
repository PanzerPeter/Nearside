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

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim().toLowerCase(), wordlist);
}

/**
 * BIP-39 produces 64 bytes; libsodium's seeded keygen takes 32. The first
 * half is used, which is the conventional choice and is fixed forever by the
 * fact that real users' phrases depend on it.
 */
export async function seedFromMnemonic(mnemonic: string): Promise<Uint8Array> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!isValidMnemonic(normalized)) throw new Error('invalid recovery phrase');
  return mnemonicToSeedSync(normalized).slice(0, SEED_BYTES);
}
