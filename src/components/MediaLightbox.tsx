import { useEffect, useState } from 'react';
import { Check, Download, Pin, PinOff, VideoOff, X } from 'lucide-react';
import type { VisualMediaType } from '../lib/types';
import { videoTrackIsUnsupported } from '../lib/media';
import { downloadName, saveToGallery } from '../lib/download';
import { isPinned, pinMedia, unpinMedia } from '../lib/pins';
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
  /** The thumbnail already found that this platform decodes no picture out of
   *  the file. Passed so the viewer never mounts a player that would play the
   *  soundtrack of a video it cannot show. */
  noPicture?: boolean;
  onClose: () => void;
}

/**
 * Full-size view, in the app, and the one place an attachment can be saved.
 *
 * The previous version was an `<a target="_blank">` around the thumbnail, which
 * cannot work here: Capacitor hands a new window to the system browser, and a
 * `blob:` URL minted inside the WebView does not exist over there. What the
 * user got was a black page of the decrypted bytes rendered as text, with no
 * way back and no way to save. Nothing leaves the WebView now.
 */
export function MediaLightbox({
  messageId,
  url,
  path,
  type,
  noPicture: noPictureHint,
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    try {
      // Refetching the object URL costs nothing and gets the decrypted bytes
      // with the content type `mimeForPath` gave them.
      const blob = await (await fetch(url)).blob();
      await saveToGallery(blob, downloadName(path, type), type);
      setSaved(true);
      toast.success(type === 'image' ? 'Photo saved to your gallery.' : 'Video saved to your gallery.');
    } catch {
      toast.error(t('lightbox.saveFailed'));
    } finally {
      setSaving(false);
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
        await pinMedia(messageId, path, bytes);
        setPinned(true);
        toast.success(t('lightbox.pinned'));
      }
    } catch {
      toast.error(t('lightbox.pinFailed'));
    } finally {
      setPinning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute top-0 right-0 left-0 flex justify-end gap-2 p-3 pt-safe">
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

      {/* Stops a tap on the media itself from closing the viewer — only the
          backdrop does that. */}
      <div className="max-w-full max-h-full p-4" onClick={(e) => e.stopPropagation()}>
        {type === 'image' ? (
          <img src={url} alt="attachment" className="max-w-full max-h-[85dvh] object-contain" />
        ) : noPicture ? (
          // The file is here and intact — it is this build that has no decoder
          // for it. Say that, rather than "no longer available", and point at
          // the save button, which is the way out.
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-white/75">
            <VideoOff className="w-8 h-8" />
            <p className="text-sm">
              This video's format can't be played here. Save it and open it in a video
              player.
            </p>
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
            onLoadedMetadata={(e) => {
              if (videoTrackIsUnsupported(e.currentTarget)) setNoPicture(true);
            }}
          />
        )}
      </div>
    </div>
  );
}
