// The open conversation's messages, and the fallbacks that keep them arriving
// when realtime doesn't.
//
// The outbox, receipts and scroll position all read or write the thread, so
// they are composed here rather than side by side in the component. `ChatRoom`
// sees one object.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import {
  fetchLatestPage,
  fetchOlderPage,
  fetchSince,
  mergeMessages,
  unseenRows,
  CATCHUP_LIMIT,
  PAGE_SIZE,
  type Cursor,
} from '../lib/message-queries';
import { advanceDelivered, type Receipt } from '../lib/receipts';
import { useConnection, reportChannelStatus, forgetChannel } from '../lib/connection';
import type { Identity } from '../lib/crypto/keys';
import { useThreadScroll, type ThreadScroll } from './useThreadScroll';
import { useReadReceipts } from './useReadReceipts';
import { useOutbox, type Outbox } from './useOutbox';
import {
  hasExpired,
  loadConversationTimer,
  saveConversationTimer,
  type ConversationTimer,
} from '../lib/disappearing';
import { purgeExpired } from '../lib/localdb';

/** Bounds how many pages a search jump will fetch looking for an old message,
 *  so a hit deep in history can't page indefinitely. */
const MAX_JUMP_PAGES = 20;

/** Safety-net poll while realtime looks healthy. It should find nothing every
 *  time; it exists because a silently wedged socket reports itself as fine. */
const POLL_HEALTHY_MS = 45_000;

/** Poll rate once realtime is known down (blocked socket, dead tunnel), when
 *  this is the only thing still delivering messages. */
const POLL_DEGRADED_MS = 6_000;

/** How long the peer's typing indicator survives without another broadcast. */
const TYPING_LINGER_MS = 3000;

/** Minimum gap between typing broadcasts. */
const TYPING_THROTTLE_MS = 1500;

export interface ChatThread {
  messages: Message[];
  hasMore: boolean;
  loadingOlder: boolean;
  friendTyping: boolean;
  peerReceipt: Receipt | null;
  outbox: Outbox;
  scroll: ThreadScroll;
  /** Ids already painted on screen for the open conversation. Read during
   *  render to gate the entrance animation. */
  isAlreadySeen: (id: string) => boolean;
  loadOlder: () => Promise<void>;
  /** Land on a search result, paging back through history first if it is
   *  older than the loaded window. */
  jumpToMessage: (messageId: string, createdAt: string) => Promise<void>;
  /** Follow a reply's quote back to the message it answers. */
  jumpToRepliedMessage: (target: Message) => void;
  notifyTyping: () => void;
  /** The conversation's timer, or null when there has never been one. */
  timer: ConversationTimer | null;
  changeTimer: (seconds: number | null) => Promise<void>;
}

interface ChatThreadOptions {
  me: string;
  peerId: string;
  identity: Identity;
  /** Your own notes. Every `isSelf` branch below exists because the other
   *  participant presence, typing and receipts describe is you. */
  isSelf: boolean;
  /** The decrypt boundary. Every fetch and realtime arrival passes through it
   *  once, on the way into state. */
  open: (rows: Message[]) => Promise<Message[]>;
  onError: (message: string) => void;
  /** Composer housekeeping, run when a text send becomes an optimistic bubble. */
  onQueued: () => void;
}

