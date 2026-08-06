// Private friend nicknames: the name YOU gave someone, visible only to you.
//
// Backed by public.friend_nicknames (0016), one row per (owner, peer). The
// username is still the identity — a nickname is a label painted over it in
// this user's own client, so nothing here changes how anyone is looked up.
//
// Why a module-level store rather than a context provider: the notification
// hook that needs a nickname (`useMessageNotifications`) is called from App's
// own body, so it cannot consume a provider App itself renders. Same shape as
// lib/connection.ts — a value plus a listener set, read either through a hook
// or as a plain function call. One fetch and one realtime channel serve every
// consumer, instead of a query per rendered row.

import { useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useConnection } from './connection';
import { SELF_CHAT_LABEL } from './conversation';

/** Matches the `nickname_length` CHECK in 0016. */
export const MAX_NICKNAME_LENGTH = 32;

export interface NicknameRow {
  owner_id: string;
  peer_id: string;
  nickname: string;
}

/** The peer → nickname map a set of rows describes. Pure, and the only place
 *  that decides the map's shape, so `loadNicknames` stays a fetch. */
export function nicknameMapFrom(rows: NicknameRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    // A normalize pass on read as well as on write: a row predating a tightened
    // constraint, or one written by another client, must not paint a broken
    // line. An unusable value is dropped rather than shown as blank.
    const nickname = normalizeNickname(row.nickname);
    if (nickname) map.set(row.peer_id, nickname);
  }
  return map;
}

/** peer id → nickname. Replaced wholesale on change so the identity check in
 *  subscribing components is enough to trigger a re-render. */
let nicknames = new Map<string, string>();
const listeners = new Set<(m: Map<string, string>) => void>();

function publish(next: Map<string, string>): void {
  nicknames = next;
  for (const listener of listeners) listener(nicknames);
}

/**
 * A nickname as it may be stored, or null if `raw` holds no usable name.
 *
 * Mirrors both CHECK constraints in 0016 so the client rejects what the
 * database would: trimmed, 1–32 characters, no control characters (a newline
 * would break the single line the sidebar and chat header render it on).
 * Over-long input is truncated rather than refused — the input is capped at
 * the same length in the UI, so this only catches paste.
 */
