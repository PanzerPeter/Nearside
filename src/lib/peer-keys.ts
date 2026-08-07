import { fromBase64 } from './crypto/keys';
import { supabase } from './supabase';
import { recordPeerKey } from './verification';

/** Keys change rarely and are read constantly, so they are cached for the
 *  session. Task 7's key-change detection is what invalidates an entry. */
const cache = new Map<string, Uint8Array>();

export async function peerPublicKey(peerId: string): Promise<Uint8Array | null> {
  const hit = cache.get(peerId);
  if (hit) return hit;

  const { data } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', peerId)
    .maybeSingle();

  if (!data?.public_key) return null;
  // Trust on first use, written down before the key is handed to any caller:
  // the recorded key is the only thing a later change can be measured against,
  // and an existing record is never overwritten here.
  await recordPeerKey(peerId, data.public_key);
  const key = await fromBase64(data.public_key);
  cache.set(peerId, key);
  return key;
}

export function forgetPeerKey(peerId: string): void {
  cache.delete(peerId);
}

/**
 * Empty the cache. Called when a session ends.
 *
 * Not about secrecy — these are public keys — but about trust-on-first-use. The
 * record a key change is measured against is written by `recordPeerKey` on a
 * cache *miss*, into the signed-in account's own store. A cache surviving the
 * sign-out means the next account to open the same conversation gets a hit,
 * never records the key, and so has nothing for `verificationState` to compare
 * a later change against: 'changed' could not fire for that peer for the rest
 * of the run.
 */
export function forgetAllPeerKeys(): void {
  cache.clear();
}
