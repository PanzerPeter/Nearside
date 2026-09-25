/**
 * Blocking — the one "stop this person" that the server enforces.
 *
 * A block leaves the friendship in place, so the conversation stays in both
 * lists and its history stays readable on both phones. What it closes is every
 * write into the conversation: messages, edits, reactions, sealed answers,
 * pins, the timer and calls (migration 0053). The row is visible to both
 * people, which is how the blocked side is told rather than left sending into
 * silence.
 *
 * One row per direction. Both people can block each other, and unblocking
 * deletes only your own row — so the conversation opens again only once
 * neither row is left. `blockStatus` is where that is decided for the UI; the
 * database decides it again for itself in `is_blocked_pair`.
 *
 * The rows are held module-side, like the chat flags, because the chat list
 * and the open conversation do not share a subtree and both need them.
 * `forgetBlocks` belongs in `App.releaseAccount` with every other per-account
 * cache.
 */

import { supabase } from './supabase';

export interface BlockRow {
  blocker_id: string;
  blocked_id: string;
}

/**
 * Where a conversation stands.
 *
 * `both` is its own state rather than a flavour of `byMe`: the blocker is told
 * that unblocking will not reopen the conversation, because the other person
 * has blocked them too.
 */
export type BlockStatus = 'none' | 'byMe' | 'byThem' | 'both';

export function blockStatus(rows: readonly BlockRow[], me: string, peer: string): BlockStatus {
  const mine = rows.some((r) => r.blocker_id === me && r.blocked_id === peer);
  const theirs = rows.some((r) => r.blocker_id === peer && r.blocked_id === me);
  if (mine && theirs) return 'both';
  if (mine) return 'byMe';
  if (theirs) return 'byThem';
  return 'none';
}

/** Everyone on the other side of a block in either direction — the peers the
 *  app stops listening for calls and presence from. */
export function blockedPeers(rows: readonly BlockRow[], me: string): Set<string> {
  const peers = new Set<string>();
  for (const r of rows) {
    if (r.blocker_id === me) peers.add(r.blocked_id);
    else if (r.blocked_id === me) peers.add(r.blocker_id);
  }
  return peers;
}

/** The people this account has blocked, for the list in Settings. */
export function blockedByMe(rows: readonly BlockRow[], me: string): string[] {
  return rows.filter((r) => r.blocker_id === me).map((r) => r.blocked_id);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let current: readonly BlockRow[] = [];
const listeners = new Set<() => void>();

export function subscribeBlocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rows as last read. A stable reference until they change, which is what
 *  `useSyncExternalStore` needs. */
export function currentBlocks(): readonly BlockRow[] {
  return current;
}

export function setBlocks(rows: readonly BlockRow[]): void {
  current = rows;
  for (const listener of listeners) listener();
}

/** Drop the previous account's rows. Left behind, the next account on this
 *  phone would open its first chat against somebody else's blocks. */
export function forgetBlocks(): void {
  setBlocks([]);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** Every block this account is on either side of. RLS scopes the read, so no
 *  filter is needed. Null when the read failed — which is not "no blocks". */
export async function fetchBlocks(): Promise<BlockRow[] | null> {
  const { data, error } = await supabase.from('blocks').select('blocker_id, blocked_id');
  if (error) return null;
  return (data ?? []) as BlockRow[];
}

/** Re-read into the store. A failed read leaves the last known rows alone. */
export async function refreshBlocks(): Promise<void> {
  const rows = await fetchBlocks();
  if (rows) setBlocks(rows);
}

export async function blockUser(me: string, peer: string): Promise<boolean> {
  const { error } = await supabase.from('blocks').insert({ blocker_id: me, blocked_id: peer });
  // Already blocked — a second tap, or another device got there first — is
  // the state that was asked for, not a failure.
  if (error && error.code !== '23505') return false;
  if (!current.some((r) => r.blocker_id === me && r.blocked_id === peer)) {
    setBlocks([...current, { blocker_id: me, blocked_id: peer }]);
  }
  return true;
}

export async function unblockUser(me: string, peer: string): Promise<boolean> {
  const { error } = await supabase
    .from('blocks')
    .delete()
    .eq('blocker_id', me)
    .eq('blocked_id', peer);
  if (error) return false;
  setBlocks(current.filter((r) => !(r.blocker_id === me && r.blocked_id === peer)));
  return true;
}
