import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
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

interface NotificationsPromptProps {
  /** The signed-in account. The offer is remembered per account, so two people
   *  sharing a phone are each asked once. */
  userId: string;
}

/**
 * The one-time offer that gets a new install asked for notifications.
 *
 * Before this, nothing in the app ever asked. The permission lived behind a
 * toggle in Settings, so an install that never opened that screen never saw
 * Android's dialog, never registered with OneSignal, and never received a
 * notification, with nothing anywhere explaining why.
 *
 * It is deliberately not asked at launch. Android only offers its dialog once,
 * and a dialog that appears before the person has any idea what the app is gets
 * dismissed, which spends the single chance for nothing. This waits until the
 * account and the recovery phrase are done, which is the first moment "we can
 * tell you when a message arrives" is a sentence with meaning behind it.
 *
 * The explainer in front of the system dialog is not decoration either. It is
 * where the app can say what a notification will and will not contain, and
 * Android's own dialog has no room for that.
 */
export function NotificationsPrompt({ userId }: NotificationsPromptProps) {
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
          native: Capacitor.isNativePlatform(),
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
      title="Get told when a message arrives"
      onClose={dismiss}
      className="max-w-sm"
      actions={
        <>
          <button className="btn btn-ghost" onClick={dismiss} disabled={busy}>
            Not now
          </button>
          <button className="btn btn-primary" onClick={() => void allow()} disabled={busy}>
            {busy ? <span className="loading loading-spinner loading-sm" /> : 'Turn on'}
          </button>
        </>
      }
    >
      <div className="flex flex-col items-center text-center gap-3">
        <span className="w-12 h-12 rounded-2xl bg-primary/15 text-primary flex items-center justify-center">
          <Bell className="w-6 h-6" />
        </span>
        <p className="text-sm text-base-content/75 leading-relaxed">
          Without this, Nearside can only reach you while it is open on screen.
        </p>
        <p className="text-sm text-base-content/75 leading-relaxed">
          A notification says who wrote to you and nothing else. It cannot quote a message, because
          the server has no readable copy of one to quote. You can turn this off again in Settings
          whenever you like.
        </p>
      </div>
    </Modal>
  );
}
