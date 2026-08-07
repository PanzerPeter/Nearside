import { useEffect } from 'react';
import { Download, X } from 'lucide-react';
import type { VisualMediaType } from '../lib/types';

interface MediaLightboxProps {
  /** An object URL for the already-decrypted bytes, owned by the caller. */
  url: string;
  type: VisualMediaType;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * Full-size view, in the app.
 *
 * The previous version was an `<a target="_blank">` around the thumbnail, which
 * cannot work here: Capacitor hands a new window to the system browser, and a
 * `blob:` URL minted inside the WebView does not exist over there. What the
 * user got was a black page of the decrypted bytes rendered as text, with no
 * way back and no way to save. Nothing leaves the WebView now.
 */
export function MediaLightbox({ url, type, onDownload, onClose }: MediaLightboxProps) {
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
            onDownload();
          }}
          title="Save"
        >
          <Download className="w-4 h-4" />
        </button>
        <button
          className="btn btn-sm btn-circle bg-base-100/20 hover:bg-base-100/40 border-none text-white"
          onClick={onClose}
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Stops a tap on the media itself from closing the viewer — only the
          backdrop does that. */}
      <div className="max-w-full max-h-full p-4" onClick={(e) => e.stopPropagation()}>
        {type === 'image' ? (
          <img src={url} alt="attachment" className="max-w-full max-h-[85dvh] object-contain" />
        ) : (
          <video src={url} controls autoPlay className="max-w-full max-h-[85dvh]" />
        )}
      </div>
    </div>
  );
}
