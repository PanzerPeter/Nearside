import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { SetNewPassword } from './components/SetNewPassword';
import { FriendsList } from './components/FriendsList';
import { ChatRoom } from './components/ChatRoom';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { SettingsPanel } from './components/SettingsPanel';
import { TabBar, type Tab } from './components/TabBar';
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
import { NotificationsPrompt } from './components/NotificationsPrompt';
import { useAppBadge } from './hooks/useAppBadge';
import { PresenceProvider } from './hooks/usePresence';
import { initSoundUnlock } from './lib/sound';
import { clearExternalUserId, initNotifications, onNotificationOpened } from './lib/notifications';
import {
  applyTheme,
  initPurchases,
  logOutPurchases,
  packsFromEntitlements,
  storedTheme,
  themeForOwnership,
} from './lib/purchases';
import { useNicknameSync } from './lib/nicknames';
import { clearAll } from './lib/outbox';
import { clearLocalDb, openLocalDb } from './lib/localdb';
import { clearPinnedMedia } from './lib/pins';
import { forgetAllPeerKeys } from './lib/peer-keys';
import { forgetAllRoomKeys } from './lib/rooms';
import { useMobileBackClose } from './hooks/useMobileBackClose';
import { MessageSquare, Settings } from 'lucide-react';

