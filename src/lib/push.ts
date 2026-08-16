import { supabase } from './supabase';

/**
 * Fire-and-forget: ask the backend to push a notification to the receiver.
 *
 * `isSelf` short-circuits it. The Edge Function refuses a self-addressed push
 * anyway (as does the database trigger), but there is no reason to spend the
 * request.
 */
export function notifyReceiver(messageId: string, isSelf: boolean): void {
  if (isSelf) return;
  supabase.functions.invoke('send-push', { body: { message_id: messageId } }).catch(() => {});
}

/**
 * The same, for a room message: the function fans out to every member except
 * the sender.
 *
 * This is the live path, not a belt to the database trigger's braces. The
 * trigger only fires once `push_config` holds a row, and it does not on this
 * project — so before this call existed, a room message notified nobody at
 * all.
 */
export function notifyRoom(roomMessageId: string): void {
  supabase.functions
    .invoke('send-push', { body: { room_message_id: roomMessageId } })
    .catch(() => {});
}
