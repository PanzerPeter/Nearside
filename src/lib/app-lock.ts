// The app lock's arithmetic: stretching a passphrase, checking one, and how
// long to wait after a wrong guess.
//
// What this is not: a second layer of encryption. The identity seed is already
// in the Android Keystore and the decrypted mirror is already in app-private
// storage. This stops someone who picks up an unlocked phone. It does not stop
// anyone who has already defeated those, and the UI must not suggest it does.
import sodium from 'libsodium-wrappers';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { fromBase64, toBase64 } from './crypto/keys';

/** Short enough to type one-handed, long enough that the stretching below makes
 *  offline guessing pointless for the threat this actually addresses. */
export const MIN_PASSPHRASE_LENGTH = 6;

const SALT_BYTES = 16;
const HASH_BITS = 256;

/**
 * PBKDF2-HMAC-SHA256, not Argon2id, and the reason is worth writing down.
 *
 * `libsodium-wrappers` ships no `crypto_pwhash` — Argon2id lives only in the
 * sumo build, which would add roughly 600 KB of parsed JavaScript to a WebView
 * that already pays for the standard build on every cold start. The cost is not
 * worth it here: the verifier below sits in the same Keystore-backed store as
 * the seed, so anyone able to read it to guess against already holds the seed,
 * which is the secret that matters. What the stretching buys is that a
 * shoulder-surfed or reused passphrase is not recoverable from the stored
 * value, and 600k iterations is the current OWASP figure for that.
 *
 * Web Crypto runs this natively, so it is faster and lighter on the lock screen
 * than a WASM Argon2id would be — about 80 ms on a desktop, under a second on a
 * slow phone.
 */
const ITERATIONS = 600_000;

const FREE_ATTEMPTS = 4;
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;

export interface LockVerifier {
  /** base64 */
  salt: string;
  /** base64 */
  hash: string;
}

async function stretch(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

export async function deriveVerifier(
  passphrase: string,
  salt?: Uint8Array
): Promise<LockVerifier> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  await sodium.ready;
  const useSalt = salt ?? sodium.randombytes_buf(SALT_BYTES);
  const hash = await stretch(passphrase, useSalt);
  return { salt: await toBase64(useSalt), hash: await toBase64(hash) };
}

/** Constant-time. A timing channel on a six-character passphrase is not
 *  hypothetical, and `===` on base64 strings leaks the matching prefix. */
export async function verifyPassphrase(
  passphrase: string,
  verifier: LockVerifier
): Promise<boolean> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return false;
  await sodium.ready;
  let stored: Uint8Array;
  let candidate: Uint8Array;
  try {
    stored = await fromBase64(verifier.hash);
    candidate = await fromBase64((await deriveVerifier(passphrase, await fromBase64(verifier.salt))).hash);
  } catch {
    // A stored entry that will not decode is not a passphrase failure, but the
    // only safe answer here is still no. `loadLock` treats a corrupt entry as
    // no lock at all, which is the path back in.
    return false;
  }
  // memcmp throws on a length mismatch, and this runs on the lock screen where
  // an unhandled throw is a user with no way back into their account.
  if (stored.length !== candidate.length) return false;
  return sodium.memcmp(candidate, stored);
}

/**
 * How long to refuse the next attempt, given how many have already failed.
 *
 * Four free tries, because a mistyped passphrase is the common case and
 * punishing it teaches people to disable the lock. Then doubling, capped — the
 * cap exists because an uncapped backoff is a denial of service the owner
 * inflicts on themselves, and there is no reset path to escape it.
 */
export function backoffMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(FIRST_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

/** Per account, for the same reason the seed is (see `keystore.ts`): two people
 *  share a phone, and the second must not meet the first one's lock screen. */
const LOCK_KEY = 'nearside.lock';
const lockKey = (userId: string) => `${LOCK_KEY}.${userId}`;

export type RelockAfter = 'immediate' | '1m' | '5m';

export const RELOCK_MS: Record<RelockAfter, number> = {
  immediate: 0,
  '1m': 60_000,
  '5m': 300_000,
};

interface StoredLock {
  verifier: LockVerifier;
  relock: RelockAfter;
}

function isRelockAfter(value: unknown): value is RelockAfter {
  return value === 'immediate' || value === '1m' || value === '5m';
}

export async function loadLock(userId: string): Promise<StoredLock | null> {
  let raw: string;
  try {
    const { value } = await SecureStoragePlugin.get({ key: lockKey(userId) });
    if (!value) return null;
    raw = value;
  } catch {
    // No lock set. The plugin throws for an absent key.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLock>;
    const { verifier, relock } = parsed;
    if (!verifier?.salt || !verifier?.hash || !isRelockAfter(relock)) return null;
    return { verifier: { salt: verifier.salt, hash: verifier.hash }, relock };
  } catch {
    // A corrupt entry is treated as no lock rather than as a locked-out
    // account: there is no reset path, and a parse failure must not be one.
    return null;
  }
}

export async function saveLock(
  userId: string,
  verifier: LockVerifier,
  relock: RelockAfter
): Promise<void> {
  await SecureStoragePlugin.set({
    key: lockKey(userId),
    value: JSON.stringify({ verifier, relock } satisfies StoredLock),
  });
}

export async function clearLock(userId: string): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key: lockKey(userId) });
  } catch {
    // Already absent.
  }
}
