// The open conversation's messages: how they get here, and everything that
// keeps them honest when the network isn't.
//
// This is the hub the other conversation hooks hang off — the outbox, the
// receipts and the scroll position all need to reach the thread or be reached
// by it, so they are composed here rather than side by side in the component.
// `ChatRoom` sees one object.

import { useEffect, useRef, useState } from 'react';
import { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import {
  fetchLatestPage,
  fetchOlderPage,
  fetchSince,
  mergeMessages,
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

/** Bounds how many pages a search jump will fetch looking for an old message,
 *  so a hit deep in history can't page indefinitely. */
const MAX_JUMP_PAGES = 20;

/** Safety-net poll while realtime is believed healthy. Realtime should make
 *  this find nothing every time — it exists because "believed healthy" is a
 *  belief, and a silently-wedged socket is invisible to the user otherwise. */
const POLL_HEALTHY_MS = 45_000;

/** Poll rate once realtime is known to be down: the socket is blocked or the
 *  network is hostile (a censored route, a saturated VPN), and this is the
 *  only thing still delivering messages. */
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
}

interface ChatThreadOptions {
  me: string;
  peerId: string;
  identity: Identity;
  /** Your own notes: no peer, so nothing about presence, typing, receipts or
   *  notifications applies. Every branch below that mentions `isSelf` exists
   *  because the other participant these features describe is you. */
  isSelf: boolean;
  /** The conversation's decrypt boundary. Every fetch and every realtime
   *  arrival passes through it to be opened once, on the way into state. */
  open: (rows: Message[]) => Promise<Message[]>;
  onError: (message: string) => void;
  /** Composer housekeeping, run the moment a text send becomes an optimistic
   *  bubble. */
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

  // The conversation a fetch was issued for. Because loads now *merge* rather
  // than replace, a reply from the previous chat landing after a switch would
  // otherwise splice that chat's messages into this one. Written from the
  // first effect declared here, so it is already current by the time any
  // composed hook's effect runs.
  const loadedFor = useRef(peerId);
  useEffect(() => {
    loadedFor.current = peerId;
  }, [peerId]);

  // Ids already painted on screen for the open conversation — gates the
  // entrance animation so a freshly opened chat's whole first page doesn't
  // cascade it. Seeded proactively by every *fetch* (initial load, "load
  // older", search paging) at the moment its rows are merged in — those calls
  // run in event/async-callback contexts, not inside a render body, so
  // mutating the ref there is fine — so those ids never read as new; left
  // un-seeded for a realtime INSERT, which is the one path that should
  // animate. What marks an INSERT's id seen afterwards is the commit-phase
  // effect below, *not* the render itself (see that effect's comment for why
  // a render-time write was the bug).
  //
  // Bounded, not ever-growing: the effect below *replaces* this ref with
  // `messages`'s current id set on every commit rather than merging into it,
  // so its size can never exceed `messages.length` — the same bound the rest
  // of this hook already accepts for that array (nothing here windows
  // `messages` itself, so a very long paged-in history still grows both
  // together, not this ref alone). It's also cleared outright on every
  // conversation switch below.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  // Newest `created_at` this client holds for the open conversation — the
  // cursor every catch-up fetch pages forward from. A ref, not derived from
  // `messages` at call time, because the pollers fire from timers that closed
  // over an older render.
  const newestAtRef = useRef<string | null>(null);
  // Guards overlapping catch-up fetches: a degraded-mode poll every 6s over a
  // link slow enough to be degraded will otherwise stack requests.
  const catchupInFlight = useRef(false);
  // Guards `jumpToMessage` against a second jump starting while one is still
  // paging — two loops running at once would stomp on the same `hasMore`,
  // `loadingOlder`, `skipAutoScroll`, and highlight timer.
  const jumpInFlight = useRef(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  // The health-registry key for `channelRef`'s channel, so teardown can
  // withdraw it — a removed channel left in the registry reports its final
  // CLOSED status forever and pins the whole app to "degraded".
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

  // Commit-phase bookkeeping for the entrance-animation gate (`isAlreadySeen`,
  // read during the thread's render). This used to be a
  // `seenMessageIdsRef.add()` call inline in that render body — which broke
  // under StrictMode: React double-invokes a render body in development
  // specifically to catch side effects like that, so the first (discarded)
  // pass claimed the id and the second (committed) pass always saw the message
  // as already seen, silencing the animation for every realtime arrival in
  // local dev. A ref write belongs in an effect, which runs once per actual
  // commit, not per render-body invocation — and React makes no promise about
  // the latter count even outside StrictMode.
  //
  // Replaces rather than merges: this ref becomes exactly `messages`'s current
  // id set on every commit, so a message's *first* render (before this effect
  // has run) still correctly reads its id as absent/new, and any later,
  // unrelated re-render (e.g. a reaction toggle) reads it as already seen. See
  // the ref's own declaration above for why replacing also keeps it bounded.
  useEffect(() => {
    seenMessageIdsRef.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setFriendTyping(false);
    // Ids belong to the conversation they were painted in; a stale entry
    // from the one just left can't collide (UUIDs), but leaving it behind
    // would only grow unbounded across a long session of switching chats.
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

  // Wake-up. The socket the app slept through is gone even when the tab never
  // lost focus or visibility, and its channels never rejoin on their own — so
  // rebuild the subscription and pull everything that landed while we were
  // out. Generation 0 is the mount, already covered by the effect above.
  // Subscribing before the catch-up, not after: a message arriving between the
  // two would otherwise fall in the gap and wait for the next poll.
  useEffect(() => {
    if (generation === 0) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    if (channelKeyRef.current) forgetChannel(channelKeyRef.current);
    subscribe();
    void pullNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  // Polling. Fast while realtime is known to be down — a blocked WebSocket
  // (some networks and VPN routes drop or stall wss:// while plain HTTPS keeps
  // working) or a dead tunnel, where this is the only thing still delivering
  // messages. Slow while it is up, as a safety net for the one failure
  // realtime cannot report about itself: a socket that believes it is fine.
  // Skipped while hidden — a background tab has nothing to show, and the wake
  // path refetches on return anyway.
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

  /** Mark ids as already displayed, so the entrance-animation check treats
   *  them as old. Call at every point that merges *fetched* history (as
   *  opposed to a live realtime arrival) into `messages`. */
  function markSeen(ids: Iterable<string>) {
    for (const id of ids) seenMessageIdsRef.current.add(id);
  }

  /**
   * Retire an optimistic bubble in favour of its server row — the visual
   * hand-off at the end of a send. The caller drops the queue entry
   * immediately after, in the same tick.
   *
   * `markSeen` first, for the same reason `loadLatest` does it: the row is
   * replacing something already on screen, so it must not play the entrance
   * animation a second time.
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
    // Seed before the state update lands: the render that first shows this
    // page's rows must already find them "seen," or the entrance animation
    // cascades across the whole initial page.
    markSeen(rows.map((m) => m.id));
    setMessages((prev) => mergeMessages(prev, rows));
    setHasMore(data.length === PAGE_SIZE);

    // Messages that arrived while the app was closed reach this running
    // client right now, on this fetch — that's the whole definition of
    // "delivered", not just the live INSERT path. `data` is newest-first, so
    // the first row from the friend is the newest one to ack.
    // Nothing is "inbound" in your own notes — a receipt row for (me, me) is
    // forbidden outright by `no_self_receipt`, so this would only ever be a
    // rejected write.
    if (isSelf) return;
    const newestInbound = data.find((m) => m.user_id === peerId);
    if (newestInbound) void advanceDelivered(peerId, newestInbound.created_at);
  }

  /**
   * Fold freshly fetched rows into the thread with the same bookkeeping the
   * realtime INSERT handler does — retire optimistic twins, acknowledge
   * delivery, count arrivals the reader has scrolled away from.
   *
   * Used by every non-realtime delivery path (wake-up catch-up, degraded-mode
   * polling), so a message arriving over the fallback is indistinguishable
   * from one that came down the socket.
   */
  function ingest(rows: Message[]) {
    const relevant = rows.filter(isRelevant);
    if (relevant.length === 0) return;

    const retired: string[] = [];
    for (const row of relevant) {
      if (!outbox.pendingRef.current.some((p) => p.id === row.id)) continue;
      retired.push(row.id);
      // This row replaces a bubble already on screen; it must not play the
      // entrance animation a second time.
      markSeen([row.id]);
      void outbox.retire(row.id);
    }

    setMessages((prev) => mergeMessages(prev, relevant));
    outbox.dropPending(...retired);

    // Same as loadLatest: in the self-chat every row is your own, so there is
    // no delivery to acknowledge and no arrival you did not just cause.
    if (isSelf) return;
    const inbound = relevant.filter((m) => m.user_id === peerId);
    if (inbound.length === 0) return;
    void advanceDelivered(peerId, inbound[inbound.length - 1].created_at);
    scroll.countArrivals(inbound.length);
  }

  /**
   * Pull whatever arrived since the newest message on screen.
   *
   * This is the piece that was missing entirely: `loadLatest` ran on mount and
   * on conversation switch, and realtime covered the rest — so any window in
   * which realtime was not actually delivering (machine asleep, socket
   * blocked, tunnel dropped) left a permanent hole that only a page reload
   * closed. Now the same call backs both the wake-up path and the poll.
   *
   * A full page back means the gap is wider than one fetch, and stitching only
   * part of it onto the thread would leave a hole in the middle that "load
   * older" can never fill — it pages from the *oldest* row held, not from the
   * hole. In that case the thread is rebuilt from the newest page instead,
   * which is exactly the view a fresh open of the conversation gives.
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

      const rows = await open(await fetchSince(me, forFriend, since, CATCHUP_LIMIT));
      if (loadedFor.current !== forFriend) return;

      if (rows.length < CATCHUP_LIMIT) {
        ingest(rows);
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
   * Land on a search result. If it's already rendered, just scroll to it.
   * Otherwise page older messages until it turns up — a hand-rolled loop
   * rather than repeated `await loadOlder()` calls, because `loadOlder`
   * reads its cursor from this render's `messages` closure; several calls
   * made without a re-render between them would each re-request the same page
   * instead of advancing. `cursor` here is a local variable updated after
   * every fetch, so each iteration pages strictly further back regardless of
   * when React gets around to re-rendering.
   *
   * Bounded by MAX_JUMP_PAGES so a result deep in history can't page forever,
   * and also stops the moment a fetched page runs older than the target's own
   * `createdAt` without having turned it up — at that point paging further
   * only ever pages past it, which means it was deleted or edited out from
   * under this search between the query and the click.
   */
  async function jumpToMessage(messageId: string, createdAt: string) {
    // A second jump clicked while one is still paging would run concurrently
    // against the same `messages`/`hasMore`/`loadingOlder`/highlight-timer
    // state — one loop's `setLoadingOlder(false)` could land while the other
    // is still mid-fetch. Released in `finally` on every exit path below,
    // including the early returns and a thrown fetch.
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
        // `found` is recomputed fresh from each page. Stop the instant the
        // target turns up — continuing to the next iteration would overwrite
        // this `true` back to `false` once that page (which doesn't contain
        // it) is checked, even though the target is already merged and
        // sitting in the DOM.
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
          // A conversation switch between the loop finishing and this
          // callback running would otherwise set the highlight and start its
          // timer for a message id from the chat just left.
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
    const channel = supabase
      .channel(channelKey, {
        config: { broadcast: { self: false } },
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        // `self: false` suppresses the echo to the tab that sent it, but not to
        // this user's *other* devices — which in the self-chat means typing on
        // a laptop would show "typing" on the phone, about yourself.
        if (isSelf) return;
        if (payload?.userId !== peerId) return;
        setFriendTyping(true);
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(() => setFriendTyping(false), TYPING_LINGER_MS);
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as Message;
          if (!isRelevant(msg)) return;
          // The other half of the send hand-off: this event and `attemptSend`'s
          // own response are two independent races back from the same insert,
          // and either can land first. When it's this one, adopt the row here —
          // otherwise the authoritative bubble paints alongside the optimistic
          // one it replaces until the response catches up. The row carries the
          // queued message's own uuid as its id, so the pairing is an exact id
          // match. An own row with no queued counterpart is a send from another
          // device: nothing to retire, and it animates in like any other
          // arrival.
          if (outbox.pendingRef.current.some((p) => p.id === msg.id)) {
            // Opened before it is adopted: the two state updates have to
            // commit in one tick, so nothing between them can await.
            void open([msg]).then(([opened]) => {
              adoptSentRow(opened);
              outbox.dropPending(msg.id);
            });
            // The queue entry is settled: its row exists. Left in place it
            // would be re-attempted by the next flush — which the primary
            // key now makes harmless, but pointless.
            void outbox.retire(msg.id);
            return;
          }
          void open([msg]).then(([opened]) => {
            setMessages((prev) => mergeMessages(prev, [opened]));
          });
          // Only count arrivals the user didn't just cause — an own send is
          // never inbound. `countArrivals` skips a reader already at the
          // bottom, who sees it land without needing the button.
          if (msg.user_id === peerId) scroll.countArrivals(1);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as Message;
          if (!isRelevant(msg)) return;
          void open([msg]).then(([opened]) => {
            setMessages((prev) => prev.map((m) => (m.id === opened.id ? opened : m)));
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_receipts',
          filter: `user_id=eq.${peerId}`,
        },
        (payload) => {
          // In the self-chat this filter matches our OWN receipt rows (for
          // every friend), none of which describe this conversation.
          if (isSelf) return;
          const row = payload.new as Receipt;
          if (row?.peer_id !== me) return;
          receipts.setPeerReceipt(row);
        }
      )
      // Report health upward: this is the channel that carries the open
      // conversation, so its status is the truest available answer to "are
      // messages actually arriving?" — truer than the socket's own, which can
      // heartbeat happily while a channel sits in CHANNEL_ERROR. A non-
      // SUBSCRIBED status here is what switches on the fast poll above and
      // raises the reconnect banner.
      .subscribe((status) => reportChannelStatus(channelKey, status));

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
