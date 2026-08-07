// The seed is the account. It is written to Keystore-backed storage on
// Android and never to Supabase, a log line, or a crash report.
//
// Every entry is scoped to the account it belongs to. A device-wide slot — what
// this file held until the multi-account fix — meant the second account to sign
// in on a phone silently inherited the first one's private key, published it as
// its own, and could open everything sealed to the first.
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { fromBase64, toBase64 } from './crypto/keys';

const SEED_KEY = 'nearside.identity.seed';
/** Set once the user has typed the check words back. Persisted rather than
 *  held in React state because the seed is written the moment it is generated:
 *  without a stored flag, backgrounding the app and returning re-runs the load,
 *  finds a seed, and lets the user past the phrase screen having copied
 *  nothing. */
const CONFIRMED_KEY = 'nearside.identity.confirmed';

const seedKey = (userId: string) => `${SEED_KEY}.${userId}`;
const confirmedKey = (userId: string) => `${CONFIRMED_KEY}.${userId}`;

/** True where the seed sits in hardware-backed storage rather than in
 *  localStorage. Surfaced in the UI so a browser session cannot be mistaken
 *  for the security properties the Android build actually has. */
export function isSecureStorageAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

async function read(key: string): Promise<string | null> {
  try {
    const { value } = await SecureStoragePlugin.get({ key });
    return value ?? null;
  } catch {
    // The plugin throws rather than returning null when the key is absent,
    // which is the ordinary first-launch case.
    return null;
  }
}

async function remove(key: string): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key });
  } catch {
    // Already absent.
  }
}

/**
 * Deletes the unscoped entries written by builds before accounts were scoped.
 *
 * They are deliberately not adopted by whoever reads next. The old slot was
 * written by whichever account onboarded first and then read by every account
 * after it, so nothing on the device says who it belongs to — and handing an
 * unowned private key to a guessed owner is the failure being fixed, not a
 * migration. The user's twelve words are the copy that survives; restoring them
 * puts the key back under the account that actually owns it.
 */
async function purgeLegacyEntries(): Promise<void> {
  await Promise.all([remove(SEED_KEY), remove(CONFIRMED_KEY)]);
}

export async function loadSeed(userId: string): Promise<Uint8Array | null> {
  await purgeLegacyEntries();
  const value = await read(seedKey(userId));
  return value ? await fromBase64(value) : null;
}

export async function storeSeed(userId: string, seed: Uint8Array): Promise<void> {
  await SecureStoragePlugin.set({ key: seedKey(userId), value: await toBase64(seed) });
}

export async function clearSeed(userId: string): Promise<void> {
  await remove(seedKey(userId));
  await remove(confirmedKey(userId));
}

/** Has this account proved it copied the phrase for the seed now on this device? */
export async function isSeedConfirmed(userId: string): Promise<boolean> {
  return (await read(confirmedKey(userId))) === 'true';
}

export async function markSeedConfirmed(userId: string): Promise<void> {
  await SecureStoragePlugin.set({ key: confirmedKey(userId), value: 'true' });
}
