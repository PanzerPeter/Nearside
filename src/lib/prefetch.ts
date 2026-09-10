// Which conversations are worth warming before anybody opens them.
//
// The thread cache (`localdb.ts`, `messages_sealed`) makes a *second* open of a
// conversation instant. The first one still waits on the network, which on a
// weak link is the wait people actually notice — they open the app, tap the
// name at the top of the list, and watch a spinner over a chat they were
// reading an hour ago.
//
// So the newest page of the few conversations most likely to be opened is
// pulled while the list is on screen. This module is only the choosing; the
// fetching is `hooks/useThreadPrefetch.ts`.
//
// The restraint matters more than the coverage. A prefetch is bytes spent on a
// guess, and the guess is wrong most of the time — so it is capped hard, it
// only ever runs when realtime says the connection is healthy, and it skips
// every conversation whose newest message this device already holds.

/** How many conversations one pass will warm. The list is ordered with pinned
 *  and most-recent first, so the top of it is where the next tap lands; past a
 *  handful this is spending somebody's data on conversations they are not
 *  going to open. */
export const PREFETCH_CONVERSATIONS = 5;

export interface PrefetchCandidate {
  peer_id: string;
  /** When the newest message in the conversation was sent, per the server's
   *  own list. Null for a conversation nobody has written in. */
  last_at: string | null;
}

/**
 * The conversations to warm, in the order they should be warmed.
 *
 * `newestCached` is what this device already holds per conversation, and it is
 * compared against the list's own `last_at`: equal or newer means the cached
 * page already ends at the newest message, so opening that chat would paint
 * everything and fetch nothing. That check is what keeps this from re-pulling
 * the same five pages on every list refresh.
 *
 * `attempted` is the peers already tried this session, whatever the result. A
 * conversation whose fetch failed is not retried on the next tick: the failure
 * is almost always the same weak link the prefetch exists to soften, and
 * hammering it competes with the messages actually being sent.
 */
export function conversationsToPrefetch(
  rows: readonly PrefetchCandidate[],
  newestCached: ReadonlyMap<string, string>,
  attempted: ReadonlySet<string>,
  max: number = PREFETCH_CONVERSATIONS
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (out.length >= max) break;
    // Nothing has ever been said here, so there is no page to pull.
    if (!row.last_at) continue;
    if (attempted.has(row.peer_id)) continue;
    const held = newestCached.get(row.peer_id);
    if (held && held >= row.last_at) continue;
    out.push(row.peer_id);
  }
  return out;
}
