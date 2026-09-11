import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Profile, Friendship, Message, ConversationSummary } from '../lib/types';
import { isSelfChat, sortConversations } from '../lib/conversation';
import { formatDisplayName, nicknameFor } from '../lib/nicknames';
import { Avatar } from './Avatar';
import { ConversationRow } from './ConversationRow';
import { ConnectModal } from './ConnectModal';
import { FirstRunInvite } from './FirstRunInvite';
import { RoomList } from './RoomList';
import { useGlobalSearch, type SearchTarget } from '../hooks/useGlobalSearch';
import { useShortcut } from '../hooks/useShortcut';
import { stepChat } from '../lib/shortcuts';
import { advanceRead, fetchUnreadCounts } from '../lib/receipts';
import { useConversationPreviews } from '../hooks/useConversationPreviews';
import { useThreadPrefetch } from '../hooks/useThreadPrefetch';
import { useConnection, reportChannelStatus, forgetChannel } from '../lib/connection';
import {
  Archive,
  ArchiveRestore,
  BellOff,
  Bell,
  ChevronDown,
  ChevronRight,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  Trash2,
  UserPlus,
  Check,
  X,
  Users,
} from 'lucide-react';
import {
  isMuted,
  isUnreadMarked,
  loadChatFlags,
  partitionArchived,
  setArchived,
  setDismissed,
  setMuted,
  setPinned,
  setUnreadMark,
  sortByFlags,
  subscribeChatFlags,
  visibleRequests,
  type ChatFlags,
} from '../lib/chat-flags';
import { cachedConversationList, putConversationList } from '../lib/localdb';
import { draftsVersion, subscribeDrafts } from '../lib/drafts';
import { removeContact } from '../lib/remove-contact';
import { syncMutedIds } from '../lib/mute';
import { syncAlertLevels } from '../lib/alerts';
import { SwipeRow } from './SwipeRow';
import { Modal } from './Modal';
import type { Identity } from '../lib/crypto/keys';
import type { RoomSummary } from '../lib/rooms';
import { useT } from '../hooks/useT';
import { useToast } from '../hooks/useToast';

/** Conversation-list refresh cadence while realtime is healthy — a backstop for
 *  the one failure realtime cannot report about itself, not a delivery
 *  mechanism. Two RPCs a tick, and `live` plus the wake generation already
 *  cover everything else, so it is deliberately slow. */
const LIST_POLL_HEALTHY_MS = 150_000;
/** …and once realtime is known to be down, when it's the only thing keeping
 *  previews, ordering and unread badges moving. */
const LIST_POLL_DEGRADED_MS = 12_000;
/** Window a burst of message events is folded into before the list is re-read.
 *  Short enough to read as immediate, long enough to catch the second binding
 *  a self-note fires and the tail of a multi-photo send. */
const LIST_REFRESH_COALESCE_MS = 400;

interface FriendsListProps {
  session: Session;
  /** Needed only by the connect dialog, which puts this device's public key
   *  into the QR so scanning it verifies the contact on the spot. */
  identity: Identity;
  selectedFriendId: string | null;
  onSelectFriend: (friend: Profile) => void;
  /** Reports the accepted-friend set upward, so presence can scope its
   *  channels to exactly these people. */
  onFriendsChange?: (friendIds: string[]) => void;
  /** Reports the summed unread count upward whenever the unread map changes,
   *  so the app-level badge can mirror it without owning the map itself. */
  onUnreadTotalChange?: (total: number) => void;
  /** Rooms live beside conversations in this list but open a different pane,
   *  so the selection is owned by App and reported back down. */
  selectedRoomId: string | null;
  onSelectRoom: (room: RoomSummary) => void;
  /**
   * Open a conversation at one particular message.
   *
   * One callback carrying both halves rather than a selection followed by a
   * jump: the two arrive in the same act, and split across two calls the
   * selection's own handler clears the jump before the jump is made.
   *
   * The chat itself rather than its id, because this list is where both are
   * already loaded — App has the selection, not the roster behind it.
   */
  onOpenSearchHit?: (
    chat: { kind: 'peer'; friend: Profile } | { kind: 'room'; room: RoomSummary },
    at: { messageId: string; createdAt: string }
  ) => void;
}

