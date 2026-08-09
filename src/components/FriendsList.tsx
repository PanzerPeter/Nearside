import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Profile, Friendship, Message, ConversationSummary } from '../lib/types';
import { isSelfChat, sortConversations } from '../lib/conversation';
import { cachedPreview } from '../lib/localdb';
import { Avatar } from './Avatar';
import { ConversationRow } from './ConversationRow';
import { ConnectModal } from './ConnectModal';
import { RoomList } from './RoomList';
import { advanceRead, fetchUnreadCounts } from '../lib/receipts';
import { useConnection, reportChannelStatus, forgetChannel } from '../lib/connection';
import { UserPlus, Check, X, Users } from 'lucide-react';
import type { Identity } from '../lib/crypto/keys';
import type { RoomSummary } from '../lib/rooms';

/** Conversation-list refresh cadence while realtime is healthy — a cheap
 *  backstop, since the list is one RPC. */
const LIST_POLL_HEALTHY_MS = 60_000;
/** …and once realtime is known to be down, when it's the only thing keeping
 *  previews, ordering and unread badges moving. */
const LIST_POLL_DEGRADED_MS = 12_000;

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
}: FriendsListProps) {
  const me = session.user.id;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /** peer_id → last message text from the local mirror, or null if unseen here. */
  const [previews, setPreviews] = useState<Map<string, string | null>>(new Map());
  const [pendingRequests, setPendingRequests] = useState<Friendship[]>([]);
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [showAddModal, setShowAddModal] = useState(false);
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

    // Previews come from the local mirror, since 0023 took the body away from
    // the server. Resolved after the rows are on screen: a row briefly showing
    // "Encrypted message" beats a sidebar that paints a frame late.
    const resolved = await Promise.all(
      rows.map(async (row) => [row.peer_id, (await cachedPreview(row.peer_id))?.text ?? null] as const)
    );
    setPreviews(new Map(resolved));
  }, [me]);

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
    for (const count of unread.values()) total += count;
    onUnreadTotalChange?.(total);
  }, [unread, onUnreadTotalChange]);

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
          void fetchConversations();
        }
      )
      // Our own sends never touch unread state, but the row's preview and
      // recency ordering still have to move.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `user_id=eq.${me}` },
        () => {
          void fetchConversations();
        }
      )
      // An edit or soft-delete of a message we received, if it was the last
      // one in that conversation, must not go on showing old text.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `receiver_id=eq.${me}` },
        () => {
          void fetchConversations();
        }
      )
      // Same, for a message we sent.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `user_id=eq.${me}` },
        () => {
          void fetchConversations();
        }
      )
      // This channel exists for the whole signed-in session, chat open or not,
      // so its health is the app-wide answer to "is realtime delivering?".
      .subscribe((status) => reportChannelStatus(unreadChannelKey, status));

    return () => {
      supabase.removeChannel(channel);
      forgetChannel(unreadChannelKey);
    };
  }, [me, generation, unreadChannelKey, fetchConversations]);

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

  /** Whether any conversation is with someone other than yourself. */
  const hasFriendRows = conversations.some((c) => !isSelfChat(me, c.peer_id));

  async function acceptRequest(friendshipId: string) {
    await supabase.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    void fetchConversations();
    void fetchPendingRequests();
  }

  async function declineRequest(friendshipId: string) {
    await supabase.from('friendships').delete().eq('id', friendshipId);
    void fetchPendingRequests();
  }

  return (
    <div className="flex flex-col h-full bg-base-100">
      {/* Header. It carries the notch inset itself: on a phone this list is the
          top of the screen — the shared top bar is desktop-only — while on
          desktop that bar is above it and already paid for the inset. */}
      <div className="p-4 pt-[calc(1rem+var(--safe-top))] sm:p-5 sm:pt-[calc(1.25rem+var(--safe-top))] lg:pt-5 border-b border-base-content/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-primary hidden lg:block" />
            <h2 className="font-semibold text-base-content">Chats</h2>
          </div>
          <button
            className="btn btn-primary btn-sm btn-circle shadow-md shadow-primary/20 hover:shadow-primary/30 transition-shadow"
            onClick={() => setShowAddModal(true)}
            title="Connect"
          >
            <UserPlus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Pending Requests */}
      {pendingRequests.length > 0 && (
        <div className="p-3 sm:p-4 border-b border-base-content/5 bg-warning/5">
          <p className="text-xs font-semibold text-warning mb-2.5 uppercase tracking-wider">
            Pending Requests ({pendingRequests.length})
          </p>
          <div className="space-y-2">
            {pendingRequests.map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between p-2 rounded-lg bg-base-100 border border-base-content/5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Avatar display_name={req.profiles?.display_name} url={req.profiles?.avatar_url} size={28} />
                  <span className="text-sm text-base-content truncate">
                    @{req.profiles?.display_name ?? 'unknown'}
                  </span>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    className="btn btn-success btn-xs btn-circle"
                    onClick={() => acceptRequest(req.id)}
                    title="Accept"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    className="btn btn-ghost btn-xs btn-circle text-error hover:bg-error/10"
                    onClick={() => declineRequest(req.id)}
                    title="Decline"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto">
        <RoomList
          me={me}
          identity={identity}
          selectedRoomId={selectedRoomId}
          onSelectRoom={onSelectRoom}
        />

        <div className="px-3 sm:px-4 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">
            Direct
          </p>
        </div>

        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 p-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-base-content/5 flex items-center justify-center mb-3">
              <Users className="w-8 h-8 text-base-content/55" />
            </div>
            <p className="text-sm text-base-content/55 font-medium">No conversations yet</p>
            <p className="text-xs text-base-content/55 mt-1">
              Tap + to scan a friend&apos;s code, or show them yours
            </p>
          </div>
        ) : (
          <ul className="p-2 sm:p-3 space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.peer_id}>
                <ConversationRow
                  conversation={conversation}
                  me={me}
                  unread={unread.get(conversation.peer_id) ?? 0}
                  lastText={previews.get(conversation.peer_id) ?? null}
                  selected={selectedFriendId === conversation.peer_id}
                  onSelect={() =>
                    onSelectFriend({
                      id: conversation.peer_id,
                      display_name: conversation.display_name,
                      avatar_url: conversation.avatar_url,
                      last_seen_at: conversation.last_seen_at,
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {/* The self-chat means the list is never empty, so the "add a friend"
            hint above would never be seen by the person who most needs it.
            Repeat it under the rows while yours is the only conversation. */}
        {conversations.length > 0 && !hasFriendRows && (
          <p className="px-4 pb-4 text-xs text-base-content/55 text-center">
            Tap + to scan a friend&apos;s code, or show them yours
          </p>
        )}
      </div>

      {/* Connect Modal */}
      {showAddModal && (
        <ConnectModal
          session={session}
          identity={identity}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
