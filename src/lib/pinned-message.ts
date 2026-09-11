// The one message held at the top of a conversation.
//
// Not to be confused with `lib/pins.ts`, which is about keeping an attachment's
// bytes on this device after the server prunes them. This is the other sense of
// the word: the line everybody in a conversation keeps scrolling back for, kept
// where it can be read without scrolling.
//
// The row is a pointer (migration 0048). The message itself stays in `messages`
// or `room_messages` with its body sealed exactly as it was, so a pin never
// puts a second copy of anything outside the encrypted column — and a client
// that cannot open the message cannot read the pin either.

import { supabase } from './supabase';

export interface PinnedMessage {
  messageId: string;
  pinnedBy: string;
  pinnedAt: string;
}

/** The conversation's pinned message, or null. */
export async function loadConversationPin(
  me: string,
  peerId: string
): Promise<PinnedMessage | null> {
  const [a, b] = me <= peerId ? [me, peerId] : [peerId, me];
  const { data } = await supabase
    .from('conversation_pins')
    .select('message_id, pinned_by, pinned_at')
    .eq('user_a', a)
    .eq('user_b', b)
    .maybeSingle();
  if (!data) return null;
  return { messageId: data.message_id, pinnedBy: data.pinned_by, pinnedAt: data.pinned_at };
}

/** Through the RPC, not a table write: the pair has to be normalized, the
 *  message has to be checked against the conversation, and `pinned_by` has to
 *  be the caller — none of which can be left to a client. */
export async function pinConversationMessage(peerId: string, messageId: string): Promise<void> {
  const { error } = await supabase.rpc('set_conversation_pin', {
    peer: peerId,
    target: messageId,
  });
  if (error) throw error;
}

/** Either participant may unpin — see the policy in 0048 for why. */
export async function unpinConversationMessage(me: string, peerId: string): Promise<void> {
  const [a, b] = me <= peerId ? [me, peerId] : [peerId, me];
  const { error } = await supabase
    .from('conversation_pins')
    .delete()
    .eq('user_a', a)
    .eq('user_b', b);
  if (error) throw error;
}

export async function loadRoomPin(roomId: string): Promise<PinnedMessage | null> {
  const { data } = await supabase
    .from('room_pins')
    .select('message_id, pinned_by, pinned_at')
    .eq('room_id', roomId)
    .maybeSingle();
  if (!data) return null;
  return { messageId: data.message_id, pinnedBy: data.pinned_by, pinnedAt: data.pinned_at };
}

export async function pinRoomMessage(roomId: string, messageId: string): Promise<void> {
  const { error } = await supabase.rpc('set_room_pin', {
    target_room: roomId,
    target: messageId,
  });
  if (error) throw error;
}

export async function unpinRoomMessage(roomId: string): Promise<void> {
  const { error } = await supabase.from('room_pins').delete().eq('room_id', roomId);
  if (error) throw error;
}
