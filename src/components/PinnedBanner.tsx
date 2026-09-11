import { Pin, X } from 'lucide-react';
import { useT } from '../hooks/useT';

interface PinnedBannerProps {
  /** One line of the pinned message. Null while the message has not been found
   *  — see the render for why that is a state worth drawing rather than
   *  hiding. */
  snippet: string | null;
  /** Who pinned it, already named by the caller. */
  by: string;
  onJump: () => void;
  onUnpin: () => void;
  busy?: boolean;
}

/**
 * The pinned message, under the conversation's header.
 *
 * One line, never more. A banner that grows with the message would push the
 * conversation down the screen, and the pinned line is a reference — the
 * address, the code, the time — not something to be read at length in place;
 * tapping it goes to the message itself.
 *
 * A pin whose message this device has not loaded still draws. The alternative
 * is a banner that appears once the thread has scrolled far enough back, which
 * reads as a bug; saying that something is pinned and that it has not been
 * found here yet is both true and tappable, and the jump is what loads it.
 */
export function PinnedBanner({ snippet, by, onJump, onUnpin, busy }: PinnedBannerProps) {
  const t = useT();

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-base-100 px-3 py-1.5 sm:px-4">
      <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />
      <button
        type="button"
        onClick={onJump}
        className="min-w-0 flex-1 text-left"
        title={t('pin.jump')}
      >
        <span className="block text-micro font-semibold uppercase tracking-wider text-subtle">
          {t('pin.by', { name: by })}
        </span>
        <span className="block truncate text-meta text-strong">
          {snippet ?? t('pin.notLoaded')}
        </span>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square shrink-0"
        onClick={onUnpin}
        disabled={busy}
        title={t('pin.unpin')}
        aria-label={t('pin.unpin')}
      >
        {busy ? <span className="loading loading-spinner loading-xs" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
