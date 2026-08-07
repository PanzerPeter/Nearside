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
