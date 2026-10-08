import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Plus, Send, Trash2, X } from 'lucide-react';
import type { StagedMedia } from '../lib/staging';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { useMobileBackClose } from '../hooks/useMobileBackClose';
import { useT } from '../hooks/useT';

/** How far a horizontal drag has to travel before it counts as a swipe. */
const SWIPE_PX = 50;

interface MediaReviewProps {
  staged: StagedMedia[];
  /** Object URLs by staged id, owned and revoked by the composer. */
  previewUrls: Record<string, string>;
  /** The first file's caption is the composer's draft, so a line typed before
   *  the picker opened is not lost and Send means the same thing it did. */
  firstCaption: string;
  onFirstCaption: (value: string) => void;
  onCaption: (id: string, value: string) => void;
  onUnstage: (id: string) => void;
  onDiscard: () => void;
  onAddMore: () => void;
  hd: boolean;
  onHd: (on: boolean) => void;
  viewOnce: boolean;
  onViewOnce: (on: boolean) => void;
  canViewOnce: boolean;
  onSend: () => void;
  busy: boolean;
  sentCount: number;
  replyingTo: string | null;
}

/**
 * The send screen for photos and videos: the whole screen, one file at a time.
 *
 * It replaced a strip of 64px thumbnails above the composer, where what was
 * about to be sent could not actually be seen, every caption but the first had
 * nowhere to go, and there was no room for a choice like "send this at full
 * size" or "let them see it once". Swiping steps through the pick; the rail at
 * the foot shows the whole of it and is where files are added and dropped.
 */
