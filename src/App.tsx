import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { SetNewPassword } from './components/SetNewPassword';
import { FriendsList } from './components/FriendsList';
import { ChatRoom } from './components/ChatRoom';
import { RoomView } from './components/RoomView';
import { SettingsModal } from './components/SettingsModal';
import { SettingsPanel } from './components/SettingsPanel';
import { ProfileUnavailable } from './components/ProfileUnavailable';
import { TabBar, type Tab } from './components/TabBar';
import { AccountRail } from './components/AccountRail';
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
import { CallProvider } from './hooks/useCall';
import { CallScreen } from './components/CallScreen';
import { forgetIceServers } from './lib/call/ice';
import { initSoundUnlock } from './lib/sound';
import {
  clearExternalUserId,
  initNotifications,
  onForegroundNotification,
  onNotificationOpened,
  setHasContacts,
} from './lib/notifications';
import {
  applyTheme,
  initPurchases,
  logOutPurchases,
  storedTheme,
  themeForOwnership,
} from './lib/purchases';
import { ownedPacks } from './lib/theme-grants';
import { useNicknameSync } from './lib/nicknames';
import { clearAll } from './lib/outbox';
import { clearLocalDb, clearLocalDbFor, openLocalDb } from './lib/localdb';
import {
  forgetAccount,
  loadAccounts,
  rememberAccount,
  type StoredAccount,
} from './lib/accounts';
import { clearSeed } from './lib/keystore';
import { clearPinnedMedia } from './lib/pins';
import { forgetAllPeerKeys } from './lib/peer-keys';
import { forgetAllPublishedKeys, forgetAllRoomKeys } from './lib/rooms';
import { forgetStickers } from './lib/stickers';
import { forgetAllMedia } from './lib/media-cache';
import { forgetAllBackgroundUrls } from './lib/background';
import { useMobileBackClose } from './hooks/useMobileBackClose';
import { useAppLock } from './hooks/useAppLock';
import { AppLockScreen } from './components/AppLockScreen';
import { clearLock } from './lib/app-lock';
import { setScreenGuard } from './lib/screen-guard';
import { useConnection } from './lib/connection';
import { MessageSquare } from 'lucide-react';

/** Gap between retries of the profile fetch the settings tab waits on. Long
 *  enough that a phone with no signal isn't spinning on it, short enough that
 *  the tab heals itself before anyone reaches for the app switcher. */
