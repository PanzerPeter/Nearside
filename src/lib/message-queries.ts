// Every read of the `messages` table the open conversation makes, in one
// place, plus the two pure helpers that shape what comes back.
//
// These return rows exactly as fetched — still sealed. Opening them is the
// caller's job, because the decrypt boundary needs a peer key and an identity
// that this module has no business holding: see `ChatRoom.open`.

import { supabase } from './supabase';
import { conversationFilter } from './conversation';
import { Message, PendingMessage } from './types';

export const PAGE_SIZE = 30;

/** Rows one incremental catch-up will pull. Hitting this cap means the gap is
 *  wider than the window we hold, so the thread is rebuilt from scratch
 *  instead — see `pullNew`. */
export const CATCHUP_LIMIT = 100;

/** Keyset position in the thread. Both halves are needed: two messages sent in
 *  the same instant share a `created_at`, and paging on that column alone
 *  silently drops whichever of them sits on the page boundary. */
export interface Cursor {
  created_at: string;
  id: string;
}

/** The newest page of the conversation, newest first. */
export async function fetchLatestPage(me: string, peerId: string): Promise<Message[]> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .or(conversationFilter(me, peerId))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as Message[];
}

/** The page immediately older than `cursor`, newest first. */
export async function fetchOlderPage(
  me: string,
  peerId: string,
  cursor: Cursor
): Promise<Message[]> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .or(conversationFilter(me, peerId))
    .or(
      `created_at.lt.${cursor.created_at},` +
        `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as Message[];
}

/**
 * Everything in this conversation at or after `sinceIso`, oldest first.
 *
 * `gte`, not `gt`: two messages can share a timestamp to the microsecond, and
 * `gt` would step over the one that isn't ours. Re-fetching the cursor row
 * itself is the cost, and `mergeMessages` de-dupes it by id.
 */
export async function fetchSince(
  me: string,
  peerId: string,
  sinceIso: string,
  limit: number
): Promise<Message[]> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .or(conversationFilter(me, peerId))
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  return (data ?? []) as Message[];
}

/**
 * Read back a row this client wrote, for the duplicate-send path in the
 * outbox.
 *
 * Scoped to `user_id = me` so a uuid that somehow belongs to someone else's
 * message can never be adopted as one of ours; `maybeSingle` so a row that has
 * since been hard-deleted reads as absent rather than as an error.
 */
export async function fetchOwnMessageRow(me: string, id: string): Promise<Message | null> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('id', id)
    .eq('user_id', me)
    .maybeSingle();
  return (data as Message) ?? null;
}

/**
 * Merge fetched rows into the list, de-duplicating by id and keeping the
 * conversation in `created_at` order.
 *
 * The initial load and the realtime subscription race by construction: the
 * channel is live while the first query is still in flight, so a message
 * arriving in that window is appended and then wiped by the query's result,
 * which was snapshotted before it existed. Merging instead of replacing keeps
 * it.
 */
export function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return prev;
  const byKey = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) byKey.set(m.id, m);
  return [...byKey.values()].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at < b.created_at
        ? -1
        : 1
  );
}

/** Shape a queued send as a `Message` so it can render through the same bubble. */
export function pendingAsMessage(msg: PendingMessage): Message {
  return {
    id: msg.id,
    user_id: msg.user_id,
    receiver_id: msg.receiver_id,
    // An optimistic bubble is local text that was never sealed — it has no
    // ciphertext to open, and `text` is exactly the field the bubble reads.
    text: msg.text,
    ciphertext: null,
    nonce: null,
    media_path: null,
    media_type: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_duration_ms: null,
    reply_to_id: msg.reply_to_id,
    // The outbox only ever queues typed text; a forward is inserted directly
    // by the forward picker and never passes through here.
    forwarded: false,
    edited_at: null,
    deleted_at: null,
    // Not stamped yet: the trigger runs on insert, and this row has not reached
    // the server. The real value arrives with the row the send returns.
    expires_at: null,
    created_at: msg.created_at,
  };
}
