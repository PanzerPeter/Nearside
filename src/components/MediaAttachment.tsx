import { useState } from 'react';
import { VisualMediaType } from '../lib/types';
import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';
import { downloadName, saveBlob } from '../lib/download';
import { useToast } from '../hooks/useToast';
import { MediaLightbox } from './MediaLightbox';
import { ImageOff, Download } from 'lucide-react';

interface MediaAttachmentProps {
  path: string;
  /** The opened file key, from `openRows`. Without it the object is opaque. */
  mediaKey?: Uint8Array | null;
  /** Voice notes are not routed here — see `VoiceNote`. */
  type: VisualMediaType;
}

/**
 * Renders a piece of chat media from the private `chat-media` bucket using a
 * short-lived signed URL. Falls back gracefully when the file has been removed
 * (e.g. trimmed by the per-conversation media cap).
 */
export function MediaAttachment({ path, type, mediaKey }: MediaAttachmentProps) {
  const { url, failed, reload } = useSignedMediaUrl(path, mediaKey, type);
  const [viewing, setViewing] = useState(false);
  const toast = useToast();

  async function handleDownload() {
    if (!url) return;
    try {
      // The blob behind `url` is already the decrypted file, carrying the type
      // `mimeForPath` gave it — refetching it costs nothing and keeps this
      // function ignorant of how the hook stores its bytes.
      const blob = await (await fetch(url)).blob();
      await saveBlob(blob, downloadName(path, type === 'image' ? 'image' : 'video'));
    } catch {
      toast.error('Could not save that file.');
    }
  }

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-xs text-base-content/60 py-2">
        <ImageOff className="w-4 h-4" />
        Media no longer available
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex items-center justify-center w-40 h-40 rounded-lg bg-base-content/5">
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  const downloadButton = (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void handleDownload();
      }}
      className="absolute top-2 right-2 btn btn-xs btn-circle bg-base-100/70 hover:bg-base-100 border-none opacity-0 group-hover:opacity-100 transition-opacity"
      title="Save"
    >
      <Download className="w-3.5 h-3.5" />
    </button>
  );

  return (
    <>
      <div className="group relative inline-block">
        {type === 'image' ? (
          <img
            src={url}
            alt="attachment"
            loading="lazy"
            className="rounded-lg max-w-full max-h-72 object-cover cursor-zoom-in"
            onClick={(e) => {
              e.stopPropagation();
              setViewing(true);
            }}
            onError={reload}
          />
        ) : (
          <video
            src={url}
            controls
            preload="metadata"
            className="rounded-lg max-w-full max-h-72"
            onError={reload}
          />
        )}
        {downloadButton}
      </div>

      {viewing && (
        <MediaLightbox
          url={url}
          type={type}
          onDownload={() => void handleDownload()}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}
