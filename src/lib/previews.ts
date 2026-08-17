/**
 * Which conversations the sidebar cannot preview yet, and must fetch to.
 *
 * Bodies are opened in exactly one place — `openRows` — and that runs only for
 * a thread somebody has on screen. So a message that arrives while the list is
 * in front, or while a different chat is open, or while the app is closed
 * altogether, is never opened and never mirrored: the row has a timestamp from
 * the server and no plaintext on this device, and `ConversationRow` prints
 * "Encrypted message" for a message this device could read perfectly well.
 *
 * The comparison is the server's newest timestamp against the mirror's newest
 * timestamp for the same peer. Equal or newer means the list is showing the
 * real thing.
 */

/** How many conversations one pass may probe. A cold start on a busy account
 *  would otherwise open a query per contact in the same tick. */
export const PREVIEW_PROBE_LIMIT = 8;

/** Identifies the *message* a probe was aimed at, so one that comes back with
 *  nothing — an uncaptioned photo has no body to open — is not retried on every
 *  refresh for the rest of the session. */
export function previewProbeKey(peerId: string, lastAt: string): string {
  return `${peerId}@${lastAt}`;
}

interface PreviewRow {
  peer_id: string;
  /** When the newest message in this conversation was stamped by the server,
   *  or null when there has never been one. */
  last_at: string | null;
}

/**
 * Peers whose newest message is missing from the mirror, most recent first.
 *
 * `cachedAt` holds the `created_at` of the newest mirrored message per peer.
 * `attempted` holds `previewProbeKey`s already probed this session.
 */
export function stalePreviews(
  rows: readonly PreviewRow[],
  cachedAt: ReadonlyMap<string, string | null>,
  attempted: ReadonlySet<string>,
  limit: number = PREVIEW_PROBE_LIMIT
): string[] {
  return rows
    .filter((row) => {
      if (!row.last_at) return false;
      if (attempted.has(previewProbeKey(row.peer_id, row.last_at))) return false;
      const mirrored = cachedAt.get(row.peer_id);
      // String comparison is safe: these are the same ISO-8601 UTC stamps
      // Postgres produced, and lexical order is chronological order for them.
      return !mirrored || mirrored < row.last_at;
    })
    .sort((a, b) => (a.last_at! < b.last_at! ? 1 : -1))
    .slice(0, limit)
    .map((row) => row.peer_id);
}
