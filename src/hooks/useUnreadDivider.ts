// The "new messages" line, decided once per conversation and then left alone.

import { useEffect, useState } from 'react';
import { firstUnreadId, type DividerRow } from '../lib/unread-divider';

/**
 * Which message the unread line sits above, or null when there is none.
 *
 * Decided on the first render where the watermark has been read and there are
 * messages to place it against, then frozen for as long as this conversation
 * stays open. Recomputing would move the line under the reader: everything
 * arriving while they sit here is newer than the watermark, so the line would
 * chase the bottom of the thread and mark messages they are watching arrive.
 *
 * The window it is decided against is whatever is loaded, so a conversation
 * with more unread messages than one page puts the line at the top of that page
 * rather than above the true first one. Paging further back does not move it —
 * a line that jumps while you read is worse than one that is early.
 */
export function useUnreadDivider(
  conversationKey: string,
  me: string,
  rows: readonly DividerRow[],
  /** `undefined` while the watermark read is still in flight. */
  readAt: string | null | undefined
): string | null {
  const [decided, setDecided] = useState<{ key: string; id: string | null } | null>(null);

  useEffect(() => {
    if (readAt === undefined || rows.length === 0) return;
    setDecided((prev) =>
      prev?.key === conversationKey ? prev : { key: conversationKey, id: firstUnreadId(rows, me, readAt) }
    );
  }, [conversationKey, me, rows, readAt]);

  return decided?.key === conversationKey ? decided.id : null;
}
