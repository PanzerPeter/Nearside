// Whether the key you are talking to is the key you agreed to talk to.
//
// Three states, and the distinction between the last two is the entire point:
//   'unverified' no record, or a record matching the current key that no human
//                has confirmed. Routine, and true of every new contact.
//   'verified'   a matching record someone confirmed in person.
//   'changed'    the recorded key is not the current one. A reinstall or a
//                restored recovery phrase looks like this, and so does an
//                interception. The UI must not guess which.
//
// State lives in the local store only (spec §7). A server-held "verified" flag
// would be a claim from exactly the party this check exists to distrust.
import { toBase64 } from './crypto/keys';
import { cachedContact, putContact } from './localdb';

export type VerificationState = 'unverified' | 'verified' | 'changed';

export async function verificationState(
  peerId: string,
  currentKey: string
): Promise<VerificationState> {
  const known = await cachedContact(peerId);
  if (!known) return 'unverified';
  if (known.public_key !== currentKey) return 'changed';
  return known.verified_at ? 'verified' : 'unverified';
}

/**
 * What sealing to a peer throws while their published key is not the one this
 * device recorded. Exported so callers can tell it from a network failure: it
 * will not fix itself on a retry, and its remedy is verifying the contact.
 */
export const KEY_CHANGED = 'peer key changed since it was recorded';

/**
 * Whether `key` differs from the key recorded for this peer — the state that
 * blocks the composer, asked by the paths the composer is not on. The outbox,
 * a forward, an edit, a sealed answer and a call signal all used to seal to
 * whatever the server published, so a swapped key was only refused where the
 * user was typing. No record is not a change: that is first use.
 */
export async function keyChanged(peerId: string, key: Uint8Array): Promise<boolean> {
  const known = await cachedContact(peerId);
  return !!known && known.public_key !== (await toBase64(key));
}

/**
 * Trust on first use. `peerPublicKey` calls this on every fetch, so the first
 * key ever seen for a peer is written down without ceremony — that record is
 * the only thing a later `'changed'` can be measured against.
 *
 * An existing record is left strictly alone, whether verified or not.
 * Overwriting it would mean a swapped key quietly replaced the evidence of the
 * swap, and `'changed'` could never fire.
 */
export async function recordPeerKey(peerId: string, key: string): Promise<void> {
  if (await cachedContact(peerId)) return;
  await putContact({ peer_id: peerId, public_key: key, verified_at: null });
}

/**
 * A human compared safety numbers, or scanned the key off the other person's
 * screen. Writes the key as well as the timestamp, which is what re-verifying
 * after a legitimate key change does.
 */
export async function markVerified(peerId: string, key: string): Promise<void> {
  await putContact({ peer_id: peerId, public_key: key, verified_at: new Date().toISOString() });
}
