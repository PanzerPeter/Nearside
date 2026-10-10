// Sealing a reaction (0059).
//
// A reaction used to be a plaintext column, on the argument that one emoji
// carries too little to be worth sealing. It carries exactly the part of a
// conversation that is pure content: a heart and a vomiting face under the
// same photograph are different replies, and the server could read every one.
// It is sealed now the way a body is, with the same keys — to the peer in a
// conversation, under the vault key in the self-chat, under the room key in a
// group — and the server keeps who reacted to which message, and when.

import type { Identity } from './crypto/keys';
import { openForSelf, sealForSelf, type Sealed } from './crypto/seal';
import { openBody, sealBody } from './sealed-body';
import { peerPublicKey } from './peer-keys';

/** How a reaction row is sealed and opened in one conversation. */
export interface ReactionSeal {
  seal: (emoji: string) => Promise<Sealed>;
  /** The emoji, or null when this device cannot open it. */
  open: (sealed: Sealed) => Promise<string | null>;
}

/** The emoji columns of a row as fetched. `emoji` is set only on a row written
 *  before 0059, which still renders. */
export interface ReactionColumns {
  emoji: string | null;
  emoji_ciphertext?: string | null;
  emoji_nonce?: string | null;
}

/** One-to-one and the self-chat: `sealBody`'s own rule for which key. The pair
 *  is always (me, peer) because a box opens the same from either side. */
export function conversationReactionSeal(
  identity: Identity,
  me: string,
  peerId: string
): ReactionSeal {
  return {
    seal: async (emoji) => sealBody(identity, await peerPublicKey(peerId), me, peerId, emoji),
    open: async (sealed) =>
      openBody(identity, await peerPublicKey(peerId), {
        ...sealed,
        user_id: me,
        receiver_id: peerId,
      }),
  };
}

/** A group: the room key, which every member holds. Authorship is the row's
 *  `user_id`, which RLS pins to the writer, as it was before. */
export function roomReactionSeal(roomKey: Uint8Array): ReactionSeal {
  return {
    seal: (emoji) => sealForSelf(roomKey, emoji),
    open: async (sealed) => {
      try {
        return await openForSelf(roomKey, sealed);
      } catch {
        return null;
      }
    },
  };
}

/** The emoji columns of an insert. The only place a reaction row's payload
 *  is built, so `no-plaintext.test.ts` checks what is actually sent. */
export async function sealedReactionColumns(sealer: ReactionSeal, emoji: string) {
  const sealed = await sealer.seal(emoji);
  return { emoji_ciphertext: sealed.ciphertext, emoji_nonce: sealed.nonce };
}

/** The emoji a fetched row stands for, or null to leave it out. */
export async function reactionEmoji(
  row: ReactionColumns,
  sealer: ReactionSeal | null
): Promise<string | null> {
  if (row.emoji) return row.emoji;
  if (!sealer || !row.emoji_ciphertext || !row.emoji_nonce) return null;
  return sealer.open({ ciphertext: row.emoji_ciphertext, nonce: row.emoji_nonce });
}
