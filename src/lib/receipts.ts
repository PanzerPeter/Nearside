// Server-side delivery & read state.
//
// Each row of `message_receipts` is owned by the person RECEIVING from `peer_id`
// and carries two monotonic watermarks. Everything compares against
// `messages.created_at`, which Postgres stamps with the server clock — so we
// only ever write timestamps lifted off a message row we actually received.
// Writing `Date.now()` here would mis-set every comparison by the device's skew,
// which is exactly the bug the old localStorage implementation had to work
// around.

import { supabase } from './supabase';

export interface Receipt {
  user_id: string;
  peer_id: string;
  delivered_at: string | null;
  read_at: string | null;
}

export type MessageStatusKind = 'pending' | 'sent' | 'delivered' | 'read';

/**
 * Parse an ISO timestamp to epoch millis, or null if unparseable. PostgREST's
 * actual wire format for timestamptz omits fractional seconds when zero and
 * uses a `+00:00` offset rather than `Z` (e.g. `2026-07-20T10:00:00+00:00`),
 * so watermark comparisons must not depend on both sides sharing one string
 * shape — they must agree on the instant.
 */
function toEpochMillis(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Which glyph one of MY sent messages should show, given the peer's receipt row.
 *
 * `peerReceipt` is the row the peer owns about messages from me — so its
 * `user_id` is the peer and its `peer_id` is me. Watermarks are inclusive: a
 * message created at exactly the watermark counts as covered.
 */
export function statusFor(
  createdAt: string,
  peerReceipt: Receipt | null
): MessageStatusKind {
  if (!peerReceipt) return 'sent';

  const created = toEpochMillis(createdAt);
  // An unparseable message timestamp can't be compared against anything, so
  // fall through to the weakest status rather than risk a wrong tick.
  if (created === null) return 'sent';

  const readAt = peerReceipt.read_at ? toEpochMillis(peerReceipt.read_at) : null;
  if (readAt !== null && readAt >= created) return 'read';

  const deliveredAt = peerReceipt.delivered_at ? toEpochMillis(peerReceipt.delivered_at) : null;
  if (deliveredAt !== null && deliveredAt >= created) return 'delivered';

  return 'sent';
}

/** Upsert my watermark row for one peer. The DB trigger clamps regressions. */
async function advance(
  peerId: string,
  patch: { delivered_at: string } | { read_at: string }
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) return;

  const { error } = await supabase
    .from('message_receipts')
    .upsert({ user_id: me, peer_id: peerId, ...patch }, { onConflict: 'user_id,peer_id' });
  if (error) {
    console.warn(`receipts: failed to upsert watermark for peer ${peerId}`, error);
  }
}

/**
 * Mark everything this peer sent me up to `iso` as having reached this device.
 * Call with the `created_at` of a message we just observed — never a local clock.
 */
export async function advanceDelivered(peerId: string, iso: string): Promise<void> {
  await advance(peerId, { delivered_at: iso });
}

/**
 * Mark everything this peer sent me up to `iso` as read. The trigger pulls
 * `delivered_at` forward to match, so a read message never shows one tick.
 */
export async function advanceRead(peerId: string, iso: string): Promise<void> {
  await advance(peerId, { read_at: iso });
}

/** Unread tally per peer, counted server-side. Only peers with ≥1 appear. */
export async function fetchUnreadCounts(): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const { data, error } = await supabase.rpc('unread_counts');
  if (error) console.warn('unread_counts failed', error.message);
  if (error || !data) return result;
  for (const row of data as Array<{ peer_id: string; unread: number }>) {
    if (row.unread > 0) result.set(row.peer_id, Number(row.unread));
  }
  return result;
}

/** The peer's receipt row about messages I sent them — the source of my ticks. */
export async function fetchPeerReceipt(peerId: string): Promise<Receipt | null> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) return null;

  const { data: row, error } = await supabase
    .from('message_receipts')
    .select('user_id, peer_id, delivered_at, read_at')
    .eq('user_id', peerId)
    .eq('peer_id', me)
    .maybeSingle();
  if (error) {
    console.warn(`receipts: failed to fetch receipt from peer ${peerId}`, error);
  }

  return row ?? null;
}

/**
 * How far *this* account has read in a conversation.
 *
 * Read once when a conversation opens, before the watermark is advanced by
 * looking at it — that ordering is the whole feature, since a watermark read
 * after it moves always says "nothing new".
 */
export async function fetchMyReadAt(peerId: string): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) return null;

  const { data: row, error } = await supabase
    .from('message_receipts')
    .select('read_at')
    .eq('user_id', me)
    .eq('peer_id', peerId)
    .maybeSingle();
  if (error) {
    console.warn(`receipts: failed to fetch own watermark for peer ${peerId}`, error);
    // Not null: an unreadable watermark would draw the line above the whole
    // conversation, which claims everything is unread on a read failure.
    return new Date().toISOString();
  }
  return (row as { read_at: string | null } | null)?.read_at ?? null;
}

/**
 * Whether this account currently lets its peers see its watermarks.
 *
 * The row is the setting; the *enforcement* is the SELECT policy on
 * `message_receipts` (migration 0045). This read exists so the toggle can show
 * the account's real answer rather than whatever this device last cached —
 * accounts move between devices and the answer travels with the account.
 */
export async function fetchShareRead(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) return true;

  const { data: row, error } = await supabase
    .from('receipt_prefs')
    .select('share_read')
    .eq('user_id', me)
    .maybeSingle();
  // No row, or a database that predates 0045: shared, which is how the app
  // behaved before the setting existed.
  if (error) return true;
  return (row as { share_read: boolean } | null)?.share_read ?? true;
}

/** Change it. Throws, so the settings page can say the change did not land
 *  rather than showing a switch that lies about the server's state. */
export async function setShareRead(on: boolean): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const me = data.session?.user.id;
  if (!me) throw new Error('not signed in');

  const { error } = await supabase
    .from('receipt_prefs')
    .upsert({ user_id: me, share_read: on }, { onConflict: 'user_id' });
  if (error) throw error;
}

/** Display helper: cap large counts so the badge keeps its width. */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count);
}
