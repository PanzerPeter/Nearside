import type { Identity } from './crypto/keys';
import { openForSelf, openFrom, sealFor, sealForSelf } from './crypto/seal';
import { isSelfChat } from './conversation';
import { cacheMessage } from './localdb';

export interface BodyColumns {
  ciphertext: string;
  nonce: string;
}

interface Readable {
  ciphertext: string | null;
  nonce: string | null;
  user_id: string;
  receiver_id: string;
}

/**
 * Columns for a message insert. Every body is sealed — the self-chat under
 * the vault key, a conversation under crypto_box to the peer's published key.
 * There is no plaintext path; Plan 2's temporary one was deleted here.
 */
export async function sealBody(
  identity: Identity,
  peerPublic: Uint8Array | null,
  me: string,
  peerId: string,
  text: string
): Promise<BodyColumns> {
  if (isSelfChat(me, peerId)) return sealForSelf(identity.vaultKey, text);
  // Throwing beats degrading: a fallback to plaintext here would be invisible
  // to the sender and would quietly falsify the product's central claim.
  if (!peerPublic) throw new Error('peer has no published key');
  return sealFor(identity.boxPrivate, peerPublic, text);
}

/** Plaintext, or null when the row cannot be opened — which spec §10 requires
 *  the UI to render explicitly rather than as an empty bubble. */
export async function openBody(
  identity: Identity,
  peerPublic: Uint8Array | null,
  row: Readable
): Promise<string | null> {
  if (row.ciphertext === null || row.nonce === null) return null;
  const sealed = { ciphertext: row.ciphertext, nonce: row.nonce };
  try {
    if (isSelfChat(row.user_id, row.receiver_id)) {
      return await openForSelf(identity.vaultKey, sealed);
    }
    if (!peerPublic) return null;
    return await openFrom(identity.boxPrivate, peerPublic, sealed);
  } catch {
    return null;
  }
}

/**
 * Fetched rows with their bodies opened into `text`, once, as they enter
 * state.
 *
 * This is the seam that keeps the rest of the app unchanged: `MessageBubble`,
 * `messageSnippet`, the forward picker and the reply quote all read one field,
 * and they keep doing so. Decrypting here rather than at each of those sites
 * also means once per row instead of once per render, and rows re-render on
 * every presence tick.
 *
 * Each row that opens is written to the local mirror on the way through, which
 * is what makes it searchable later. A row the user has never loaded is not in
 * the mirror and is not searchable — correct, and explainable.
 *
 * `decrypt_failed` marks the rows that could not be opened, because a null
 * `text` alone is indistinguishable from a media message with no caption —
 * and the two must not render the same way.
 */
export async function openRows<T extends Readable & { id: string; created_at: string }>(
  identity: Identity | null,
  peerPublic: Uint8Array | null,
  peerId: string,
  rows: T[]
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      // No identity yet: the row is sealed and unopenable, which is exactly
      // what decrypt_failed describes.
      const text = identity ? await openBody(identity, peerPublic, row) : null;
      if (text !== null) {
        await cacheMessage({
          id: row.id,
          peer_id: peerId,
          user_id: row.user_id,
          text,
          created_at: row.created_at,
        });
      }
      return { ...row, text, decrypt_failed: text === null };
    })
  );
}
