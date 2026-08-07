import { ShieldAlert, ShieldCheck } from 'lucide-react';

interface KeyChangedNoticeProps {
  /** Null when the peer has published no key at all, so there is nothing to
   *  compare and the button has nothing to open. */
  peerKey: Uint8Array | null;
  onVerify: () => void;
}

/**
 * What stands in for the composer once the peer's key has changed under us.
 *
 * The composer is replaced rather than disabled: a greyed-out box invites
 * hunting for the way around it, and there deliberately isn't one until
 * somebody has looked at a safety number.
 */
export function KeyChangedNotice({ peerKey, onVerify }: KeyChangedNoticeProps) {
  return (
    <div className="p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] border-t border-error/30 bg-error/10">
      <div className="flex items-start gap-3">
        <ShieldAlert className="w-5 h-5 text-error shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-error">Their key changed.</p>
          <p className="text-sm text-base-content/70 mt-1">
            This happens when someone reinstalls the app or restores from a recovery phrase. It is
            also what someone listening in would look like. Compare safety numbers in person before
            you carry on.
          </p>
          <button className="btn btn-error btn-sm mt-3 gap-1.5" onClick={onVerify} disabled={!peerKey}>
            <ShieldCheck className="w-4 h-4" />
            Compare safety numbers
          </button>
        </div>
      </div>
    </div>
  );
}
