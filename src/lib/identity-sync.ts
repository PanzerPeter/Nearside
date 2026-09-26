import type { Session } from '@supabase/supabase-js';
import { identityFromSeed, toBase64, type Identity } from './crypto/keys';
import { isValidMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { supabase } from './supabase';

/** Exactly the three columns 0020 added, and nothing else. Extracted from the
 *  writer so a test can assert no private half ever reaches the payload. */
export async function publicKeyPayload(identity: Identity) {
  return {
    public_key: await toBase64(identity.boxPublic),
    signing_key: await toBase64(identity.signPublic),
    key_updated_at: new Date().toISOString(),
  };
}

/** Idempotent: writes only when the stored keys differ from this device's. */
export async function syncPublicKeys(session: Session, identity: Identity): Promise<void> {
  const payload = await publicKeyPayload(identity);
  const { data } = await supabase
    .from('profiles')
    .select('public_key, signing_key')
    .eq('id', session.user.id)
    .maybeSingle();

  if (data?.public_key === payload.public_key && data?.signing_key === payload.signing_key) return;
  await supabase.from('profiles').update(payload).eq('id', session.user.id);
}

/**
 * The encryption key this account already publishes, or null when it has none
 * yet. Read by the identity screen, which otherwise cannot tell a brand-new
 * account from an existing one on a new phone — and `syncPublicKeys` above
 * overwrites whatever it finds, so "create a new key" on an existing account
 * silently orphans every message ever sealed to it.
 *
 * Throws on a failed read rather than answering null: "no key" is the one
 * answer that lets a new key be published over an old one.
 */
export async function publishedBoxKey(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.public_key as string | null | undefined) ?? null;
}

/** Whether a typed phrase derives the key this account already publishes. */
export async function phraseMatchesKey(phrase: string, publishedKey: string): Promise<boolean> {
  if (!isValidMnemonic(phrase)) return false;
  const identity = await identityFromSeed(await seedFromMnemonic(phrase));
  return (await toBase64(identity.boxPublic)) === publishedKey;
}
