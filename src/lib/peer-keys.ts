import { fromBase64 } from './crypto/keys';
import { cachedContact } from './localdb';
import { supabase } from './supabase';
import { recordPeerKey } from './verification';

/** Keys change rarely and are read constantly, so they are cached for the
 *  session. `lib/verification.ts` is what invalidates an entry, via
 *  `forgetPeerKey`, when it decides a peer's published key has changed. */
const cache = new Map<string, Uint8Array>();

export async function peerPublicKey(peerId: string): Promise<Uint8Array | null> {
  const hit = cache.get(peerId);
  if (hit) return hit;

  const { data } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', peerId)
    .maybeSingle();

  // The published key is still asked for first, and on every cold start. It is
  // what `verificationState` compares the recorded key against, so a client
  // that stopped reading it would be a client in which 'changed' — an
  // interception, or a peer who reinstalled — could never fire again.
  if (!data?.public_key) return recordedKey(peerId);

  // Trust on first use, written down before the key is handed to any caller:
  // the recorded key is the only thing a later change can be measured against,
  // and an existing record is never overwritten here.
  await recordPeerKey(peerId, data.public_key);
  const key = await fromBase64(data.public_key);
  cache.set(peerId, key);
  return key;
}

/**
 * The key this device wrote down the first time it spoke to this peer.
 *
 * Reached only when the profile read came back with nothing, which on a phone
 * usually means no network rather than no peer. Without this the thread cache
 * would be pointless offline: every cached row would fail to open for want of
 * a key already sitting in `contacts`, and the conversation would paint a page
 * of "encrypted message" over messages this device has read before.
 *
 * It is not a weaker check. The recorded key is the one trust-on-first-use
 * pinned; if the peer has since published a different one, the next read that
 * *does* reach the server is what surfaces that, exactly as before. What this
 * cannot do is notice a change while offline — and neither could the code it
 * replaces, which noticed nothing at all.
 */
async function recordedKey(peerId: string): Promise<Uint8Array | null> {
  const known = await cachedContact(peerId);
  if (!known) return null;
  const key = await fromBase64(known.public_key);
  // Deliberately not cached in-module: a session that started offline must
  // re-ask the server the moment it can, or the verification comparison above
  // would be skipped for the rest of the run.
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