const PROFILE_RETRY_MS = 4_000;

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

  // Every account signed in on this device, for the switcher in settings. Device
  // -wide rather than per-account on purpose; see `lib/accounts.ts`.
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  useEffect(() => {
    void loadAccounts().then(setAccounts).catch(() => {});
  }, []);

  // Showing the sign-in form while somebody is still signed in, to add a second
  // account. Cleared by the account changing underneath it, which is what
  // signing in successfully does — the form has no success callback of its own
  // and does not need one.
  const [addingAccount, setAddingAccount] = useState(false);
  useEffect(() => {
    setAddingAccount(false);
  }, [userId]);

  const appLock = useAppLock(userId);
  const unlocked = appLock.state === 'off' || appLock.state === 'unlocked';

  // Held closed while locked. The decrypted mirror is the one place on the
  // device holding message plaintext; a lock that hides a screen while the
  // mirror is open and queried is a screensaver.
  useEffect(() => {
    if (!userId || !unlocked) return;
    void openLocalDb(userId);
  }, [userId, unlocked]);

  // Held whenever the feature is enabled, not only while the lock screen is up.
  // The leak this closes is the recents-switcher thumbnail: a task-switcher
  // preview of an open conversation is readable without unlocking anything.
  useEffect(() => {
    if (appLock.state === 'loading') return;
    void setScreenGuard(appLock.state !== 'off', 'app-lock');
  }, [appLock.state]);

  // Whether the last attempt came back with nothing. The settings tab waits on
  // `myProfile`, so a single failed fetch used to be terminal: the row was
  // asked for once per session and nothing ever asked again, leaving the tab on
  // its spinner until the app was restarted.
  const [profileFailed, setProfileFailed] = useState(false);

  const fetchMyProfile = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, last_seen_at')
      .eq('id', session.user.id)
      .maybeSingle();
    if (data) {
      setMyProfile(data);
      setProfileFailed(false);
    } else {
      setProfileFailed(true);
    }
  }, [session]);

  // Keyed on the connection's generation like every other fetch in the app, so
  // a wake that rebuilds the subscriptions re-asks for the profile too.
  const { generation } = useConnection();
  useEffect(() => {
    void fetchMyProfile();
  }, [fetchMyProfile, generation]);

  // Wake is not the only way out of a failed fetch — the phone can simply
  // regain signal while the app stays in the foreground. Retrying sets the flag
  // again on another failure, which reschedules this.
  useEffect(() => {
    if (!profileFailed || !session) return;
    const timer = setTimeout(() => void fetchMyProfile(), PROFILE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [profileFailed, session, fetchMyProfile]);

  // Keep this account resumable from the switcher.
  //
  // Keyed on the refresh token rather than the session object, and re-run every
  // time that token changes: Supabase rotates it on each refresh and invalidates
  // the one it replaced, so a roster written once at sign-in holds a spent
  // credential within the hour. The failure would surface much later and look
  // unrelated — someone taps an account and is asked to sign in instead.
  //
  // The profile is in the dependencies because it usually arrives after the
  // session does; without it the first write files the account under an empty
  // name and nothing ever corrects it.
  const refreshToken = session?.refresh_token ?? null;
  useEffect(() => {
    if (!userId || !refreshToken) return;
    void rememberAccount({
      userId,
      display_name: myProfile?.display_name ?? '',
      avatar_url: myProfile?.avatar_url ?? null,
      refresh_token: refreshToken,
    })
      .then(loadAccounts)
      .then(setAccounts)
      .catch(() => {});
  }, [userId, refreshToken, myProfile?.display_name, myProfile?.avatar_url]);

  // Foreground sound + notifications for incoming messages from any friend.
  useMessageNotifications(session, selectedFriend?.id ?? null);

  // Whose messages the user is currently reading, for the push that would
  // otherwise announce a line already on screen. Null while the app lock is up:
  // a conversation behind the lock screen is open in state and not in front of
  // anybody. Written on every render and read from a listener registered once,
  // which is why it is a ref.
  const readingRef = useRef<string | null>(null);
  readingRef.current = unlocked ? selectedFriend?.id ?? null : null;

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
  // Everything that must not survive into the *next* account on this device,
  // and nothing that would destroy the account being left.
  //
  // Split out of `signOut` for the switcher: switching accounts has to drop the
  // same in-memory keys and the same remote bindings, but must leave the seed,
  // the mirror, the lock verifier, the outbox and the pinned files exactly where
  // they are — the account is coming back, and a switch that quietly wiped its
  // history would be a sign-out wearing a different label.
  const releaseAccount = useCallback(async () => {
    // See `forgetAllPeerKeys` for why a surviving peer key breaks key-change
    // detection for the next account, and `forgetAllRoomKeys` for why room keys
    // must not outlive the session.
    forgetAllPeerKeys();
    forgetAllRoomKeys();
    // Published box/signing keys, cached for the session by `lib/rooms.ts`.
    // Public, but scoped to whoever this account can read.
    forgetAllPublishedKeys();
    // Decrypted sticker images, held in memory under the vault key of the
    // account being left. Every new per-account cache belongs in this chain.
    forgetStickers();
    // Decrypted attachments from the conversations of the account being left —
    // photos, videos and voice notes, in memory, same rule.
    forgetAllMedia();
    // Signed URLs held for chat backgrounds. Each is a bearer token for one
    // object this account could read; the next one on the device may not.
    forgetAllBackgroundUrls();
    // TURN credentials are minted against the signed-in user's JWT. Left
    // behind, the next account on this phone would relay its calls under the
    // previous owner's credentials.
    forgetIceServers();
    await setScreenGuard(false, 'app-lock').catch(() => {});
    // A device left bound keeps delivering the previous account's notifications
    // and reporting its purchases. Neither failing may block the caller.
    await clearExternalUserId().catch(() => {});
    await logOutPurchases().catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await clearAll();
    // Before `clearLocalDb`, which drops the rows naming these files. Pinned
    // attachments are decrypted bytes in the sandbox and the store is the only
    // thing that knows where they are.
    await clearPinnedMedia().catch(() => {});
    await clearLocalDb();
    // Per-account, like the seed and the peer-key cache. Left behind, the next
    // account to sign in on this phone meets the previous owner's lock screen
    // and cannot get past it.
    if (userId) await clearLock(userId).catch(() => {});
    // Signing out drops the switcher entry too. Leaving it would make the row a
    // one-tap undo of the sign-out that was just confirmed, which is not what
    // anybody means by the word.
    if (userId) await forgetAccount(userId).catch(() => {});
    await releaseAccount();
    await supabase.auth.signOut();
    setAccounts(await loadAccounts().catch(() => []));
  }, [userId, releaseAccount]);

  /**
   * Resume a previously signed-in account from its stored refresh token.
   *
   * The teardown runs first, deliberately. `refreshSession` rewrites the stored
   * session the instant it succeeds, so releasing afterwards would race the
   * `[userId]` effects that re-bind OneSignal and RevenueCat and could clear the
   * binding that had just been made for the *new* account.
   *
   * The cost of that ordering is the failure path: a token that has been revoked
   * or already rotated on another device leaves nobody signed in. That is an
   * honest state rather than a broken one — the sign-in screen is exactly where
   * someone whose session expired belongs — and the dead row is dropped on the
   * way so the switcher never offers it twice.
   */
  const switchAccount = useCallback(
    async (target: StoredAccount) => {
      if (target.userId === userId) return;
      await releaseAccount();
      const { error } = await supabase.auth.refreshSession({
        refresh_token: target.refresh_token,
      });
      if (error) {
        await forgetAccount(target.userId).catch(() => {});
        await supabase.auth.signOut();
      }
      // Close the open chat either way: it belongs to the account being left,
      // and its peer is not a contact of whoever is signed in now.
      setSelectedFriend(null);
      setSelectedRoom(null);
      setMyProfile(null);
      setTab('chats');
      setAccounts(await loadAccounts().catch(() => []));
    },
    [userId, releaseAccount]
  );

  /**
   * Remove an account this device is *not* signed into.
   *
   * The roster entry is the way back in, so dropping it alone would strand the
   * rest of that account's device state — its mirror is decrypted message text
   * and its seed is the private key — with nothing in the UI able to reach any
   * of it again. Everything filed under the id goes together.
   *
   * The seed goes last: it is the piece with no recovery path other than the
   * user's twelve words, so anything that can fail should have failed already.
   */
  const forgetAccountFully = useCallback(
    async (target: StoredAccount) => {
      await forgetAccount(target.userId).catch(() => {});
      await clearLocalDbFor(target.userId, userId).catch(() => {});
      await clearLock(target.userId).catch(() => {});
      await clearSeed(target.userId).catch(() => {});
      setAccounts(await loadAccounts().catch(() => []));
    },
    [userId]
  );

  // Bind this device to the account for notifications, and start the store.
  // Both are best effort: neither failing may stop the messenger running.
  useEffect(() => {
    if (!userId) return;
    void initNotifications(userId);
    void initPurchases(userId);
  }, [userId]);

  // Reported whenever the friend list settles, not only on the first accepted
  // request: `FriendsList` re-reports on every pass, so this converges even if
  // the write that added the friendship happened on another device.
  //
  // Gated on a ready identity so an account still stuck on the phrase screen is
  // not also told about connect codes — that account has one thing to do, and
  // the recovery journey is the one addressing it.
  useEffect(() => {
    if (!userId || identityStatus !== 'ready') return;
    void setHasContacts(friendIds.length > 0);
  }, [userId, identityStatus, friendIds.length]);

  // The stored theme applies before any ownership check finishes, so a paying
  // user never gets a frame of the default look, then reconciles, because a
  // refund must not leave the paid-for theme in place. `ownedPacks` counts a
  // server-side grant as owned, so a showcase account keeps its theme too.
  useEffect(() => {
    applyTheme(storedTheme());
    if (!userId) return;
    void ownedPacks().then((owned) => {
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

  // Nothing announces a message that is already on screen. Registered once for
  // the same reason as the click listener above, which is why it reads the open
  // chat through a ref rather than closing over it.
  //
  // Decided here rather than in `send-push`: the server would have to be told
  // which conversation is open to make this call, and "who is reading whom,
  // right now" is precisely the kind of thing this app does not hand it.
  useEffect(() => {
    if (!session) return;
    // A payload with no sender names no conversation, so it can never be the
    // one on screen — `null === null` would otherwise swallow every push that
    // is not a direct message.
    void onForegroundNotification(
      (senderId) => senderId !== null && readingRef.current === senderId
    );
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

  // Adding a second account. Above the lock and identity gates because the form
  // shows none of this account's content — and below the `!session` check, so
  // the ordinary signed-out case still renders the form without a way to cancel
  // back to nothing.
  if (addingAccount) {
    return <AuthForm onCancel={() => setAddingAccount(false)} />;
  }

  if (appLock.state === 'loading') {
    return (
      <div className="h-dvh flex items-center justify-center bg-base-300">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  // Outside the identity gate, so a locked phone does not show a recovery-phrase
  // prompt — or anything else — to whoever is holding it.
  if (appLock.state === 'locked') {
    return (
      <AppLockScreen
        onUnlock={appLock.unlock}
        onUnlockWithRecoveryPhrase={appLock.unlockWithRecoveryPhrase}
        waitMs={appLock.waitMs}
        onSignOut={() => void signOut()}
      />
    );
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
    {/* Above the layout, not inside it: a call outlives the conversation that
        started it, and one answered from a notification has no chat open at
        all. The provider unmounts with the session, which is what stops a call
        surviving a sign-out with the microphone still open. */}
    <CallProvider session={session} identity={identity} friendIds={friendIds}>
    <CallScreen />
    {/* Rendered only past the identity gate, so the first thing a new install
        is asked is never "can we notify you" before it knows what the app is.
        The component decides for itself whether there is anything to ask. */}
    <NotificationsPrompt userId={session.user.id} />
    <div className="h-dvh flex flex-col bg-base-300 overflow-hidden">
      {/* No top bar. A row spanning both panes to hold a wordmark and an avatar
          costs every conversation a line of height and leaves the desktop with
          two stacked headers — one naming the app, one naming the person. The
          account moved to the foot of the list (`AccountRail`), which is where
          it is always reachable and never above the conversation. */}

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
          {/* The list is `h-full`, so it needs a box of its own to be full of:
              without this the rail below would be pushed past the bottom. */}
          <div className="flex-1 min-h-0">
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
          </div>

          {/* Desktop's only route into settings, and so into sign-out. It
              renders whether or not the profile row loaded — see the rail. */}
          <AccountRail
            profile={myProfile}
            profileFailed={profileFailed}
            onOpenSettings={() => setShowSettings(true)}
          />
        </aside>

        {/* Chat Area */}
        <main
          // Opening a conversation is a navigation on a phone, so the pane
          // travels in from the edge it will leave by. The attribute, rather
          // than a class, is what lets the expressive set restart the
          // animation each time it flips — see index.css.
          data-chat-open={chatOpen}
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
                <div className="motion-float w-20 h-20 rounded-2xl bg-base-content/5 flex items-center justify-center mx-auto mb-4">
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
            <div className="px-4 pt-[calc(1rem+var(--safe-top))] pb-4 border-b border-base-content/5 shrink-0">
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
                  appLock={appLock}
                  accounts={accounts}
                  onSwitchAccount={(a) => void switchAccount(a)}
                  onForgetAccount={(a) => void forgetAccountFully(a)}
                  onAddAccount={() => setAddingAccount(true)}
                />
              ) : profileFailed ? (
                <ProfileUnavailable
                  onRetry={() => void fetchMyProfile()}
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

      {/* Not gated on the profile: the rail can be pressed without one, and the
          dialog is where sign-out lives. */}
      {showSettings && (
        <SettingsModal
          session={session}
          profile={myProfile}
          onUpdated={(p) => setMyProfile(p)}
          onSignOut={() => void signOut()}
          onClose={() => setShowSettings(false)}
          profileFailed={profileFailed}
          onRetryProfile={() => void fetchMyProfile()}
          appLock={appLock}
          accounts={accounts}
          onSwitchAccount={(a) => {
            setShowSettings(false);
            void switchAccount(a);
          }}
          onForgetAccount={(a) => void forgetAccountFully(a)}
          onAddAccount={() => {
            setShowSettings(false);
            setAddingAccount(true);
          }}
        />
      )}
    </div>
    </CallProvider>
    </PresenceProvider>
  );
}

export default App;
