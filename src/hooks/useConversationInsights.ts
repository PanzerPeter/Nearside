// What the open conversation turns out to contain, read out of the local
// mirror and grouped for the panel.
//
// Everything here happens on this device. There is no query to write against
// the server — 0023 took message bodies away from it — so the panel can only
// know about messages this phone decrypted, the same limit search lives with.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cachedConversation } from '../lib/localdb';
import {
  extractDates,
  extractLinks,
  splitDates,
  type DateInsight,
  type InsightSource,
  type LinkInsight,
} from '../lib/extract';

export interface ConversationInsights {
  loading: boolean;
  upcoming: DateInsight[];
  past: DateInsight[];
  links: LinkInsight[];
  /** How many cached messages were read. Zero is the case worth naming in the
   *  UI: not "nothing was said", but "this device has not opened this
   *  conversation", which looks identical and is not. */
  scanned: number;
  /** The instant the split was made against. The panel labels its rows with
   *  the same one, so "Today" and "still upcoming" cannot disagree. */
  now: number;
}

/**
 * @param peerId the conversation to read
 * @param enabled false while the panel is closed — the scan is over every
 *   cached message in the conversation and there is no reason to pay for it
 *   until somebody asks to see the result
 * @param revision bump to re-read; the caller passes the thread's message
 *   count so a message that arrives while the panel is open shows up in it
 */
export function useConversationInsights(
  peerId: string,
  enabled: boolean,
  revision: number
): ConversationInsights {
  const [rows, setRows] = useState<InsightSource[]>([]);
  const [loading, setLoading] = useState(false);
  // Frozen per scan rather than read at render: "upcoming" is decided against
  // it, and a clock that moved between two renders would let a row jump
  // sections under the reader's thumb.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cached = await cachedConversation(peerId);
      setRows(
        cached.map((row) => ({
          id: row.id,
          user_id: row.user_id,
          text: row.text,
          created_at: row.created_at,
        }))
      );
      setNow(Date.now());
    } finally {
      setLoading(false);
    }
  }, [peerId]);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    void load();
  }, [enabled, load, revision]);

  // The scan itself: two passes over up to a thousand bodies, so it is kept off
  // every unrelated re-render of the conversation around it.
  return useMemo(() => {
    const { upcoming, past } = splitDates(extractDates(rows), now);
    return { loading, upcoming, past, links: extractLinks(rows), scanned: rows.length, now };
  }, [rows, now, loading]);
}
