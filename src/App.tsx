import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { SetNewPassword } from './components/SetNewPassword';
import { FriendsList } from './components/FriendsList';
import { ChatRoom } from './components/ChatRoom';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { Avatar } from './components/Avatar';
import { BrandMark } from './components/BrandMark';
import { supabase } from './lib/supabase';
import { Profile } from './lib/types';
import type { RoomSummary } from './lib/rooms';
import { useMessageNotifications } from './hooks/useMessageNotifications';
import { useLastSeen } from './hooks/useLastSeen';
import { useIdentity } from './hooks/useIdentity';
import { syncPublicKeys } from './lib/identity-sync';
import { isSecureStorageAvailable } from './lib/keystore';
import { IdentitySetup } from './components/IdentitySetup';
import { useAppBadge } from './hooks/useAppBadge';
import { PresenceProvider } from './hooks/usePresence';
import { initSoundUnlock } from './lib/sound';
import { initNotifications, onNotificationOpened } from './lib/notifications';
import { initPurchases, applyTheme, packsFromEntitlements, storedTheme, themeForOwnership } from './lib/purchases';
import { useNicknameSync } from './lib/nicknames';
import { clearAll } from './lib/outbox';
import { clearLocalDb, openLocalDb } from './lib/localdb';
import { LogOut, MessageSquare, Settings } from 'lucide-react';

