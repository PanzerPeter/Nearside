import { fromBase64 } from './crypto/keys';
import { supabase } from './supabase';

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
  const key = await fromBase64(data.public_key);
  cache.set(peerId, key);
  return key;
}

export function forgetPeerKey(peerId: string): void {
  cache.delete(peerId);
}
