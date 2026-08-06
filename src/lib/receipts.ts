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

/** Display helper: cap large counts so the badge keeps its width. */
export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count);
}
