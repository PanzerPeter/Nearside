// The sealed exchanges in the open conversation: their answers, and the two
// writes that move one along.
//
// Kept beside `useChatThread` rather than inside it because the answers are a
// different table with a different visibility rule — the thread's rows are
// yours the moment they exist, and these are handed over by policy only once
// you have committed one of your own.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useConnection } from '../lib/connection';
import { peerPublicKey } from '../lib/peer-keys';
import type { Identity } from '../lib/crypto/keys';
import type { Message } from '../lib/types';
import {
  answerSealed,
  askSealed,
  fetchAnswers,
  openAnswer,
  type OpenedAnswer,
  type SealedAnswerRow,
} from '../lib/sealed-exchange';

export interface SealedExchange {
  /** Answers this device is allowed to see, by prompt id. A prompt with no
   *  entry has not been fetched yet, which reads the same as "nothing to
   *  show" and is what the card renders while it waits. */
  answers: Map<string, OpenedAnswer[]>;
  /** Prompt ids with a write in flight, so the card can disable its own
   *  controls without a second piece of state per exchange. */
  busy: Set<string>;
  /** Ask a question and commit your own answer, atomically. Resolves with the
   *  prompt row so the caller can merge it into the thread. */
  ask: (question: string, answer: string) => Promise<Message | null>;
  answer: (promptId: string, text: string) => Promise<void>;
}

interface SealedExchangeOptions {
  me: string;
  peerId: string;
  identity: Identity;
  /** Your own notes. A sealed exchange with yourself withholds nothing, and
   *  the CHECK constraint on `sealed_prompt` refuses the row anyway. */
  isSelf: boolean;
  /** The conversation's messages, which is where the prompts come from. */
  messages: Message[];
  onError: (message: string) => void;
}

export function useSealedExchange({
  me,
  peerId,
  identity,
  isSelf,
  messages,
  onError,
}: SealedExchangeOptions): SealedExchange {
  const { generation } = useConnection();
  const [answers, setAnswers] = useState<Map<string, OpenedAnswer[]>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Live prompts only: a tombstoned question can no longer be answered (the
  // INSERT policy refuses it), so there is nothing left to fetch for one.
  const promptIds = messages.filter((m) => m.sealed_prompt && !m.deleted_at).map((m) => m.id);
  // A stable dependency for the effect below. `promptIds` is a fresh array on
  // every render, and the thread re-renders on every presence tick.
  const promptKey = promptIds.join(',');

  // The conversation a fetch was issued for, so a slow response cannot write
  // one chat's answers into another's state after a switch.
  const loadedFor = useRef(peerId);
  useEffect(() => {
    loadedFor.current = peerId;
  }, [peerId]);

  const openAll = useCallback(
    async (rows: SealedAnswerRow[]): Promise<OpenedAnswer[]> => {
      const peerKey = await peerPublicKey(peerId);
      return Promise.all(rows.map((row) => openAnswer(identity, peerKey, me, peerId, row)));
    },
    [identity, me, peerId]
  );

  const merge = useCallback((opened: OpenedAnswer[], promptIdsInScope: string[]) => {
    setAnswers((prev) => {
      const next = new Map(prev);
      for (const id of promptIdsInScope) next.set(id, []);
      for (const a of opened) next.set(a.prompt_id, [...(next.get(a.prompt_id) ?? []), a]);
      return next;
    });
  }, []);

  /** Re-read one exchange. Used after either side writes: the peer's insert
   *  arrives over realtime, but your own changes what the policy will hand
   *  you, and there is no event for that. */
  const refresh = useCallback(
    async (promptId: string) => {
      const forPeer = peerId;
      const rows = await fetchAnswers([promptId]);
      const opened = await openAll(rows);
      if (loadedFor.current !== forPeer) return;
      merge(opened, [promptId]);
    },
    [merge, openAll, peerId]
  );

  // Load, and reload on wake — a phone that slept through the peer's answer
  // has a card sitting on "waiting" that the socket will never correct.
  useEffect(() => {
    if (isSelf || promptIds.length === 0) {
      setAnswers(new Map());
      return;
    }
    const forPeer = peerId;
    let cancelled = false;

    void (async () => {
      const rows = await fetchAnswers(promptIds);
      const opened = await openAll(rows);
      if (cancelled || loadedFor.current !== forPeer) return;
      merge(opened, promptIds);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptKey, peerId, isSelf, generation, openAll, merge]);

  // The peer's answer landing is the moment both sides open, so it gets its
  // own subscription rather than waiting for a poll. Keyed on the generation
  // like every other channel in the app: a socket the phone slept through is
  // gone even when nothing reported it.
  useEffect(() => {
    if (isSelf) return;
    const channel = supabase
      .channel(`sealed:${[me, peerId].sort().join('_')}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sealed_answers' },
        (payload) => {
          const row = payload.new as SealedAnswerRow;
          // Refetch rather than merging the event's row: this arrival may have
          // just unlocked the *other* answer, which no event announces.
          void refresh(row.prompt_id);
        }
      )
      .subscribe();

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [me, peerId, isSelf, generation, refresh]);

  const mark = useCallback((promptId: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(promptId);
      else next.delete(promptId);
      return next;
    });
  }, []);

  const ask = useCallback(
    async (question: string, answerText: string): Promise<Message | null> => {
      const id = crypto.randomUUID();
      mark(id, true);
      try {
        const row = await askSealed(
          identity,
          await peerPublicKey(peerId),
          me,
          peerId,
          id,
          question,
          answerText
        );
        await refresh(id);
        return row;
      } catch {
        onError('Could not send that question.');
        return null;
      } finally {
        mark(id, false);
      }
    },
    [identity, me, peerId, mark, onError, refresh]
  );

  const answer = useCallback(
    async (promptId: string, text: string) => {
      mark(promptId, true);
      try {
        await answerSealed(identity, await peerPublicKey(peerId), me, peerId, promptId, text);
        await refresh(promptId);
      } catch {
        onError('Could not send that answer.');
      } finally {
        mark(promptId, false);
      }
    },
    [identity, me, peerId, mark, onError, refresh]
  );

  return { answers, busy, ask, answer };
}
