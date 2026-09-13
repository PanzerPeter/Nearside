import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel, Session } from '@supabase/supabase-js';
import {
  ArrowLeft,
  BellRing,
  CornerUpRight,
  FileDown,
  Image as ImageIcon,
  Lock,
  LogOut,
  MoreVertical,
  Search,
  ShieldAlert,
  Timer,
  Trash2,
  UserMinus,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  ROOM_MESSAGE_COLUMNS,
  deleteRoom,
  deleteRoomMessage,
  editRoomMessage,
  leaveRoom,
  openRoomRows,
  roomColour,
  roomKeyFor,
  removeMember,
  markRoomRead,
  roomAsMessage,
  roomMembers,
  roomReadAt,
  roomSigningKeys,
  sendRoomMessage,
  type RoomMessage,
  type RoomParticipant,
  type RoomSummary,
} from '../lib/rooms';
import { formatDisplayName, nicknameFor } from '../lib/nicknames';
import {
  describeTimerChange,
  formatTtl,
  loadRoomTimer,
  saveRoomTimer,
  TTL_OPTIONS,
  type ConversationTimer,
} from '../lib/disappearing';
import { useChatBackground } from '../hooks/useChatBackground';
import { ChatBackgroundModal } from './ChatBackgroundModal';
import { Modal } from './Modal';
import { PinnedBanner } from './PinnedBanner';
import {
  loadRoomPin,
  pinRoomMessage,
  unpinRoomMessage,
  type PinnedMessage,
} from '../lib/pinned-message';
import { isBodyOptional, messageSnippet } from '../lib/conversation';
import { tapSend } from '../lib/haptics';
import { notifyRoom } from '../lib/push';
import { forgetChannel, reportChannelStatus, useConnection } from '../lib/connection';
import { useToast } from '../hooks/useToast';
import { useMediaSend } from '../hooks/useMediaSend';
import { useStickers } from '../hooks/useStickers';
import { useReactions } from '../hooks/useReactions';
import { useDraft } from '../hooks/useDraft';
import { draftKey } from '../lib/drafts';
import { privacyPrefs } from '../lib/privacy-prefs';
import type { PendingMessage, Profile } from '../lib/types';
import { Composer, type ComposerHandle } from './Composer';
import { GalleryProvider } from '../hooks/useGallery';
import { useShortcut } from '../hooks/useShortcut';
import { useExportChat } from '../hooks/useExportChat';
import { useHistoryBackfill } from '../hooks/useHistoryBackfill';
import { useExpirySweep } from '../hooks/useExpirySweep';
import { selectionPowers, toggleSelected } from '../lib/selection';
import {
  alertLevelFor,
  loadChatFlags,
  setAlertLevel,
  subscribeChatFlags,
  type AlertLevel,
} from '../lib/chat-flags';
import { MessageThread } from './MessageThread';
import { useThreadScroll } from '../hooks/useThreadScroll';
import { ForwardModal } from './ForwardModal';
import { ReactionSheet } from './ReactionSheet';
import { isRoomForwardable, roomSource } from '../lib/forward';
import { ConversationSearch } from './ConversationSearch';
import { StickerPicker } from './StickerPicker';
import { useUnreadDivider } from '../hooks/useUnreadDivider';
import { useT } from '../hooks/useT';

interface RoomViewProps {
  session: Session;
  room: RoomSummary;
  identity: import('../lib/crypto/keys').Identity;
  /** A message to land on when the group opens, from a search across all
   *  chats. Null every other time — the default is the newest message. */
  openAt?: { messageId: string; createdAt: string } | null;
  onBack: () => void;
  onLeft: () => void;
}

/** A group has no outbox. One frozen array rather than a literal in the call,
 *  so the scroll hook's "did pending grow?" check is not handed a new identity
 *  on every render. */
const NO_PENDING: PendingMessage[] = [];

/** Stable identity for "nothing picked", so the thread is not handed a new Set
 *  on every render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const PAGE_SIZE = 50;
/** How far back a search result may drag the thread. The same cap the 1:1
 *  thread uses: past it the jump costs more than reading back by hand. */
const MAX_JUMP_PAGES = 10;
/** How long a typing mark survives without another broadcast. Matches the 1:1
 *  thread's, so the indicator behaves the same in both places. */
const TYPING_LINGER_MS = 3_000;
/** Minimum gap between typing broadcasts. */
const TYPING_THROTTLE_MS = 2_000;
/** Polling cadence while realtime is down, matching ChatRoom's fallback. */
const POLL_DEGRADED_MS = 5_000;

/** A daisyUI dropdown is held open by focus, so a menu item that only runs its
 *  handler leaves the menu standing over the answer — see `ChatHeader`. The
 *  entries that open a `<dialog>` hid it by taking focus; the ones that just
 *  set something (the timer, the alert level) left it on screen. */
function closeMenu() {
  (document.activeElement as HTMLElement | null)?.blur();
}

/**
 * A room conversation.
 *
 * Signatures are checked before anything is decrypted, in `openRoomRows`. A
 * message that fails renders as a warning bubble rather than being dropped —
 * hiding it would conceal an attack in progress, which is precisely the case
 * the signature exists to surface.
 */