export function normalizeNickname(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const trimmed = stripped.trim().slice(0, MAX_NICKNAME_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * How to name a conversation in one line: the nickname if one was given, the
 * self-chat's default label for your own notes, `@username` otherwise. Pure, so
 * the whole fallback chain is testable without a store; `useNickname` supplies
 * the first argument.
 */
export function formatDisplayName(
  nickname: string | null | undefined,
  username: string | null | undefined,
  selfChat = false
): string {
  const nick = nickname?.trim();
  if (nick) return nick;
  if (selfChat) return SELF_CHAT_LABEL;
  const name = username?.trim();
  return name ? `@${name}` : 'unknown';
}

/** The nickname held for `peerId`, or null. For code outside the React tree. */
export function nicknameFor(peerId: string | null | undefined): string | null {
  if (!peerId) return null;
  return nicknames.get(peerId) ?? null;
}

/** Current map. Exposed for the hook's initial snapshot and for tests. */
export function getNicknames(): Map<string, string> {
  return nicknames;
}

export function subscribeNicknames(
  listener: (m: Map<string, string>) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop everything. Called on sign-out so the next account starts clean. */
export function resetNicknames(): void {
  if (nicknames.size === 0) return;
  publish(new Map());
}

/** Replace the store from the server. RLS already scopes rows to the owner;
 *  the explicit filter is belt and braces, and keeps the query intentional. */
async function loadNicknames(me: string): Promise<void> {
  const { data, error } = await supabase
    .from('friend_nicknames')
    .select('owner_id, peer_id, nickname')
    .eq('owner_id', me);

  if (error) {
    // Not fatal: without nicknames every name falls back to @username, which
    // is exactly the pre-feature behaviour. Logged because a missing migration
    // (PGRST205) surfaces here first, before anyone tries to set one.
    console.error('nickname load failed', error);
    return;
  }

  publish(nicknameMapFrom((data ?? []) as NicknameRow[]));
}

/**
 * Keep the store in step with the server for the signed-in user. Call once,
 * from App. Re-runs on wake (`generation`) because a channel joined to a socket
 * that no longer exists rejoins nothing on its own.
 */
export function useNicknameSync(session: Session | null): void {
  const { generation } = useConnection();

  useEffect(() => {
    if (!session) {
      resetNicknames();
      return;
    }
    const me = session.user.id;
    void loadNicknames(me);

    const channel = supabase
      .channel(`nicknames:${me}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_nicknames' },
        () => {
          // RLS scopes this stream to our own rows, so anything that arrives is
          // ours and relevant. Refetching the whole set (a handful of rows) is
          // simpler than patching the map per event kind, and it cannot drift.
          void loadNicknames(me);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, generation]);
}

/** Subscribe a component to the whole map. For the callers that name several
 *  peers at once (the forward picker) and so cannot use a hook per row. */
export function useNicknameMap(): Map<string, string> {
  const [snapshot, setSnapshot] = useState<Map<string, string>>(getNicknames);
  useEffect(() => subscribeNicknames(setSnapshot), []);
  return snapshot;
}

/** Subscribe a component to one peer's nickname. */
export function useNickname(peerId: string | null | undefined): string | null {
  const snapshot = useNicknameMap();
  return peerId ? snapshot.get(peerId) ?? null : null;
}

/** The shape of a PostgREST error, narrowed to what the message depends on. */
interface WriteError {
  code?: string;
  message?: string;
}

/**
 * A user-facing message for a failed nickname write. Same reasoning as
 * `describeWriteError` in lib/background.ts: a setup problem and a permission
 * problem must not read identically, so the codes with an unambiguous cause get
 * a specific message and everything else falls through to the server's text.
 */
function describeNicknameError(error: WriteError | null | undefined): string {
  if (!error) return 'Could not save the nickname.';
  switch (error.code) {
    // Table missing from PostgREST's schema cache: 0016 has not been run, or
    // has not been picked up yet.
    case 'PGRST205':
      return 'Nicknames are not set up on the server yet.';
    // A CHECK constraint rejected the value — length or a control character.
    case '23514':
      return `A nickname must be 1–${MAX_NICKNAME_LENGTH} characters on one line.`;
    // Postgres "permission denied": the role lacks table privileges. Distinct
    // from an RLS denial, which returns 0 rows.
    case '42501':
      return 'No permission to set a nickname for this person.';
    default:
      return error.message?.trim() || 'Could not save the nickname.';
  }
}

/**
 * Store a nickname for `peerId`. Resolves to an error message, or null on
 * success; the caller owns how that is surfaced.
 *
 * The store is updated optimistically so the header and sidebar rename on the
 * same frame as the click, then reverted if the write is refused — the realtime
 * echo would otherwise be the first thing to show it, a round trip later.
 */
export async function saveNickname(
  me: string,
  peerId: string,
  raw: string
): Promise<string | null> {
  const nickname = normalizeNickname(raw);
  if (!nickname) return 'Enter a nickname, or remove the one you have.';

  const previous = nicknames;
  const next = new Map(previous);
  next.set(peerId, nickname);
  publish(next);

  const { error } = await supabase
    .from('friend_nicknames')
    .upsert(
      { owner_id: me, peer_id: peerId, nickname },
      { onConflict: 'owner_id,peer_id' }
    );

  if (error) {
    console.error('nickname upsert failed', error);
    publish(previous);
    return describeNicknameError(error);
  }
  return null;
}

/** Remove the nickname for `peerId`, falling the name back to `@username`. */
export async function clearNickname(me: string, peerId: string): Promise<string | null> {
  const previous = nicknames;
  if (previous.has(peerId)) {
    const next = new Map(previous);
    next.delete(peerId);
    publish(next);
  }

  const { error } = await supabase
    .from('friend_nicknames')
    .delete()
    .eq('owner_id', me)
    .eq('peer_id', peerId);

  if (error) {
    console.error('nickname delete failed', error);
    publish(previous);
    return describeNicknameError(error);
  }
  return null;
}
