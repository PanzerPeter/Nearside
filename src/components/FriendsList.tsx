import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Profile, Friendship, Message, ConversationSummary } from '../lib/types';
import { isSelfChat, sortConversations } from '../lib/conversation';
import { cachedPreview } from '../lib/localdb';
import { Avatar } from './Avatar';
import { ConversationRow } from './ConversationRow';
import { AddFriendModal } from './AddFriendModal';
import { LegalFooter } from './LegalFooter';
import { advanceRead, fetchUnreadCounts } from '../lib/receipts';
import { useConnection, reportChannelStatus, forgetChannel } from '../lib/connection';
import { UserPlus, Check, X, Users } from 'lucide-react';

/** Conversation-list refresh cadence while realtime is healthy — a cheap
 *  backstop, since the list is one RPC. */
const LIST_POLL_HEALTHY_MS = 60_000;
/** …and once realtime is known to be down, when it's the only thing keeping
 *  previews, ordering and unread badges moving. */
const LIST_POLL_DEGRADED_MS = 12_000;

interface FriendsListProps {
  session: Session;
  selectedFriendId: string | null;
  onSelectFriend: (friend: Profile) => void;
  /** Reports the accepted-friend set upward, so presence can scope its
   *  channels to exactly these people. */
  onFriendsChange?: (friendIds: string[]) => void;
  /** Reports the summed unread count upward whenever the unread map changes,
   *  so the app-level badge can mirror it without owning the map itself. */
  onUnreadTotalChange?: (total: number) => void;
}

