import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Pin,
  PinOff,
  VideoOff,
  X,
} from 'lucide-react';
import type { VisualMediaType } from '../lib/types';
import { videoTrackIsUnsupported } from '../lib/media';
import { downloadName, saveToGallery } from '../lib/download';
import { isPinned, pinMedia, unpinMedia } from '../lib/pins';
import { canCopyImage, copyImage } from '../lib/clipboard';
import { useToast } from '../hooks/useToast';
import { useT } from '../hooks/useT';

interface MediaLightboxProps {
  /** The owning message. Pins are recorded against it, not against the object
   *  path — two forwards of one file share a path, and unpinning one would
   *  otherwise delete the other's bytes. */
  messageId: string;
  /** An object URL for the already-decrypted bytes, owned by the caller. */
  url: string;
  /** The storage object path, which is where the saved file gets its name. */
  path: string;
  type: VisualMediaType;
  /** The message's body, recorded with the pin so a caption survives the
   *  sender's trim along with the picture — see `lib/pin-restore.ts`. */
  caption?: string | null;
  /** The thumbnail already found that this platform decodes no picture out of
   *  the file. Passed so the viewer never mounts a player that would play the
   *  soundtrack of a video it cannot show. */
  noPicture?: boolean;
  /** Where this file sits among the conversation's pictures, 1-based, and how
   *  many there are. Both null when the viewer was opened from somewhere with
   *  no thread behind it — the pinned-media screen — which is also when the
   *  arrows are not drawn. */
  position?: { index: number; total: number } | null;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}

/** How far a finger must travel across the picture before it counts as a move
 *  to the next one rather than a tap that missed. */
const SWIPE_THRESHOLD_PX = 60;

/**
 * Full-size view, in the app, and the one place an attachment can be saved.
 *
 * The previous version was an `<a target="_blank">` around the thumbnail, which
 * cannot work here: Capacitor hands a new window to the system browser, and a
 * `blob:` URL minted inside the WebView does not exist over there. What the
 * user got was a black page of the decrypted bytes rendered as text, with no
 * way back and no way to save. Nothing leaves the WebView now.
 *
 * It is called from inside a message bubble, which is why it needs both a
 * portal and the propagation stops below — see the render.
 */
