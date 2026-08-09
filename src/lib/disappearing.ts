// Disappearing messages, client side.
//
// The timer belongs to the conversation, not to one side's preference: a
// per-user setting would let one party keep a copy the other believed was
// gone, which is worse than not having the feature. The server stamps and the
// server deletes; everything here is presentation and the local sweep.
import { supabase } from './supabase';

/**
 * The single key for a conversation, whichever side is asking.
 *
 * Sorted rather than "whoever started it first", because there is no such
 * record — and the same normalization runs in `0029_disappearing.sql`'s CHECK
 * constraint, so the two must not drift.
 */
export function normalizePair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export const TTL_OPTIONS: ReadonlyArray<{ seconds: number | null; label: string }> = [
  { seconds: null, label: 'Off' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 604_800, label: '1 week' },
];

export function formatTtl(seconds: number | null): string {
  const known = TTL_OPTIONS.find((option) => option.seconds === seconds);
  if (known) return known.label;
  return `${seconds} seconds`;
}

/** Whether a row's server-stamped expiry has passed. An unparseable value is
 *  reported as not expired: this decides what to delete locally, and guessing
 *  wrong in that direction cannot be undone. */
export function hasExpired(expiresAt: string | null, nowMs: number): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= nowMs;
}

export interface ConversationTimer {
  ttlSeconds: number | null;
  setBy: string;
  updatedAt: string;
}

export interface TimerChange {
  label: string;
  /** When the change was made, so the thread can put it where it happened. */
  at: string;
}

/**
 * The one line the thread shows about the timer.
 *
 * There is exactly one, because `conversation_timers` keeps one row per pair:
 * the current setting and who set it last. Earlier changes were overwritten and
 * are not recoverable, so this is the whole history the app can honestly draw.
 * Both phones read that row, so both show the same line in the same place.
 */
export function describeTimerChange(
  timer: ConversationTimer | null,
  me: string,
  peerLabel: string
): TimerChange | null {
  if (!timer) return null;
  const who = timer.setBy === me ? 'You' : peerLabel;
  const label =
    timer.ttlSeconds === null
      ? `${who} turned off disappearing messages`
      : `${who} set messages to disappear after ${formatTtl(timer.ttlSeconds).toLowerCase()}`;
  return { label, at: timer.updatedAt };
}

/**
 * Where the change belongs in a thread ordered oldest first: before the first
 * message sent after it, or at the end when it is newer than all of them.
 *
 * A timestamp that will not parse is sorted to the end rather than dropped —
 * the line is worth showing in the wrong place, and not worth hiding over.
 */
export function timerChangeIndex(createdAts: readonly string[], at: string): number {
  const changedAt = Date.parse(at);
  if (!Number.isFinite(changedAt)) return createdAts.length;
  const i = createdAts.findIndex((iso) => {
    const sentAt = Date.parse(iso);
    return Number.isFinite(sentAt) && sentAt > changedAt;
  });
  return i === -1 ? createdAts.length : i;
}

export async function loadConversationTimer(
  me: string,
  peerId: string
): Promise<ConversationTimer | null> {
  const [a, b] = normalizePair(me, peerId);
  const { data } = await supabase
    .from('conversation_timers')
    .select('ttl_seconds, set_by, updated_at')
    .eq('user_a', a)
    .eq('user_b', b)
    .maybeSingle();
  if (!data) return null;
  return { ttlSeconds: data.ttl_seconds, setBy: data.set_by, updatedAt: data.updated_at };
}

/** Through the RPC, not a table write: the pair has to be normalized and
 *  `set_by` has to be the caller, and neither can be trusted to a client. */
export async function saveConversationTimer(
  peerId: string,
  ttlSeconds: number | null
): Promise<void> {
  const { error } = await supabase.rpc('set_conversation_timer', {
    peer: peerId,
    ttl: ttlSeconds,
  });
  if (error) throw error;
}

export async function saveRoomTimer(roomId: string, ttlSeconds: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_room_timer', { target: roomId, ttl: ttlSeconds });
  if (error) throw error;
}
