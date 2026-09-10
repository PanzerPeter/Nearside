// Where the "new messages" line sits in a thread.
//
// Pure, because the rule is the whole feature and the rule has edges: a line
// drawn above your own message says you missed something you wrote, and a line
// that moves as pages load points at whichever message happened to be fetched
// first.

/** The shape both threads can produce: a 1:1 row's `user_id`, a group row's
 *  `sender_id`, and the stamp they are both ordered by. */
export interface DividerRow {
  id: string;
  from: string;
  created_at: string;
}

/**
 * The first message the reader had not seen when they opened the conversation,
 * or null when there is nothing to mark.
 *
 * `readAt` is the watermark as it stood **before** opening — advancing it first
 * and then asking this would always answer null, which is the bug that makes
 * this kind of line quietly stop appearing.
 *
 * Rows may arrive in any order (a jump prepends a page), so the answer is the
 * earliest match rather than the first one in the array.
 */
export function firstUnreadId(
  rows: readonly DividerRow[],
  me: string,
  readAt: string | null
): string | null {
  let best: DividerRow | null = null;
  for (const row of rows) {
    // Your own message is never unread, whatever the watermark says.
    if (row.from === me) continue;
    // Strictly after: the watermark names the last message read, not the first
    // one still to read.
    if (readAt !== null && row.created_at <= readAt) continue;
    if (!best || row.created_at < best.created_at) best = row;
  }
  return best?.id ?? null;
}
