import type { Identity } from './crypto/keys';
import { openForSelf, sealForSelf } from './crypto/seal';
import { isSelfChat } from './conversation';

export interface BodyColumns {
  content: string | null;
  ciphertext: string | null;
  nonce: string | null;
}

interface Readable extends BodyColumns {
  user_id: string;
  receiver_id: string;
}

/**
 * Columns for a message insert.
 *
 * The self-chat is sealed with the vault key; a peer conversation is still
 * plaintext, because sealing to a peer requires their published key and the
 * verified connect flow that Plan 3 introduces. Plan 3 deletes the else
 * branch and this comment with it.
 */
export async function sealBody(
  identity: Identity,
  me: string,
  peerId: string,
  text: string
): Promise<BodyColumns> {
  if (!isSelfChat(me, peerId)) return { content: text, ciphertext: null, nonce: null };
  const sealed = await sealForSelf(identity.vaultKey, text);
  return { content: null, ciphertext: sealed.ciphertext, nonce: sealed.nonce };
}

/**
 * Plaintext for a row, or null when it cannot be opened.
 *
 * Null is a rendering instruction, not an error to swallow: spec §10 requires
 * an explicit "can't decrypt" bubble, because a blank one is indistinguishable
 * from a message someone actually sent as empty.
 */
export async function openBody(identity: Identity, row: Readable): Promise<string | null> {
  if (row.ciphertext === null || row.nonce === null) return row.content;
  if (!isSelfChat(row.user_id, row.receiver_id)) return null;
  try {
    return await openForSelf(identity.vaultKey, { ciphertext: row.ciphertext, nonce: row.nonce });
  } catch {
    return null;
  }
}

/**
 * Fetched rows with their bodies opened into `content`, once, as they enter
 * state.
 *
 * This is the seam that keeps the rest of the app unchanged: `MessageBubble`,
 * `messageSnippet`, the forward picker and the reply quote all read
 * `msg.content`, and they keep doing so. Decrypting here rather than at each
 * of those sites also means once per row instead of once per render, and rows
 * re-render on every presence tick.
 *
 * `decrypt_failed` marks the rows that could not be opened, because a null
 * `content` alone is indistinguishable from a media message with no caption —
 * and the two must not render the same way.
 */
export async function openRows<T extends Readable>(
  identity: Identity | null,
  rows: T[]
): Promise<T[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.ciphertext === null || row.nonce === null) return row;
      // No identity yet: the row is sealed and unopenable, which is exactly
      // what decrypt_failed describes.
      const content = identity ? await openBody(identity, row) : null;
      return { ...row, content, decrypt_failed: content === null };
    })
  );
}
