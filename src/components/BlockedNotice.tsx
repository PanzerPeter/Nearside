import { Ban } from 'lucide-react';
import type { BlockStatus } from '../lib/blocks';
import { useT } from '../hooks/useT';

interface BlockedNoticeProps {
  status: Exclude<BlockStatus, 'none'>;
  peerLabel: string;
  busy: boolean;
  onUnblock: () => void;
}

/**
 * What stands in for the composer while either side has blocked.
 *
 * Replaced rather than disabled, like `KeyChangedNotice`: a greyed-out box
 * invites typing into a conversation that cannot send. The blocked side is
 * told plainly, and only the side that placed a block is offered a way out of
 * it — when both have, lifting yours is said not to be enough.
 */
export function BlockedNotice({ status, peerLabel, busy, onUnblock }: BlockedNoticeProps) {
  const t = useT();
  const mine = status === 'byMe' || status === 'both';
  return (
    <div className="p-4 pb-[calc(1rem+var(--safe-bottom))] border-t border-hairline bg-base-100">
      <div className="flex items-start gap-3">
        <Ban className="w-5 h-5 text-subtle shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-strong">
            {mine
              ? t('block.byMeTitle', { name: peerLabel })
              : t('block.byThemTitle', { name: peerLabel })}
          </p>
          <p className="text-meta text-muted mt-1">
            {mine ? t('block.byMeBody') : t('block.byThemBody')}
          </p>
          {status === 'both' && (
            <p className="text-meta text-muted mt-1">{t('block.bothBody', { name: peerLabel })}</p>
          )}
          {mine && (
            <button className="btn btn-sm btn-outline mt-3" onClick={onUnblock} disabled={busy}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : t('chat.unblock')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
