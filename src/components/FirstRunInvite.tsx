import { Camera, QrCode, Users } from 'lucide-react';
import { useT } from '../hooks/useT';

interface FirstRunInviteProps {
  /** Opens the connect dialog on the code this device shows. */
  onShowCode: () => void;
  /** Opens the same dialog on the camera, for the person holding the other phone. */
  onScan: () => void;
  onCreateRoom: () => void;
}

/**
 * The whole first screen after a sign-up, in one card.
 *
 * Rendered only while the account has no contacts and no rooms — the state a
 * new user lands in and the only one where every list on this pane is empty.
 * Without it that pane is two section labels, two lines of grey explanation and
 * the self-chat row, with the one action that changes any of it sitting in the
 * corner as an unlabelled icon. Both directions are offered because connecting
 * takes two people and only one of them has to scan.
 */
export function FirstRunInvite({ onShowCode, onScan, onCreateRoom }: FirstRunInviteProps) {
  const t = useT();
  return (
    <div className="mx-2 sm:mx-3 mt-3 rounded-2xl border border-primary/15 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-11 h-11 rounded-2xl bg-primary/15 text-primary flex items-center justify-center">
          <QrCode className="w-5 h-5" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-base-content">{t('firstRun.title')}</p>
          <p className="mt-1 text-xs leading-relaxed text-base-content/60">
            {t('firstRun.body')}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          className="btn btn-primary btn-sm flex-1 gap-1.5 shadow-md shadow-primary/20"
          onClick={onShowCode}
        >
          <QrCode className="w-4 h-4" />
          {t('firstRun.myCode')}
        </button>
        <button
          className="btn btn-outline btn-sm flex-1 gap-1.5 border-primary/30 text-primary hover:border-primary/40 hover:bg-primary/10"
          onClick={onScan}
        >
          <Camera className="w-4 h-4" />
          {t('firstRun.scan')}
        </button>
      </div>

      <button
        className="btn btn-ghost btn-xs mt-1.5 w-full gap-1.5 font-normal text-base-content/60"
        onClick={onCreateRoom}
      >
        <Users className="w-3.5 h-3.5" />
        {t('firstRun.startRoom')}
      </button>
    </div>
  );
}
