import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Message } from '../lib/types';
import { openViewOnce, viewOnceState } from '../lib/view-once';
import { setScreenGuard } from '../lib/screen-guard';
import { useMobileBackClose } from '../hooks/useMobileBackClose';
import { useToast } from '../hooks/useToast';
import { useT } from '../hooks/useT';

/** The "1" in a dashed ring that marks a view-once message, sized to sit in a
 *  line of bubble text. */
function OnceMark({ spent }: { spent: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-meta font-semibold ${
        spent ? 'border-current/40 opacity-60' : 'border-dashed border-current'
      }`}
    >
      1
    </span>
  );
}

/**
 * A view-once photo or video in the thread.
 *
 * There is no thumbnail to draw — 0058 refuses one, because a small copy would
 * outlive the deletion — so the bubble is a label that says what kind of thing
 * is waiting and whether it has been opened. The sender gets the same label and
 * cannot open it: it was sent to someone else, and they get the one view.
 */
export function ViewOnceAttachment({ msg, me }: { msg: Message; me: string }) {
  const t = useT();
  const toast = useToast();
  const state = viewOnceState(msg, me);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const kind = msg.media_type === 'video' ? t('viewOnce.video') : t('viewOnce.photo');

  async function open() {
    if (state !== 'ready' || loading) return;
    setLoading(true);
    try {
      setUrl(await openViewOnce(msg));
    } catch (error) {
      console.error('view-once open failed', error);
      toast.error(t('viewOnce.failed'));
    } finally {
      setLoading(false);
    }
  }

  const status =
    state === 'ready'
      ? t('viewOnce.tapToOpen')
      : state === 'sent'
        ? t('viewOnce.notOpened')
        : t('viewOnce.opened');

  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        disabled={state !== 'ready' || loading}
        className="flex items-center gap-3 py-1 pr-2 text-left disabled:cursor-default"
      >
        {loading ? (
          <span className="loading loading-spinner loading-sm w-7" />
        ) : (
          <OnceMark spent={state === 'opened' || state === 'seen'} />
        )}
        <span className="min-w-0">
          <span className="block text-body font-medium">{kind}</span>
          <span className="block text-meta opacity-75">{status}</span>
        </span>
      </button>
      {url && (
        <ViewOnceViewer
          url={url}
          video={msg.media_type === 'video'}
          onClose={() => {
            URL.revokeObjectURL(url);
            setUrl(null);
          }}
        />
      )}
    </>
  );
}

function ViewOnceViewer({
  url,
  video,
  onClose,
}: {
  url: string;
  video: boolean;
  onClose: () => void;
}) {
  const t = useT();
  useMobileBackClose(true, onClose);

  // Screenshots, recording and the recents thumbnail are blocked for as long
  // as the picture is up, under a reason of its own so the app lock's hold is
  // not released with it.
  useEffect(() => {
    void setScreenGuard(true, 'view-once');
    return () => void setScreenGuard(false, 'view-once');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('viewOnce.viewer')}
      className="fixed inset-0 z-[70] flex flex-col bg-black select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between px-3 pt-[calc(0.75rem+var(--safe-top))] pb-2 text-white">
        <span className="text-meta opacity-80">{t('viewOnce.viewerHint')}</span>
        <button
          type="button"
          className="btn btn-ghost btn-circle text-white"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <X className="w-6 h-6" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center pb-(--safe-bottom)">
        {video ? (
          <video
            src={url}
            autoPlay
            playsInline
            controls
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            className="max-h-full max-w-full"
          />
        ) : (
          <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        )}
      </div>
    </div>,
    document.body
  );
}
