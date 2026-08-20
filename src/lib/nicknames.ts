// Private friend nicknames: the name YOU gave someone, visible only to you.
//
// Sealed under the vault key since 0041, so "visible only to you" is now true
// of the server as well as of the app — it was a plaintext column before, which
// made the claim true of everything except the one party in a position to
// collect it. Rows written before that still hold plaintext; they are rendered,
// re-sealed and cleared as they are met (`resealPlaintext`), so the old column
// empties itself rather than waiting on anybody.
//
// Backed by public.friend_nicknames (0016), one row per (owner, peer). The
// display_name remains the identity; a nickname is a label painted over it in
// this user's own client, and nothing here changes how anyone is looked up.
//
// A module-level store rather than a context provider, because
// `useMessageNotifications` is called from App's own body and cannot consume a
// provider App renders. Same shape as lib/connection.ts: a value plus a
// listener set, read through a hook or as a plain call. One fetch and one
// realtime channel serve every consumer instead of a query per rendered row.

import { useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { useConnection } from './connection';
import { SELF_CHAT_LABEL } from './conversation';
import { openForSelf, sealForSelf } from './crypto/seal';
import type { Identity } from './crypto/keys';

/** Matches the `nickname_length` CHECK in 0016. */
export const MAX_NICKNAME_LENGTH = 32;

/** A row as the database holds it: sealed, or — before 0041 — not. */
export interface NicknameRow {
  owner_id: string;
  peer_id: string;
  /** Pre-0041 rows only. Null on everything written since. */
  nickname: string | null;
  nickname_ciphertext: string | null;
  nickname_nonce: string | null;
}

/** A row whose name has been opened. The rest of this module works in these. */
export interface OpenedNickname {
  peer_id: string;
  nickname: string;
}

/** Every column the store needs. Named once because the select and the realtime
 *  refetch must not drift apart. */
const COLUMNS = 'owner_id, peer_id, nickname, nickname_ciphertext, nickname_nonce';

/** True for a row still carrying its name in the clear. Pure, and the whole
 *  test for whether 0041's migration still has work left on this device. */
export function isPlaintextRow(row: NicknameRow): boolean {
  return row.nickname !== null && row.nickname_ciphertext === null;
}

/** The peer → nickname map a set of opened rows describes. Pure, and the only
 *  place that decides the map's shape, so `loadNicknames` stays a fetch. */
export function nicknameMapFrom(rows: OpenedNickname[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    // Normalized on read as well as on write, so a row predating a tightened
    // constraint cannot paint a broken line. Unusable values are dropped
    // rather than shown blank.
    const nickname = normalizeNickname(row.nickname);
    if (nickname) map.set(row.peer_id, nickname);
  }
  return map;
}

/**
 * Open what is sealed, take the rest at face value.
 *
 * A row that will not open is skipped rather than thrown on. The way that
 * happens is a row sealed under a different account's vault key — impossible
 * through the policy, but a name that cannot be decrypted must not take the
 * whole sidebar's naming down with it.
 */
export async function openNicknames(
  vaultKey: Uint8Array,
  rows: NicknameRow[]
): Promise<OpenedNickname[]> {
  const opened: OpenedNickname[] = [];
  for (const row of rows) {
    if (row.nickname_ciphertext && row.nickname_nonce) {
      try {
        opened.push({
          peer_id: row.peer_id,
          nickname: await openForSelf(vaultKey, {
            ciphertext: row.nickname_ciphertext,
            nonce: row.nickname_nonce,
          }),
        });
      } catch {
        console.error('nickname could not be opened', row.peer_id);
      }
    } else if (row.nickname) {
      opened.push({ peer_id: row.peer_id, nickname: row.nickname });
    }
  }
  return opened;
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
 * database would: trimmed, 1 to 32 characters, no control characters, since a
 * newline breaks the single line the sidebar and chat header render on.
 * Over-long input is truncated rather than refused, and only ever arrives by
 * paste: the field itself is capped at the same length.
 */
export function normalizeNickname(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const trimmed = stripped.trim().slice(0, MAX_NICKNAME_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * How to name a conversation in one line: the nickname if one was given, the
 * self-chat's default label for your own notes, the display name otherwise.
 * Pure, so the fallback chain is testable without a store. `useNickname`
 * supplies the first argument.
 *
 * The display name used to be prefixed with an `@`, which read as a handle —
 * something you could type at a search box to find the person. There has been
 * no directory to type it into since 0022b, and connect codes replaced the one
 * flow that ever needed one. The sigil was promising a lookup the app does not
 * have.
 */
export function formatDisplayName(
  nickname: string | null | undefined,
  display_name: string | null | undefined,
  selfChat = false
): string {
  const nick = nickname?.trim();
  if (nick) return nick;
  if (selfChat) return SELF_CHAT_LABEL;
  const name = display_name?.trim();
  return name ? name : 'unknown';
}

/** The nickname held for `peerId`, or null. For code outside the React tree. */
export function nicknameFor(peerId: string | null | undefined): string | null {
  if (!peerId) return null;
  return nicknames.get(peerId) ?? null;
}

/** Current map. Exposed for the hook's initial snapshot and for tests. */
function getNicknames(): Map<string, string> {
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

/**
 * Seal the names of any pre-0041 rows and clear the plaintext behind them.
 *
 * Runs after the store has been published, never before: the names are already
 * on screen by then, and a device that goes offline mid-sweep has changed
 * nothing a later pass will not finish. Failures are logged and dropped for the
 * same reason — the row still renders from its plaintext, so the only cost of
 * not migrating today is migrating tomorrow.
 */
async function resealPlaintext(me: string, rows: NicknameRow[], identity: Identity): Promise<void> {
  for (const row of rows.filter(isPlaintextRow)) {
    const nickname = normalizeNickname(row.nickname ?? '');
    if (!nickname) continue;
    try {
      const sealed = await sealForSelf(identity.vaultKey, nickname);
      const { error } = await supabase
        .from('friend_nicknames')
        // One write, both halves: a row that dropped its plaintext without
        // gaining a ciphertext would be a name nobody could read again, and
        // `nickname_plaintext_or_sealed` refuses it anyway.
        .update({
          nickname: null,
          nickname_ciphertext: sealed.ciphertext,
          nickname_nonce: sealed.nonce,
        })
        .eq('owner_id', me)
        .eq('peer_id', row.peer_id);
      if (error) throw error;
    } catch (error) {
      console.error('nickname re-seal failed', error);
      return;
    }
  }
}

/** Replace the store from the server. RLS already scopes rows to the owner;
 *  the explicit filter is belt and braces, and keeps the query intentional. */
async function loadNicknames(me: string, identity: Identity): Promise<void> {
  const { data, error } = await supabase
    .from('friend_nicknames')
    .select(COLUMNS)
    .eq('owner_id', me);

  if (error) {
    // Not fatal: without nicknames every name falls back to the display name.
    // Logged because a missing migration (PGRST205) surfaces here first,
    // before anyone tries to set one.
    console.error('nickname load failed', error);
    return;
  }

  const rows = (data ?? []) as NicknameRow[];
  publish(nicknameMapFrom(await openNicknames(identity.vaultKey, rows)));
  void resealPlaintext(me, rows, identity);
}

/**
 * Keep the store in step with the server for the signed-in user. Call once,
 * from App. Re-runs on wake (`generation`) because a channel joined to a socket
 * that no longer exists rejoins nothing on its own.
 */
export function useNicknameSync(session: Session | null, identity: Identity | null): void {
  const { generation } = useConnection();

  useEffect(() => {
    // No identity means no vault key, and a sealed name cannot be read without
    // one. Nothing is shown rather than something wrong: every name falls back
    // to its display name for the moment the keys take to derive, and this
    // effect re-runs when they land.
    if (!session || !identity) {
      resetNicknames();
      return;
    }
    const me = session.user.id;
    void loadNicknames(me, identity);

    const channel = supabase
      .channel(`nicknames:${me}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_nicknames' },
        () => {
          // RLS scopes this stream to our own rows, so anything arriving is
          // relevant. Refetching the handful of rows cannot drift the way
          // patching the map per event kind can — and the payload is
          // ciphertext, so patching would mean opening it here anyway.
          void loadNicknames(me, identity);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, identity, generation]);
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
      return `A nickname has to be 1 to ${MAX_NICKNAME_LENGTH} characters on one line.`;
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
 * The store updates optimistically so the header and sidebar rename on the
 * same frame as the click, and reverts if the write is refused. Otherwise the
 * realtime echo is the first thing to show it, a round trip later.
 */
export async function saveNickname(
  me: string,
  peerId: string,
  raw: string,
  identity: Identity
): Promise<string | null> {
  const nickname = normalizeNickname(raw);
  if (!nickname) return 'Enter a nickname, or remove the one you have.';

  const previous = nicknames;
  const next = new Map(previous);
  next.set(peerId, nickname);
  publish(next);

  const sealed = await sealForSelf(identity.vaultKey, nickname);
  const { error } = await supabase
    .from('friend_nicknames')
    .upsert(
      {
        owner_id: me,
        peer_id: peerId,
        // Explicitly null, not omitted: an upsert onto a pre-0041 row would
        // otherwise leave the old plaintext beside the new ciphertext, and the
        // reader prefers the ciphertext — so the stale name would sit in the
        // database, readable, for as long as the row lived.
        nickname: null,
        nickname_ciphertext: sealed.ciphertext,
        nickname_nonce: sealed.nonce,
      },
      { onConflict: 'owner_id,peer_id' }
    );

  if (error) {
    console.error('nickname upsert failed', error);
    publish(previous);
    return describeNicknameError(error);
  }
  return null;
}

/** Remove the nickname for `peerId`, falling the name back to `@display_name`. */
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