export function MediaReview({
  staged,
  previewUrls,
  firstCaption,
  onFirstCaption,
  onCaption,
  onUnstage,
  onDiscard,
  onAddMore,
  hd,
  onHd,
  viewOnce,
  onViewOnce,
  canViewOnce,
  onSend,
  busy,
  sentCount,
  replyingTo,
}: MediaReviewProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const at = Math.min(index, staged.length - 1);
  const current = staged[at];
  const swipeFrom = useRef<number | null>(null);
  const hasImage = staged.some((item) => item.file.type.startsWith('image/'));

  useMobileBackClose(true, onDiscard);

  function step(by: number) {
    setIndex((i) => Math.max(0, Math.min(staged.length - 1, Math.min(i, staged.length - 1) + by)));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The caption field owns the arrow keys while it is being typed in.
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'Escape') onDiscard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!current) return null;
  const url = previewUrls[current.id];
  const isVideo = current.file.type.startsWith('video/');
  const caption = at === 0 ? firstCaption : (current.caption ?? '');

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('review.title')}
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
    >
      <div className="flex items-center gap-2 px-2 pt-[calc(0.5rem+var(--safe-top))] pb-2">
        <button
          type="button"
          className="btn btn-ghost btn-circle text-white"
          onClick={onDiscard}
          disabled={busy}
          title={t('review.discard')}
          aria-label={t('review.discard')}
        >
          <X className="w-6 h-6" />
        </button>
        <p className="flex-1 text-center text-meta text-white/80 tabular-nums">
          {busy
            ? t('composer.sendingProgress', {
                index: Math.min(sentCount + 1, staged.length),
                total: staged.length,
              })
            : staged.length > 1
              ? t('review.position', { index: at + 1, total: staged.length })
              : ''}
        </p>
        <button
          type="button"
          className={`btn btn-ghost btn-circle text-white ${staged.length > 1 ? '' : 'invisible'}`}
          onClick={() => onUnstage(current.id)}
          disabled={busy}
          title={t('composer.removeThisFile')}
          aria-label={t('composer.removeThisFile')}
        >
          <Trash2 className="w-5 h-5" />
        </button>
      </div>

      <div
        className="relative flex-1 min-h-0 flex items-center justify-center touch-pan-y"
        onPointerDown={(e) => {
          swipeFrom.current = e.clientX;
        }}
        onPointerUp={(e) => {
          const from = swipeFrom.current;
          swipeFrom.current = null;
          if (from === null) return;
          const dx = e.clientX - from;
          if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => {
          swipeFrom.current = null;
        }}
      >
        {url &&
          (isVideo ? (
            <video
              key={current.id}
              src={url}
              controls
              playsInline
              className="max-h-full max-w-full"
            />
          ) : (
            <img
              key={current.id}
              src={url}
              alt={t('composer.attachmentN', { index: at + 1 })}
              draggable={false}
              className="max-h-full max-w-full object-contain select-none"
            />
          ))}
        {/* Swipe is the phone's way between files; a mouse has no swipe. */}
        {at > 0 && (
          <button
            type="button"
            className="pointer-coarse:hidden absolute left-3 btn btn-circle bg-black/50 border-0 text-white"
            onClick={() => step(-1)}
            aria-label={t('review.previous')}
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {at < staged.length - 1 && (
          <button
            type="button"
            className="pointer-coarse:hidden absolute right-3 btn btn-circle bg-black/50 border-0 text-white"
            onClick={() => step(1)}
            aria-label={t('review.next')}
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] bg-gradient-to-t from-black via-black/90 to-transparent">
        <div className="flex gap-2 overflow-x-auto pb-3 scrollbar-none [&::-webkit-scrollbar]:hidden">
          {staged.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={t('composer.attachmentN', { index: i + 1 })}
              aria-current={i === at}
              className={`relative shrink-0 w-14 h-14 rounded-field overflow-hidden ring-2 transition ${
                i === at ? 'ring-white' : 'ring-transparent opacity-60'
              }`}
            >
              {item.file.type.startsWith('video/') ? (
                <video src={previewUrls[item.id]} muted className="w-full h-full object-cover" />
              ) : (
                <img src={previewUrls[item.id]} alt="" className="w-full h-full object-cover" />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={onAddMore}
            disabled={busy}
            title={t('review.add')}
            aria-label={t('review.add')}
            className="shrink-0 w-14 h-14 rounded-field border-2 border-dashed border-white/40 flex items-center justify-center text-white/80"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 pb-3">
          {hasImage && (
            <Chip on={hd} onClick={() => onHd(!hd)} disabled={busy}>
              {t('review.hd')}
            </Chip>
          )}
          {canViewOnce && (
            <Chip on={viewOnce} onClick={() => onViewOnce(!viewOnce)} disabled={busy}>
              <span
                aria-hidden
                className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-dashed border-current text-[10px] font-semibold"
              >
                1
              </span>
              {t('viewOnce.toggle')}
            </Chip>
          )}
        </div>
        {viewOnce && <p className="pb-3 text-meta text-white/70">{t('viewOnce.toggleHint')}</p>}
        {replyingTo && (
          <p className="pb-2 text-meta text-white/70 truncate">
            {t('composer.replyingTo', { name: replyingTo })}
          </p>
        )}

        <div className="flex items-center gap-2">
          {/* No caption on a view-once file: it would be kept after the
              picture is gone. */}
          <input
            type="text"
            className="input flex-1 min-w-0 rounded-box bg-white/10 border-white/15 text-white placeholder:text-white/50 focus:border-white/40 focus:outline-hidden"
            placeholder={viewOnce ? t('review.noCaption') : t('composer.caption')}
            disabled={viewOnce || busy}
            maxLength={MAX_MESSAGE_LENGTH}
            value={viewOnce ? '' : caption}
            onChange={(e) =>
              at === 0 ? onFirstCaption(e.target.value) : onCaption(current.id, e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!busy) onSend();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary btn-circle relative"
            onClick={onSend}
            disabled={busy}
            title={t('common.send')}
            aria-label={t('composer.sendMessage')}
          >
            {busy ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <Send className="w-4.5 h-4.5" />
            )}
            {staged.length > 1 && !busy && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-white text-black text-micro font-semibold flex items-center justify-center">
                {staged.length}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Chip({
  on,
  onClick,
  disabled,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-meta font-medium border transition-colors ${
        on ? 'bg-white text-black border-white' : 'bg-white/10 text-white border-white/20'
      }`}
    >
      {children}
    </button>
  );
}
