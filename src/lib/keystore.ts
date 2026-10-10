// The seed is the account. It is written to Keystore-backed storage on
// Android and never to Supabase, a log line, or a crash report.
//
// Every entry is scoped to the account it belongs to. A device-wide slot — what
// this file held until the multi-account fix — meant the second account to sign
// in on a phone silently inherited the first one's private key, published it as
// its own, and could open everything sealed to the first.
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { fromBase64, identityFromSeed, toBase64 } from './crypto/keys';
import { isMobileNative } from './platform';

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
  return isMobileNative();
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
 * The unscoped seed written by builds before accounts were scoped, adopted
 * only by the account that can be shown to own it.
 *
 * The old slot was written by whichever account onboarded first and then read
 * by every account after it, so the device cannot say whose it is — but the
 * key can. A seed derives exactly one box key, and an account publishes
 * exactly one; when they match, the seed is that account's and nobody else's,
 * and it moves into that account's slot. Handing it to anyone else is the
 * failure scoping fixed, so nobody else gets it.
 *
 * It used to be deleted on the first read by any account, which lost the
 * account of anyone who upgraded without their twelve words to hand — or whose
 * phone was first opened by a second account. Now it stays, in the same
 * Keystore-backed storage as every scoped seed, until its owner signs in. A
 * lookup that fails (offline, say) decides nothing.
 *
 * The confirmation flag is never adopted: it was device-wide too, and the
 * phrase screen showing once more is the cheap side of that mistake.
 */
async function adoptLegacySeed(
  userId: string,
  publishedKey: (userId: string) => Promise<string | null>
): Promise<void> {
  const legacy = await read(SEED_KEY);
  if (!legacy) return;
  let published: string | null;
  try {
    published = await publishedKey(userId);
  } catch {
    return;
  }
  if (!published) return;
  const seed = await fromBase64(legacy).catch(() => null);
  if (!seed || (await toBase64((await identityFromSeed(seed)).boxPublic)) !== published) return;
  await storeSeed(userId, seed);
  await Promise.all([remove(SEED_KEY), remove(CONFIRMED_KEY)]);
}

/**
 * `publishedKey` is the account's box key as the server holds it, for
 * `adoptLegacySeed`. Without one a legacy entry is left where it is.
 */
export async function loadSeed(
  userId: string,
  publishedKey: (userId: string) => Promise<string | null> = async () => null
): Promise<Uint8Array | null> {
  const value = await read(seedKey(userId));
  if (value) return await fromBase64(value);
  await adoptLegacySeed(userId, publishedKey);
  const adopted = await read(seedKey(userId));
  return adopted ? await fromBase64(adopted) : null;
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
