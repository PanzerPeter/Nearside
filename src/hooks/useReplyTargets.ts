// Resolves the message a reply quotes, including when that message is not in
// the loaded window.
//
// The thread renders a page at a time (30 messages, plus whatever "load older"
// has pulled in), while a reply can point arbitrarily far back — reply to a
// message from last week and the quote's parent is nowhere on screen. Looking
// the parent up in the rendered list alone therefore fails routinely, and the
// quote fell back to a placeholder that said nothing about the message it was
// quoting. This fetches the ones the window is missing, once each, and caches
// them for as long as the conversation stays open.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { conversationFilter } from '../lib/conversation';
import { Message } from '../lib/types';

export interface ReplyTargets {
  /** The quoted message, or null while it is still being looked up (or if it
   *  turned out not to be readable at all). */
  get(id: string): Message | null;
  /** True while a lookup for `id` is outstanding — the quote should wait
   *  rather than claim the message is gone. */
  isLoading(id: string): boolean;
}

/**
 * @param me The viewer.
 * @param peerId The other side of the open conversation. Also the cache
 *   scope: changing it drops everything resolved for the chat being left.
 * @param messages The loaded window, both the source of quotes to resolve and
 *   the first place each one is looked for.
 */
export function useReplyTargets(me: string, peerId: string, messages: Message[]): ReplyTargets {
  const [fetched, setFetched] = useState<Map<string, Message>>(() => new Map());
  // Ids the server did not return: the parent is unreadable (hard-deleted, or
  // hidden by RLS). Remembered so the same miss isn't re-requested on every
  // render for as long as the reply stays on screen.
  const [unresolvable, setUnresolvable] = useState<Set<string>>(() => new Set());
  const inFlight = useRef<Set<string>>(new Set());

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // Sorted and joined so the fetch effect below re-runs when the *set* of
  // quoted-but-absent parents changes, not on every re-render of the thread.
  const wantedKey = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.reply_to_id && !byId.has(m.reply_to_id)) ids.add(m.reply_to_id);
    }
    return [...ids].sort().join(',');
  }, [messages, byId]);

  useEffect(() => {
    setFetched(new Map());
    setUnresolvable(new Set());
    inFlight.current = new Set();
  }, [peerId]);

  useEffect(() => {
    const wanted = wantedKey ? wantedKey.split(',') : [];
    const missing = wanted.filter(
      (id) => !fetched.has(id) && !unresolvable.has(id) && !inFlight.current.has(id)
    );
    if (missing.length === 0) return;

    let cancelled = false;
    for (const id of missing) inFlight.current.add(id);

    void (async () => {
      // Scoped to this conversation on top of the id list. RLS alone would
      // already keep the lookup to messages the viewer may read, but a quote
      // must only ever resolve to something from the thread it is displayed
      // in — `reply_to_id` is written by the sender, and nothing else stops
      // it naming a message from elsewhere.
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .in('id', missing)
        .or(conversationFilter(me, peerId));
      for (const id of missing) inFlight.current.delete(id);
      // The cleanup below fires on a conversation switch, which is exactly
      // when a late reply from the previous one must not be cached.
      if (cancelled) return;
      // A failed lookup is left unresolved rather than marked unresolvable:
      // the next render re-requests it, so a lookup lost to a dropped
      // connection recovers on its own.
      if (error) return;

      const rows = (data ?? []) as Message[];
      if (rows.length > 0) {
        setFetched((prev) => {
          const next = new Map(prev);
          for (const row of rows) next.set(row.id, row);
          return next;
        });
      }
      const found = new Set(rows.map((row) => row.id));
      const gone = missing.filter((id) => !found.has(id));
      if (gone.length > 0) setUnresolvable((prev) => new Set([...prev, ...gone]));
    })();

    return () => {
      cancelled = true;
    };
  }, [wantedKey, me, peerId, fetched, unresolvable]);

  return useMemo(
    () => ({
      get: (id: string) => byId.get(id) ?? fetched.get(id) ?? null,
      isLoading: (id: string) => !byId.has(id) && !fetched.has(id) && !unresolvable.has(id),
    }),
    [byId, fetched, unresolvable]
  );
}