export function FriendsList({
  session,
  identity,
  selectedFriendId,
  onSelectFriend,
  onFriendsChange,
  onUnreadTotalChange,
  selectedRoomId,
  onSelectRoom,
  onOpenSearchHit,
}: FriendsListProps) {
  const t = useT();
  const toast = useToast();
  const me = session.user.id;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Friendship[]>([]);
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [connectTab, setConnectTab] = useState<'show' | 'scan' | null>(null);
  /** Room count as last reported by RoomList, null until its first successful
   *  load. Both this and `loaded` gate the first-run card: painted off the
   *  initial empty state instead, it would flash on every cold start for
   *  accounts that have plenty of contacts. */
  const [roomCount, setRoomCount] = useState<number | null>(null);
  /** The groups as RoomList last read them, kept only so a search hit in one
   *  can be shown under its title rather than under a uuid. */
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** This device's pins, mutes and dismissals — see `lib/chat-flags.ts`. */
  const [flags, setFlags] = useState<Map<string, ChatFlags>>(new Map());
  // Drafts live in memory, not in state, so the rows that read them need
  // telling when one appears or goes. Subscribed here rather than per row:
  // one store, one subscription, and the rows read it during render.
  useSyncExternalStore(subscribeDrafts, draftsVersion, draftsVersion);
  /** Which row's action rail is open. One at a time: two rails open at once is
   *  a list with two rows in a state the user did not put them both in. */
  const [openRail, setOpenRail] = useState<string | null>(null);
  /** Whether the archive shelf is open. Session state on purpose: the shelf is
   *  meant to be out of the way, so it closes again next time. */
  const [showArchived, setShowArchived] = useState(false);
  /** The contact a delete is being confirmed for. */
  const [confirmRemove, setConfirmRemove] = useState<ConversationSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  /** Owned here rather than in RoomList, which is not on screen at all in the
   *  state where the first-run card offers to create the first room. */
  const [creatingRoom, setCreatingRoom] = useState(false);
  const { generation, live } = useConnection();

  // Live refs so the realtime handler always sees current friends and
  // selection. Assigned during render rather than in an effect, so they are
  // never one render stale whatever the effects below are gated on.
  const friendsRef = useRef<ConversationSummary[]>([]);
  friendsRef.current = conversations;
  const selectedRef = useRef<string | null>(selectedFriendId);
  selectedRef.current = selectedFriendId;

  // Both fetchers are declared above every effect that depends on them: a
  // dependency array is evaluated during render, so a `const` defined further
  // down the body would be read in its temporal dead zone. Each depends only
  // on `me`, which cannot change for a mounted list, so their identities are
  // stable and no effect below re-runs for them.
  const fetchConversations = useCallback(async () => {
    const { data, error } = await supabase.rpc('conversation_list');
    // A read that failed is not a list that is empty. `data ?? []` here turns
    // one transient RPC error into an empty sidebar, missing even the vault
    // the RPC always returns, with nothing to refetch it but an app restart.
    if (error) return;
    // Ordering lives in lib/conversation.ts so it can be tested without a
    // component.
    const rows = sortConversations((data ?? []) as ConversationSummary[], me);
    setConversations(rows);
    setLoaded(true);
    // Sorted, so the cached copy is the list in the order it was shown in and
    // the offline paint does not reshuffle itself when the RPC lands.
    void putConversationList(rows);
  }, [me]);

  /**
   * Paint the sidebar from the last list this device saw.
   *
   * The RPC is one round trip and there is nothing on screen until it lands —
   * no names, no ordering, not even the self-chat it always returns. That is a
   * blank app for the length of a slow round trip, and a permanently blank app
   * with no network at all, on a device whose mirror holds the conversations.
   *
   * `setLoaded` is deliberately not set here. It is what tells the list the
   * server has answered, and the empty-state and first-run cards are written
   * for that answer, not for a guess off disk.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const cached = await cachedConversationList();
      // Only if the RPC has not already answered: it is authoritative, and a
      // slow disk read must never repaint a fresher list with an older one.
      if (alive && cached.length > 0) {
        setConversations((prev) => (prev.length > 0 ? prev : sortConversations(cached, me)));
      }
    })();
    return () => {
      alive = false;
    };
  }, [me]);

  const refreshFlags = useCallback(async () => {
    const next = await loadChatFlags();
    setFlags(next);
    // The notification extension reads its own copy, because a push arrives
    // when no JavaScript of ours is running. See `lib/mute.ts`.
    void syncMutedIds(me, next);
    // Beside the mute list, and for the same reason — see `lib/alerts.ts`.
    void syncAlertLevels(me, next);
  }, [me]);

  useEffect(() => {
    void refreshFlags();
    // Also whenever anything writes a flag — including the settings screens,
    // which are mounted beside this list rather than inside it. Unhiding
    // somebody there has to put their request back in the strip below without
    // waiting for a restart.
    return subscribeChatFlags(() => void refreshFlags());
  }, [refreshFlags]);

  // Previews come from the local mirror, since 0023 took the body away from the
  // server — and from a one-row fetch for whatever the mirror has never opened.
  // See `useConversationPreviews`.
  const previews = useConversationPreviews(me, identity, conversations);

  // …and the newest page of the few most likely to be opened, so the first tap
  // after a cold start paints from disk like every one after it. See
  // `hooks/useThreadPrefetch.ts` for the three gates that keep it cheap.
  useThreadPrefetch(me, identity, conversations);

  /**
   * Coalesce a burst of realtime events into one list refresh.
   *
   * Four bindings watch `messages` below, and a note to yourself matches two of
   * them at once (`user_id` and `receiver_id` are both you), so a single row
   * used to cost two `conversation_list` calls. A burst — someone sending three
   * messages, or a batch of photos going out — cost one per row. The list only
   * ever paints the newest of them.
   *
   * Trailing rather than leading: the row that matters is the last one in the
   * burst, and the badge beside it is updated optimistically anyway.
   */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleConversationRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void fetchConversations();
    }, LIST_REFRESH_COALESCE_MS);
  }, [fetchConversations]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    []
  );

  const fetchPendingRequests = useCallback(async () => {
    const { data } = await supabase
      .from('friendships')
      .select('*')
      .eq('addressee_id', me)
      .eq('status', 'pending');

    if (!data || data.length === 0) {
      setPendingRequests([]);
      return;
    }

    const requesterIds = data.map((f) => f.requester_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .in('id', requesterIds);

    setPendingRequests(
      data.map((f) => ({ ...f, profiles: profiles?.find((p) => p.id === f.requester_id) }))
    );
  }, [me]);

  // `generation` for the same reason the channels below take it: after a wake,
  // or the resume following a deep link, a fetch in flight over a dead socket
  // never lands, and re-subscribing re-reads nothing. This is the retry that
  // makes a failed first load temporary rather than permanent.
  useEffect(() => {
    void fetchConversations();
    void fetchPendingRequests();
  }, [generation, fetchConversations, fetchPendingRequests]);

  // Live friendship updates: requests, accepts, declines and removals. RLS
  // scopes the stream to rows naming this user, so every event is relevant and
  // both views refetch. `generation` is a dep here and on the messages channel
  // below, because after a wake the old channels are joined to a socket that
  // no longer exists and nothing rejoins them on its own.
  useEffect(() => {
    const channel = supabase
      .channel(`friendships:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        void fetchConversations();
        void fetchPendingRequests();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [me, generation, fetchConversations, fetchPendingRequests]);

  // The self-chat row is not a friend: presence would otherwise open a channel
  // to watch this user's own devices, and report them back as a peer.
  useEffect(() => {
    onFriendsChange?.(
      conversations.map((c) => c.peer_id).filter((id) => !isSelfChat(me, id))
    );
  }, [conversations, onFriendsChange, me]);

  useEffect(() => {
    let total = 0;
    // Muted conversations are left out of the icon badge: a number on the app
    // icon is the loudest surface there is, and a chat you silenced should not
    // be the reason it is lit. The row keeps its own count.
    for (const [peerId, count] of unread) {
      if (!isMuted(peerId, flags)) total += count;
    }
    onUnreadTotalChange?.(total);
  }, [unread, flags, onUnreadTotalChange]);

  // The Profile handed upward on click is a snapshot of that render's row, and
  // nothing re-syncs it while the chat stays open. `last_seen_at` changes
  // continuously, so without this the chat header reports the friend's
  // last-seen time as of when the chat was opened. Nothing is refetched; the
  // row this list already keeps current is re-reported. Keyed on the values
  // rather than the row object, which is new on every refetch.
  const selectedRow = conversations.find((c) => c.peer_id === selectedFriendId);
  const selectedUsername = selectedRow?.display_name;
  const selectedAvatar = selectedRow?.avatar_url;
  const selectedLastSeen = selectedRow?.last_seen_at;
  const onSelectFriendRef = useRef(onSelectFriend);
  onSelectFriendRef.current = onSelectFriend;
  useEffect(() => {
    if (!selectedFriendId || selectedUsername === undefined) return;
    onSelectFriendRef.current({
      id: selectedFriendId,
      display_name: selectedUsername,
      avatar_url: selectedAvatar ?? null,
      last_seen_at: selectedLastSeen ?? null,
    });
  }, [selectedFriendId, selectedUsername, selectedAvatar, selectedLastSeen]);

  // Stable primitive dep. `conversations` gets a new array identity on every
  // refetch, but a full unread recount only means anything when the *set of
  // peers* changes. Keying on the array made every inbound message cost two
  // round trips: the optimistic increment below, clobbered by this effect
  // re-running off the refetch it triggered. Same pattern as usePresence.
  const peerKey = useMemo(
    () => conversations.map((c) => c.peer_id).sort().join(','),
    [conversations]
  );

  // Recompute unread counts whenever the friend set changes.
  useEffect(() => {
    if (conversations.length === 0) {
      setUnread(new Map());
      return;
    }
    let cancelled = false;
    fetchUnreadCounts().then((counts) => {
      // A refetch that started while this one was in flight has published
      // fresher counts already; this snapshot must not overwrite them.
      if (cancelled) return;
      // The open conversation is read by definition, and its watermark may
      // still be mid-write, which would resurrect the badge just cleared.
      const open = selectedRef.current;
      if (open) counts.delete(open);
      setUnread(counts);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerKey, me]);

  /** Drop a conversation's badge and persist the marker behind it. */
  const clearUnreadFor = useCallback(
    (friendId: string) => {
      // Your own notes are read by definition: `unread_counts()` excludes them
      // and `no_self_receipt` forbids the watermark row this would write.
      if (isSelfChat(me, friendId)) return;
      setUnread((prev) => {
        if (!prev.has(friendId)) return prev;
        const next = new Map(prev);
        next.delete(friendId);
        return next;
      });
      // Fire-and-forget: the badge is already gone locally, and a failed write
      // only means the count is recomputed on the next load. Anchored to the
      // newest message they actually sent, because the watermark is compared
      // against `created_at` and a local clock is wrong by the device's skew.
      void supabase
        .from('messages')
        .select('created_at')
        .eq('receiver_id', me)
        .eq('user_id', friendId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(
          ({ data }) => {
            if (data?.created_at) void advanceRead(friendId, data.created_at);
          },
          // supabase-js resolves with { error } rather than rejecting, but a
          // transport-level failure can still reject. The builder is a thenable
          // rather than a full Promise, so the handler goes here instead of in
          // a chained `.catch`.
          () => {}
        );
    },
    [me]
  );

  // Clear a conversation's unread badge when it's opened.
  useEffect(() => {
    if (!selectedFriendId) return;
    clearUnreadFor(selectedFriendId);
  }, [selectedFriendId, clearUnreadFor]);

  // Live unread updates: increment on inbound messages unless that chat is
  // open and focused, and refetch either way so the row moves and its preview
  // updates.
  //
  // Four bindings rather than one. `receiver_id=eq.${me}` never fires for our
  // own sends, so a conversation you just messaged would sit frozen on the
  // peer's older preview until they replied. UPDATE is bound in both
  // directions so an edit or soft-delete of the last message refreshes the
  // preview. `fetchConversations` only reads, so none of these refetches can
  // re-trigger the subscription.
  const unreadChannelKey = `friends-unread:${me}`;
  useEffect(() => {
    const channel = supabase
      .channel(unreadChannelKey)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${me}` },
        (payload) => {
          const msg = payload.new as Message;
          if (msg.user_id === me || msg.deleted_at) return;
          if (!friendsRef.current.some((f) => f.peer_id === msg.user_id)) return;

          const lookingAtThisChat =
            selectedRef.current === msg.user_id &&
            document.visibilityState === 'visible' &&
            document.hasFocus();
          if (lookingAtThisChat) {
            // Already server-stamped; use it directly rather than a round trip.
            void advanceRead(msg.user_id, msg.created_at);
          } else {
            setUnread((prev) => {
              const next = new Map(prev);
              next.set(msg.user_id, (next.get(msg.user_id) ?? 0) + 1);
              return next;
            });
          }
          scheduleConversationRefresh();
        }
      )
      // Our own sends never touch unread state, but the row's preview and
      // recency ordering still have to move.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `user_id=eq.${me}` },
        () => {
          scheduleConversationRefresh();
        }
      )
      // An edit or soft-delete of a message we received, if it was the last
      // one in that conversation, must not go on showing old text.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `receiver_id=eq.${me}` },
        () => {
          scheduleConversationRefresh();
        }
      )
      // Same, for a message we sent.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `user_id=eq.${me}` },
        () => {
          scheduleConversationRefresh();
        }
      )
      // This channel exists for the whole signed-in session, chat open or not,
      // so its health is the app-wide answer to "is realtime delivering?".
      .subscribe((status) => reportChannelStatus(unreadChannelKey, status));

    return () => {
      supabase.removeChannel(channel);
      forgetChannel(unreadChannelKey);
    };
  }, [me, generation, unreadChannelKey, scheduleConversationRefresh]);

  /** Recompute every conversation's unread badge from the server. */
  const refreshUnread = useCallback(async () => {
    const counts = await fetchUnreadCounts();
    // The open conversation is read by definition; its watermark write may
    // still be in flight, which would otherwise resurrect a cleared badge.
    const open = selectedRef.current;
    if (open) counts.delete(open);
    setUnread(counts);
  }, []);

  // Wake-up: pull the list, the requests and the badges. Everything realtime
  // would have delivered while the machine was asleep arrives here instead.
  useEffect(() => {
    if (generation === 0) return;
    void fetchConversations();
    void fetchPendingRequests();
    void refreshUnread();
  }, [generation, refreshUnread, fetchConversations, fetchPendingRequests]);

  // Same two-speed poll as the open conversation: the only delivery mechanism
  // when realtime is blocked, a cheap backstop when it isn't.
  useEffect(() => {
    const period = live ? LIST_POLL_HEALTHY_MS : LIST_POLL_DEGRADED_MS;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchConversations();
      void refreshUnread();
    }, period);
    return () => window.clearInterval(id);
  }, [live, refreshUnread, fetchConversations]);

  // Returning to the open chat (refocus/unhide) also clears its badge.
  useEffect(() => {
    const clearActive = () => {
      const id = selectedRef.current;
      if (!id) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      clearUnreadFor(id);
    };
    window.addEventListener('focus', clearActive);
    document.addEventListener('visibilitychange', clearActive);
    return () => {
      window.removeEventListener('focus', clearActive);
      document.removeEventListener('visibilitychange', clearActive);
    };
  }, [clearUnreadFor]);

  /** Pinned first, then whatever order `sortConversations` decided. */
  const ordered = useMemo(
    () =>
      sortByFlags(
        conversations.map((c) => ({ ...c, id: c.peer_id, lastAt: c.last_at })),
        flags
      ),
    [conversations, flags]
  );

  /** The everyday list and the shelf. Archiving does not stop a conversation
   *  or silence it; it takes it out of the list you read every day. */
  const { active: activeRows, archived: archivedRows } = useMemo(
    () => partitionArchived(ordered, flags),
    [ordered, flags]
  );

  /** Requests from people this device removed are not shown: removal stops
   *  them messaging, but nothing stops them asking again. */
  const shownRequests = useMemo(
    () => visibleRequests(pendingRequests, flags),
    [pendingRequests, flags]
  );

  /** Whether any conversation is with someone other than yourself. */
  const hasFriendRows = conversations.some((c) => !isSelfChat(me, c.peer_id));
  /** Nothing on this pane but the self-chat — where a new sign-up lands, and
   *  the only state worth spending a whole card on. */
  const firstRun = loaded && roomCount === 0 && !hasFriendRows;
  /** Section labels are structure; with one row under each of them they are
   *  louder than the content they label. */
  const showSections = hasFriendRows || (roomCount ?? 0) > 0;

  /** Every conversation a hit could be in, under the name this list shows it
   *  by — the nickname where there is one, exactly as the row above would. */
  const searchTargets = useMemo(() => {
    const map = new Map<string, SearchTarget>();
    for (const c of conversations) {
      const self = isSelfChat(me, c.peer_id);
      map.set(c.peer_id, {
        id: c.peer_id,
        name: formatDisplayName(nicknameFor(c.peer_id), c.display_name, self),
        avatarUrl: c.avatar_url,
        isRoom: false,
      });
    }
    for (const room of rooms) {
      map.set(room.id, { id: room.id, name: room.title, avatarUrl: null, isRoom: true });
    }
    return map;
  }, [conversations, rooms, me]);

  const search = useGlobalSearch({
    me,
    targets: searchTargets,
    onOpen: (target, messageId, createdAt) => {
      const at = { messageId, createdAt };
      if (target.isRoom) {
        const room = rooms.find((r) => r.id === target.id);
        if (room) onOpenSearchHit?.({ kind: 'room', room }, at);
        return;
      }
      const conversation = conversations.find((c) => c.peer_id === target.id);
      if (!conversation) return;
      onOpenSearchHit?.(
        {
          kind: 'peer',
          friend: {
            id: conversation.peer_id,
            display_name: conversation.display_name,
            avatar_url: conversation.avatar_url,
            last_seen_at: conversation.last_seen_at,
          },
        },
        at
      );
    },
  });

  /**
   * The desktop keyboard shortcuts this list can answer.
   *
   * Moving between conversations walks the everyday list only — the shelf is
   * deliberately out of the way, and arrowing into it would be a surprise. A
   * group is not in this list at all, so `Alt+↑/↓` from an open group starts
   * from the end rather than from nowhere: `stepChat` treats an id it cannot
   * find as nothing selected.
   */
  useShortcut((shortcut) => {
    if (shortcut === 'search-all') {
      search.focus();
      return true;
    }
    if (shortcut === 'previous-chat' || shortcut === 'next-chat') {
      const next = stepChat(
        activeRows.map((row) => row.peer_id),
        selectedFriendId,
        shortcut === 'next-chat' ? 1 : -1
      );
      const conversation = next && activeRows.find((row) => row.peer_id === next);
      if (!conversation) return true;
      onSelectFriend({
        id: conversation.peer_id,
        display_name: conversation.display_name,
        avatar_url: conversation.avatar_url,
        last_seen_at: conversation.last_seen_at,
      });
      return true;
    }
    if (shortcut === 'archive-chat') {
      // Your own notes are never archived: the row is where a new account
      // lands and there is nothing to take it off the shelf with.
      if (!selectedFriendId || isSelfChat(me, selectedFriendId)) return false;
      const archived = flags.get(selectedFriendId)?.archivedAt != null;
      void setArchived(selectedFriendId, 'peer', !archived);
      return true;
    }
    return false;
  });

  /** The three actions behind a row. Your own notes are not a contact, so they
   *  get the two that mean something and not the one that does not. */
  function rowActions(
    conversation: ConversationSummary,
    self: boolean,
    pinned: boolean,
    muted: boolean,
    archived: boolean,
    unread: boolean
  ) {
    const id = conversation.peer_id;
    const actions = [
      {
        key: 'pin',
        label: pinned ? t('chatList.unpin') : t('chatList.pin'),
        icon: pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />,
        onClick: () => {
          void setPinned(id, 'peer', !pinned);
        },
      },
      // Marking read and marking unread are the same control: whichever the
      // row is not. Two separate entries would leave one of them a no-op on
      // every row it appeared on.
      {
        key: 'unread',
        label: unread ? t('chatList.markRead') : t('chatList.markUnread'),
        icon: unread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />,
        onClick: () => {
          if (unread) {
            void setUnreadMark(id, 'peer', false);
            clearUnreadFor(id);
          } else {
            void setUnreadMark(id, 'peer', true);
          }
        },
      },
    ];
    if (self) return actions;
    return [
      ...actions,
      {
        key: 'mute',
        label: muted ? t('chatList.unmute') : t('chatList.mute'),
        icon: muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />,
        onClick: () => {
          void setMuted(id, 'peer', !muted);
        },
      },
      {
        key: 'archive',
        label: archived ? t('chatList.unarchive') : t('chatList.archive'),
        icon: archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />,
        onClick: () => {
          void setArchived(id, 'peer', !archived);
        },
      },
      {
        key: 'delete',
        label: t('common.delete'),
        icon: <Trash2 className="w-4 h-4" />,
        destructive: true,
        onClick: () => setConfirmRemove(conversation),
      },
    ];
  }

  /** One row, used by both the everyday list and the archive shelf — the same
   *  row in two places rather than two copies that drift. */
  function renderRow(conversation: ConversationSummary) {
    const peerId = conversation.peer_id;
    const self = isSelfChat(me, peerId);
    const pinned = flags.get(peerId)?.pinnedAt != null;
    const muted = isMuted(peerId, flags);
    const archived = flags.get(peerId)?.archivedAt != null;
    const counted = unread.get(peerId) ?? 0;
    const marked = isUnreadMarked(peerId, flags, conversation.last_at);
    return (
      <li key={peerId} className="group/row">
        <SwipeRow
          open={openRail === peerId}
          onOpenChange={(open) => setOpenRail(open ? peerId : null)}
          actions={rowActions(conversation, self, pinned, muted, archived, counted > 0 || marked)}
        >
          <ConversationRow
            conversation={conversation}
            me={me}
            // A hand-placed mark has no number behind it, so it shows as a dot
            // rather than inventing a count the server never gave.
            unread={counted}
            markedUnread={marked && counted === 0}
            lastText={previews.get(peerId) ?? null}
            selected={selectedFriendId === peerId}
            pinned={pinned}
            muted={muted}
            onSelect={() => {
              // A rail left open behind a chat is a state the user cannot see
              // and will not expect on the way back.
              setOpenRail(null);
              // Opening a conversation is reading it, so a mark placed by hand
              // has served its purpose and goes.
              if (marked) void setUnreadMark(peerId, 'peer', false);
              onSelectFriend({
                id: peerId,
                display_name: conversation.display_name,
                avatar_url: conversation.avatar_url,
                last_seen_at: conversation.last_seen_at,
              });
            }}
          />
        </SwipeRow>
      </li>
    );
  }

  async function confirmRemoveContact() {
    const target = confirmRemove;
    if (!target || removing) return;
    setRemoving(true);
    const error = await removeContact(me, target.peer_id);
    setRemoving(false);
    if (error) return;
    setConfirmRemove(null);
    // The row goes when the list is re-read; the flags carry the dismissal
    // that keeps them out of the requests strip, and `setDismissed` announces
    // it — see the subscription above.
    void fetchConversations();
    void fetchPendingRequests();
  }

  async function acceptRequest(friendshipId: string) {
    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    void fetchConversations();
    void fetchPendingRequests();
  }

  async function declineRequest(friendshipId: string, requesterId: string | undefined) {
    await supabase.from('friendships').delete().eq('id', friendshipId);
    // Declining hides them too. `friendships_insert_own` only checks that the
    // requester is themself, so without this a declined request can be sent
    // again immediately, and again after that.
    //
    // Said out loud, because the hiding is the part nobody would guess. A tap
    // meant for Accept used to silently swallow every request that person sent
    // afterwards, with the way back buried in a settings page the user had no
    // reason to look at.
    if (requesterId) await setDismissed(requesterId, true).catch(() => {});
    toast.success(t('requests.declinedHidden'));
    void fetchPendingRequests();
  }

  return (
    <div className="flex flex-col h-full bg-base-100">
      {/* Header. It carries the notch inset itself: on a phone this list is the
          top of the screen — the shared top bar is desktop-only — while on
          desktop that bar is above it and already paid for the inset.
          Past `lg` it also stands in the `--chrome-top` band, so the rule under
          it meets the conversation header's rule rather than sitting below it. */}
      <div className="px-4 pb-3 pt-[calc(1rem+var(--safe-top))] lg:flex lg:flex-col lg:justify-center lg:min-h-[var(--chrome-top)] lg:py-2 border-b border-hairline">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-primary hidden lg:block" />
            <h2 className="text-display font-semibold text-base-content">{t('tabs.chats')}</h2>
          </div>
          <button
            className="brand-gradient btn btn-primary btn-circle border-0 shadow-md shadow-primary/20 hover:shadow-primary/30 transition-shadow"
            onClick={() => setConnectTab('show')}
            title={t('chatList.addContact')}
            aria-label={t('chatList.addContact')}
          >
            <UserPlus className="w-5 h-5" />
          </button>
        </div>
        {search.field}
      </div>

      {/* Pending Requests */}
      {shownRequests.length > 0 && (
        <div className="p-3 sm:p-4 border-b border-hairline bg-warning/5">
          <p className="text-micro font-semibold text-warning mb-2.5 uppercase tracking-wider">
            {t('requests.pending', { count: shownRequests.length })}
          </p>
          <div className="space-y-2">
            {shownRequests.map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between p-2 rounded-field bg-base-100 border border-hairline"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Avatar display_name={req.profiles?.display_name} url={req.profiles?.avatar_url} size={28} />
                  <span className="text-body text-base-content truncate">
                    {req.profiles?.display_name ?? t('requests.unknown')}
                  </span>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    className="btn btn-success btn-xs btn-circle"
                    onClick={() => acceptRequest(req.id)}
                    title={t('requests.accept')}
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    className="btn btn-ghost btn-xs btn-circle text-error hover:bg-error/10"
                    onClick={() => declineRequest(req.id, req.requester_id)}
                    title={t('requests.decline')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversation List. A search across every chat stands in for it rather
          than sitting under it: the results are the answer to "which chat",
          and a list of all the others below them is the question again. */}
      <div className="flex-1 overflow-y-auto">
        {search.active ? (
          search.results
        ) : (
        <>
        {firstRun && (
          <FirstRunInvite
            onShowCode={() => setConnectTab('show')}
            onScan={() => setConnectTab('scan')}
            onCreateRoom={() => setCreatingRoom(true)}
          />
        )}

        <RoomList
          me={me}
          identity={identity}
          selectedRoomId={selectedRoomId}
          onSelectRoom={onSelectRoom}
          onCountChange={setRoomCount}
          onRoomsChange={setRooms}
          hideWhenEmpty={firstRun}
          creating={creatingRoom}
          onCreatingChange={setCreatingRoom}
        />

        {showSections && (
          <div className="px-4 sm:px-5 pt-2">
            <p className="text-micro font-semibold uppercase tracking-wider text-subtle">
              {t('chatList.direct')}
            </p>
          </div>
        )}

        {/* No empty state here: `conversation_list` always returns the self-chat,
            so the only genuinely empty render is the one before the first fetch
            lands, and a spinner-shaped hole in a list that paints in a moment is
            worse than the space it fills. */}
        <ul className="motion-stagger p-2 space-y-0.5">{activeRows.map(renderRow)}</ul>

        {/* The shelf, collapsed. Archived conversations are not gone and not
            silenced — they are out of the way — so they get a heading that says
            how many and opens on a tap, rather than a screen of their own that
            somebody has to remember exists. */}
        {archivedRows.length > 0 && (
          <div className="px-2 pb-2">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-field px-2 py-2 text-left hover:bg-wash"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
            >
              {showArchived ? (
                <ChevronDown className="w-4 h-4 text-subtle" />
              ) : (
                <ChevronRight className="w-4 h-4 text-subtle" />
              )}
              <Archive className="w-4 h-4 text-subtle" />
              <span className="text-meta font-medium text-muted">
                {t('chatList.archivedCount', { count: archivedRows.length })}
              </span>
            </button>
            {showArchived && <ul className="space-y-0.5">{archivedRows.map(renderRow)}</ul>}
          </div>
        )}

        {/* Someone who has rooms but no contacts gets no first-run card, and
            their only direct row is the self-chat — still the person who most
            needs to be told how connecting works here. */}
        {loaded && !hasFriendRows && !firstRun && (
          <div className="px-4 pb-4 text-center">
            <button
              className="btn btn-ghost btn-xs font-normal text-muted"
              onClick={() => setConnectTab('show')}
            >
              {t('chatList.showOrScan')}
            </button>
          </div>
        )}
        </>
        )}
      </div>

      {/* Connect Modal */}
      {connectTab && (
        <ConnectModal
          session={session}
          identity={identity}
          initialTab={connectTab}
          onClose={() => setConnectTab(null)}
        />
      )}

      {confirmRemove && (
        <Modal
          title={t('chatList.deleteChatTitle', {
            name: formatDisplayName(
              nicknameFor(confirmRemove.peer_id),
              confirmRemove.display_name
            ),
          })}
          onClose={() => (removing ? undefined : setConfirmRemove(null))}
          actions={
            <>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmRemove(null)}
                disabled={removing}
              >
                {t('chatList.keep')}
              </button>
              <button className="btn btn-error btn-sm" onClick={confirmRemoveContact} disabled={removing}>
                {removing ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  t('common.delete')
                )}
              </button>
            </>
          }
        >
          {/* Says both halves, including the one the app cannot do. A dialog
              that implied their copy went too would be a promise made on
              somebody else's device. */}
          <p className="text-body text-strong">{t('chatList.deleteChatBody')}</p>
        </Modal>
      )}
    </div>
  );
}
