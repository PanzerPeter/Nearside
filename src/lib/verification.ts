// Whether the key you are talking to is the key you agreed to talk to.
//
// Three states, and the distinction between the last two is the entire point:
//   'unverified' — no record, or a record matching the current key that no
//                  human has ever confirmed. Routine; every new contact.
//   'verified'   — a matching record someone confirmed in person.
//   'changed'    — the recorded key is not the current one. A reinstall or a
//                  restored recovery phrase looks like this, and so does an
//                  interception. The UI must not guess which.
//
// State lives in the local store only (spec §7). A server-held "verified" flag
// would be a claim from exactly the party this check exists to distrust.
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
