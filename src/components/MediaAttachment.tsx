import { useState } from 'react';
import { VisualMediaType } from '../lib/types';
import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';
import { MediaLightbox } from './MediaLightbox';
import { ImageOff, Play } from 'lucide-react';

interface MediaAttachmentProps {
  path: string;
  /** The opened file key, from `openRows`. Without it the object is opaque. */
  mediaKey?: Uint8Array | null;
  /** Voice notes are not routed here — see `VoiceNote`. */
  type: VisualMediaType;
}

/**
 * A thumbnail in the conversation. Tapping it opens the full-size viewer, which
 * is where playing and saving happen.
 *
 * The thumbnail deliberately has no controls and no save button of its own.
 * Both used to be here, and between them and the viewer a video offered three
 * different ways to save the same file: a hover-only button that a touch screen
 * never reveals, the browser's own overflow menu, and the viewer. One way is
 * enough, and it is the one you reach by tapping the thing you want.
 */
export function MediaAttachment({ path, type, mediaKey }: MediaAttachmentProps) {
  const { url, failed, reload } = useSignedMediaUrl(path, mediaKey, type);
  const [viewing, setViewing] = useState(false);

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-xs text-base-content/60 py-2">
        <ImageOff className="w-4 h-4" />
        This file is no longer available
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

  return (
    <>
      <button
        type="button"
        className="relative block rounded-lg overflow-hidden cursor-zoom-in"
        onClick={(e) => {
          e.stopPropagation();
          setViewing(true);
        }}
        aria-label={type === 'image' ? 'Open photo' : 'Play video'}
      >
        {type === 'image' ? (
          <img
            src={url}
            alt="attachment"
            loading="lazy"
            className="max-w-full max-h-72 object-cover"
            onError={reload}
          />
        ) : (
          <>
            <video
              // The fragment is the poster. A <video> with no `poster` paints
              // nothing until it has decoded a frame, and "decode a frame" is
              // not something metadata loading does on its own — which is why
              // the thumbnail was a grey box with a play glyph until the video
              // had been played once. Asking for a time offset makes the
              // element seek there, and a seek decodes.
              src={`${url}#t=0.001`}
              preload="metadata"
              muted
              playsInline
              className="max-w-full max-h-72 pointer-events-none"
              onError={reload}
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55">
                <Play className="w-6 h-6 ml-0.5 text-white fill-current" />
              </span>
            </span>
          </>
        )}
      </button>

      {viewing && (
        <MediaLightbox url={url} path={path} type={type} onClose={() => setViewing(false)} />
      )}
    </>
  );
}