function App() {
  const { session, loading, recovering, endRecovery } = useAuth();
  const [selectedFriend, setSelectedFriend] = useState<Profile | null>(null);
  // Rooms and one-to-one conversations share the chat pane, so opening one
  // closes the other. Two selections set at once would render whichever the
  // JSX below checked first.
  const [selectedRoom, setSelectedRoom] = useState<RoomSummary | null>(null);
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  // The phone's tab bar selection. Desktop shows both panes at once and reaches
  // settings through the top bar's dialog, so this only decides what the
  // single-pane layout is showing.
  const [tab, setTab] = useState<Tab>('chats');
  const [showSettings, setShowSettings] = useState(false);
  // Owned here, reported up by FriendsList: presence needs the friend set to
  // scope its channels, and the chat pane needs it below the provider.
  const [friendIds, setFriendIds] = useState<string[]>([]);
  // Summed unread count across all conversations, reported up by FriendsList
  // so the OS-level app badge can mirror it without duplicating the map.
  const [unreadTotal, setUnreadTotal] = useState(0);
  useAppBadge(unreadTotal);

  // Signing out unmounts FriendsList, so nothing would report the total back
  // down to zero and the installed icon would keep a badge for an account
  // nobody is signed into. The tab resets with it, or the next person to sign
  // in on the phone lands on settings rather than their conversations.
  useEffect(() => {
    if (!session) {
      setUnreadTotal(0);
      setTab('chats');
    }
  }, [session]);

  // Open this account's mirror before anything writes to it. Cache calls are
  // silent no-ops until the connection exists, so a missed open leaves search
  // and previews permanently empty rather than failing. Keyed on the account,
  // because the store holds decrypted text and the next person to sign in on
  // this phone gets their own.
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

  // Private friend nicknames, loaded once and kept live for the whole app. The
  // sidebar, the chat header and the notification titles all read them.
  useNicknameSync(session);

  // Hardware and browser back close the open chat, and return the settings tab
  // to the chat list, rather than leaving the app. Both are full-screen
  // takeovers on a phone and neither is one on desktop; see the hook.
  const chatOpen = !!selectedFriend || !!selectedRoom;
  useMobileBackClose(chatOpen, () => {
    setSelectedFriend(null);
    setSelectedRoom(null);
  });
  useMobileBackClose(!chatOpen && tab === 'settings', () => setTab('chats'));

  // Unlock Web Audio on the first user gesture.
  useEffect(() => {
    initSoundUnlock();
  }, []);

  // Queued-but-unsent bodies are message content and must not outlive the
  // session that wrote them on a shared device. The local mirror holds
  // decrypted text for the same reason and goes with it, the account's own
  // mirror rather than the device's, so a second account keeps its history.
  //
  // OneSignal and RevenueCat are told to forget the account too. A device left
  // bound to the previous user keeps receiving their notifications and reports
  // their purchases. Neither failing is a reason to leave someone signed in,
  // so both run first and neither can block the sign-out.
  const signOut = useCallback(async () => {
    await clearAll();
    // Before `clearLocalDb`, which drops the rows naming these files. Pinned
    // attachments are decrypted bytes in the sandbox and the store is the only
    // thing that knows where they are.
    await clearPinnedMedia().catch(() => {});
    await clearLocalDb();
    // In-memory key caches, which no store clears. See `forgetAllPeerKeys` for
    // why a surviving peer key breaks key-change detection for the next
    // account, and `forgetAllRoomKeys` for why room keys must not outlive the
    // session.
    forgetAllPeerKeys();
    forgetAllRoomKeys();
    await clearExternalUserId().catch(() => {});
    await logOutPurchases().catch(() => {});
    await supabase.auth.signOut();
  }, []);

  // Bind this device to the account for notifications, and start the store.
  // Both are best effort: neither failing may stop the messenger running.
  useEffect(() => {
    if (!userId) return;
    void initNotifications(userId);
    void initPurchases(userId);
  }, [userId]);

  // The stored theme applies before any entitlement check finishes, so a
  // paying user never gets a frame of the default look, then reconciles,
  // because a refund must not leave the paid-for theme in place.
  useEffect(() => {
    applyTheme(storedTheme());
    if (!userId) return;
    void packsFromEntitlements().then((owned) => {
      applyTheme(themeForOwnership(storedTheme(), owned));
    });
  }, [userId]);

  /** Open a conversation given only a user id, from a notification click or a
   *  `?chat=` deep link. FriendsList re-reports the full live row on its next
   *  pass, so this only has to be right enough to mount the chat. */
  const openChatWith = useCallback(async (friendId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, last_seen_at')
      .eq('id', friendId)
      .maybeSingle();
    if (data) {
      setSelectedRoom(null);
      setSelectedFriend(data);
      // A notification tapped while the settings tab is up would otherwise
      // mount the conversation behind a hidden pane, and read as doing nothing.
      setTab('chats');
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

  // Cold start from a notification, where the worker opened `/?chat=<id>`
  // because no window was running to message. The parameter is consumed and
  // scrubbed, so a later reload does not re-open a chat already left.
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

  // 'unconfirmed' belongs here too. `createIdentity` stores the seed and flips
  // status the moment the phrase is generated, so a gate matching only
  // 'missing' renders the chat on that very render and the user never sees the
  // twelve words the vault cannot be recovered without.
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
  // are two pieces of state and only one is in the type system. Narrowing on
  // the key lets everything below take it as non-null instead of each consumer
  // inventing a fallback.
  if (!identity) {
    return (
      <div className="h-dvh flex items-center justify-center bg-base-300">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  return (
    <PresenceProvider session={session} friendIds={friendIds}>
    {/* Rendered only past the identity gate, so the first thing a new install
        is asked is never "can we notify you" before it knows what the app is.
        The component decides for itself whether there is anything to ask. */}
    <NotificationsPrompt userId={session.user.id} />
    <div className="h-dvh flex flex-col bg-base-300 overflow-hidden">
      {/* Top Bar. Desktop only: on a phone the tab bar carries settings and the
          list's own header carries the brand, so this row would be a second
          header stacked on the screen with the least room for one. */}
      <header className="hidden lg:flex navbar bg-base-100 px-4 sm:px-6 shrink-0 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.25)] z-20 min-h-[3.5rem] pt-safe">
        <div className="flex-1 gap-2">
          <BrandMark size={22} />
          <span className="font-bold text-base sm:text-lg tracking-tight">Nearside</span>
        </div>
        {/* Sign-out is no longer a bare icon up here: it lives in settings
            beside what it clears, next to the account it belongs to. */}
        <div className="flex-none flex items-center gap-2">
          {myProfile && (
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center gap-2 btn btn-ghost btn-sm normal-case"
              title="Profile settings"
            >
              <Avatar display_name={myProfile.display_name} url={myProfile.avatar_url} size={24} />
              <span className="text-xs text-base-content/60 truncate max-w-[120px]">
                @{myProfile.display_name}
              </span>
              <Settings className="w-4 h-4 text-base-content/60" />
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        {/* Hidden, never unmounted, when the settings tab is up: this list owns
            the app-wide unread channel, the presence scope and the badge the tab
            bar is showing, so tearing it down on a tab switch would drop all
            three and pay for a full refetch on the way back. */}
        <aside
          className={`w-full lg:w-80 xl:w-96 lg:border-r lg:border-base-content/5 shrink-0 transition-all duration-200 ${
            chatOpen || tab === 'settings' ? 'hidden lg:flex lg:flex-col' : 'flex flex-col'
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

        {/* Settings, as the phone's second tab. The same panel the desktop
            dialog renders — mounted only while the tab is up, so its push and
            entitlement checks don't run on every launch. */}
        {tab === 'settings' && !chatOpen && (
          <section className="w-full lg:hidden flex flex-col min-w-0 bg-base-100">
            <div className="px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-4 border-b border-base-content/5 shrink-0">
              <h2 className="font-semibold text-base-content">Settings</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {/* The profile row is what every field here edits, so the tab
                  waits for it rather than rendering an empty form. */}
              {myProfile ? (
                <SettingsPanel
                  session={session}
                  profile={myProfile}
                  onUpdated={(p) => setMyProfile(p)}
                  onSignOut={() => void signOut()}
                />
              ) : (
                <div className="flex justify-center py-10">
                  <span className="loading loading-spinner text-primary" />
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {/* Hidden while a conversation is open: the composer owns the bottom edge
          there, and "chats" would be a button leading to where you already are. */}
      {!chatOpen && <TabBar tab={tab} onSelect={setTab} unread={unreadTotal} />}

      {showSettings && myProfile && (
        <SettingsModal
          session={session}
          profile={myProfile}
          onUpdated={(p) => setMyProfile(p)}
          onSignOut={() => void signOut()}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
    </PresenceProvider>
  );
}

export default App;