function App() {
  const { session, loading, recovering, endRecovery } = useAuth();
  const [selectedFriend, setSelectedFriend] = useState<Profile | null>(null);
  // Rooms and one-to-one conversations share the chat pane, so opening one
  // must close the other — two selections both set would render whichever the
  // JSX below happened to check first, which is not a decision to leave to
  // ordering.
  const [selectedRoom, setSelectedRoom] = useState<RoomSummary | null>(null);
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Owned here, reported up by FriendsList: presence needs the friend set to
  // scope its channels, and the chat pane needs it below the provider.
  const [friendIds, setFriendIds] = useState<string[]>([]);
  // Summed unread count across all conversations, reported up by FriendsList
  // so the OS-level app badge can mirror it without duplicating the map.
  const [unreadTotal, setUnreadTotal] = useState(0);
  useAppBadge(unreadTotal);

  // Signing out unmounts FriendsList, so nothing would ever report the total
  // back down to zero — the badge would sit on the installed icon claiming
  // unread messages for an account nobody is signed into.
  useEffect(() => {
    if (!session) setUnreadTotal(0);
  }, [session]);

  // Open this account's mirror before anything tries to write to it. Every
  // cache call is a silent no-op until the connection exists, so a missed open
  // would not fail — it would just leave search and previews permanently empty.
  // Keyed on the account: the store holds decrypted text, and the next person
  // to sign in on this phone gets their own.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (userId) void openLocalDb(userId);
  }, [userId]);

  const fetchMyProfile = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, last_seen_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (data) setMyProfile(data);
  }, [session]);

  useEffect(() => {
    fetchMyProfile();
  }, [fetchMyProfile]);

  // Foreground sound + notifications for incoming messages from any friend.
  useMessageNotifications(session, selectedFriend?.id ?? null);

  // Throttled writer for this device's own last_seen_at.
  useLastSeen(session);

  // This device's keypair, derived from a seed that never leaves it.
  const { identity, status: identityStatus, createIdentity, confirmIdentity, restoreIdentity } =
    useIdentity(session);

  // Only the public halves, and only when they differ from what is stored.
  useEffect(() => {
    if (session && identity) void syncPublicKeys(session, identity);
  }, [session, identity]);

  // Private friend nicknames, loaded once and kept live for the whole app —
  // the sidebar, the chat header and the notification titles all read them.
  useNicknameSync(session);

  // Hardware/browser back closes the open chat instead of leaving the app.
  // Only on the single-pane layout — on desktop both panes are visible, so
  // "back" closing the chat would be surprising rather than expected.
  const chatOpen = !!selectedFriend || !!selectedRoom;
  useEffect(() => {
    if (!chatOpen) return;
    if (!window.matchMedia('(max-width: 1023px)').matches) return;

    window.history.pushState({ nearsideChat: true }, '');
    const onPop = () => {
      setSelectedFriend(null);
      setSelectedRoom(null);
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed from the UI rather than by a back navigation: our entry is still
      // on the stack, so consume it or the next back press would be a no-op.
      if (window.history.state?.nearsideChat) window.history.back();
    };
  }, [chatOpen]);

  // Unlock Web Audio on the first user gesture.
  useEffect(() => {
    initSoundUnlock();
  }, []);

  // Queued-but-unsent bodies are message content; they should not outlive the
  // session that wrote them on a shared device. The local mirror holds
  // decrypted text for the same reason and goes with it — the account's own
  // mirror, not the device's, so the other account keeps its history.
  const signOut = useCallback(async () => {
    await clearAll();
    await clearLocalDb();
    await supabase.auth.signOut();
  }, []);

  // Bind this device to the account for notifications, and start the store.
  // Both are best-effort by construction: neither one failing may stop the
  // messenger from running.
  useEffect(() => {
    if (!userId) return;
    void initNotifications(userId);
    void initPurchases(userId);
  }, [userId]);

  // The stored theme is applied before any entitlement check finishes, so a
  // paying user does not get a frame of the default look — then reconciled,
  // because a refund must not leave the paid-for theme in place.
  useEffect(() => {
    applyTheme(storedTheme());
    if (!userId) return;
    void packsFromEntitlements().then((owned) => {
      applyTheme(themeForOwnership(storedTheme(), owned));
    });
  }, [userId]);

  /** Open a conversation given only a user id (from a notification click or a
   *  `?chat=` deep link). The friends list re-reports the full, live row for
   *  the selected id on its next pass, so this only has to be right enough to
   *  mount the chat. */
  const openChatWith = useCallback(async (friendId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, last_seen_at')
      .eq('id', friendId)
      .maybeSingle();
    if (data) {
      setSelectedRoom(null);
      setSelectedFriend(data);
    }
  }, []);

  // Which chat a tapped notification meant. Registered once per session: the
  // OneSignal listener has no removal API, so re-registering on every render
  // would stack handlers and open the same chat several times over.
  useEffect(() => {
    if (!session) return;
    void onNotificationOpened((senderId) => void openChatWith(senderId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  // Cold start from a notification: the worker opened `/?chat=<id>` because no
  // window was running to message. Consume the parameter and scrub it, so a
  // later reload doesn't re-open a chat the user has since navigated away from.
  useEffect(() => {
    if (!session) return;
    const chatId = new URLSearchParams(window.location.search).get('chat');
    if (!chatId) return;
    window.history.replaceState({}, '', window.location.pathname);
    void openChatWith(chatId);
  }, [session, openChatWith]);

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-base-300">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  if (recovering) {
    return <SetNewPassword onDone={endRecovery} />;
  }

  if (!session) {
    return <AuthForm />;
  }

  if (identityStatus === 'loading') {
    return (
      <div className="h-dvh flex items-center justify-center bg-base-300">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  // 'unconfirmed' must be here too: createIdentity stores the seed and flips
  // status the moment the phrase is generated, so a gate matching only
  // 'missing' would render the chat on that very render and the user would
  // never see the twelve words they cannot recover the vault without.
  if (identityStatus === 'missing' || identityStatus === 'unconfirmed') {
    return (
      <IdentitySetup
        onCreate={createIdentity}
        onConfirm={confirmIdentity}
        onRestore={restoreIdentity}
        account={myProfile?.display_name ?? session.user.email ?? 'this account'}
        onSignOut={() => void signOut()}
        secureStorage={isSecureStorageAvailable()}
      />
    );
  }

  // 'ready' is never set without a derived identity, but the status and the key
  // are two pieces of state and only one of them is in the type system. Narrow
  // on the key itself, so everything below can take it as non-null rather than
  // each consumer inventing its own fallback.
  if (!identity) {
    return (
      <div className="h-dvh flex items-center justify-center bg-base-300">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  return (
    <PresenceProvider session={session} friendIds={friendIds}>
    <div className="h-dvh flex flex-col bg-base-300 overflow-hidden">
      {/* Top Bar */}
      <header className="navbar bg-base-100 px-4 sm:px-6 shrink-0 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.25)] z-20 min-h-[3.5rem] pt-safe">
        <div className="flex-1 gap-2">
          <BrandMark size={22} />
          <span className="font-bold text-base sm:text-lg tracking-tight">Nearside</span>
        </div>
        <div className="flex-none flex items-center gap-1 sm:gap-2">
          {myProfile && (
            <button
              onClick={() => setShowSettings(true)}
              className="hidden sm:flex items-center gap-2 btn btn-ghost btn-sm normal-case"
              title="Profile settings"
            >
              <Avatar display_name={myProfile.display_name} url={myProfile.avatar_url} size={24} />
              <span className="text-xs text-base-content/60 hidden sm:inline truncate max-w-[120px]">
                @{myProfile.display_name}
              </span>
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="btn btn-ghost btn-sm btn-square sm:hidden"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={() => void signOut()}
            className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`w-full lg:w-80 xl:w-96 lg:border-r lg:border-base-content/5 shrink-0 transition-all duration-200 ${
            chatOpen ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
          }`}
        >
          <FriendsList
            session={session}
            identity={identity}
            selectedFriendId={selectedFriend?.id || null}
            onSelectFriend={(friend) => {
              setSelectedRoom(null);
              setSelectedFriend(friend);
            }}
            onFriendsChange={setFriendIds}
            onUnreadTotalChange={setUnreadTotal}
            selectedRoomId={selectedRoom?.id ?? null}
            onSelectRoom={(room) => {
              setSelectedFriend(null);
              setSelectedRoom(room);
            }}
          />
        </aside>

        {/* Chat Area */}
        <main
          className={`flex-1 min-w-0 ${
            chatOpen ? 'flex flex-col' : 'hidden lg:flex lg:flex-col'
          }`}
        >
          {selectedFriend ? (
            <ChatRoom
              session={session}
              friend={selectedFriend}
              identity={identity}
              onBack={() => setSelectedFriend(null)}
            />
          ) : selectedRoom ? (
            <RoomView
              session={session}
              room={selectedRoom}
              identity={identity}
              onBack={() => setSelectedRoom(null)}
              onLeft={() => setSelectedRoom(null)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-base-200/50">
              <div className="text-center px-4">
                <div className="w-20 h-20 rounded-2xl bg-base-content/5 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="w-10 h-10 text-base-content/55" />
                </div>
                <p className="text-base-content/60 text-base sm:text-lg font-medium">
                  Select a friend to start chatting
                </p>
                <p className="text-base-content/55 text-sm mt-1">
                  Your conversations will appear here
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {showSettings && myProfile && (
        <SettingsModal
          session={session}
          profile={myProfile}
          onUpdated={(p) => setMyProfile(p)}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
    </PresenceProvider>
  );
}

export default App;
