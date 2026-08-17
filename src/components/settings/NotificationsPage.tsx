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
import { useT } from '../../hooks/useT';

/**
 * Everything about being told something arrived, calls excepted — those have
 * their own page, because the question there is whether the phone rings at all
 * and the answer involves a second Android permission.
 */
export function NotificationsPage() {
  const toast = useToast();
  const native = isMobileNative();
  const t = useT();

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
      toast.success(t('notifications.turnedOff'));
    } else {
      // Asked here, at the moment the user turns them on, and never at launch.
      const ok = await requestPushPermission();
      setGranted(ok);
      setPushOn(ok);
      if (ok) {
        await setPushEnabled(true);
        toast.success(t('notifications.turnedOn'));
      } else {
        // A refusal and a dialog that never appeared need different advice, so
        // re-read whether Android is still willing to ask.
        const askable = await canRequestPushPermission();
        setCanRequest(askable);
        toast.error(
          askable
            ? t('notifications.refused')
            : t('notifications.noLongerAsking', { location: permissionSettingsLocation() }),
        );
      }
    }
    setPushBusy(false);
  }

  const notifStatus = !native
    ? t('notifications.androidOnly')
    : granted === null
      ? t('common.checking')
      : pushOn
        ? t('notifications.statusOn')
        : granted
          ? t('notifications.statusGranted')
          : pushBlockedByOs({ granted: false, canRequest })
            ? t('notifications.statusBlocked', { location: permissionSettingsLocation() })
            : t('notifications.statusAsk');

  return (
    <Card>
      <ToggleRow
        icon={Bell}
        label={t('notifications.messages')}
        hint={notifStatus}
        checked={pushOn}
        onChange={() => void toggleNotifications()}
        disabled={!native}
        busy={pushBusy}
      />
      <ToggleRow
        icon={Volume2}
        label={t('notifications.sound')}
        hint={t('notifications.soundHint')}
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
        label={t('notifications.mutedChats')}
        hint={t('notifications.mutedChatsHint')}
      />
      <InfoRow
        icon={AtSign}
        label={t('notifications.mentions')}
        hint={t('notifications.mentionsHint')}
      />
    </Card>
  );
}