export function RoomView({ session, room, identity, openAt, onBack, onLeft }: RoomViewProps) {
  const t = useT();
  const me = session.user.id;
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  /** Deletes asked for but not yet written — see `requestDelete`. */
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  /** Messages picked out to be acted on together. Null when nothing is being
   *  picked, which is a different state from an empty set — see `ChatRoom`. */
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  /** A bulk forward, through the sheet a single forward uses. */
  const [forwardingMany, setForwardingMany] = useState<RoomMessage[] | null>(null);
  /** The one message held at the top of the group — see migration 0048. */
  const [pinned, setPinned] = useState<PinnedMessage | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  /** The group's disappearing-message timer, from `rooms.ttl_seconds`. */
  const [timer, setTimer_] = useState<ConversationTimer | null>(null);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  /** Leaving is the one action here that cannot be undone — for an owner it
   *  ends the group for everybody — so it is asked twice. */
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** Whether the server has anything older than the oldest row on screen. A
   *  group used to be a hard window of the newest fifty with no way back:
   *  message fifty-one existed and could not be reached from the UI. */
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Who is typing, and when they last said so. */
  const [typingBy, setTypingBy] = useState<Map<string, number>>(new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastTypingSent = useRef(0);
  /**
   * Ids already painted, gating the bubble's entrance animation.
   *
   * Every *fetch* seeds its rows here as they merge, so a page of history never
   * reads as new — opening a group used to cascade the animation down all fifty
   * of its messages, because the group thread drew `animate-message-in` on
   * every row unconditionally. A realtime arrival is deliberately left
   * unseeded: that is the one path an animation is for.
   *
   * The effect below then replaces the set with what is on screen, which both
   * marks that arrival seen and bounds the set to the loaded window.
   */
  const seenIds = useRef<Set<string>>(new Set());
  const [members, setMembers] = useState<RoomParticipant[]>([]);
  const [forwarding, setForwarding] = useState<RoomMessage | null>(null);
  /** Whose reactions the sheet is showing, by message id: the rows are rebuilt
   *  on every wake, so a captured row would leave the open sheet frozen. */
  const [showingReactions, setShowingReactions] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [roomKey, setRoomKey] = useState<Uint8Array | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  // Per room, and outside this component, for the reason `ChatRoom` keeps its
  // own there: the pane survives a switch between conversations.
  const draft = useDraft(draftKey('room', room.id));
  const [replyingTo, setReplyingTo] = useState<RoomMessage | null>(null);
  const [sending, setSending] = useState(false);
  /** The message being rewritten, and the text so far. Held here rather than in
   *  the bubble: the composer owns Save and Cancel, so both ends of the edit
   *  have to read the same string. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  /** What the message said when the editor opened, so saving the same words
   *  back can be recognised as the no-op it is — writing it anyway would stamp
   *  `edited_at` and hang "(edited)" on a message nobody changed. */
  const editingOriginal = useRef('');
  const [showMembers, setShowMembers] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** How far this account had read when the group opened. `undefined` while
   *  that read is in flight — the mark below waits for it, because the mark is
   *  what would erase it. */
  const [readAtOnOpen, setReadAtOnOpen] = useState<string | null | undefined>(undefined);
  /** One jump at a time: two loops would page the same thread against each
   *  other's `messages` and `hasMore`. */
  const jumpInFlight = useRef(false);
  /** Who is mid-removal, so their row can show it and not be tapped twice. */
  const [removing, setRemoving] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const toast = useToast();
  const { generation, live } = useConnection();

  const isOwner = room.created_by === me;

  // The drawer is per account, not per room — the same hook the 1:1 composer
  // uses, and the same cache behind it.
  const stickers = useStickers(me, identity);
  const background = useChatBackground(me, { kind: 'room', roomId: room.id }, identity);

  // The same sweep the 1:1 thread runs, for the same reason: the server
  // deletes the row, but a group left open goes on painting it from what this
  // component is holding until somebody reopens the view.
  useExpirySweep(setMessages, generation);

  // Read once per group. The timer is changed rarely and by a member, so the
  // realtime `rooms` stream is not worth a subscription of its own — a change
  // made elsewhere lands the next time the group is opened, and the messages
  // themselves already carry the expiry the server stamped on them.
  useEffect(() => {
    let alive = true;
    void loadRoomTimer(room.id).then((t) => {
      if (alive) setTimer_(t);
    });
    return () => {
      alive = false;
    };
  }, [room.id]);

  // The same shortcut a 1:1 conversation answers, for the same reason.
  useShortcut((shortcut) => {
    if (shortcut !== 'search-chat') return false;
    setSearchOpen(true);
    return true;
  });

  /** How loudly this group arrives — see `ChatRoom` for why it is read from
   *  the flag store rather than held here. */
  const [alertLevel, setAlertLevelState] = useState<AlertLevel | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void loadChatFlags().then((flags) => {
        if (alive) setAlertLevelState(alertLevelFor(room.id, flags));
      });
    read();
    const stop = subscribeChatFlags(read);
    return () => {
      alive = false;
      stop();
    };
  }, [room.id]);

  async function changeAlertLevel(level: AlertLevel | null) {
    try {
      await setAlertLevel(room.id, 'room', level);
    } catch {
      toast.error(t('alerts.failed'));
    }
  }

  async function setTimer(ttlSeconds: number | null) {
    try {
      await saveRoomTimer(room.id, ttlSeconds);
      setTimer_(await loadRoomTimer(room.id));
    } catch {
      toast.error(t('room.timerFailed'));
    }
  }

  const media = useMediaSend({
    me,
    target: { kind: 'room', roomId: room.id, roomKey },
    identity,
    onStaged: () => composerRef.current?.focus(),
    onSent: () => {
      draft.clear();
      composerRef.current?.focus();
    },
    onError: toast.error,
  });

  // The same hook the 1:1 thread uses, pointed at the room table. Not a copy:
  // the optimistic toggle and the realtime de-duplication are what make a
  // reaction feel instant, and two copies of them drift.
  const reactions = useReactions(
    me,
    useMemo(() => messages.map((m) => m.id), [messages]),
    'room_message_reactions'
  );

  /** Every display name in the room, so `@name` is only highlighted for
   *  somebody who is actually here. */
  const handles = useMemo(
    () =>
      members
        .map((p) => profiles.get(p.user_id)?.display_name)
        .filter((n): n is string => !!n),
    [members, profiles]
  );
  const myHandle = profiles.get(me)?.display_name ?? '';

  /** Loaded messages by id, for resolving a quote without a second query. A
   *  reply whose target is outside the window renders as unavailable. */
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  /** What the thread draws: everything except the messages whose delete is
   *  still inside its undo window. */
  const shown = useMemo(() => messages.filter((m) => !deleting.has(m.id)), [messages, deleting]);

  /**
   * The same rows in the shape the thread renders.
   *
   * `MessageThread` and `MessageBubble` are the app's only message renderer —
   * a group used to have its own, which is how it came to be missing date
   * dividers, message grouping, the jump-to-latest button, a delivery tick and
   * the proper action menu while the 1:1 thread had all five. One renderer,
   * and an adapter at its edge; see `roomAsMessage`.
   */
  const shownMessages = useMemo(
    () => shown.map((m) => roomAsMessage(m, room.id)),
    [shown, room.id]
  );

  // Declared above the scroll hook, which lands the first scroll of a group on
  // this line rather than at the newest message.
  const dividerRows = useMemo(
    () => messages.map((m) => ({ id: m.id, from: m.sender_id, created_at: m.created_at })),
    [messages]
  );
  const unreadDividerId = useUnreadDivider(room.id, me, dividerRows, readAtOnOpen);

  /**
   * Where the list is looking — the hook the 1:1 thread has always used.
   *
   * What a group gets out of this that it did not have: the view follows new
   * messages only when the reader is already at the bottom. Before, every
   * arrival called `scrollIntoView` unconditionally, so reading back through a
   * busy group meant being yanked to the newest message every time somebody
   * said anything. The jump-to-latest button and its unread counter come with
   * it, and so does the ring a search result lands on.
   */
  const scroll = useThreadScroll({
    peerId: room.id,
    me,
    messages: shownMessages,
    // A group has no outbox yet: a send that fails says so and leaves the words
    // in the composer, rather than queueing them the way a 1:1 does.
    pending: NO_PENDING,
    peerTyping: typingBy.size > 0,
    unreadDividerId,
  });

  /**
   * Quote resolution, against the loaded window alone.
   *
   * The 1:1 thread fetches a quote's parent when it falls outside the window;
   * a group cannot use that hook as it stands — it queries `messages` with a
   * pair filter — so a reply to something older still renders as unavailable
   * here, exactly as it did before. Shaped as a `ReplyTargets` so the thread
   * does not have to know which of the two it was handed.
   */
  const replyTargets = useMemo(
    () => ({
      get: (id: string) => {
        const row = byId.get(id);
        return row ? roomAsMessage(row, room.id) : null;
      },
      isLoading: () => false,
    }),
    [byId, room.id]
  );

  const colourFor = useMemo(() => {
    const map = new Map(members.map((m) => [m.user_id, roomColour(m.colour_index)]));
    return (userId: string) => map.get(userId) ?? 'text-base-content';
  }, [members]);

  const nameFor = useCallback(
    (userId: string) => {
      if (userId === me) return t('common.you');
      const profile = profiles.get(userId);
      return formatDisplayName(nicknameFor(userId), profile?.display_name);
    },
    [me, profiles, t]
  );

  // The one line the group shows about its timer, and where in the thread it
  // belongs. `rooms` keeps the current setting and who set it last, so — as in
  // a 1:1 conversation — this is the whole history the app can honestly draw.
  //
  // Must stay below `nameFor`: the memo body calls it during the render that
  // creates it, and every room has a `rooms` row, so `timer` is non-null the
  // moment the fetch lands. Declared above, that call reads a `const` in its
  // temporal dead zone — a ReferenceError in render, which the app-wide error
  // boundary turns into "Something went wrong" for the whole app on opening
  // any group.
  const timerChange = useMemo(
    () => (timer?.setBy ? describeTimerChange(timer, me, nameFor(timer.setBy)) : null),
    // `nameFor` reads the member list, which is state; it is re-created on
    // every render and as a dependency would recompute this on each of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timer, me, members]
  );
  // Re-read on every wake, like every other fetch beside a subscription.
  useEffect(() => {
    let alive = true;
    void loadRoomPin(room.id)
      .then((row) => {
        if (alive) setPinned(row);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [room.id, generation]);

  useEffect(() => {
    const channel = supabase
      .channel(`room-pin:${room.id}:${generation}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_pins' }, () => {
        // One row, so a re-read is cheaper than reassembling it from a payload
        // whose DELETE half carries only the key.
        void loadRoomPin(room.id).then(setPinned).catch(() => {});
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [room.id, generation]);

  const pinnedSnippet = useMemo(() => {
    if (!pinned) return null;
    const row = messages.find((m) => m.id === pinned.messageId);
    return row ? messageSnippet(roomAsMessage(row, room.id)) : null;
  }, [pinned, messages, room.id]);

  async function togglePin(id: string) {
    setPinBusy(true);
    try {
      if (pinned?.messageId === id) await unpinRoomMessage(room.id);
      else await pinRoomMessage(room.id, id);
      setPinned(await loadRoomPin(room.id));
    } catch {
      toast.error(t('pin.failed'));
    } finally {
      setPinBusy(false);
    }
  }

  /** The picked messages, resolved against what the thread still holds. */
  const picked = useMemo(
    () => (selectedIds ? messages.filter((m) => selectedIds.has(m.id)) : []),
    [selectedIds, messages]
  );
  const powers = useMemo(
    () =>
      selectionPowers(
        picked.map((m) => ({
          id: m.id,
          isOwn: m.sender_id === me,
          // A row this device could not verify must not be re-signed as
          // somebody else's — the same rule a single forward follows.
          forwardable: isRoomForwardable(m),
        }))
      ),
    [picked, me]
  );

  function deleteSelected() {
    const doomed = picked;
    setSelectedIds(null);
    setDeleting((prev) => {
      const next = new Set(prev);
      for (const m of doomed) next.add(m.id);
      return next;
    });
    const forget = () =>
      setDeleting((prev) => {
        const next = new Set(prev);
        for (const m of doomed) next.delete(m.id);
        return next;
      });
    toast.offer(
      t('message.deletedMany', { count: doomed.length }),
      { label: t('common.undo'), onAct: forget },
      () => {
        forget();
        for (const m of doomed) {
          void deleteRoomMessage(m.id, identity).catch(() =>
            toast.error(t('room.deleteMessageFailed'))
          );
        }
      }
    );
  }

  /** Open a page of rows: verify every signature, then decrypt. Shared by the
   *  newest-page load and the older-page load so the two cannot drift in what
   *  they check. */
  const openPage = useCallback(
    async (rows: RoomMessage[], key: Uint8Array) => {
      const signing = await roomSigningKeys([...new Set(rows.map((r) => r.sender_id))]);
      return openRoomRows(rows, key, signing);
    },
    []
  );

  /**
   * The rest of the room's history, fetched into the local mirror when
   * something asks a question of the whole of it — the same walk the 1:1
   * thread runs, and for the same reason: search and the transcript read the
   * mirror, and the mirror holds what this device has opened.
   *
   * Pages go through `openPage`, so every row is signature-checked before it
   * is mirrored. A forgery must not become searchable on this phone because it
   * arrived through the back-fill rather than through the thread.
   */
  const history = useHistoryBackfill({
    conversationId: room.id,
    ready: roomKey !== null,
    pageSize: PAGE_SIZE,
    fetchOlder: useCallback(
      async (cursor) => {
        if (!roomKey) return [];
        let query = supabase
          .from('room_messages')
          .select(ROOM_MESSAGE_COLUMNS)
          .eq('room_id', room.id)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (cursor) query = query.lt('created_at', cursor.created_at);
        const { data, error } = await query;
        if (error) throw error;
        const page = (data as unknown as RoomMessage[] | null) ?? [];
        await openPage(page, roomKey);
        return page;
      },
      [room.id, roomKey, openPage]
    ),
  });

  // The callback, not the object the hook returns: that one is rebuilt on
  // every render, and depending on it would re-fire this effect on each.
  const startHistory = history.ensure;
  useEffect(() => {
    if (searchOpen) void startHistory();
  }, [searchOpen, startHistory]);

  const chatExport = useExportChat({
    conversationId: room.id,
    title: room.title,
    me,
    meLabel: t('common.you'),
    nameFor,
    // Same as the 1:1 export: the file must not quietly stop where this
    // device's mirror does.
    prepare: history.ensure,
  });

  async function runExport() {
    if (chatExport.busy) return;
    const written = await chatExport.run();
    if (written === null) toast.error(t('chat.exportFailed'));
    else toast.success(t('chat.exported', { count: written }));
  }

  /** Who is typing right now, by name. A group needs the names: three dots in
   *  a room of six say nothing about who is about to speak. */
  const typingNames = useMemo(
    () => [...typingBy.keys()].filter((id) => id !== me).map((id) => nameFor(id)),
    [typingBy, me, nameFor]
  );

  // The key first: every other fetch is useless without it, and a null key is
  // a state the user must be told about rather than shown as an empty room.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const key = await roomKeyFor(room.id, identity);
      if (!alive) return;
      setRoomKey(key);
      setKeyMissing(!key);
    })();
    return () => {
      alive = false;
    };
  }, [room.id, identity, generation]);

  const loadMembers = useCallback(async () => {
    const rows = await roomMembers(room.id);
    setMembers(rows);
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', rows.map((r) => r.user_id));
    setProfiles(new Map(((data as Profile[] | null) ?? []).map((p) => [p.id, p])));
  }, [room.id]);

  const loadMessages = useCallback(async () => {
    if (!roomKey) return;
    // One more than the page, purely to answer "is there anything older?"
    // without a second round trip or a count.
    const { data, error } = await supabase
      .from('room_messages')
      .select(ROOM_MESSAGE_COLUMNS)
      .eq('room_id', room.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (error) return;

    const page = (data as unknown as RoomMessage[] | null) ?? [];
    setHasMore(page.length > PAGE_SIZE);
    const rows = page.slice(0, PAGE_SIZE).reverse();
    const opened = await openPage(rows, roomKey);
    for (const m of opened) seenIds.current.add(m.id);
    setMessages(opened);
  }, [room.id, roomKey, openPage]);

  /**
   * Another page, older than what is on screen.
   *
   * Keyed on the oldest loaded `created_at` rather than an offset: rows arrive
   * while somebody is reading, and an offset would skip or repeat around them.
   */
  const loadOlder = useCallback(async () => {
    if (!roomKey || loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const { data, error } = await supabase
        .from('room_messages')
        .select(ROOM_MESSAGE_COLUMNS)
        .eq('room_id', room.id)
        .lt('created_at', messages[0].created_at)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE + 1);
      if (error) return;

      const page = (data as unknown as RoomMessage[] | null) ?? [];
      setHasMore(page.length > PAGE_SIZE);
      const older = await openPage(page.slice(0, PAGE_SIZE).reverse(), roomKey);
      if (older.length === 0) return;
      for (const m of older) seenIds.current.add(m.id);

      // The browser keeps the scroll offset, not the content under it, so
      // prepending would silently carry the reader up the thread. Measured
      // before the commit and restored after it, which is what makes paging
      // look like the list simply got longer above.
      const list = scroll.listRef.current;
      const before = list?.scrollHeight ?? 0;
      scroll.skipAutoScroll.current = true;
      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        return [...older.filter((m) => !known.has(m.id)), ...current];
      });
      requestAnimationFrame(() => {
        if (!list) return;
        list.scrollTop += list.scrollHeight - before;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [room.id, roomKey, messages, loadingOlder, openPage, scroll.listRef, scroll.skipAutoScroll]);

  /**
   * Follow a search result back to its message, loading pages until it is on
   * screen.
   *
   * Paged rather than fetched around the hit: a page dropped into the middle of
   * the thread with a hole on either side of it reads as a thread that lost
   * messages. The cap is what stops a hit from years back paging the whole
   * group into memory.
   */
  const jumpToMessage = useCallback(
    async (id: string, createdAt: string) => {
      if (jumpInFlight.current) return;
      jumpInFlight.current = true;
      try {
        if (messages.some((m) => m.id === id)) {
          scroll.scrollToMessage(id);
          return;
        }
        if (!roomKey || !hasMore) {
          toast.error(t('search.notFound'));
          return;
        }

        setLoadingOlder(true);
        let cursor: string | undefined = messages[0]?.created_at;
        let more: boolean = hasMore;
        let found = false;
        for (let page = 0; page < MAX_JUMP_PAGES && more && cursor; page++) {
          const { data, error } = await supabase
            .from('room_messages')
            .select(ROOM_MESSAGE_COLUMNS)
            .eq('room_id', room.id)
            .lt('created_at', cursor)
            .order('created_at', { ascending: false })
            .limit(PAGE_SIZE + 1);
          if (error) break;

          const rows = (data as unknown as RoomMessage[] | null) ?? [];
          more = rows.length > PAGE_SIZE;
          const older = await openPage(rows.slice(0, PAGE_SIZE).reverse(), roomKey);
          if (older.length === 0) {
            more = false;
            break;
          }
          for (const m of older) seenIds.current.add(m.id);
          scroll.skipAutoScroll.current = true;
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.id));
            return [...older.filter((m) => !known.has(m.id)), ...prev];
          });
          setHasMore(more);
          found = older.some((m) => m.id === id);
          if (found) break;
          cursor = older[0].created_at;
          // Paged past where the hit should have been: it is not in this group
          // any more, whatever the mirror still remembers.
          if (cursor < createdAt) break;
        }
        setLoadingOlder(false);

        // Let the merged pages paint before measuring where to scroll to.
        if (found) requestAnimationFrame(() => scroll.scrollToMessage(id));
        else toast.error(t('search.tooFarBack'));
      } finally {
        jumpInFlight.current = false;
      }
    },
    [room.id, roomKey, messages, hasMore, openPage, scroll, toast, t]
  );

  // Land on the message a search result named, once, after the first page is
  // in. Keyed on the target rather than run on mount: opening the same group at
  // a different message is a second jump, and re-running every render would
  // fight the reader for the scroll position.
  const jumpedTo = useRef<string | null>(null);
  useEffect(() => {
    if (!openAt) {
      jumpedTo.current = null;
      return;
    }
    if (jumpedTo.current === openAt.messageId || messages.length === 0) return;
    jumpedTo.current = openAt.messageId;
    void jumpToMessage(openAt.messageId, openAt.createdAt);
    // `jumpToMessage` is rebuilt whenever `messages` changes, which is every
    // page; as a dependency it would re-enter the jump it just finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt, messages.length]);

  /**
   * Verify, open and append one row that arrived over the socket.
   *
   * The subscription used to call `loadMessages`, which re-read the newest
   * fifty rows and every sender's profile for a row the event had already
   * delivered in full. In a room of five that is five clients each pulling
   * fifty messages for every one message anybody sends, and the cost grows with
   * the room rather than with the conversation.
   *
   * De-duplicated by id because the sender's own insert is echoed back here as
   * well as returned to `send`, and because a poll running underneath a
   * recovering socket can deliver the same row twice.
   */
  const appendMessage = useCallback(
    async (row: RoomMessage) => {
      if (!roomKey) return;
      const signing = await roomSigningKeys([row.sender_id]);
      const [opened] = await openRoomRows([row], roomKey, signing);
      setMessages((prev) =>
        prev.some((m) => m.id === opened.id)
          ? prev.map((m) => (m.id === opened.id ? opened : m))
          : [...prev, opened]
      );
    },
    [roomKey]
  );

  /**
   * Verify, open and fold in one row that changed under us — an edit or a
   * tombstone.
   *
   * Verification runs first here exactly as it does on an insert: a deletion is
   * re-signed over the emptied row (see `deleteRoomMessage`), so a tombstone
   * that arrives with the old signature still on it is not a deletion this
   * group should trust.
   *
   * A row that is not on screen is dropped rather than appended: an edit to a
   * message older than the loaded window belongs where that message is, and
   * appending it would drop a lone out-of-order bubble at the bottom of the
   * thread.
   */
  const replaceMessage = useCallback(
    async (row: RoomMessage) => {
      if (!roomKey) return;
      const signing = await roomSigningKeys([row.sender_id]);
      const [opened] = await openRoomRows([row], roomKey, signing);
      setMessages((prev) =>
        prev.some((m) => m.id === opened.id)
          ? prev.map((m) => (m.id === opened.id ? opened : m))
          : prev
      );
    },
    [roomKey]
  );

  useEffect(() => {
    void loadMembers();
  }, [loadMembers, generation]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages, generation]);

  // Realtime, with the same channel-status reporting every other subscription
  // in the app uses, so `lib/connection.ts`'s wake and reconnect handling
  // applies here unchanged.
  useEffect(() => {
    if (!roomKey) return;
    const channelKey = `room:${room.id}:${generation}`;
    const channel = supabase
      .channel(channelKey, { config: { broadcast: { self: false } } })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        (payload) => void appendMessage(payload.new as RoomMessage)
      )
      // Edits and deletions. Without this an edit made on somebody else's
      // phone never reached this one: the row changed, no INSERT fired, and the
      // group went on showing the text its author had already corrected until
      // the view was reopened.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'room_messages', filter: `room_id=eq.${room.id}` },
        (payload) => void replaceMessage(payload.new as RoomMessage)
      )
      // Who is typing, by id. A group needs the id — "someone is typing" in a
      // room of six is not worth showing, and the name is what makes it worth
      // showing.
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        // The setting is symmetric: with typing off this device broadcasts
        // none of its own, so it does not read anybody else's.
        if (!privacyPrefs().typing) return;
        const who = payload?.userId as string | undefined;
        if (!who || who === me) return;
        setTypingBy((current) => new Map(current).set(who, Date.now()));
      })
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_participants',
          filter: `room_id=eq.${room.id}`,
        },
        () => void loadMembers()
      )
      .subscribe((status) => reportChannelStatus(channelKey, status));

    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      forgetChannel(channelKey);
      void supabase.removeChannel(channel);
    };
  }, [room.id, roomKey, generation, me, appendMessage, replaceMessage, loadMembers]);

  // Typing marks expire on a timer rather than on a "stopped" broadcast: a
  // sender who closes the app sends nothing, and a mark waiting for a message
  // that never comes stays up for good.
  useEffect(() => {
    if (typingBy.size === 0) return;
    const id = setInterval(() => {
      setTypingBy((current) => {
        const now = Date.now();
        const next = new Map([...current].filter(([, at]) => now - at < TYPING_LINGER_MS));
        return next.size === current.size ? current : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [typingBy]);

  // Polling fallback for networks that stall `wss://` while ordinary HTTPS
  // keeps working — the banner already says so; this is what keeps the room
  // moving underneath it.
  useEffect(() => {
    if (live || !roomKey) return;
    const id = setInterval(() => void loadMessages(), POLL_DEGRADED_MS);
    return () => clearInterval(id);
  }, [live, roomKey, loadMessages]);

  useEffect(() => {
    let alive = true;
    setReadAtOnOpen(undefined);
    void (async () => {
      const at = await roomReadAt(room.id, me);
      if (alive) setReadAtOnOpen(at);
    })();
    return () => {
      alive = false;
    };
  }, [room.id, me]);

  /**
   * Mark the group read up to its newest message.
   *
   * Keyed on the newest `created_at` rather than firing per render: re-marking
   * the same instant is a wasted write on every reaction, every typing frame
   * and every re-render the room does while somebody sits in it.
   */
  useEffect(() => {
    const newest = messages[messages.length - 1]?.created_at;
    if (!newest || readAtOnOpen === undefined) return;
    // The list hears about this through `subscribeRoomReads`, not through a
    // prop threaded up to App and back down.
    void markRoomRead(room.id, me, newest);
  }, [room.id, me, messages, readAtOnOpen]);

  // Commit-phase half of the entrance-animation gate. In an effect rather than
  // inline for the reason `useChatThread` gives: done during render it silences
  // the animation under StrictMode, where the discarded first pass claims the
  // id and the committed pass then reads the message as already seen.
  useEffect(() => {
    seenIds.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  /**
   * Tell the group this device is typing.
   *
   * Throttled rather than debounced: the mark expires on the receiving side, so
   * a steady one every two seconds is all it takes to hold the indicator up,
   * and a broadcast per keystroke would be a message per character.
   */
  function notifyTyping() {
    if (!privacyPrefs().typing) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_THROTTLE_MS) return;
    lastTypingSent.current = now;
    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { userId: me },
    });
  }

  function startEdit(m: RoomMessage) {
    setEditingId(m.id);
    setEditingText(m.text ?? '');
    editingOriginal.current = m.text ?? '';
    setReplyingTo(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingText('');
  }

  /**
   * Commit an edit.
   *
   * Nothing is written back into `messages` here: the update comes home over
   * the socket through `replaceMessage`, which verifies the new signature — so
   * this device sees its own edit the same way every other member does, and a
   * re-signing bug cannot hide behind an optimistic local copy.
   */
  async function saveEdit(id: string) {
    const target = byId.get(id);
    if (!target || !roomKey || savingEdit) return;
    const trimmed = editingText.trim();
    if (!trimmed && !isBodyOptional({ media_path: target.media_path ?? null })) return;
    if (trimmed === editingOriginal.current.trim()) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    try {
      await editRoomMessage(id, identity, roomKey, trimmed, target);
      cancelEdit();
    } catch {
      toast.error(t('room.editFailed'));
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * Ask for a message to be deleted, and hold it for as long as the toast is
   * up.
   *
   * Same bargain as the 1:1 thread: the bubble goes at once, because a grace
   * period nobody can see is not one, and the write — which re-signs an emptied
   * row on everybody's phone and cannot be taken back — only starts when the
   * offer of an undo expires.
   */
  function requestDelete(m: RoomMessage) {
    if (editingId === m.id) cancelEdit();
    setDeleting((prev) => new Set(prev).add(m.id));
    const forget = () =>
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(m.id);
        return next;
      });
    toast.offer(t('message.deleteToast'), { label: t('common.undo'), onAct: forget }, () => {
      forget();
      void deleteRoomMessage(m.id, identity).catch(() =>
        toast.error(t('room.deleteMessageFailed'))
      );
    });
  }

  async function send() {
    // Anything staged makes this a media send, and the typed line becomes its
    // caption — the same rule the 1:1 composer follows, so Send does one thing
    // in both places.
    if (media.staged.length) {
      await media.send(draft.value.trim(), replyingTo?.id ?? null);
      setReplyingTo(null);
      return;
    }

    const text = draft.value.trim();
    if (!text || !roomKey || sending) return;
    void tapSend();
    setSending(true);
    try {
      const row = await sendRoomMessage(room.id, me, identity, roomKey, text, {
        replyToId: replyingTo?.id ?? null,
      });
      draft.clear();
      setReplyingTo(null);
      // The database trigger covers this too, but only on a project with a
      // `push_config` row — this one has none, so without the invoke a room
      // message wakes nobody.
      notifyRoom(row.id);
      // The insert returned the row, so the bubble is built from it rather than
      // by re-reading the page it belongs to. The echo of our own insert
      // arrives over the socket a moment later and `appendMessage`
      // de-duplicates it by id.
      await appendMessage(row);
    } catch {
      toast.error(t('room.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  /** Owner-only. The panel below already tells the owner what removal does and
   *  does not reach; this is the action that copy was written for. */
  async function handleRemove(userId: string) {
    setRemoving(userId);
    try {
      await removeMember(room.id, userId);
      await loadMembers();
    } catch {
      toast.error(t('room.removeFailed'));
    } finally {
      setRemoving(null);
    }
  }

  async function handleLeave() {
    try {
      if (isOwner) await deleteRoom(room.id);
      else await leaveRoom(room.id, me);
      onLeft();
    } catch {
      toast.error(isOwner ? t('room.deleteFailed') : t('room.leaveFailed'));
    }
  }

  return (
    <div className="relative flex flex-col h-full bg-base-200/50 min-h-0">
      {/* Same top edge as ChatHeader, and inset the same way — see the comment
          there for why `lg:` puts it back. */}
      <header className="navbar bg-base-100 px-2 sm:px-4 pt-[calc(0.5rem+var(--safe-top))] shrink-0 border-b border-hairline min-h-[3.5rem] lg:min-h-[var(--chrome-top)] gap-1">
        <button
          className="btn btn-ghost btn-sm btn-square lg:hidden"
          onClick={onBack}
          title={t('common.back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-box bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <Users className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-body truncate">{room.title}</p>
              <p className="text-meta text-muted truncate">
                {t('room.memberCount', { count: members.length })} · {t('call.e2ee')}
              </p>
            </div>
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={() => setSearchOpen((v) => !v)}
          title={t('chat.searchMessages')}
          aria-label={t('chat.searchMessages')}
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={() => setShowMembers((v) => !v)}
          title={t('room.members')}
        >
          <Users className="w-4 h-4" />
        </button>
        {/* Everything that is not a one-tap action moves behind a menu, the
            way the 1:1 header does it. Leaving used to be a bare button beside
            the member list, which for an owner meant the group could be
            deleted for everybody by one mis-tap with no way back. */}
        <div className="dropdown dropdown-end">
          <button
            tabIndex={0}
            className="btn btn-ghost btn-sm btn-square"
            title={t('room.more')}
            aria-label={t('room.more')}
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {/* Same shell as the 1:1 header's menu, and sized the same way — see
              the comment there for what a fixed width did to these rows. */}
          <ul
            tabIndex={0}
            className="dropdown-content menu z-30 mt-1 w-max max-w-[calc(100vw-1rem)] rounded-box border border-hairline bg-base-100 p-2 shadow-overlay"
          >
            <li>
              <details>
                <summary>
                  <Timer
                    className={`w-4 h-4 ${timer?.ttlSeconds != null ? 'text-primary' : ''}`}
                  />
                  {t('chat.disappearing')}
                  <span className="ml-auto text-meta text-subtle">
                    {formatTtl(timer?.ttlSeconds ?? null)}
                  </span>
                </summary>
                <ul>
                  {TTL_OPTIONS.map((seconds) => (
                    <li key={String(seconds)}>
                      <button
                        className={(timer?.ttlSeconds ?? null) === seconds ? 'active' : ''}
                        onClick={() => {
                          closeMenu();
                          void setTimer(seconds);
                        }}
                      >
                        {formatTtl(seconds)}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  setBackgroundOpen(true);
                }}
              >
                <ImageIcon className="w-4 h-4" />
                {t('chat.background')}
              </button>
            </li>
            <li>
              <details>
                <summary>
                  <BellRing className={`w-4 h-4 ${alertLevel ? 'text-primary' : ''}`} />
                  {t('alerts.title')}
                  <span className="ml-auto text-meta text-subtle">
                    {t(
                      alertLevel === 'quiet'
                        ? 'alerts.quiet'
                        : alertLevel === 'urgent'
                          ? 'alerts.urgent'
                          : 'alerts.default'
                    )}
                  </span>
                </summary>
                <ul>
                  {([null, 'quiet', 'urgent'] as const).map((level) => (
                    <li key={level ?? 'default'}>
                      <button
                        className={alertLevel === level ? 'active' : ''}
                        onClick={() => {
                          closeMenu();
                          void changeAlertLevel(level);
                        }}
                      >
                        {t(
                          level === 'quiet'
                            ? 'alerts.quiet'
                            : level === 'urgent'
                              ? 'alerts.urgent'
                              : 'alerts.default'
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  void runExport();
                }}
              >
                <FileDown className="w-4 h-4" />
                {t('chat.export')}
              </button>
            </li>
            <li>
              <button
                className="text-error"
                onClick={() => {
                  closeMenu();
                  setConfirmLeave(true);
                }}
              >
                {isOwner ? <Trash2 className="w-4 h-4" /> : <LogOut className="w-4 h-4" />}
                {isOwner ? t('room.delete') : t('room.leave')}
              </button>
            </li>
          </ul>
        </div>
      </header>

      {pinned && (
        <PinnedBanner
          snippet={pinnedSnippet}
          by={pinned.pinnedBy === me ? t('common.you') : nameFor(pinned.pinnedBy)}
          busy={pinBusy}
          onJump={() => void jumpToMessage(pinned.messageId, pinned.pinnedAt)}
          onUnpin={() => void togglePin(pinned.messageId)}
        />
      )}

      {searchOpen && (
        <ConversationSearch
          key={room.id}
          peerId={room.id}
          me={me}
          peerLabel={room.title}
          senderName={nameFor}
          loadingHistory={history.running}
          historyRevision={history.fetched}
          onJump={(messageId, createdAt) => {
            setSearchOpen(false);
            void jumpToMessage(messageId, createdAt);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {backgroundOpen && (
        <ChatBackgroundModal
          url={background.url}
          busy={background.busy}
          onPick={background.setBackground}
          onRemove={background.removeBackground}
          onClose={() => setBackgroundOpen(false)}
        />
      )}

      {confirmLeave && (
        <Modal
          title={isOwner ? t('room.confirmDeleteTitle') : t('room.confirmLeaveTitle')}
          onClose={() => setConfirmLeave(false)}
        >
          <p className="text-body text-muted">
            {isOwner
              ? t('room.confirmDeleteBody', { name: room.title })
              : t('room.confirmLeaveBody', { name: room.title })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmLeave(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-error btn-sm"
              onClick={() => {
                setConfirmLeave(false);
                void handleLeave();
              }}
            >
              {isOwner ? t('room.delete') : t('room.leave')}
            </button>
          </div>
        </Modal>
      )}

      {showingReactions && (
        <ReactionSheet
          reactions={reactions.byMessage.get(showingReactions) ?? []}
          me={me}
          nameFor={nameFor}
          onClose={() => setShowingReactions(null)}
        />
      )}

      {forwardingMany && (
        <ForwardModal
          me={me}
          // Oldest first, so they arrive in the order the group had them.
          sources={[...forwardingMany]
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map(roomSource)}
          preview={t('selection.count', { count: forwardingMany.length })}
          fromKey={room.id}
          identity={identity}
          onClose={() => {
            setForwardingMany(null);
            setSelectedIds(null);
          }}
        />
      )}

      {forwarding && (
        <ForwardModal
          me={me}
          sources={[roomSource(forwarding)]}
          preview={messageSnippet(roomAsMessage(forwarding, room.id))}
          fromKey={room.id}
          identity={identity}
          onClose={() => setForwarding(null)}
        />
      )}

      {showMembers && (
        <div className="bg-base-100 border-b border-hairline px-4 py-3 shrink-0">
          <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
            {members.map((m) => (
              <li
                key={m.user_id}
                className={`flex items-center gap-1 text-meta font-medium ${roomColour(m.colour_index)}`}
              >
                {nameFor(m.user_id)}
                {isOwner && m.user_id !== me && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-circle text-subtle hover:text-error"
                    onClick={() => void handleRemove(m.user_id)}
                    disabled={removing !== null}
                    title={`Remove ${nameFor(m.user_id)} from this room`}
                    aria-label={`Remove ${nameFor(m.user_id)} from this room`}
                  >
                    {removing === m.user_id ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <UserMinus className="w-3 h-3" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {isOwner && (
            <p className="text-micro text-muted mt-2">{t('room.removeNote')}</p>
          )}
        </div>
      )}

      {keyMissing && (
        <div className="alert alert-error rounded-none text-body">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{t('room.noKey')}</span>
        </div>
      )}

      {/* The group's pictures, so the viewer opened from any one of them can
          step to the next without closing (`lib/gallery.ts`). Over what is
          drawn, not over everything held: a message inside its delete-undo
          window is not on screen and must not be a stop in the viewer. */}
      <GalleryProvider messages={shownMessages}>
        <MessageThread
          me={me}
          // Not the group's own name: this is what the typing line and the
          // default empty state would say, and a room supplies both itself.
          peerLabel={room.title}
          nameFor={nameFor}
          // The whole reason a group bubble carries a header: a message that
          // does not say who wrote it is worse than one in a box.
          showSenderNames
          colourFor={colourFor}
          handles={handles}
          myHandle={myHandle}
          emptyState={
            <>
              <span className="w-16 h-16 rounded-box bg-base-content/5 flex items-center justify-center mb-3 mx-auto">
                <Lock className="w-7 h-7 text-muted" />
              </span>
              <p className="text-body font-medium text-muted">{t('room.emptyTitle')}</p>
              <p className="text-meta text-muted mt-1 max-w-xs">{t('room.emptyBody')}</p>
            </>
          }
          isSelf={false}
          messages={shownMessages}
          queued={NO_PENDING}
          typingLabel={
            typingNames.length === 0
              ? null
              : typingNames.length === 1
                ? t('thread.typing', { name: typingNames[0] })
                : t('room.typingMany', { names: typingNames.join(', ') })
          }
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          // Every member keeps their own watermark, so a single tick meaning
          // "the server has this row" is the most a group bubble can honestly
          // claim — which is what `statusFor` returns for a null receipt.
          peerReceipt={null}
          unreadDividerId={unreadDividerId}
          reactions={reactions.byMessage}
          replyTargets={replyTargets}
          scroll={scroll}
          backgroundUrl={background.url}
          timerChange={timerChange}
          editingId={editingId}
          editingText={editingText}
          isAlreadySeen={(id) => seenIds.current.has(id)}
          onLoadOlder={() => void loadOlder()}
          onToggleReaction={(messageId, emoji) => void reactions.toggle(messageId, emoji)}
          onReply={(msg) => setReplyingTo(byId.get(msg.id) ?? null)}
          onForward={(msg) => setForwarding(byId.get(msg.id) ?? null)}
          onShowReactions={(msg) => setShowingReactions(msg.id)}
          onJumpToReplied={(target) => scroll.scrollToMessage(target.id)}
          selecting={selectedIds !== null}
          selectedIds={selectedIds ?? EMPTY_SELECTION}
          onStartSelecting={(msg) => setSelectedIds(new Set([msg.id]))}
          onToggleSelected={(msg) =>
            setSelectedIds((current) => toggleSelected(current ?? new Set(), msg.id))
          }
          pinnedId={pinned?.messageId ?? null}
          onTogglePin={(msg) => void togglePin(msg.id)}
          onEditingTextChange={setEditingText}
          onSaveEdit={(id) => void saveEdit(id)}
          onCancelEdit={cancelEdit}
          onStartEdit={(msg) => {
            const row = byId.get(msg.id);
            if (row) startEdit(row);
          }}
          onDelete={(msg) => {
            const row = byId.get(msg.id);
            if (row) requestDelete(row);
          }}
          // A group has no outbox, so nothing ever reaches these.
          onRetryQueued={() => {}}
          onDiscardQueued={() => {}}
        />
      </GalleryProvider>

      {/* While messages are being picked out the bar stands in for the
          composer, the same way it does in a 1:1 thread. */}
      {selectedIds !== null ? (
        <div className="flex items-center gap-2 border-t border-hairline bg-base-100 p-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:p-4 sm:pb-[calc(1rem+var(--safe-bottom))]">
          <button className="btn btn-ghost btn-sm" onClick={() => setSelectedIds(null)}>
            {t('selection.cancel')}
          </button>
          <span className="flex-1 truncate text-body font-medium">
            {t('selection.count', { count: powers.count })}
          </span>
          <button
            className="btn btn-ghost btn-sm btn-square"
            disabled={!powers.canForward}
            onClick={() => setForwardingMany(picked)}
            title={powers.canForward ? t('message.forward') : t('selection.mixedForward')}
            aria-label={t('message.forward')}
          >
            <CornerUpRight className="h-4 w-4" />
          </button>
          {/* Hidden rather than greyed, same as the 1:1 bar: see the note
              there. */}
          {powers.canDelete && (
            <button
              className="btn btn-ghost btn-sm btn-square text-error"
              onClick={deleteSelected}
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
      <>
      {/* The same composer the 1:1 thread uses, not a second one: attaching,
          recording and the sticker drawer are behaviour a room must not have
          its own slightly different copy of. */}
      <Composer
        ref={composerRef}
        value={draft.value}
        // While an edit is open the composer shows its edit bar instead of the
        // input — the text is being typed up in the bubble. See `Composer`.
        onChange={(v) => {
          draft.setValue(v);
          notifyTyping();
        }}
        onSend={() => void send()}
        onStageFile={media.stage}
        staged={media.staged}
        onUnstage={media.unstage}
        onClearStaged={media.clearStaged}
        sentCount={media.sentCount}
        sending={sending}
        uploading={media.uploading || keyMissing}
        replyingTo={
          replyingTo
            ? {
                display_name: nameFor(replyingTo.sender_id),
                snippet: messageSnippet(roomAsMessage(replyingTo, room.id)),
              }
            : null
        }
        onCancelReply={() => setReplyingTo(null)}
        editing={
          editingId
            ? {
                canSave:
                  !!editingText.trim() ||
                  isBodyOptional({ media_path: byId.get(editingId)?.media_path ?? null }),
                saving: savingEdit,
                onSave: () => void saveEdit(editingId),
                onCancel: cancelEdit,
              }
            : null
        }
        onError={toast.error}
        stickers={
          <StickerPicker
            drawer={stickers}
            onSelect={(sticker) => {
              void media.sendSticker(sticker, replyingTo?.id ?? null);
              setReplyingTo(null);
            }}
            onError={toast.error}
          />
        }
      />
      </>
      )}
    </div>
  );
}