export function useChatThread({
  me,
  peerId,
  identity,
  isSelf,
  open,
  onError,
  onQueued,
}: ChatThreadOptions): ChatThread {
  // `generation` bumps every time the app wakes (sleep, tab restore, network
  // return); `live` is false while realtime isn't delivering.
  const { generation, live } = useConnection();

  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [friendTyping, setFriendTyping] = useState(false);
  const [timer, setTimer] = useState<ConversationTimer | null>(null);

  // The conversation a fetch was issued for. Loads merge rather than replace,
  // so a reply from the previous chat landing after a switch would otherwise
  // splice that chat's messages into this one. Written from the first effect
  // declared here, so it is current before any composed hook's effect runs.
  const loadedFor = useRef(peerId);
  useEffect(() => {
    loadedFor.current = peerId;
  }, [peerId]);

  // Ids already painted, gating the entrance animation so a freshly opened
  // chat's first page doesn't cascade it. Every *fetch* seeds its rows here as
  // they merge, so they never read as new; a realtime INSERT is left unseeded,
  // because that is the one path that should animate. The effect below then
  // replaces this set with `messages`'s ids, which both marks the INSERT seen
  // and bounds the set to `messages.length`.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  // Cursor every catch-up fetch pages forward from. A ref rather than derived
  // from `messages`, because the pollers fire from timers that closed over an
  // older render.
  const newestAtRef = useRef<string | null>(null);
  // The loaded window, for the same reason: `pullNew` runs from a timer and has
  // to know what the thread already holds before it decrypts anything.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // A degraded-mode poll every 6s over a link slow enough to be degraded would
  // otherwise stack requests.
  const catchupInFlight = useRef(false);
  // Two jump loops at once would stomp on the same `hasMore`, `loadingOlder`,
  // `skipAutoScroll` and highlight timer.
  const jumpInFlight = useRef(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  // Health-registry key, so teardown can withdraw it. A removed channel left
  // in the registry reports CLOSED forever and pins the app to "degraded".
  const channelKeyRef = useRef<string | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  const receipts = useReadReceipts({ peerId, isSelf, messages, loadedFor, generation });
  const outbox = useOutbox({
    me,
    peerId,
    identity,
    isSelf,
    loadedFor,
    generation,
    open,
    onAdopt: adoptSentRow,
    onQueued,
    onError,
  });
  const scroll = useThreadScroll({ peerId, me, messages, pending: outbox.pending });

  useEffect(() => {
    newestAtRef.current = messages.length ? messages[messages.length - 1].created_at : null;
  }, [messages]);

  // Commit-phase bookkeeping for the entrance-animation gate. This write has
  // to live in an effect: done inline in the render body it silences the
  // animation under StrictMode, where React's discarded first pass claims the
  // id and the committed pass then reads the message as already seen.
  //
  // Replacing rather than merging keeps a message's first render reading as
  // new while any later re-render (a reaction toggle, say) reads as seen.
  useEffect(() => {
    seenMessageIdsRef.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setFriendTyping(false);
    // Entries from the chat just left can't collide (UUIDs), but they would
    // grow unbounded across a long session of switching conversations.
    seenMessageIdsRef.current = new Set();

    void loadLatest();
    subscribe();

    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      if (channelKeyRef.current) forgetChannel(channelKeyRef.current);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId]);

  // Wake-up. A socket the app slept through is gone even when the tab never
  // lost visibility, and its channels never rejoin on their own. Generation 0
  // is the mount, covered by the effect above. Subscribe before catching up: a
  // message arriving between the two would otherwise fall in the gap and wait
  // for the next poll.
  useEffect(() => {
    if (generation === 0) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    if (channelKeyRef.current) forgetChannel(channelKeyRef.current);
    subscribe();
    void pullNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  // Load the timer, and sweep whatever has expired since we last looked.
  // Keyed on the generation so a phone that was asleep for a day sweeps on wake
  // rather than showing a day of messages the server has already deleted.
  useEffect(() => {
    if (!me || !peerId) return;
    let cancelled = false;

    async function refresh() {
      const loaded = await loadConversationTimer(me, peerId);
      if (cancelled) return;
      setTimer(loaded);

      const removed = await purgeExpired(Date.now());
      if (cancelled) return;
      const gone = new Set(removed);
      const now = Date.now();
      setMessages((current) =>
        current.filter((m) => !gone.has(m.id) && !hasExpired(m.expires_at, now))
      );
    }

    void refresh();
    // A minute, matching the server's cron cadence. There is no point sweeping
    // faster than the rows are actually being deleted.
    const tick = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [me, peerId, generation]);

  const changeTimer = useCallback(
    async (seconds: number | null) => {
      if (!peerId) return;
      await saveConversationTimer(peerId, seconds);
      setTimer(await loadConversationTimer(me, peerId));
    },
    [me, peerId]
  );

  // Fast while realtime is down, which some networks and VPN routes cause by
  // stalling wss:// while plain HTTPS keeps working. Slow while it is up, as a
  // net under the one failure realtime cannot report about itself. Skipped
  // while hidden, since the wake path refetches on return.
  useEffect(() => {
    const period = live ? POLL_HEALTHY_MS : POLL_DEGRADED_MS;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void pullNew();
    }, period);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, peerId]);

  function isRelevant(m: Message) {
    return (
      (m.user_id === me && m.receiver_id === peerId) ||
      (m.user_id === peerId && m.receiver_id === me)
    );
  }

  /** Mark ids as already displayed. Call wherever *fetched* history merges
   *  into `messages`, but never for a live realtime arrival. */
  function markSeen(ids: Iterable<string>) {
    for (const id of ids) seenMessageIdsRef.current.add(id);
  }

  /**
   * Retire an optimistic bubble in favour of its server row. The caller drops
   * the queue entry immediately after, in the same tick.
   *
   * `markSeen` first: the row replaces something already on screen, so it must
   * not play the entrance animation a second time.
   */
  function adoptSentRow(row: Message) {
    markSeen([row.id]);
    setMessages((prev) => mergeMessages(prev, [row]));
  }

  async function loadLatest() {
    const forFriend = peerId;
    const data = await fetchLatestPage(me, forFriend);

    if (loadedFor.current !== forFriend) return;
    const rows = await open(data);
    // Seed before the state update lands, or the entrance animation cascades
    // across the whole initial page.
    markSeen(rows.map((m) => m.id));
    setMessages((prev) => mergeMessages(prev, rows));
    setHasMore(data.length === PAGE_SIZE);

    // Messages that arrived while the app was closed count as delivered on
    // this fetch, not only over the live INSERT path. `data` is newest-first.
    // In your own notes there is nothing inbound, and `no_self_receipt` would
    // reject the write anyway.
    if (isSelf) return;
    const newestInbound = data.find((m) => m.user_id === peerId);
    if (newestInbound) void advanceDelivered(peerId, newestInbound.created_at);
  }

  /**
   * Fold fetched rows into the thread with the same bookkeeping the realtime
   * INSERT handler does: retire optimistic twins, acknowledge delivery, count
   * arrivals the reader has scrolled away from. Shared by the wake-up catch-up
   * and the degraded-mode poll, so a message arriving over the fallback is
   * indistinguishable from one that came down the socket.
   */
  function ingest(rows: Message[]) {
    const relevant = rows.filter(isRelevant);
    if (relevant.length === 0) return;

    const retired: string[] = [];
    for (const row of relevant) {
      if (!outbox.pendingRef.current.some((p) => p.id === row.id)) continue;
      retired.push(row.id);
      // Replaces a bubble already on screen, so it must not animate again.
      markSeen([row.id]);
      void outbox.retire(row.id);
    }

    setMessages((prev) => mergeMessages(prev, relevant));
    outbox.dropPending(...retired);

    // In the self-chat every row is your own: no delivery to acknowledge, and
    // no arrival you did not just cause.
    if (isSelf) return;
    const inbound = relevant.filter((m) => m.user_id === peerId);
    if (inbound.length === 0) return;
    void advanceDelivered(peerId, inbound[inbound.length - 1].created_at);
    scroll.countArrivals(inbound.length);
  }

  /**
   * Pull whatever arrived since the newest message on screen. Backs both the
   * wake-up path and the poll, closing the hole that any window of undelivered
   * realtime (machine asleep, socket blocked, tunnel dropped) would otherwise
   * leave until a page reload.
   *
   * A full page back means the gap is wider than one fetch. Stitching part of
   * it on would leave a hole in the middle that "load older" can never fill,
   * since that pages from the *oldest* row held. The thread is rebuilt from
   * the newest page instead, which is what a fresh open of the chat gives.
   */
  async function pullNew(): Promise<void> {
    if (catchupInFlight.current) return;
    const forFriend = peerId;
    const since = newestAtRef.current;
    catchupInFlight.current = true;
    try {
      if (!since) {
        await loadLatest();
        return;
      }

      const fetched = await fetchSince(me, forFriend, since, CATCHUP_LIMIT);
      if (loadedFor.current !== forFriend) return;

      if (fetched.length < CATCHUP_LIMIT) {
        // Filtered before `open`, not after: `fetchSince` is deliberately
        // inclusive of the cursor row (`gte`, so a shared microsecond cannot
        // step over a message), so the usual tick returns exactly one row the
        // thread already holds. Opening it again re-decrypted a body every 45
        // seconds, and every 6 while realtime is down, to produce state
        // identical to what was already on screen.
        ingest(await open(unseenRows(messagesRef.current, fetched)));
        return;
      }

      setMessages([]);
      seenMessageIdsRef.current = new Set();
      scroll.resetPosition();
      setHasMore(false);
      await loadLatest();
    } catch {
      /* a failed catch-up is retried by the next poll tick */
    } finally {
      catchupInFlight.current = false;
    }
  }

  async function loadOlder() {
    if (messages.length === 0) return;
    const forFriend = peerId;
    setLoadingOlder(true);
    const older = await open(await fetchOlderPage(me, forFriend, messages[0]));
    if (loadedFor.current !== forFriend) {
      setLoadingOlder(false);
      return;
    }
    const el = scroll.listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    scroll.skipAutoScroll.current = true;
    markSeen(older.map((m) => m.id));
    setMessages((prev) => mergeMessages(prev, older));
    setHasMore(older.length === PAGE_SIZE);
    setLoadingOlder(false);

    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    });
  }

  /**
   * Land on a search result, paging older messages until it turns up. The loop
   * is hand-rolled rather than repeated `await loadOlder()` calls because
   * `loadOlder` reads its cursor from this render's `messages` closure, so
   * successive calls without a re-render between them re-request the same page
   * forever. `cursor` is local and updated after every fetch instead.
   *
   * MAX_JUMP_PAGES bounds a result deep in history. The loop also stops once a
   * page runs older than the target's `createdAt` without finding it, which
   * means it was deleted or edited between the query and the click.
   */
  async function jumpToMessage(messageId: string, createdAt: string) {
    // Two loops would run against the same `messages`, `hasMore`,
    // `loadingOlder` and highlight timer. Released in `finally` on every exit
    // path, including the early returns and a thrown fetch.
    if (jumpInFlight.current) return;
    jumpInFlight.current = true;
    try {
      if (messages.some((m) => m.id === messageId)) {
        scroll.scrollToMessage(messageId);
        return;
      }

      if (!hasMore) {
        onError('Could not find that message.');
        return;
      }

      const forFriend = peerId;
      setLoadingOlder(true);
      let cursor: Cursor | undefined = messages[0];
      let more: boolean = hasMore;
      let found = false;

      for (let page = 0; page < MAX_JUMP_PAGES && more && cursor; page++) {
        const data = await fetchOlderPage(me, forFriend, cursor);

        if (loadedFor.current !== forFriend) {
          setLoadingOlder(false); // else it's stuck true for whichever conversation loads next
          return;
        }

        const older: Message[] = await open(data);
        if (older.length === 0) {
          more = false;
          break;
        }

        scroll.skipAutoScroll.current = true;
        markSeen(older.map((m) => m.id));
        setMessages((prev) => mergeMessages(prev, older));
        more = older.length === PAGE_SIZE;
        setHasMore(more);
        found = older.some((m) => m.id === messageId);
        cursor = older[older.length - 1];
        // `found` is recomputed per page, so another iteration would overwrite
        // this `true` even though the target is already merged and in the DOM.
        if (found) break;
        if (cursor.created_at < createdAt) {
          more = false; // paged past where the target should have been
          break;
        }
      }

      setLoadingOlder(false);

      if (found) {
        const forHighlight = forFriend;
        // Let the just-merged messages paint before measuring where to scroll.
        requestAnimationFrame(() => {
          // A conversation switch between the loop finishing and this callback
          // running would highlight an id from the chat just left.
          if (loadedFor.current !== forHighlight) return;
          scroll.scrollToMessage(messageId);
        });
      } else {
        onError("Couldn't find that message. It may be too far back in the history.");
      }
    } finally {
      jumpInFlight.current = false;
    }
  }

  function subscribe() {
    const channelKey = `dm:${[me, peerId].sort().join('_')}`;

    /**
     * Whose rows this channel asks for.
     *
     * Both bindings are needed and neither is wider than it has to be. The
     * peer's covers what they send us — RLS already narrows their rows to the
     * ones naming us, so `user_id` alone is the whole filter. Ours covers a
     * send from another device of ours, which nothing else in this hook would
     * ever hear about.
     *
     * There used to be no filter at all, which is not the same thing: an
     * unfiltered binding is authorized per row against `messages_select_
     * participant`, so the socket carried every message of every conversation
     * this account has open elsewhere, for `isRelevant` to drop. In the
     * self-chat the two ids are the same and one binding is registered, or the
     * one row would arrive twice and be counted as two arrivals.
     */
    const senders = isSelf ? [me] : [peerId, me];

    let channel = supabase
      .channel(channelKey, {
        config: { broadcast: { self: false } },
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        // `self: false` suppresses the echo to the sending tab but not to this
        // user's other devices, so in the self-chat typing on a laptop would
        // show "typing" on the phone, about yourself.
        if (isSelf) return;
        if (payload?.userId !== peerId) return;
        setFriendTyping(true);
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(() => setFriendTyping(false), TYPING_LINGER_MS);
      })
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_receipts',
          filter: `user_id=eq.${peerId}`,
        },
        (payload) => {
          // In the self-chat this filter matches our own receipt rows for
          // every friend, none of which describe this conversation.
          if (isSelf) return;
          const row = payload.new as Receipt;
          if (row?.peer_id !== me) return;
          receipts.setPeerReceipt(row);
        }
      );

    for (const sender of senders) {
      channel = channel
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `user_id=eq.${sender}` },
          (payload) => {
            const msg = payload.new as Message;
            if (!isRelevant(msg)) return;
            // This event and `attemptSend`'s own response race back from the
            // same insert, and either can land first. Adopting here too keeps
            // the authoritative bubble from painting beside the optimistic one
            // it replaces. The row carries the queued message's uuid, so
            // pairing is an exact id match; an own row with no queued
            // counterpart is a send from another device and animates in like
            // any other arrival.
            if (outbox.pendingRef.current.some((p) => p.id === msg.id)) {
              // Opened before adoption, because the two state updates have to
              // commit in one tick and nothing between them can await.
              void open([msg]).then(([opened]) => {
                adoptSentRow(opened);
                outbox.dropPending(msg.id);
              });
              // The queue entry is settled. Left in place the next flush would
              // re-attempt it, which the primary key makes harmless but
              // useless.
              void outbox.retire(msg.id);
              return;
            }
            void open([msg]).then(([opened]) => {
              setMessages((prev) => mergeMessages(prev, [opened]));
            });
            // Only arrivals the user didn't just cause. `countArrivals` skips a
            // reader already at the bottom, who sees it land anyway.
            if (msg.user_id === peerId) scroll.countArrivals(1);
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'messages', filter: `user_id=eq.${sender}` },
          (payload) => {
            const msg = payload.new as Message;
            if (!isRelevant(msg)) return;
            void open([msg]).then(([opened]) => {
              setMessages((prev) => prev.map((m) => (m.id === opened.id ? opened : m)));
            });
          }
        );
    }

    // This channel carries the open conversation, so its status answers "are
    // messages arriving?" better than the socket's own, which can heartbeat
    // happily while a channel sits in CHANNEL_ERROR. Anything other than
    // SUBSCRIBED switches on the fast poll and raises the banner.
    channel.subscribe((status) => reportChannelStatus(channelKey, status));

    channelRef.current = channel;
    channelKeyRef.current = channelKey;
  }

  function notifyTyping() {
    if (isSelf) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_THROTTLE_MS) return;
    lastTypingSent.current = now;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: me },
    });
  }

  return {
    messages,
    timer,
    changeTimer,
    hasMore,
    loadingOlder,
    friendTyping,
    peerReceipt: receipts.peerReceipt,
    outbox,
    scroll,
    isAlreadySeen: (id) => seenMessageIdsRef.current.has(id),
    loadOlder,
    jumpToMessage,
    jumpToRepliedMessage: (target) => void jumpToMessage(target.id, target.created_at),
    notifyTyping,
  };
}
