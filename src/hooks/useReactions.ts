import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Reaction } from '../lib/types';
import { useConnection } from '../lib/connection';

/**
 * Which table the reactions live in.
 *
 * A parameter rather than a second copy of this hook: the optimistic toggle,
 * the delta fetch, the wake re-query and the realtime de-duplication are the
 * behaviour that makes reactions feel instant, and two copies of it drift the
 * first time one of them is fixed.
 */
export type ReactionTable = 'message_reactions' | 'room_message_reactions';

/**
 * Loads and live-syncs reactions for the currently loaded messages of a
 * conversation or a room. Reactions are keyed by message id; `toggle` adds the
 * current user's reaction or removes it if it already exists.
 */
export function useReactions(
  me: string,
  messageIds: string[],
  table: ReactionTable = 'message_reactions'
) {
  const [reactions, setReactions] = useState<Reaction[]>([]);
  // Message ids whose reactions we've already fetched. Prevents a full
  // re-query on every new message — realtime keeps the set fresh after the
  // initial fetch, so we only ever query the delta (kind to free-plan quotas).
  const fetchedIds = useRef<Set<string>>(new Set());
  const idsKey = messageIds.join(',');
  const { generation } = useConnection();
  const lastGeneration = useRef(generation);

  useEffect(() => {
    let active = true;
    // After a wake, reactions added while the socket was dead were never
    // delivered — and every id on screen is already marked fetched, so the
    // delta below would find nothing to do. Clearing the marks re-queries the
    // whole visible window once. Existing rows are merged, not replaced, so
    // nothing flickers.
    if (lastGeneration.current !== generation) {
      lastGeneration.current = generation;
      fetchedIds.current = new Set();
    }
    // Conversation switched (list cleared): reset and wait for the reload.
    if (messageIds.length === 0) {
      fetchedIds.current = new Set();
      setReactions([]);
      return;
    }
    const missing = messageIds.filter((id) => !fetchedIds.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => fetchedIds.current.add(id));

    supabase
      .from(table)
      .select('*')
      .in('message_id', missing)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          // Let a later change retry these ids rather than silently dropping.
          missing.forEach((id) => fetchedIds.current.delete(id));
          return;
        }
        if (!data || data.length === 0) return;
        setReactions((prev) => {
          const have = new Set(prev.map((r) => r.id));
          const added = data.filter((r) => !have.has(r.id));
          return added.length ? [...prev, ...added] : prev;
        });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, generation, table]);

  // The live set of message ids on screen, read by the subscription without
  // re-subscribing every time the list grows.
  const visibleIds = useRef<Set<string>>(new Set());
  visibleIds.current = new Set(messageIds);

  useEffect(() => {
    // A fixed topic. This used to carry a `Date.now()` suffix, which minted a
    // new topic per mount for no benefit — the effect's own cleanup already
    // removes the channel, so nothing was ever left behind to collide with.
    // The table is in the topic as well as in the filter: a conversation and a
    // room can be mounted at once, and one topic per subscriber is what keeps
    // their two streams from arriving on the same channel.
    const channel = supabase
      .channel(`reactions:${table}:${me}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table },
        (payload) => {
          const r = payload.new as Reaction;
          // The stream is RLS-scoped to us, not to this conversation, so rows
          // for other chats arrive too and would accumulate unboundedly.
          if (!visibleIds.current.has(r.message_id)) return;
          setReactions((prev) => (prev.some((x) => x.id === r.id) ? prev : [...prev, r]));
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table },
        (payload) => {
          const old = payload.old as { id: string };
          setReactions((prev) => prev.filter((x) => x.id !== old.id));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [me, generation, table]);

  const byMessage = new Map<string, Reaction[]>();
  for (const r of reactions) {
    const arr = byMessage.get(r.message_id) ?? [];
    arr.push(r);
    byMessage.set(r.message_id, arr);
  }

  const toggle = useCallback(
    async (messageId: string, emoji: string) => {
      const mine = reactions.find(
        (r) => r.message_id === messageId && r.user_id === me && r.emoji === emoji
      );
      if (mine) {
        setReactions((prev) => prev.filter((r) => r.id !== mine.id));
        await supabase.from(table).delete().eq('id', mine.id);
      } else {
        const { data } = await supabase
          .from(table)
          .insert({ message_id: messageId, user_id: me, emoji })
          .select('*')
          .single();
        if (data) {
          setReactions((prev) => (prev.some((x) => x.id === data.id) ? prev : [...prev, data]));
        }
      }
    },
    [reactions, me, table]
  );

  return { byMessage, toggle };
}
