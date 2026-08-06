import { useEffect, useRef, useState } from 'react';
import { Session, RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Message, PendingMessage, Profile } from '../lib/types';
import {
  conversationFilter,
  classifyMedia,
  fileExtension,
  isSelfChat,
  mediaPath,
  messageSnippet,
  MAX_MESSAGE_LENGTH,
  MEDIA_MAX_BYTES,
} from '../lib/conversation';
import { openRows, sealBody } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import type { Identity } from '../lib/crypto/keys';
import { formatDisplayName, useNickname } from '../lib/nicknames';
import { MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from '../lib/media';
import { CHAT_IMAGE_MAX_EDGE, compressImage } from '../lib/compress';
import { Avatar } from './Avatar';
import { StatusDot, presenceLabels } from './StatusDot';
import { MessageBubble } from './MessageBubble';
import { Composer, ComposerHandle } from './Composer';
import { ConversationSearch } from './ConversationSearch';
import { ChatBackgroundModal } from './ChatBackgroundModal';
import { NicknameModal } from './NicknameModal';
import { ForwardModal } from './ForwardModal';
import { useReactions } from '../hooks/useReactions';
import { useReplyTargets } from '../hooks/useReplyTargets';
import { useChatBackground } from '../hooks/useChatBackground';
import { usePresenceStatus } from '../hooks/usePresence';
import { useToast } from '../hooks/useToast';
import {
  advanceDelivered,
  advanceRead,
  fetchPeerReceipt,
  formatUnread,
  statusFor,
  type Receipt,
} from '../lib/receipts';
import {
  bumpAttempts,
  dequeue,
  enqueue,
  isDuplicateSend,
  listFor,
  nextDelayMs,
  MAX_ATTEMPTS,
} from '../lib/outbox';
import { formatDate, formatLastSeen, formatTime } from '../lib/time';
import { prefersReducedMotion } from '../lib/motion';
import { useConnection, reportChannelStatus, forgetChannel } from '../lib/connection';
import { closeNotificationsFor } from '../lib/push';
import { ArrowLeft, ChevronDown, Image as ImageIcon, NotebookPen, Search } from 'lucide-react';

const PAGE_SIZE = 30;
/** How long a jumped-to message's ring highlight stays visible. */
const HIGHLIGHT_MS = 1200;
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
/** Rows one incremental catch-up will pull. Hitting this cap means the gap is
 *  wider than the window we hold, so the thread is rebuilt from scratch
 *  instead — see `pullNew`. */
const CATCHUP_LIMIT = 100;

interface ChatRoomProps {
  session: Session;
  friend: Profile;
  /** Required, not optional: this component cannot send or read a vault
   *  message without a key, and a required prop makes that a type error
   *  instead of a runtime branch. App renders nothing until the key exists. */
  identity: Identity;
  onBack: () => void;
}

export function ChatRoom({ session, friend, identity, onBack }: ChatRoomProps) {
  const me = session.user.id;
  // Your own notes: no peer, so nothing about presence, typing, receipts or
  // notifications applies. Every branch below that mentions `isSelf` exists
  // because the other participant these features describe is you.
  const isSelf = isSelfChat(me, friend.id);
  const nickname = useNickname(friend.id);
  const peerLabel = formatDisplayName(nickname, friend.display_name, isSelf);
  const friendStatus = usePresenceStatus(friend.id);
  const toast = useToast();
  const background = useChatBackground(me, friend.id);
  // `generation` bumps every time the app wakes (sleep, tab restore, network
  // return); `live` is false while realtime isn't delivering.
  const { generation, live } = useConnection();

  /**
   * The single read boundary. Every fetch and every realtime arrival passes
   * through here to be decrypted once, on the way into state.
   *
   * The peer key is resolved per call rather than held in state on purpose:
   * `peerPublicKey` caches in-module after the first fetch, so this costs one
   * request per peer per session, and there is no window during which rows can
   * arrive before a key-loading effect has settled and render as decrypt
   * failures that a later re-render would have to undo.
   */
  async function open(rows: Message[]): Promise<Message[]> {
    return openRows(identity, await peerPublicKey(friend.id), friend.id, rows);
  }

  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [friendTyping, setFriendTyping] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  // Length of a staged voice recording. Kept beside the file because a
  // MediaRecorder blob carries no duration of its own, and the composer, the
  // message row and the bubble all need it.
  const [stagedDurationMs, setStagedDurationMs] = useState<number | null>(null);
  const [peerReceipt, setPeerReceipt] = useState<Receipt | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  // The message whose "Forward" was chosen, and so the one the picker will
  // copy. Null when the picker is closed.
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // The message a search jump just landed on — briefly ringed, then cleared.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Render-facing mirror of `atBottomRef`, kept in sync by `handleListScroll`.
  // The ref stays the source of truth other logic reads synchronously; this
  // exists only to gate the jump-to-latest button's visibility.
  const [atBottom, setAtBottom] = useState(true);
  // Inbound messages that arrived while scrolled away from the bottom, shown
  // on the jump-to-latest button. Reset on return to the bottom.
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  // Text sends not yet acknowledged by the server, rendered after `messages`
  // rather than merged into it — a pending row carries a client uuid that
  // will never match the real row's id, so folding it into `mergeMessages`
  // would leave a duplicate bubble once the realtime INSERT lands.
  const [pending, setPending] = useState<PendingMessage[]>([]);

  const messageIds = messages.map((m) => m.id);
  const { byMessage, toggle } = useReactions(me, messageIds);
  const byId = new Map(messages.map((m) => [m.id, m]));
  // A queued send now carries the id its server row will have, so the two
  // lists can name the same message for the moment between the row being
  // merged and the queue entry being retired. The authoritative row wins;
  // rendering both would paint the message twice (and hand React two
  // children with the same key).
  const queued = pending.filter((m) => !byId.has(m.id));
  // Quoted messages, including the ones that are older than the loaded window
  // and so can't be found in `byId` at all.
  const replyTargets = useReplyTargets(me, friend.id, messages);

  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // `pending`, readable from the realtime callbacks — those close over the
  // state as it was when `subscribe` ran, which for a long-lived channel is
  // almost never the current one. Written from an effect, not inline during
  // render, for the same reason `seenMessageIdsRef` is (see below).
  const pendingRef = useRef<PendingMessage[]>(pending);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // The health-registry key for `channelRef`'s channel, so teardown can
  // withdraw it — a removed channel left in the registry reports its final
  // CLOSED status forever and pins the whole app to "degraded".
  const channelKeyRef = useRef<string | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const composerRef = useRef<ComposerHandle>(null);
  const skipAutoScroll = useRef(false);
  // The conversation a fetch was issued for. Because loads now *merge* rather
  // than replace, a reply from the previous chat landing after a switch would
  // otherwise splice that chat's messages into this one.
  const loadedFor = useRef(friend.id);
  // Reset per conversation: the first scroll into a chat should not animate.
  const didFirstScroll = useRef(false);
  // Whether the message list is scrolled (near) to the bottom. Used to avoid
  // yanking the view down when a message arrives while you're reading history.
  const atBottomRef = useRef(true);
  // The `created_at` last written to our read watermark for this conversation.
  // `messages` changes on every send, page load, and realtime edit/delete, and
  // the peer subscribes to `message_receipts` with `event: '*'` — so a
  // same-value re-write isn't a no-op locally, it's a spurious re-render fired
  // at them. Skip the call unless the watermark would actually advance.
  const lastReadSent = useRef<string | null>(null);
  // The pending timer, and which conversation's queue it will flush. Keyed
  // rather than a bare boolean so a switch mid-flush doesn't make the new
  // conversation's own mount-flush a no-op — see `flushOutbox`.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushInFlightFor = useRef<string | null>(null);
  // Set when a flush is asked for while one is already running for the same
  // conversation, so the running pass re-runs once instead of the request
  // being lost — see `flushOutbox`.
  const flushAgainFor = useRef<string | null>(null);
  // Messages `enqueue` could not persist (IndexedDB unavailable or denied),
  // keyed by id. These never appear in `listFor`'s results, so without this
  // `flushOutbox` would never attempt them at all — the composer would show
  // a "pending" bubble that is never sent, retried, or failed. Reset
  // alongside `pending` on every conversation switch, since nothing in here
  // is durable across one anyway.
  const unqueuedRef = useRef<Map<string, PendingMessage>>(new Map());
  // Pending clear for `highlightId`, tracked so a second jump landing before
  // the first flash finishes can cancel and restart it cleanly.
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards `jumpToMessage` against a second jump starting while one is still
  // paging — two loops running at once would stomp on the same `hasMore`,
  // `loadingOlder`, `skipAutoScroll`, and highlight timer.
  const jumpInFlight = useRef(false);
  // Previous render's `messages` identity and `pending` length, used by the
  // auto-scroll effect below to tell an *addition* to `pending` (scroll-worthy)
  // apart from a *removal* (not) without adding a second effect.
  const prevMessagesRef = useRef<Message[]>(messages);
  const prevPendingLenRef = useRef(0);
  // Ids already painted on screen for the open conversation — gates the
  // entrance animation (Task 11) so a freshly opened chat's whole first page
  // doesn't cascade it. Seeded proactively by every *fetch* (initial load,
  // "load older", search paging) at the moment its rows are merged in — those
  // calls run in event/async-callback contexts, not inside a render body, so
  // mutating the ref there is fine — so those ids never read as new; left
  // un-seeded for a realtime INSERT, which is the one path that should
  // animate. What marks an INSERT's id seen afterwards is the commit-phase
  // effect below, *not* the render itself (see that effect's comment for why
  // a render-time write was the bug).
  //
  // Bounded, not ever-growing: the effect below *replaces* this ref with
  // `messages`'s current id set on every commit rather than merging into it,
  // so its size can never exceed `messages.length` — the same bound the rest
  // of this component already accepts for that array (nothing here windows
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

  useEffect(() => {
    newestAtRef.current = messages.length ? messages[messages.length - 1].created_at : null;
  }, [messages]);

  useEffect(() => {
    loadedFor.current = friend.id;
    didFirstScroll.current = false;
    atBottomRef.current = true;
    lastReadSent.current = null;
    // The jump-to-latest button and its counter belong to the conversation
    // that built them — carrying either across a switch would show the new
    // chat's opening view with the old one's count still attached.
    setAtBottom(true);
    setNewSinceScroll(0);
    setMessages([]);
    setFriendTyping(false);
    setReplyingTo(null);
    setStagedFile(null);
    setPeerReceipt(null);
    setPending([]);
    unqueuedRef.current = new Map();
    flushAgainFor.current = null;
    // Ids belong to the conversation they were painted in; a stale entry
    // from the one just left can't collide (UUIDs), but leaving it behind
    // would only grow unbounded across a long session of switching chats.
    seenMessageIdsRef.current = new Set();
    // A search's results and any in-flight highlight belong to the
    // conversation that was open when they fired — carrying them across a
    // switch would flash or list the wrong friend's messages.
    setSearchOpen(false);
    setHighlightId(null);
    // Same reasoning: the picker holds a message from the conversation being
    // left, and forwarding it after the switch would be acting on a bubble
    // that is no longer on screen.
    setForwarding(null);
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
      highlightTimer.current = null;
    }
    loadLatest();
    cleanupOldMedia();
    subscribe();
    loadPeerReceipt();
    void flushOutbox();

    const handleOnline = () => void flushOutbox();
    window.addEventListener('online', handleOnline);

    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      if (channelKeyRef.current) forgetChannel(channelKeyRef.current);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
      }
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friend.id]);

  useEffect(() => {
    const messagesChanged = messages !== prevMessagesRef.current;
    const pendingGrew = pending.length > prevPendingLenRef.current;
    prevMessagesRef.current = messages;
    prevPendingLenRef.current = pending.length;

    if (skipAutoScroll.current) {
      skipAutoScroll.current = false;
      return;
    }
    // `pending` only ever shrinks here from a successful flush or a
    // MAX_ATTEMPTS drop — cleanup of a bubble already on screen, not
    // something new to look at. Scrolling for it would yank a user reading
    // history back to the bottom for no reason (worst case, right as they
    // also get an error toast for the drop). Skip unless this run was
    // actually caused by a `messages` change or a `pending` addition.
    if (!messagesChanged && !pendingGrew) return;
    // Stick to the bottom only when the user is already there, or when the
    // newest message is one they just sent — otherwise leave their scroll be.
    // `pending` is in the dep array too: an optimistic send appends there,
    // not to `messages`, and it's still your own newest message.
    const last = pending[pending.length - 1] ?? messages[messages.length - 1];
    const isMine = last?.user_id === me;
    if (isMine || atBottomRef.current) {
      // Jump straight to the bottom on the first paint of a conversation —
      // animating a fresh 30-message list scrolls visibly past all of it.
      // `behavior: 'smooth'` passed explicitly here always wins over the
      // CSS reduced-motion rule in index.css, so that preference has to be
      // applied on this side too.
      bottomRef.current?.scrollIntoView({
        behavior: didFirstScroll.current && !prefersReducedMotion() ? 'smooth' : 'auto',
      });
      didFirstScroll.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pending]);

  // Commit-phase bookkeeping for the entrance-animation gate (`isNew`, read
  // in the `messages.map` below). This used to be a `seenMessageIdsRef.add()`
  // call inline in that render body — which broke under StrictMode: React
  // double-invokes a render body in development specifically to catch side
  // effects like that, so the first (discarded) pass claimed the id and the
  // second (committed) pass always saw `isNew === false`, silencing the
  // animation for every realtime arrival in local dev. A ref write belongs in
  // an effect, which runs once per actual commit, not per render-body
  // invocation — and React makes no promise about the latter count even
  // outside StrictMode.
  //
  // Replaces rather than merges: this ref becomes exactly `messages`'s
  // current id set on every commit, so a message's *first* render (before
  // this effect has run) still correctly reads its id as absent/new, and any
  // later, unrelated re-render (e.g. a reaction toggle) reads it as already
  // seen. See the ref's own declaration above for why replacing also keeps
  // it bounded.
  useEffect(() => {
    seenMessageIdsRef.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // Wake-up. The socket the app slept through is gone even when the tab never
  // lost focus or visibility, and its channels never rejoin on their own — so
  // rebuild the subscription and pull everything that landed while we were
  // out. Generation 0 is the mount, already covered by the effect above.
  useEffect(() => {
    if (generation === 0) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    if (channelKeyRef.current) forgetChannel(channelKeyRef.current);
    subscribe();
    loadPeerReceipt();
    void flushOutbox();
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
  }, [live, friend.id]);

  // Reading is what the open, focused chat means. Re-run on refocus so a
  // message that arrived while the window was in the background is only
  // marked read once you actually come back to it.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      markReadHere(messages);
      // Reading the chat retires its notifications. Without this, banners for
      // messages plainly visible on screen stay stacked in the OS tray (and
      // keep the taskbar/dock icon lit) until dismissed by hand.
      void closeNotificationsFor(`dm:${friend.id}`);
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, friend.id]);

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;
    const nowAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    atBottomRef.current = nowAtBottom;
    setAtBottom(nowAtBottom);
    if (nowAtBottom) setNewSinceScroll(0);
  }

  // The counter drops here rather than waiting for the smooth scroll's
  // trailing scroll event, so the badge doesn't linger through the animation.
  function scrollToLatest() {
    bottomRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    setNewSinceScroll(0);
  }

  function isRelevant(m: Message) {
    return (
      (m.user_id === me && m.receiver_id === friend.id) ||
      (m.user_id === friend.id && m.receiver_id === me)
    );
  }

  /** Shape a queued send as a `Message` so it can render through the same bubble. */
  function pendingAsMessage(msg: PendingMessage): Message {
    return {
      id: msg.id,
      user_id: msg.user_id,
      receiver_id: msg.receiver_id,
      // An optimistic bubble is local text that was never sealed — it has no
      // ciphertext to open, and `text` is exactly the field the bubble reads.
      text: msg.text,
      ciphertext: null,
      nonce: null,
      media_path: null,
      media_type: null,
      media_duration_ms: null,
      reply_to_id: msg.reply_to_id,
      // The outbox only ever queues typed text; a forward is inserted directly
      // by `forwardMessage` and never passes through here.
      forwarded: false,
      edited_at: null,
      deleted_at: null,
      created_at: msg.created_at,
    };
  }

  /**
   * Merge fetched rows into the list, de-duplicating by id and keeping the
   * conversation in `created_at` order.
   *
   * The initial load and the realtime subscription race by construction: the
   * channel is live while the first query is still in flight, so a message
   * arriving in that window is appended and then wiped by the query's result,
   * which was snapshotted before it existed. Merging instead of replacing keeps
   * it.
   */
  /** Mark ids as already displayed, so the entrance-animation check below
   *  treats them as old. Call at every point that merges *fetched* history
   *  (as opposed to a live realtime arrival) into `messages`. */
  function markSeen(ids: Iterable<string>) {
    for (const id of ids) seenMessageIdsRef.current.add(id);
  }

  function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
    if (incoming.length === 0) return prev;
    const byKey = new Map(prev.map((m) => [m.id, m]));
    for (const m of incoming) byKey.set(m.id, m);
    return [...byKey.values()].sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at < b.created_at
          ? -1
          : 1
    );
  }

  async function loadLatest() {
    const forFriend = friend.id;
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(conversationFilter(me, friend.id))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE);

    if (loadedFor.current !== forFriend) return;
    const rows = await open((data ?? []) as Message[]);
    // Seed before the state update lands: the render that first shows this
    // page's rows must already find them "seen," or the entrance animation
    // cascades across the whole initial page.
    markSeen(rows.map((m) => m.id));
    setMessages((prev) => mergeMessages(prev, rows));
    setHasMore((data?.length ?? 0) === PAGE_SIZE);

    // Messages that arrived while the app was closed reach this running
    // client right now, on this fetch — that's the whole definition of
    // "delivered", not just the live INSERT path. `data` is newest-first, so
    // the first row from the friend is the newest one to ack.
    // Nothing is "inbound" in your own notes — a receipt row for (me, me) is
    // forbidden outright by `no_self_receipt`, so this would only ever be a
    // rejected write.
    if (isSelf) return;
    const newestInbound = (data ?? []).find((m) => m.user_id === friend.id);
    if (newestInbound) void advanceDelivered(friend.id, newestInbound.created_at);
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

    const retired = new Set<string>();
    for (const row of relevant) {
      if (!pendingRef.current.some((p) => p.id === row.id)) continue;
      retired.add(row.id);
      // This row replaces a bubble already on screen; it must not play the
      // entrance animation a second time.
      markSeen([row.id]);
      void retireQueued(row.id);
    }

    setMessages((prev) => mergeMessages(prev, relevant));
    if (retired.size) setPending((prev) => prev.filter((m) => !retired.has(m.id)));

    // Same as loadLatest: in the self-chat every row is your own, so there is
    // no delivery to acknowledge and no arrival you did not just cause.
    if (isSelf) return;
    const inbound = relevant.filter((m) => m.user_id === friend.id);
    if (inbound.length === 0) return;
    void advanceDelivered(friend.id, inbound[inbound.length - 1].created_at);
    if (!atBottomRef.current) setNewSinceScroll((n) => n + inbound.length);
  }

  /**
   * Everything in this conversation at or after `sinceIso`, oldest first.
   *
   * `gte`, not `gt`: two messages can share a timestamp to the microsecond,
   * and `gt` would step over the one that isn't ours. Re-fetching the cursor
   * row itself is the cost, and `mergeMessages` de-dupes it by id.
   */
  async function fetchSince(sinceIso: string, limit: number): Promise<Message[]> {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(conversationFilter(me, friend.id))
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);
    return open((data ?? []) as Message[]);
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
    const forFriend = friend.id;
    const since = newestAtRef.current;
    catchupInFlight.current = true;
    try {
      if (!since) {
        await loadLatest();
        return;
      }

      const rows = await fetchSince(since, CATCHUP_LIMIT);
      if (loadedFor.current !== forFriend) return;

      if (rows.length < CATCHUP_LIMIT) {
        ingest(rows);
        return;
      }

      setMessages([]);
      seenMessageIdsRef.current = new Set();
      atBottomRef.current = true;
      setAtBottom(true);
      setNewSinceScroll(0);
      setHasMore(false);
      await loadLatest();
    } catch {
      /* a failed catch-up is retried by the next poll tick */
    } finally {
      catchupInFlight.current = false;
    }
  }

  async function loadPeerReceipt() {
    if (isSelf) return;
    const forFriend = friend.id;
    const row = await fetchPeerReceipt(friend.id);
    if (loadedFor.current !== forFriend) return;
    setPeerReceipt(row);
  }

  /**
   * Advance my read watermark to the newest message this friend has sent.
   * Anchored to a server-stamped `created_at` rather than the local clock —
   * the watermark is compared against that same column.
   */
  function markReadHere(list: Message[]) {
    if (isSelf) return;
    const newestInbound = [...list].reverse().find((m) => m.user_id === friend.id);
    if (!newestInbound) return;
    if (newestInbound.created_at === lastReadSent.current) return;
    lastReadSent.current = newestInbound.created_at;
    void advanceRead(friend.id, newestInbound.created_at);
  }

  async function loadOlder() {
    if (messages.length === 0) return;
    const forFriend = friend.id;
    setLoadingOlder(true);
    // Keyset on (created_at, id): a plain `created_at < oldest` silently drops
    // every message sharing the boundary timestamp, which two messages sent in
    // the same instant will.
    const oldest = messages[0];
    const { data } = await supabase
      .from('messages')
      .select('*')
      .or(conversationFilter(me, friend.id))
      .or(
        `created_at.lt.${oldest.created_at},` +
          `and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE);

    const older = await open((data ?? []) as Message[]);
    if (loadedFor.current !== forFriend) {
      setLoadingOlder(false);
      return;
    }
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    skipAutoScroll.current = true;
    markSeen(older.map((m) => m.id));
    setMessages((prev) => mergeMessages(prev, older));
    setHasMore(older.length === PAGE_SIZE);
    setLoadingOlder(false);

    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - prevHeight;
    });
  }

  /** Scroll a rendered bubble into view and ring it briefly so a search
   *  result reads as "found", not just silently present on screen. */
  function scrollToMessage(id: string) {
    // Same reduced-motion override as the auto-scroll effect above: a
    // `behavior: 'smooth'` passed here would otherwise animate regardless
    // of the OS setting.
    document.getElementById(`msg-${id}`)?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightId(id);
    highlightTimer.current = setTimeout(() => {
      setHighlightId(null);
      highlightTimer.current = null;
    }, HIGHLIGHT_MS);
  }

  /**
   * Land on a search result. If it's already rendered, just scroll to it.
   * Otherwise page older messages until it turns up — a hand-rolled loop
   * rather than repeated `await loadOlder()` calls, because `loadOlder`
   * reads its `oldest` cursor from this render's `messages` closure; several
   * calls made without a re-render between them would each re-request the
   * same page instead of advancing. `cursor` here is a local variable
   * updated after every fetch, so each iteration pages strictly further
   * back regardless of when React gets around to re-rendering.
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
      setSearchOpen(false);

      if (messages.some((m) => m.id === messageId)) {
        scrollToMessage(messageId);
        return;
      }

      if (!hasMore) {
        toast.error('Could not find that message.');
        return;
      }

      const forFriend = friend.id;
      setLoadingOlder(true);
      let cursor: { created_at: string; id: string } | undefined = messages[0];
      let more: boolean = hasMore;
      let found = false;

      for (let page = 0; page < MAX_JUMP_PAGES && more && cursor; page++) {
        const response = await supabase
          .from('messages')
          .select('*')
          .or(conversationFilter(me, friend.id))
          .or(
            `created_at.lt.${cursor.created_at},` +
              `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
          )
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PAGE_SIZE);

        if (loadedFor.current !== forFriend) {
          setLoadingOlder(false); // else it's stuck true for whichever conversation loads next
          return;
        }

        const older: Message[] = await open((response.data ?? []) as Message[]);
        if (older.length === 0) {
          more = false;
          break;
        }

        skipAutoScroll.current = true;
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
          // callback running would otherwise set `highlightId` and start the
          // highlight timer for a message id from the chat just left.
          if (loadedFor.current !== forHighlight) return;
          scrollToMessage(messageId);
        });
      } else {
        toast.error("Couldn't find that message — it may be too far back in history.");
      }
    } finally {
      jumpInFlight.current = false;
    }
  }

  /** Follow a reply's quote back to the message it answers. Same landing as a
   *  search hit — scroll, ring, and page back through history first if the
   *  quoted message is older than the loaded window. */
  function jumpToRepliedMessage(target: Message) {
    void jumpToMessage(target.id, target.created_at);
  }

  function subscribe() {
    const channelKey = `dm:${[me, friend.id].sort().join('_')}`;
    const channel = supabase
      .channel(channelKey, {
        config: { broadcast: { self: false } },
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        // `self: false` suppresses the echo to the tab that sent it, but not to
        // this user's *other* devices — which in the self-chat means typing on
        // a laptop would show "typing" on the phone, about yourself.
        if (isSelf) return;
        if (payload?.userId !== friend.id) return;
        setFriendTyping(true);
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        typingTimeout.current = setTimeout(() => setFriendTyping(false), 3000);
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as Message;
          if (!isRelevant(msg)) return;
          // The other half of the send hand-off: this event and
          // `attemptSend`'s own response are two independent races back from
          // the same insert, and either can land first. When it's this one,
          // adopt the row here — otherwise the authoritative bubble paints
          // alongside the optimistic one it replaces until the response
          // catches up. The row carries the queued message's own uuid as its
          // id, so the pairing is an exact id match. An own row with no
          // queued counterpart is a send from another device: nothing to
          // retire, and it animates in like any other arrival.
          if (pendingRef.current.some((p) => p.id === msg.id)) {
            // Opened before it is adopted: `adoptSentRow` has to commit both
            // state updates in one tick, so it cannot await anything itself.
            void open([msg]).then(([opened]) => {
              adoptSentRow(opened, (prev) => prev.filter((m) => m.id !== msg.id));
            });
            // The queue entry is settled: its row exists. Left in place it
            // would be re-attempted by the next flush — which the primary
            // key now makes harmless, but pointless.
            void retireQueued(msg.id);
            return;
          }
          void open([msg]).then(([opened]) => {
            setMessages((prev) => mergeMessages(prev, [opened]));
          });
          // Only count arrivals the user didn't just cause and isn't already
          // looking at — an own send is never inbound, and a reader already
          // at the bottom sees it land without needing the button.
          if (msg.user_id === friend.id && !atBottomRef.current) {
            setNewSinceScroll((n) => n + 1);
          }
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
          filter: `user_id=eq.${friend.id}`,
        },
        (payload) => {
          // In the self-chat this filter matches our OWN receipt rows (for
          // every friend), none of which describe this conversation.
          if (isSelf) return;
          const row = payload.new as Receipt;
          if (row?.peer_id !== me) return;
          setPeerReceipt(row);
        }
      )
      // Report health upward: this is the channel that carries the open
      // conversation, so its status is the truest available answer to "are
      // messages actually arriving?" — truer than the socket's own, which can
      // heartbeat happily while a channel sits in CHANNEL_ERROR. A non-
      // SUBSCRIBED status here is what switches on the fast poll below and
      // raises the reconnect banner.
      .subscribe((status) => reportChannelStatus(channelKey, status));

    channelRef.current = channel;
    channelKeyRef.current = channelKey;
  }

  function notifyTyping() {
    if (isSelf) return;
    const now = Date.now();
    if (now - lastTypingSent.current < 1500) return;
    lastTypingSent.current = now;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: me },
    });
  }

  /** Fire-and-forget: ask the backend to push a notification to the receiver. */
  function notifyReceiver(messageId: string) {
    // The receiver is you. The Edge Function refuses these anyway (as does the
    // database trigger), but there is no reason to spend the request.
    if (isSelf) return;
    supabase.functions.invoke('send-push', { body: { message_id: messageId } }).catch(() => {});
  }

  /** Validate a picked/pasted/recorded file and stage it before sending. */
  function handleStageFile(file: File, durationMs?: number) {
    if (!classifyMedia(file)) {
      toast.error('Unsupported file type. Use an image, video or voice message.');
      return;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      toast.error('File is too large (50 MB max).');
      return;
    }
    setStagedFile(file);
    setStagedDurationMs(durationMs ?? null);
    composerRef.current?.focus();
  }

  function handleClearStaged() {
    setStagedFile(null);
    setStagedDurationMs(null);
  }

  async function handleSend() {
    if (stagedFile) {
      // Media stays synchronous: queueing a 50 MB video in IndexedDB is a
      // different problem than this task solves, and the staged-file preview
      // already gives the user feedback while the upload is in flight.
      await sendMedia(stagedFile, newMessage.trim(), stagedDurationMs);
    } else {
      await sendText(newMessage.trim());
    }
  }

  /**
   * Text sends are optimistic: the bubble appears and the composer clears
   * before any network round trip, and the message is durable (via the
   * outbox) before this function returns. `sendText` itself never talks to
   * the server — `flushOutbox` does, immediately after and again on retry.
   */
  async function sendText(trimmed: string) {
    if (!trimmed) return;
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      toast.error(`Message is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }

    setSending(true);
    // The local clock only orders this bubble among this session's own
    // optimistic sends — it never reaches a receipt comparison, because the
    // row is discarded the moment the server's `messages` insert (with its
    // own, authoritative `created_at`) arrives over realtime and replaces it.
    const msg: PendingMessage = {
      id: crypto.randomUUID(),
      user_id: me,
      receiver_id: friend.id,
      text: trimmed,
      reply_to_id: replyingTo?.id ?? null,
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    setPending((p) => [...p, msg]);
    setNewMessage('');
    setReplyingTo(null);
    composerRef.current?.focus();
    const persisted = await enqueue(msg);
    // IndexedDB unavailable or denied: the outbox can't take custody of this
    // message, so `flushOutbox` would never see it via `listFor` and it
    // would sit on screen as "pending" forever. Track it here instead so
    // `flushOutbox` still attempts (and retries, and can fail) it directly.
    if (!persisted) unqueuedRef.current.set(msg.id, msg);
    setSending(false);
    void flushOutbox();
  }

  /**
   * The insert `sendText` used to make directly, now made only from the
   * queue. Returns the authoritative row (not just `true`) so the caller can
   * swap it in for the optimistic bubble itself — see `adoptSentRow`.
   *
   * The insert carries the queued message's own uuid as the row's primary
   * key, which is what makes sending idempotent. Without it, a send whose
   * *response* was lost — a dropped connection, a frozen tab, a timeout —
   * looked identical to one that never reached the server at all, and the
   * retry wrote a second copy: the "message sent twice" everyone sees on a
   * flaky link. With it, the retry collides with the row it already created,
   * and that collision is read here as the delivery it actually was.
   */
  async function attemptSend(msg: PendingMessage): Promise<Message | null> {
    try {
      const { data: inserted, error: insertError } = await supabase
        .from('messages')
        .insert({
          id: msg.id,
          user_id: msg.user_id,
          receiver_id: msg.receiver_id,
          ...(await sealBody(identity, await peerPublicKey(msg.receiver_id), msg.user_id, msg.receiver_id, msg.text)),
          reply_to_id: msg.reply_to_id,
        })
        .select('*')
        .single();

      if (isDuplicateSend(insertError)) {
        const existing = await fetchOwnMessage(msg.id);
        // The row landed but its response never did, so the push for it was
        // never asked for either — this retry is the first chance to send it.
        if (existing) notifyReceiver(existing.id);
        return existing;
      }
      // Genuinely offline fetches reject rather than resolving with an
      // `error` field on some stacks — the outbox exists specifically for
      // this case, so treat a thrown network error as an ordinary failure
      // rather than letting it escape as an unhandled rejection.
      if (insertError || !inserted) return null;
      notifyReceiver(inserted.id);
      const [opened] = await open([inserted as Message]);
      return opened;
    } catch {
      return null;
    }
  }

  /**
   * Read back a row this client wrote, for the duplicate-send path above.
   *
   * Scoped to `user_id = me` so a uuid that somehow belongs to someone else's
   * message can never be adopted as one of ours; `maybeSingle` so a row that
   * has since been hard-deleted reads as absent rather than as an error. A
   * null here is treated as an ordinary failed attempt — the send is retried,
   * hits the same collision, and tries again, which is harmless.
   */
  async function fetchOwnMessage(id: string): Promise<Message | null> {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('id', id)
      .eq('user_id', me)
      .maybeSingle();
    if (!data) return null;
    const [opened] = await open([data as Message]);
    return opened;
  }

  /**
   * Retire an optimistic bubble in favour of its server row — the visual
   * hand-off at the end of a send.
   *
   * Both state updates have to sit in one commit, with no `await` between
   * them: React batches only within a tick, and either ordering across two
   * commits is visible at 60fps. Dropping `pending` first blinks the bubble
   * out and back; adding the row first paints the same message twice.
   *
   * `markSeen` before the update, for the same reason `loadLatest` does it:
   * the row is replacing something already on screen, so it must not play the
   * entrance animation a second time.
   */
  function adoptSentRow(row: Message, dropPending: (p: PendingMessage[]) => PendingMessage[]) {
    markSeen([row.id]);
    setMessages((prev) => mergeMessages(prev, [row]));
    setPending(dropPending);
  }

  function scheduleFlush(delayMs: number) {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flushOutbox();
    }, delayMs);
  }

  /** In-memory equivalent of `bumpAttempts`, for a message the outbox never
   *  captured (see `unqueuedRef`) — same shape, so `flushOutbox` can treat a
   *  durable and a non-durable entry identically apart from where the new
   *  attempt count is written. Null when the entry has left the queue
   *  meanwhile, matching what `bumpAttempts` reports for the same case. */
  function bumpUnqueued(msg: PendingMessage): PendingMessage | null {
    const current = unqueuedRef.current.get(msg.id);
    if (!current) return null;
    const updated: PendingMessage = { ...current, attempts: current.attempts + 1 };
    unqueuedRef.current.set(msg.id, updated);
    return updated;
  }

  /** Drop a settled message from whichever queue is holding it. Both halves
   *  are no-ops when the entry isn't there, so callers that don't know which
   *  one captured it (the realtime adoption paths) can just call this. */
  async function retireQueued(id: string): Promise<void> {
    unqueuedRef.current.delete(id);
    await dequeue(id);
  }

  /**
   * Drain this conversation's queue: attempt every entry, dequeue and drop
   * from `pending` on success, or bump its attempt count on failure — giving
   * up (and toasting) once `MAX_ATTEMPTS` is reached. A message that reaches
   * the server is *not* pushed into `messages` here; the realtime INSERT
   * delivers the authoritative row and `mergeMessages` de-dupes it.
   *
   * Two sources feed the attempt list: `queued`, read from IndexedDB via
   * `listFor`, and `unqueuedRef`, messages `sendText` couldn't persist there
   * at all (storage denied, private browsing). They're disjoint by
   * construction — `sendText` puts a given message's id in exactly one of
   * them — so attempting both here can't double-send; it's what keeps a
   * message going out even when the outbox itself is unavailable.
   *
   * Guarded per-conversation (not with a single flag) so a slow flush for a
   * conversation you've since left doesn't block the new one's mount-flush.
   * Durable writes (`dequeue`, `bumpAttempts`, and the `unqueuedRef`
   * mutations that stand in for them) run unconditionally — they only touch
   * storage local to this function, not the screen, so they're correct
   * regardless of which conversation is open. Only the React state updates
   * (`setPending`, `toast`) are gated behind `loadedFor`, since those alone
   * paint *this* screen. Do not "simplify" this back to one shared gate: it
   * used to gate the durable write too, so a success landing exactly as the
   * user switched conversations away never got dequeued — the next flush
   * re-sent it and produced a duplicate row on the server.
   */
  async function flushOutbox() {
    const forFriend = friend.id;
    // A flush already reading this conversation's queue snapshotted it before
    // whatever prompted this call — a fresh `sendText`, a reconnect — so the
    // new work is invisible to it. Ask for one more pass instead of dropping
    // the request on the floor, which used to leave a message queued behind a
    // concurrent flush with nothing left to retry it.
    if (flushInFlightFor.current === forFriend) {
      flushAgainFor.current = forFriend;
      return;
    }
    flushInFlightFor.current = forFriend;

    try {
      const queued = await listFor(me, forFriend);
      if (loadedFor.current !== forFriend) return;
      // Seeds `pending` with anything that survived a reload — the mount
      // flush is the only trigger with no prior `sendText` call to have
      // added these already.
      setPending((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const additions = queued.filter((m) => !known.has(m.id));
        return additions.length ? [...prev, ...additions] : prev;
      });

      const attemptList: Array<{ msg: PendingMessage; durable: boolean }> = [
        ...queued.map((msg) => ({ msg, durable: true })),
        ...[...unqueuedRef.current.values()].map((msg) => ({ msg, durable: false })),
      ];

      const stillQueued: PendingMessage[] = [];
      for (const { msg, durable } of attemptList) {
        const row = await attemptSend(msg);
        const onScreen = loadedFor.current === forFriend;

        if (row) {
          // Before the durable write, not after: `dequeue` is an await, and
          // an await between the two state updates inside `adoptSentRow`
          // splits them across commits — the exact flicker it exists to
          // avoid. Dequeuing a moment later is invisible either way.
          if (onScreen) {
            adoptSentRow(row, (prev) => prev.filter((m) => m.id !== msg.id));
          }
          if (durable) await dequeue(msg.id);
          else unqueuedRef.current.delete(msg.id);
          continue;
        }

        // A rate-limit rejection lands here too: it consumes an attempt like
        // any other failure rather than being retried immediately, so a
        // flush against that limit backs off instead of spinning on it.
        const updated: PendingMessage | null = durable
          ? await bumpAttempts(msg.id)
          : bumpUnqueued(msg);

        // Gone from the queue while this attempt was in flight: its server
        // row arrived over realtime and the adoption path retired it. The
        // message is delivered — not failed — so there is nothing to retry
        // and nothing to tell the user about.
        if (!updated) continue;

        if (updated.attempts >= MAX_ATTEMPTS) {
          if (durable) await dequeue(msg.id);
          else unqueuedRef.current.delete(msg.id);
          if (onScreen) {
            setPending((prev) => prev.filter((m) => m.id !== msg.id));
            toast.error('Message failed to send.');
          }
          continue;
        }

        if (onScreen) {
          setPending((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
          stillQueued.push(updated);
        }
      }

      if (stillQueued.length > 0) {
        const lowestAttempts = Math.min(...stillQueued.map((m) => m.attempts));
        scheduleFlush(nextDelayMs(lowestAttempts));
      }
    } finally {
      if (flushInFlightFor.current === forFriend) flushInFlightFor.current = null;
      // Serve whatever asked for a flush while this one held the lock. Only
      // for the conversation still on screen, and only once per coalesced
      // burst — the flag is cleared before the recursive call, so a pass that
      // finds nothing to do ends the chain rather than looping.
      if (flushAgainFor.current === forFriend) {
        flushAgainFor.current = null;
        if (loadedFor.current === forFriend) void flushOutbox();
      }
    }
  }

  async function sendMedia(file: File, caption: string, durationMs: number | null) {
    if (caption.length > MAX_MESSAGE_LENGTH) {
      toast.error(`Caption is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }
    const kind = classifyMedia(file);
    if (!kind) {
      toast.error('Unsupported file type. Use an image, video or voice message.');
      return;
    }

    setUploading(true);
    // Images are re-encoded before they leave the device — a phone photo is
    // typically megabytes of resolution this UI never paints. Videos and voice
    // notes go up as recorded (voice is already ~180 KB a minute).
    const upload =
      kind === 'image' ? await compressImage(file, { maxEdge: CHAT_IMAGE_MAX_EDGE }) : file;

    const path = mediaPath(me, friend.id, `${crypto.randomUUID()}.${fileExtension(upload)}`);
    const { error: uploadError } = await supabase.storage
      .from('chat-media')
      .upload(path, upload, { contentType: upload.type });

    if (uploadError) {
      setUploading(false);
      toast.error(uploadError.message);
      return;
    }

    const replyId = replyingTo?.id ?? null;
    const { data: inserted, error: insertError } = await supabase
      .from('messages')
      .insert({
        user_id: me,
        receiver_id: friend.id,
        // A caption is body text like any other and is sealed like any other.
        // The attachment itself is still a plaintext object in Storage; Task 4
        // of this plan is where that changes.
        ...(caption
          ? await sealBody(identity, await peerPublicKey(friend.id), me, friend.id, caption)
          : { ciphertext: null, nonce: null }),
        media_path: path,
        media_type: kind,
        media_duration_ms: kind === 'audio' ? durationMs : null,
        reply_to_id: replyId,
      })
      .select('id')
      .single();
    setUploading(false);

    if (insertError) {
      await supabase.storage.from('chat-media').remove([path]);
      toast.error(
        /rate_limited_messages/.test(insertError.message)
          ? "You're sending messages too quickly — give it a moment."
          : 'Could not send media.'
      );
      return;
    }
    // Sent: clear the composer and staged attachment.
    setStagedFile(null);
    setStagedDurationMs(null);
    setNewMessage('');
    setReplyingTo(null);
    composerRef.current?.focus();
    if (inserted) notifyReceiver(inserted.id);
    cleanupOldMedia();
  }

  /** Trim this conversation's media back to the per-kind keep limits. */
  async function cleanupOldMedia() {
    const { data } = await supabase
      .from('messages')
      .select('id, media_path, user_id, media_type')
      .or(conversationFilter(me, friend.id))
      .not('media_path', 'is', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(MEDIA_SCAN_LIMIT);

    if (!data) return;

    const stale = selectStaleMedia(data as MediaRow[]);
    if (!stale.length) return;

    const paths = stale.map((m) => m.media_path).filter((p): p is string => !!p);
    if (paths.length) await supabase.storage.from('chat-media').remove(paths);

    // RLS lets us edit only our own rows; the friend's rows degrade gracefully
    // (the attachment and voice-note components both show a "no longer
    // available" fallback).
    const myStale = stale.filter((m) => m.user_id === me);
    if (myStale.length) {
      // The placeholder names what was trimmed, so a cleared voice note doesn't
      // read as a lost photo.
      const byKind = new Map<string, string[]>();
      for (const row of myStale) {
        const label = row.media_type === 'audio' ? '🎤 voice message removed' : '📎 media removed';
        byKind.set(label, [...(byKind.get(label) ?? []), row.id]);
      }
      const peerKey = await peerPublicKey(friend.id);
      for (const [label, ids] of byKind) {
        await supabase
          .from('messages')
          .update({
            media_path: null,
            media_type: null,
            media_duration_ms: null,
            // The placeholder is a body, so it is sealed like one. Written as
            // plaintext it would simply never appear: nothing reads `content`
            // any more, and the bubble would show a decrypt failure where a
            // "media removed" note belongs.
            ...(await sealBody(identity, peerKey, me, friend.id, label)),
          })
          .in('id', ids);
      }
    }
  }

  function startEdit(msg: Message) {
    setEditingId(msg.id);
    setEditingText(msg.text ?? '');
  }

  async function saveEdit(id: string) {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      toast.error(`Message is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }
    setEditingId(null);
    // Re-sealed, not written back as plaintext: an edit in the vault must
    // leave the row exactly as unreadable as the send did.
    const { error: updateError } = await supabase
      .from('messages')
      .update({
        ...(await sealBody(identity, await peerPublicKey(friend.id), me, friend.id, trimmed)),
        edited_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (updateError) toast.error('Could not edit message.');
  }

  async function deleteMessage(msg: Message) {
    setEditingId(null);
    if (msg.media_path) {
      await supabase.storage.from('chat-media').remove([msg.media_path]);
    }
    const { error: deleteError } = await supabase
      .from('messages')
      .update({
        deleted_at: new Date().toISOString(),
        // Empty rather than null only because `has_body` still counts `content`
        // as a body until 0023 drops the column. Task 3 removes this line and
        // exempts tombstones from the rebuilt constraint instead — a deleted
        // message is meant to have no body at all.
        content: '',
        // Cleared with the body: a tombstone that kept its ciphertext would
        // leave the sealed text sitting on the server after the user asked
        // for it to be gone, and `openBody` would still open it.
        ciphertext: null,
        nonce: null,
        media_path: null,
        media_type: null,
        // Cleared with the rest of it: a length left on a row that no longer
        // names a file is a fact about something that isn't there, and it is
        // the one field the media trim (`cleanupOldMedia`) already nulls.
        media_duration_ms: null,
      })
      .eq('id', msg.id);
    if (deleteError) toast.error('Could not delete message.');
  }

  /** Group consecutive messages from the same sender within this window. */
  const GROUP_WINDOW_MS = 5 * 60 * 1000;

  return (
    <div className="flex flex-col h-full bg-base-200/50">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 sm:px-5 py-3 bg-base-100 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.25)] z-10 shrink-0">
        <button
          className="btn btn-ghost btn-sm btn-square lg:hidden hover:bg-base-content/10 transition-colors"
          onClick={onBack}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="relative shrink-0" style={{ width: 36, height: 36 }}>
          <Avatar display_name={friend.display_name} url={friend.avatar_url} size={36} />
          {isSelf && (
            <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
              <NotebookPen className="w-3 h-3 text-primary" />
            </span>
          )}
        </div>
        {/* The name is the button that opens the nickname editor: it is the
            thing being renamed, so it needs no icon of its own to explain it. */}
        <button
          type="button"
          className="min-w-0 text-left rounded-lg px-1 -mx-1 hover:bg-base-content/5 transition-colors"
          onClick={() => setNicknameOpen(true)}
          title={isSelf ? 'Name this chat' : 'Set a nickname'}
        >
          <p className="font-semibold text-sm truncate">
            {peerLabel}
            {nickname && !isSelf && (
              <span className="ml-1.5 font-normal text-xs text-base-content/45">
                @{friend.display_name}
              </span>
            )}
          </p>
          <p className="text-xs text-base-content/60">
            {isSelf ? (
              // Presence and last-seen would be this device reporting on
              // itself; what is worth saying here is that nobody else can read
              // any of it.
              <span>Only you can see this</span>
            ) : friendTyping ? (
              <span className="inline-flex items-center gap-1.5 text-primary">
                <span className="loading loading-dots loading-xs" />
                typing
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={friendStatus} size={8} />
                {friendStatus === 'offline' && friend.last_seen_at
                  ? formatLastSeen(friend.last_seen_at)
                  : presenceLabels[friendStatus]}
              </span>
            )}
          </p>
        </button>
        <button
          className="btn btn-ghost btn-sm btn-square ml-auto hover:bg-base-content/10 transition-colors"
          onClick={() => setSearchOpen((open) => !open)}
          title="Search messages"
          aria-pressed={searchOpen}
        >
          <Search className="w-5 h-5" />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
          onClick={() => setBackgroundOpen(true)}
          title="Chat background"
        >
          <ImageIcon className="w-5 h-5" />
        </button>
      </header>

      {backgroundOpen && (
        <ChatBackgroundModal
          url={background.url}
          busy={background.busy}
          onPick={background.setBackground}
          onRemove={background.removeBackground}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

      {forwarding && (
        <ForwardModal
          me={me}
          msg={forwarding}
          fromPeerId={friend.id}
          identity={identity}
          onClose={() => setForwarding(null)}
        />
      )}

      {nicknameOpen && (
        <NicknameModal
          me={me}
          peerId={friend.id}
          display_name={friend.display_name}
          isSelf={isSelf}
          onClose={() => setNicknameOpen(false)}
        />
      )}

      {searchOpen && (
        <ConversationSearch
          key={friend.id}
          peerId={friend.id}
          me={me}
          peerLabel={peerLabel}
          isSelf={isSelf}
          onJump={jumpToMessage}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        {background.url && (
          <>
            {/* aria-hidden and pointer-events-none: decoration only. Both
                layers sit behind the thread, which is why <main> below is
                positioned — without that it would paint under them. */}
            <div
              aria-hidden
              className="absolute inset-0 bg-cover bg-center pointer-events-none"
              style={{ backgroundImage: `url("${background.url}")` }}
            />
            {/* Scrim. Bubbles stay opaque, but date dividers, the empty state
                and the load-older button are bare text over whatever photo the
                pair chose — this is what keeps them legible on a light one. */}
            <div aria-hidden className="absolute inset-0 bg-base-200/65 pointer-events-none" />
          </>
        )}
        {/* overflow-x-clip is load-bearing, not defensive: `overflow-y: auto`
            forces the other axis's `visible` to compute to `auto`, so anything
            reaching past the list's right edge — a swipe-to-reply bubble
            travelling up to MAX_PX, a wide bubble's overlay — turned the whole
            thread into a sideways-scrollable pane on touch. `clip` (not
            `hidden`) because hidden would make this a scroll container on both
            axes again, which is what the bug was. */}
        <main
          ref={listRef}
          onScroll={handleListScroll}
          className="relative h-full overflow-y-auto overflow-x-clip px-3 sm:px-5 py-4"
        >
          {hasMore && (
            <div className="flex justify-center mb-3">
              <button
                className="btn btn-ghost btn-xs text-base-content/60"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  'Load older messages'
                )}
              </button>
            </div>
          )}

          {messages.length === 0 && queued.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center px-6">
                {isSelf ? (
                  <>
                    <p className="text-base-content/60 text-sm">
                      Send yourself notes, links and reminders
                    </p>
                    {/* "Your words", not "everything": the text is sealed with
                        the vault key, but an attachment is still an object in
                        Storage that the server can read. Claiming otherwise
                        here would be the app's first lie about the one
                        property it is selling. */}
                    <p className="text-base-content/50 text-xs mt-1">
                      Notes, photos and voice memos. Your words are encrypted with a key only this
                      phone holds.
                    </p>
                  </>
                ) : (
                  <p className="text-base-content/60 text-sm">
                    Start the conversation with {peerLabel}
                  </p>
                )}
              </div>
            </div>
          )}

          <div>
            {messages.map((msg, i) => {
              const isOwn = msg.user_id === me;
              const prev = messages[i - 1];
              const msgDate = formatDate(msg.created_at);
              const showDateDivider = !prev || formatDate(prev.created_at) !== msgDate;
              const groupedWithPrev =
                !!prev &&
                !showDateDivider &&
                prev.user_id === msg.user_id &&
                new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() <
                  GROUP_WINDOW_MS;
              const isEditing = editingId === msg.id;
              // Not pre-seeded by a fetch (see markSeen call sites above) means
              // this id reached `messages` via the realtime INSERT handler —
              // the one path an arrival should actually animate for. Read only:
              // the commit-phase effect above is what marks it seen afterwards.
              const isNew = !seenMessageIdsRef.current.has(msg.id);

              return (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`rounded-xl transition-shadow duration-300 ${
                    groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'
                  } ${highlightId === msg.id ? 'ring-2 ring-primary' : ''}`}
                >
                  {showDateDivider && (
                    <div className="flex justify-center my-4">
                      <span className="text-[0.7rem] font-medium text-base-content/60 bg-base-300/80 px-3 py-1 rounded-full ring-1 ring-base-content/5 backdrop-blur-sm">
                        {msgDate}
                      </span>
                    </div>
                  )}
                  <MessageBubble
                    msg={msg}
                    isOwn={isOwn}
                    me={me}
                    peerLabel={peerLabel}
                    showHeader={!groupedWithPrev}
                    isEditing={isEditing}
                    editingText={editingText}
                    reactions={byMessage.get(msg.id) ?? []}
                    repliedTo={msg.reply_to_id ? replyTargets.get(msg.reply_to_id) : null}
                    repliedToLoading={
                      msg.reply_to_id ? replyTargets.isLoading(msg.reply_to_id) : false
                    }
                    onForward={setForwarding}
                    onJumpToReplied={jumpToRepliedMessage}
                    status={
                      // No ticks in the self-chat: delivered-to-whom, read-by-whom.
                      isOwn && !isSelf ? statusFor(msg.created_at, peerReceipt) : undefined
                    }
                    isNew={isNew}
                    onToggleReaction={(emoji) => toggle(msg.id, emoji)}
                    onReply={setReplyingTo}
                    onEditingTextChange={setEditingText}
                    onSaveEdit={saveEdit}
                    onCancelEdit={() => setEditingId(null)}
                    onStartEdit={startEdit}
                    onDelete={deleteMessage}
                    formatTime={formatTime}
                  />
                </div>
              );
            })}

            {/* Queued sends, newest by construction — appended rather than run
                through `mergeMessages`. Every action is a no-op: a message that
                doesn't exist server-side can't be edited, deleted, replied to,
                or reacted to. */}
            {queued.map((msg, i) => {
              const prev = i === 0 ? messages[messages.length - 1] : queued[i - 1];
              const groupedWithPrev =
                !!prev &&
                prev.user_id === msg.user_id &&
                new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() <
                  GROUP_WINDOW_MS;

              // opacity-90, not the /70 this started at: the hand-off to the
              // server row is a swap between two elements, so the dim can't
              // tween away — whatever gap is left here is a visible pop the
              // instant a send lands, which for an online send is a few
              // hundred milliseconds after it appears. The clock glyph in the
              // footer is what actually communicates "sending"; this only has
              // to hint at it.
              return (
                <div
                  key={msg.id}
                  className={`opacity-90 ${groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'}`}
                >
                  <MessageBubble
                    msg={pendingAsMessage(msg)}
                    isOwn
                    me={me}
                    peerLabel={peerLabel}
                    showHeader={!groupedWithPrev}
                    isEditing={false}
                    editingText=""
                    reactions={[]}
                    repliedTo={msg.reply_to_id ? replyTargets.get(msg.reply_to_id) : null}
                    repliedToLoading={
                      msg.reply_to_id ? replyTargets.isLoading(msg.reply_to_id) : false
                    }
                    onJumpToReplied={jumpToRepliedMessage}
                    status="pending"
                    // `pending` never carries a first-paint backlog worth
                    // guarding against (it's this session's own in-flight
                    // sends, occasionally a handful recovered from the outbox
                    // on mount) — every entry just appeared, so it always
                    // animates rather than needing the same seen-id tracking
                    // `messages` does.
                    isNew
                    onToggleReaction={() => {}}
                    onReply={() => {}}
                    onEditingTextChange={() => {}}
                    onSaveEdit={() => {}}
                    onCancelEdit={() => {}}
                    onStartEdit={() => {}}
                    onDelete={() => {}}
                    formatTime={formatTime}
                  />
                </div>
              );
            })}
          </div>
          <div ref={bottomRef} />
        </main>

        {!atBottom && (
          <button
            type="button"
            className="btn btn-circle btn-sm absolute bottom-4 right-4"
            onClick={scrollToLatest}
            aria-label={
              newSinceScroll > 0
                ? `Jump to latest messages, ${newSinceScroll} new`
                : 'Jump to latest messages'
            }
          >
            <ChevronDown className="w-4 h-4" />
            {newSinceScroll > 0 && (
              <span className="badge badge-primary badge-xs absolute -top-1 -right-1">
                {formatUnread(newSinceScroll)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Input */}
      <Composer
        ref={composerRef}
        value={newMessage}
        onChange={(v) => {
          setNewMessage(v);
          notifyTyping();
        }}
        onSend={handleSend}
        onStageFile={handleStageFile}
        stagedFile={stagedFile}
        stagedDurationMs={stagedDurationMs}
        onClearStaged={handleClearStaged}
        onError={toast.error}
        sending={sending}
        uploading={uploading}
        replyingTo={
          replyingTo
            ? {
                display_name: replyingTo.user_id === me ? 'yourself' : peerLabel,
                snippet: messageSnippet(replyingTo),
              }
            : null
        }
        onCancelReply={() => setReplyingTo(null)}
      />
    </div>
  );
}
