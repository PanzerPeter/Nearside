import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import {
  canRequestPushPermission,
  hasPushPermission,
  markPushOfferSeen,
  pushOfferSeen,
  requestPushPermission,
  setPushEnabled,
  shouldOfferPush,
} from '../lib/notifications';
import { Modal } from './Modal';
import { isMobileNative } from '../lib/platform';
import { useT } from '../hooks/useT';

interface NotificationsPromptProps {
  /** The signed-in account. The offer is remembered per account, so two people
   *  sharing a phone are each asked once. */
  userId: string;
}

/**
 * The one-time offer that gets a new install asked for notifications.
 *
 * Without it the permission lives behind a toggle in Settings, so an install
 * that never opens that screen never sees Android's dialog, never registers
 * with OneSignal, and never receives a notification.
 *
 * Not asked at launch. Android offers its dialog once, and a dialog appearing
 * before the person knows what the app is gets dismissed, spending that single
 * chance for nothing. This waits until the account and the recovery phrase are
 * done, the first moment "we can tell you when a message arrives" means
 * anything.
 *
 * The explainer in front of the system dialog is where the app says what a
 * notification will and will not contain. Android's own dialog has no room
 * for that.
 */
export function NotificationsPrompt({ userId }: NotificationsPromptProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Read the OS state before deciding, not after: an account restored onto
      // a phone that already granted the permission must not be asked again.
      const [granted, canRequest] = await Promise.all([
        hasPushPermission(),
        canRequestPushPermission(),
      ]);
      if (!alive) return;
      setOpen(
        shouldOfferPush({
          native: isMobileNative(),
          granted,
          canRequest,
          alreadyAsked: pushOfferSeen(userId),
        })
      );
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  /** Both answers count as asked. "Not now" that comes back next launch is not
   *  a choice, it is nagging. Settings still has the toggle. */
  function dismiss() {
    markPushOfferSeen(userId);
    setOpen(false);
  }

  async function allow() {
    if (busy) return;
    setBusy(true);
    const ok = await requestPushPermission();
    if (ok) await setPushEnabled(true);
    setBusy(false);
    dismiss();
  }

  if (!open) return null;

  return (
    <Modal
      title={t('notifyPrompt.title')}
      onClose={dismiss}
      className="max-w-sm"
      actions={
        <>
          <button className="btn btn-ghost" onClick={dismiss} disabled={busy}>
            {t('common.notNow')}
          </button>
          <button className="btn btn-primary" onClick={() => void allow()} disabled={busy}>
            {busy ? <span className="loading loading-spinner loading-sm" /> : t('common.turnOn')}
          </button>
        </>
      }
    >
      <div className="flex flex-col items-center text-center gap-3">
        <span className="w-12 h-12 rounded-2xl bg-primary/15 text-primary flex items-center justify-center">
          <Bell className="w-6 h-6" />
        </span>
        <p className="text-sm text-base-content/75 leading-relaxed">
          {t('notifyPrompt.body1')}
        </p>
        <p className="text-sm text-base-content/75 leading-relaxed">
          {t('notifyPrompt.body2')}
        </p>
      </div>
    </Modal>
  );
}
