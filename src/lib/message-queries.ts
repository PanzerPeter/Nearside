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

/**
 * The newest live row in a conversation, and nothing else.
 *
 * For the sidebar preview, which needs one line: `fetchLatestPage` would pull
 * thirty rows per conversation to render it. Tombstones are excluded because a
 * deleted message has no preview to show.
 */
export async function fetchNewestMessage(me: string, peerId: string): Promise<Message | null> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .or(conversationFilter(me, peerId))
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Message | null) ?? null;
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
 * Whether `incoming` says anything `held` does not.
 *
 * Compared field by field rather than by identity, because every row that
 * arrives has been through `open()` and is a fresh object even when the server
 * sent back exactly what we already had. The columns listed are the ones a row
 * can change in: an edit, a soft delete, and the expiry the trigger stamps.
 * `text` covers the edit's payload, which is what `open()` produced from the
 * ciphertext.
 */
export function rowChanged(held: Message, incoming: Message): boolean {
  return (
    held.text !== incoming.text ||
    held.edited_at !== incoming.edited_at ||
    held.deleted_at !== incoming.deleted_at ||
    held.expires_at !== incoming.expires_at ||
    held.ciphertext !== incoming.ciphertext
  );
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
 *
 * Returns `prev` itself when nothing in `incoming` is new or different. That
 * identity is load-bearing rather than a micro-optimisation: `fetchSince` uses
 * `gte` and so re-fetches the cursor row on every tick by design, which means
 * the poll delivers a row the thread already holds every 45 seconds — every 6
 * while realtime is down. A fresh array for that re-render the whole thread,
 * re-ran `useReplyTargets`'s map, and handed `MediaAttachment` a new key array
 * for a key that had not changed.
 */
export function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return prev;

  const byKey = new Map(prev.map((m) => [m.id, m]));
  let differs = false;
  for (const m of incoming) {
    const held = byKey.get(m.id);
    if (!held || rowChanged(held, m)) differs = true;
    byKey.set(m.id, m);
  }
  if (!differs) return prev;

  return [...byKey.values()].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at < b.created_at
        ? -1
        : 1
  );
}

/**
 * The rows of `fetched` worth opening: ones the thread does not hold, or holds
 * in an older shape.
 *
 * Decryption is the expensive half of a catch-up and the poll's usual result is
 * a single row that has not changed since the last tick. Compared on the sealed
 * columns, since this runs *before* `open()` — `ciphertext` is what an edit
 * rewrites, and the two timestamps cover a soft delete and an expiry stamp.
 */
export function unseenRows(held: readonly Message[], fetched: readonly Message[]): Message[] {
  if (fetched.length === 0) return [];
  const byId = new Map(held.map((m) => [m.id, m]));
  return fetched.filter((row) => {
    const have = byId.get(row.id);
    return (
      !have ||
      have.ciphertext !== row.ciphertext ||
      have.edited_at !== row.edited_at ||
      have.deleted_at !== row.deleted_at ||
      have.expires_at !== row.expires_at
    );
  });
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
    // by the forward picker and never passes through here, and a sealed
    // question is written by an RPC that has to be online to run at all.
    forwarded: false,
    sealed_prompt: false,
    edited_at: null,
    deleted_at: null,
    // Not stamped yet: the trigger runs on insert, and this row has not reached
    // the server. The real value arrives with the row the send returns.
    expires_at: null,
    created_at: msg.created_at,
  };
}
