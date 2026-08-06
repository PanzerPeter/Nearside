import { VisualMediaType } from '../lib/types';
import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';
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
  const { url, failed, reload } = useSignedMediaUrl(path, mediaKey);

  async function handleDownload() {
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = path.split('/').pop() || (type === 'image' ? 'image' : 'video');
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      /* best-effort; ignore */
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
      onClick={handleDownload}
      className="absolute top-2 right-2 btn btn-xs btn-circle bg-base-100/70 hover:bg-base-100 border-none opacity-0 group-hover:opacity-100 transition-opacity"
      title="Download"
    >
      <Download className="w-3.5 h-3.5" />
    </button>
  );

  if (type === 'image') {
    return (
      <div className="group relative inline-block">
        <a href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt="attachment"
            loading="lazy"
            className="rounded-lg max-w-full max-h-72 object-cover"
            onError={reload}
          />
        </a>
        {downloadButton}
      </div>
    );
  }

  return (
    <div className="group relative inline-block">
      <video
        src={url}
        controls
        preload="metadata"
        className="rounded-lg max-w-full max-h-72"
        onError={reload}
      />
      {downloadButton}
    </div>
  );
}
