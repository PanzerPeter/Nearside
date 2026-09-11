// Filling the local mirror with the rest of a conversation, on request.
//
// The loop is `lib/history-backfill.ts`; this is the bookkeeping around it —
// where the bookmark is kept (`localdb`), who is allowed to start one, and what
// the screen is told while it runs.
//
// Started by the three things that read the mirror and were quietly answering
// from a fraction of it: the in-chat search, the "in this conversation" panel,
// and the transcript export. Not started by opening a chat: a walk through
// every message is worth a conversation's worth of requests when somebody has
// asked a question of the whole thing, and is not worth it to paint a screen
// that already has what it needs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { historySync, rememberHistorySync } from '../lib/localdb';
import {
  runBackfill,
  type BackfillProgress,
  type HistoryCursor,
} from '../lib/history-backfill';

export interface HistoryBackfill {
  /** Walk the rest of the conversation into the mirror, or join a walk already
   *  running. Resolves when there is nothing left to fetch — or when the run
   *  stopped early, which the flags below describe. */
  ensure: () => Promise<void>;
  /** A page is in flight. */
  running: boolean;
  /** Rows fetched since this conversation was opened. Bumped per page so a
   *  panel reading the mirror can re-read as the history lands, rather than
   *  sitting still until the whole walk finishes. */
  fetched: number;
  /** The mirror holds this conversation back to its first message. */
  complete: boolean;
}

interface Options {
  /** A peer's user id, or a room's — the mirror keys both the same way. */
  conversationId: string;
  /** False while there is nothing to read the mirror for, or before the keys
   *  needed to open a page exist. `ensure` does nothing until it is true. */
  ready: boolean;
  pageSize: number;
  /**
   * One page older than the cursor, newest first, **already opened** — opening
   * is what writes it to the mirror. Held in a ref, so a caller may rebuild it
   * per render without restarting the walk.
   */
  fetchOlder: (cursor: HistoryCursor | null) => Promise<readonly HistoryCursor[]>;
}

export function useHistoryBackfill({
  conversationId,
  ready,
  pageSize,
  fetchOlder,
}: Options): HistoryBackfill {
  const [running, setRunning] = useState(false);
  const [fetched, setFetched] = useState(0);
  const [complete, setComplete] = useState(false);

  const fetchRef = useRef(fetchOlder);
  fetchRef.current = fetchOlder;

  /** Cleared when the conversation changes or the view goes away, which is what
   *  stops a walk mid-page rather than letting it write for a chat nobody is
   *  looking at any more. */
  const alive = useRef(true);
  /** The run in flight, so three panels asking at once share one walk instead
   *  of paging the same conversation three times over. */
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    alive.current = true;
    setFetched(0);
    setComplete(false);
    inFlight.current = null;
    let current = true;
    void historySync(conversationId).then((state) => {
      if (current) setComplete(state?.complete === 1);
    });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [conversationId]);

  const ensure = useCallback(async () => {
    if (!ready) return;
    if (inFlight.current) return inFlight.current;

    const run = (async () => {
      const state = await historySync(conversationId);
      if (state?.complete === 1) {
        setComplete(true);
        return;
      }
      if (!alive.current) return;

      setRunning(true);
      try {
        const save = async (progress: BackfillProgress) => {
          await rememberHistorySync({
            peer_id: conversationId,
            oldest_at: progress.cursor?.created_at ?? null,
            oldest_id: progress.cursor?.id ?? null,
            complete: progress.complete ? 1 : 0,
          });
          if (!alive.current) return;
          setFetched(progress.rows);
          if (progress.complete) setComplete(true);
        };

        await runBackfill({
          start:
            state?.oldest_at && state.oldest_id
              ? { created_at: state.oldest_at, id: state.oldest_id }
              : null,
          pageSize,
          fetchOlder: (cursor) => fetchRef.current(cursor),
          onPage: save,
          keepGoing: () => alive.current,
        });
      } catch {
        // Left where it stopped. The bookmark from the last page that landed is
        // already written, so the next attempt carries on from there — and the
        // panel that asked is showing whatever the mirror holds, which is not
        // wrong, only short.
      } finally {
        if (alive.current) setRunning(false);
      }
    })();

    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
  }, [conversationId, ready, pageSize]);

  return { ensure, running, fetched, complete };
}