export function MediaLightbox({
  messageId,
  url,
  path,
  type,
  caption,
  noPicture: noPictureHint,
  position,
  onPrev,
  onNext,
  onClose,
}: MediaLightboxProps) {
  const t = useT();
  // Seeded from the thumbnail and confirmed here, because the viewer can also
  // be reached without one having rendered.
  const [noPicture, setNoPicture] = useState(!!noPictureHint);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [copying, setCopying] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    void isPinned(messageId).then((v) => {
      if (alive) setPinned(v);
    });
    return () => {
      alive = false;
    };
  }, [messageId]);

  // Everything that is true of one picture and not the next. The component is
  // deliberately not remounted between them — see the note where it is
  // rendered — so what a key would have thrown away is cleared here instead.
  // Without it, stepping past a saved photo showed the next one as saved.
  useEffect(() => {
    setSaving(false);
    setSaved(false);
    setCopying(false);
    setPinning(false);
    setNoPicture(!!noPictureHint);
  }, [messageId, noPictureHint]);

  // Hardware and browser back close the viewer rather than the conversation
  // behind it — the same treatment ChatRoom gives an open chat.
  useEffect(() => {
    window.history.pushState({ nearsideLightbox: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.nearsideLightbox) window.history.back();
    };
    // Deliberately once per mount: onClose is a fresh arrow on every parent
    // render, and re-running this would push a history entry per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Held in refs' place by the effect's own dependencies: both handlers are
      // fresh arrows each render, so the listener is re-bound with them.
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  // Swipe, tracked here rather than delegated to the bubble's own swipe: this
  // is a portal, so a gesture on the picture still travels up the React tree to
  // the message it was opened from, and every pointer event is stopped below
  // for exactly that reason. A drag has to be recognised before it is stopped.
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);

  function onSwipeStart(e: React.PointerEvent) {
    swipeFrom.current = { x: e.clientX, y: e.clientY };
  }

  function onSwipeEnd(e: React.PointerEvent) {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    // A mostly-vertical drag is a pull to dismiss on some phones and a scroll
    // everywhere else; either way it is not a request for the next picture.
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(e.clientY - from.y)) return;
    if (dx > 0) onPrev?.();
    else onNext?.();
  }

  async function save() {
    setSaving(true);
    try {
      // Refetching the object URL costs nothing and gets the decrypted bytes
      // with the content type `mimeForPath` gave them.
      const blob = await (await fetch(url)).blob();
      await saveToGallery(blob, downloadName(path, type), type);
      setSaved(true);
      toast.success(t(type === 'image' ? 'lightbox.photoSaved' : 'lightbox.videoSaved'));
    } catch {
      toast.error(t('lightbox.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  /** The picture itself onto the clipboard, not a link to it: the object is
   *  ciphertext behind a URL that expires within the hour, so a pasted address
   *  would be a dead one. Offered for stills only — a clipboard has nowhere to
   *  put a video. */
  async function copyPicture() {
    setCopying(true);
    try {
      await copyImage(await (await fetch(url)).blob());
      toast.success(t('lightbox.copied'));
    } catch {
      toast.error(t('lightbox.copyFailed'));
    } finally {
      setCopying(false);
    }
  }

  /** Pinning is free and always will be: the plaintext goes into this app's
   *  own sandbox, and the server copy then prunes on the ordinary schedule.
   *  Nothing about this is sold. */
  async function togglePin() {
    setPinning(true);
    try {
      if (pinned) {
        await unpinMedia(messageId);
        setPinned(false);
        toast.success(t('lightbox.unpinned'));
      } else {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        await pinMedia(messageId, path, bytes, { mediaType: type, caption: caption ?? '' });
        setPinned(true);
        toast.success(t('lightbox.pinned'));
      }
    } catch {
      toast.error(t('lightbox.pinFailed'));
    } finally {
      setPinning(false);
    }
  }

  // Out of the bubble's DOM subtree. `position: fixed` does not escape one: a
  // bubble mid-swipe carries a `transform`, which makes it the containing block
  // for anything fixed inside it, and it is `overflow-hidden` besides. The
  // viewer would be positioned against — and clipped to — the message it came
  // from.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      onClick={(e) => {
        // A portal moves the DOM node, not the React tree: synthetic events
        // still travel from here up to MessageBubble, whose click, contextmenu
        // and double-click handlers put the reaction menu in the middle of the
        // photo and fired a reply on a double tap. The viewer is a screen of
        // its own and ends every gesture that reaches it.
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // Swipe-to-reply sits on the bubble too, and would read a drag across the
      // picture as a pull on the message behind it.
      onPointerDown={(e) => {
        e.stopPropagation();
        onSwipeStart(e);
      }}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => {
        e.stopPropagation();
        onSwipeEnd(e);
      }}
      onPointerCancel={() => {
        swipeFrom.current = null;
      }}
    >
      <div className="absolute top-0 right-0 left-0 flex items-center gap-2 p-3 pt-safe">
        {position && position.total > 1 && (
          <p className="flex-1 pl-1 text-meta text-white/70">
            {t('lightbox.position', { index: position.index, total: position.total })}
          </p>
        )}
        <span className="flex-1" />
        <button
          className="btn btn-sm btn-circle bg-base-100/20 hover:bg-base-100/40 border-none text-white"
          onClick={(e) => {
            e.stopPropagation();
            void togglePin();
          }}
          disabled={pinning}
          title={pinned ? t('lightbox.pinnedTitle') : t('lightbox.pinTitle')}
          aria-label={pinned ? t('lightbox.unpinLabel') : t('lightbox.pinLabel')}
          aria-pressed={pinned}
        >
          {pinning ? (
            <span className="loading loading-spinner loading-xs" />
          ) : pinned ? (
            <PinOff className="w-4 h-4" />
          ) : (
            <Pin className="w-4 h-4" />
          )}
        </button>
        {type === 'image' && canCopyImage() && (
          <button
            className="btn btn-sm btn-circle bg-base-100/20 hover:bg-base-100/40 border-none text-white"
            onClick={(e) => {
              e.stopPropagation();
              void copyPicture();
            }}
            disabled={copying}
            title={t('lightbox.copy')}
            aria-label={t('lightbox.copy')}
          >
            {copying ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}
        <button
          className="btn btn-sm btn-circle bg-base-100/20 hover:bg-base-100/40 border-none text-white"
          onClick={(e) => {
            e.stopPropagation();
            void save();
          }}
          disabled={saving || saved}
          title={saved ? t('lightbox.saved') : t('common.save')}
          aria-label={saved ? t('lightbox.savedToGallery') : t('lightbox.saveToGallery')}
        >
          {saving ? (
            <span className="loading loading-spinner loading-xs" />
          ) : saved ? (
            <Check className="w-4 h-4" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </button>
        <button
          className="btn btn-sm btn-circle bg-base-100/20 hover:bg-base-100/40 border-none text-white"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Either side of the picture, and only when there is one to move to.
          Hidden from a screen reader on a coarse pointer would be wrong — the
          swipe is not discoverable there either — so both stay in the tree and
          the reader is told which direction each goes. */}
      {onPrev && (
        <button
          className="absolute left-2 z-10 btn btn-sm btn-circle border-none bg-base-100/20 text-white hover:bg-base-100/40"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          title={t('lightbox.previous')}
          aria-label={t('lightbox.previous')}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {onNext && (
        <button
          className="absolute right-2 z-10 btn btn-sm btn-circle border-none bg-base-100/20 text-white hover:bg-base-100/40"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          title={t('lightbox.next')}
          aria-label={t('lightbox.next')}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}

      {/* Stops a tap on the media itself from closing the viewer — only the
          backdrop does that. */}
      <div className="max-w-full max-h-full p-4" onClick={(e) => e.stopPropagation()}>
        {type === 'image' ? (
          <img
            src={url}
            alt={t('media.attachment')}
            className="max-w-full max-h-[85dvh] object-contain"
          />
        ) : noPicture ? (
          // The file is here and intact — it is this build that has no decoder
          // for it. Say that, rather than "no longer available", and point at
          // the save button, which is the way out.
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-white/75">
            <VideoOff className="w-8 h-8" />
            <p className="text-body">{t('lightbox.unplayableBody')}</p>
          </div>
        ) : (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            // The browser's own overflow menu offers a download that writes
            // nowhere useful from inside a WebView, and a second save button
            // that behaves differently from the first is worse than none.
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            className="max-w-full max-h-[85dvh]"
            // The transport bar is a horizontal drag by design, and every one
            // of them would otherwise land on the next video.
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onLoadedMetadata={(e) => {
              if (videoTrackIsUnsupported(e.currentTarget)) setNoPicture(true);
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
