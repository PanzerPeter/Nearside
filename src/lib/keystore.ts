// The seed is the account. It is written to Keystore-backed storage on
// Android and never to Supabase, a log line, or a crash report.
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { fromBase64, toBase64 } from './crypto/keys';

const SEED_KEY = 'nearside.identity.seed';

/** True where the seed sits in hardware-backed storage rather than in
 *  localStorage. Surfaced in the UI so a browser session cannot be mistaken
 *  for the security properties the Android build actually has. */
export function isSecureStorageAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

export async function loadSeed(): Promise<Uint8Array | null> {
  try {
    const { value } = await SecureStoragePlugin.get({ key: SEED_KEY });
    return value ? await fromBase64(value) : null;
  } catch {
    // The plugin throws rather than returning null when the key is absent,
    // which is the ordinary first-launch case.
    return null;
  }
}

export async function storeSeed(seed: Uint8Array): Promise<void> {
  await SecureStoragePlugin.set({ key: SEED_KEY, value: await toBase64(seed) });
}

export async function clearSeed(): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key: SEED_KEY });
  } catch {
    // Already absent.
  }
}
