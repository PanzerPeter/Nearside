import { fromBase64, toBase64, type Identity } from './crypto/keys';
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

interface MediaKeyed {
  media_key_ciphertext: string | null;
  media_key_nonce: string | null;
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
 * Columns carrying a file's key, sealed to whoever can read the message.
 *
 * The key is base64'd and put through the same `sealBody` as a body, rather
 * than growing a parallel byte-sealing path: it is 32 bytes of text as far as
 * the crypto is concerned, and one sealing routine means one place where the
 * self-chat/peer decision is made.
 */
export async function sealMediaKey(
  identity: Identity,
  peerPublic: Uint8Array | null,
  me: string,
  peerId: string,
  key: Uint8Array
): Promise<{ media_key_ciphertext: string; media_key_nonce: string }> {
  const sealed = await sealBody(identity, peerPublic, me, peerId, await toBase64(key));
  return { media_key_ciphertext: sealed.ciphertext, media_key_nonce: sealed.nonce };
}

/** The file key for a row, or null when it cannot be opened. */
export async function openMediaKey(
  identity: Identity,
  peerPublic: Uint8Array | null,
  row: MediaKeyed
): Promise<Uint8Array | null> {
  if (!row.media_key_ciphertext || !row.media_key_nonce) return null;
  const text = await openBody(identity, peerPublic, {
    ciphertext: row.media_key_ciphertext,
    nonce: row.media_key_nonce,
    user_id: row.user_id,
    receiver_id: row.receiver_id,
  });
  if (text === null) return null;
  try {
    return await fromBase64(text);
  } catch {
    return null;
  }
}

/** A row after `openRows` has been over it: the three client-only fields are
 *  present, not merely allowed. */
export type Opened<T> = T & {
  text: string | null;
  media_key: Uint8Array | null;
  decrypt_failed: boolean;
};

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
 * `decrypt_failed` marks the rows that could not be opened. A null `text` on
 * its own does not mean that: an uncaptioned photo or a voice note is inserted
 * with null ciphertext because there was no body to seal, and nothing failed.
 * The row has to be carrying a sealed body for a null to count as a failure.
 * Without an identity nothing can be opened, file keys included, so every row
 * is a failure in that case whether it carries a body or not.
 */
export async function openRows<
  T extends Readable & MediaKeyed & { id: string; created_at: string },
>(
  identity: Identity | null,
  peerPublic: Uint8Array | null,
  peerId: string,
  rows: T[]
): Promise<Opened<T>[]> {
  return Promise.all(
    rows.map(async (row) => {
      // No identity yet: the row is sealed and unopenable, which is exactly
      // what decrypt_failed describes.
      const text = identity ? await openBody(identity, peerPublic, row) : null;
      // The file key opens at the same boundary as the body, so no component
      // rendering an attachment ever has to hold an identity or a peer key.
      const media_key = identity ? await openMediaKey(identity, peerPublic, row) : null;
      if (text !== null) {
        await cacheMessage({
          id: row.id,
          peer_id: peerId,
          user_id: row.user_id,
          text,
          created_at: row.created_at,
        });
      }
      const sealed = row.ciphertext !== null && row.nonce !== null;
      return { ...row, text, media_key, decrypt_failed: text === null && (sealed || !identity) };
    })
  );
}
