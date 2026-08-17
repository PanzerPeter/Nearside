import { useEffect, useState } from 'react';
import { AtSign, Bell, BellOff, Volume2 } from 'lucide-react';
import {
  canRequestPushPermission,
  hasPushPermission,
  pushBlockedByOs,
  requestPushPermission,
  setPushEnabled,
} from '../../lib/notifications';
import { isSoundMuted, setSoundMuted } from '../../lib/sound';
import { permissionSettingsLocation } from '../../lib/device';
import { isMobileNative } from '../../lib/platform';
import { useToast } from '../../hooks/useToast';
import { Card, InfoRow, ToggleRow } from './SettingsUi';

/**
 * Everything about being told something arrived, calls excepted — those have
 * their own page, because the question there is whether the phone rings at all
 * and the answer involves a second Android permission.
 */
export function NotificationsPage() {
  const toast = useToast();
  const native = isMobileNative();

  // Whether the OS has granted notifications, as OneSignal reports it.
  // Deliberately NOT the WebView's `Notification.permission`: an Android
  // WebView has no `window.Notification` at all, so that check answered
  // "denied" on the one platform this app ships to and left the toggle
  // disabled under the words "Not supported on this device".
  const [granted, setGranted] = useState<boolean | null>(null);
  // Whether Android would still show its dialog. Android 13 stops offering it
  // after a dismissal, and from then on the toggle cannot do anything at all,
  // so this is what decides between "tap to turn on" and "go to system
  // settings". Saying the second while the first was true is what made the
  // toggle read as broken.
  const [canRequest, setCanRequest] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [muted, setMuted] = useState(isSoundMuted());

  // Reflect whether this device is currently opted in with OneSignal.
  useEffect(() => {
    let active = true;
    void Promise.all([hasPushPermission(), canRequestPushPermission()]).then(([ok, askable]) => {
      if (!active) return;
      setGranted(ok);
      setPushOn(ok);
      setCanRequest(askable);
    });
    return () => {
      active = false;
    };
  }, []);

  async function toggleNotifications() {
    if (pushBusy) return;
    setPushBusy(true);
    if (pushOn) {
      await setPushEnabled(false);
      setPushOn(false);
      toast.success('Notifications turned off on this device.');
    } else {
      // Asked here, at the moment the user turns them on, and never at launch.
      const ok = await requestPushPermission();
      setGranted(ok);
      setPushOn(ok);
      if (ok) {
        await setPushEnabled(true);
        toast.success('Notifications on. They never carry message content.');
      } else {
        // A refusal and a dialog that never appeared need different advice, so
        // re-read whether Android is still willing to ask.
        const askable = await canRequestPushPermission();
        setCanRequest(askable);
        toast.error(
          askable
            ? 'Notifications stay off until you allow them.'
            : `Android is no longer asking. Turn them on in ${permissionSettingsLocation()}.`,
        );
      }
    }
    setPushBusy(false);
  }

  const notifStatus = !native
    ? 'Only the Android app can notify you in the background'
    : granted === null
      ? 'Checking…'
      : pushOn
        ? 'On. A notification names the sender and never what they said.'
        : granted
          ? 'Hear about messages while the app is closed'
          : pushBlockedByOs({ granted: false, canRequest })
            ? `Blocked by Android. Turn them on in ${permissionSettingsLocation()}.`
            : 'Tap to turn on. Android will ask you to allow it.';

  return (
    <Card>
      <ToggleRow
        icon={Bell}
        label="Message notifications"
        hint={notifStatus}
        checked={pushOn}
        onChange={() => void toggleNotifications()}
        disabled={!native}
        busy={pushBusy}
      />
      <ToggleRow
        icon={Volume2}
        label="Notification sound"
        hint="Play a chime for new messages"
        checked={!muted}
        onChange={() => {
          const next = !muted;
          setMuted(next);
          setSoundMuted(next);
        }}
      />
      {/* Stated rather than left to be inferred as a broken feature. The
          mention is inside the sealed body, so the server cannot know one
          happened — giving it a louder notification would mean telling the
          server what the message says. */}
      {/* Where muting a chat stops working, said plainly. The app does not
          claim protections it does not have — the same rule that gave
          `isSecureStorageAvailable()` its honest answer. */}
      <InfoRow
        icon={BellOff}
        label="Muted chats"
        hint="Swipe a chat to mute it. On Android the notification is discarded on this phone, before it is shown, so the server is never told which chats you keep quiet. The desktop app has no such hook and will still ring."
      />
      <InfoRow
        icon={AtSign}
        label="Mentions in rooms"
        hint="Highlighted in the room, but they get the same notification as any other message: your name is inside the encrypted message, so the server cannot see it."
      />
    </Card>
  );
}
