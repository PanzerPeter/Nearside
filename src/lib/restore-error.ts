// Restoring a key fails for two unrelated reasons, and naming the wrong one
// costs the user the account.
//
// The restore screen used to catch every throw from the restore and print "that
// phrase is not valid". But the phrase is checked first and the device is used
// after: the seed is written to storage, the confirmation flag beside it, and
// three keys derived through libsodium. A failure in any of those — a storage
// write the shell cannot do, a WASM module that never initialised — arrived at
// the same catch and sent the user off to retype twelve words that were already
// correct, with the one message that guarantees they never report the real bug.
import { isValidMnemonic } from './crypto/mnemonic';

export const PHRASE_INVALID = 'That phrase is not valid. Check the spelling and the order.';

/** Capacitor plugins reject with a bare string rather than an Error — the
 *  secure storage web fallback does exactly that — so `.message` is not
 *  something to reach for without checking. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'no reason given';
}

/**
 * What to tell someone whose restore just failed.
 *
 * The phrase is re-checked rather than inferred from the error, so the only
 * thing that produces "your phrase is wrong" is a phrase that is wrong.
 */
export function restoreErrorMessage(phrase: string, error: unknown): string {
  if (!isValidMnemonic(phrase)) return PHRASE_INVALID;
  return `Your phrase is correct, but this device could not store the key: ${describe(error)}`;
}