export function FriendsList({
  session,
  selectedFriendId,
  onSelectFriend,
  onFriendsChange,
  onUnreadTotalChange,
}: FriendsListProps) {
  const me = session.user.id;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /** peer_id → last message text from the local mirror, or null if unseen here. */
  const [previews, setPreviews] = useState<Map<string, string | null>>(new Map());
  const [pendingRequests, setPendingRequests] = useState<Friendship[]>([]);
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [showAddModal, setShowAddModal] = useState(false);
  const { generation, live } = useConnection();

  // Live refs so the realtime handler always sees current friends/selection.
  // Assigned directly during render (not inside an effect) so they're never
  // one render stale, regardless of what any effect below is gated on.
  const friendsRef = useRef<ConversationSummary[]>([]);
  friendsRef.current = conversations;
  const selectedRef = useRef<string | null>(selectedFriendId);
  selectedRef.current = selectedFriendId;

  // Both fetchers are declared here, above every effect that lists them as a
  // dependency: a dependency array is evaluated during render, so a `const`
  // defined further down the component body would be read in its temporal dead
  // zone. Each depends only on `me`, which cannot change for a mounted list, so
  // the identities are stable and none of the effects below re-runs for them.
  const fetchConversations = useCallback(async () => {
    const { data, error } = await supabase.rpc('conversation_list');
    // A read that failed is not a list that is empty. Writing `data ?? []`
    // here turned a single transient RPC error into a sidebar with nothing in
    // it — not even the vault, which the RPC always returns — and nothing
    // refetches on its own, so the only way back was restarting the app.
    if (error) return;
    // Ordering (self pinned first, then newest activity) lives in
    // lib/conversation.ts so it can be tested without a component.
    const rows = sortConversations((data ?? []) as ConversationSummary[], me);
    setConversations(rows);

    // Previews come from the local mirror, because 0023 took the body away
    // from the server. Resolved after the rows are already on screen: the list
    // must not wait on the local database to paint, and a row briefly showing
    // "Encrypted message" before its preview lands is a better failure than a
    // sidebar that appears a frame late.
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

  // `generation` for the same reason the channels below take it: after a wake
  // — or the resume that follows a deep link back into the app — a fetch that
  // was in flight over a dead socket never lands, and re-subscribing does not
  // re-read anything. This is the retry that makes a failed first load
  // temporary rather than permanent.
  useEffect(() => {
    void fetchConversations();
    void fetchPendingRequests();
  }, [generation, fetchConversations, fetchPendingRequests]);

  // Live friendship updates: incoming requests, accepts, declines and removals
  // all arrive here so the list stays current without a reload. RLS scopes the
  // stream to rows where this user is the requester or addressee, so any event
  // is relevant — just refetch both views.
  // `generation` is a dep on this and the messages channel below: after a wake
  // the old channels are joined to a socket that no longer exists, and nothing
  // rejoins them on its own. Re-running the effect tears them down and builds
  // fresh ones.
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
  // nothing re-syncs it while the chat stays open. That was harmless until
  // last_seen_at joined Profile: it changes continuously, so the chat header
  // would report the friend's last-seen time as of when you opened the chat,
  // not as of now. This refetches nothing — it just re-reports the row this
  // list is already keeping current. Keyed on the values rather than the row
  // object, which is new on every refetch.
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

  // Stable primitive dep: `conversations` gets a new array identity on every
  // refetch (recency reshuffles, preview text edits, ...), but a full unread
  // recount is only meaningful when the *set of peers* actually changes.
  // Keying on the array itself meant every inbound message paid for two
  // round trips — the optimistic increment in the realtime handler below,
  // immediately clobbered by this effect re-running off the fetchConversations
  // it triggered. Same pattern as usePresence's peerKey.
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
      // A refetch triggered while this one was in flight has already published
      // fresher counts; don't overwrite it with our stale snapshot.
      if (cancelled) return;
      // The open conversation is read by definition. Its watermark may still
      // be mid-write (advanceRead is a round trip), which would otherwise
      // resurrect the badge we just cleared.
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
      // Your own notes are read by definition — `unread_counts()` excludes
      // them, and `no_self_receipt` forbids the watermark row this would write.
      if (isSelfChat(me, friendId)) return;
      setUnread((prev) => {
        if (!prev.has(friendId)) return prev;
        const next = new Map(prev);
        next.delete(friendId);
        return next;
      });
      // Fire-and-forget: the badge is already gone locally, and a failed write
      // only means the count is recomputed on the next load.
      // Anchor to the newest message they actually sent us: the watermark is
      // compared against `created_at`, so a local clock would be wrong by the
      // device's skew in whichever direction it happens to drift.
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
          // transport-level failure could still reject; swallow it the same
          // way as the error path above — the badge recomputes on next load.
          // (The builder is only a thenable, not a full Promise, so the
          // rejection handler goes here rather than in a chained `.catch`.)
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
  // open and focused; either way refetch so the row moves and its preview updates.
  //
  // Four bindings on one channel, not one: `receiver_id=eq.${me}` only ever
  // matches messages sent TO us, so it never fires for our own sends — a
  // conversation you just messaged would otherwise sit frozen with the
  // peer's older preview and stale ordering until they reply. UPDATE is
  // covered on both directions too, so an edit or soft-delete of the last
  // message (ours or theirs) refreshes the preview instead of showing stale
  // text. fetchConversations() only reads via RPC, so none of these refetches
  // writes to `messages` and none can re-trigger this subscription itself.
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
      // Our own sends: never touch unread state, but the row's preview and
      // recency ordering still need to move.
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
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-base-content/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-primary" />
            <h2 className="font-semibold text-base-content">Friends</h2>
          </div>
          <button
            className="btn btn-primary btn-sm btn-circle shadow-md shadow-primary/20 hover:shadow-primary/30 transition-shadow"
            onClick={() => setShowAddModal(true)}
            title="Add Friend"
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
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-base-content/5 flex items-center justify-center mb-3">
              <Users className="w-8 h-8 text-base-content/55" />
            </div>
            <p className="text-sm text-base-content/55 font-medium">No conversations yet</p>
            <p className="text-xs text-base-content/55 mt-1">Tap + to add a friend by display name</p>
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
            Tap + to add a friend by display name
          </p>
        )}
      </div>

      {/* Footer */}
      <LegalFooter className="py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-base-content/5 shrink-0" />

      {/* Add Friend Modal */}
      {showAddModal && <AddFriendModal me={me} onClose={() => setShowAddModal(false)} />}
    </div>
  );
}
