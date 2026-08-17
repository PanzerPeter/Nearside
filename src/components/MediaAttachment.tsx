import { useEffect, useState } from 'react';
import { VisualMediaType } from '../lib/types';
import { useSignedMediaUrl } from '../hooks/useSignedMediaUrl';
import { MediaLightbox } from './MediaLightbox';
import { mediaFailureNotice, videoTrackIsUnsupported } from '../lib/media';
import { ImageOff, Play, VideoOff } from 'lucide-react';
import { useT } from '../hooks/useT';

interface MediaAttachmentProps {
  /** The owning message, so the viewer can pin it and so a pruned object can
   *  fall back to the pinned copy. */
  messageId: string;
  path: string;
  /** The opened file key, from `openRows`. Without it the object is opaque. */
  mediaKey?: Uint8Array | null;
  /** Voice notes are not routed here — see `VoiceNote`. */
  type: VisualMediaType;
  /** Stretch the thumbnail to the bubble's full width, cropping what won't
   *  fit. Set when a caption is what sizes the bubble: left at its natural
   *  width, a picture narrower than the text leaves a band of bubble colour
   *  down one side that reads as a rendering fault. */
  fill?: boolean;
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
export function MediaAttachment({ messageId, path, type, mediaKey, fill }: MediaAttachmentProps) {
  const t = useT();
  // Deferred: the placeholder below reserves the slot at the right size, so
  // nothing jumps when the picture lands, and a page of thirty messages stops
  // downloading the twenty-five attachments that are nowhere near the screen.
  const { url, failure, reload, probeRef } = useSignedMediaUrl(
    path,
    mediaKey,
    type,
    messageId,
    true
  );
  const [viewing, setViewing] = useState(false);
  // Set when this platform demuxed the file but could not decode its picture —
  // an HEVC clip in the desktop shell. Without it the thumbnail is a grey box
  // with a play glyph that promises a video and delivers its soundtrack.
  const [noPicture, setNoPicture] = useState(false);
  useEffect(() => setNoPicture(false), [url]);

  // The caller pulls this component out to the bubble's edges with a negative
  // margin; the placeholder and the failure notice are text, and text wants the
  // padding back.
  if (failure) {
    // A video this build cannot decode gets the video glyph, matching the
    // notice the viewer already draws for the same file (`MediaLightbox`).
    const FailIcon = type === 'video' && failure === 'undecodable' ? VideoOff : ImageOff;
    return (
      // The bubble may be floating its timestamp over the bottom-right corner
      // on the assumption that a picture is there; the extra right pad keeps
      // the words clear of it.
      <div className="flex items-center gap-2 py-2 pl-3.5 pr-16 text-xs text-base-content/60">
        <FailIcon className="w-4 h-4 shrink-0" />
        {mediaFailureNotice(failure, type)}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        ref={probeRef}
        className={`flex items-center justify-center bg-base-content/5 ${
          fill ? 'w-full h-40' : 'mx-3.5 w-40 h-40 rounded-lg'
        }`}
      >
        <span className="loading loading-spinner loading-sm" />
      </div>
    );
  }

  // `w-full` on a replaced element still contributes its intrinsic width to the
  // bubble's shrink-to-fit sizing, so a wide photo keeps setting the bubble's
  // width and only a picture narrower than the caption is stretched up to it.
  // max-h keeps a portrait crop from taking the whole screen; the full frame is
  // one tap away in the viewer.
  const frame = fill ? 'block w-full max-h-72 object-cover' : 'block max-w-full max-h-72 object-cover';

  return (
    <>
      <button
        type="button"
        // Square corners, and the caller rounds. The thumbnail sits flush
        // against the bubble's edges now, so any radius of its own would cut
        // four notches of bubble colour into the picture's corners.
        // `w-full` on the button as well as the image: a form control sizes to
        // fit-content even as a block, so on its own the image's 100% resolved
        // against a box already shrunk to the picture.
        className={`relative block overflow-hidden cursor-zoom-in ${fill ? 'w-full' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setViewing(true);
        }}
        aria-label={type === 'image' ? 'Open photo' : 'Play video'}
      >
        {type === 'image' ? (
          <img
            src={url}
            alt={t('media.attachment')}
            loading="lazy"
            // `block`: an inline image leaves a baseline gap under it, which
            // used to hide inside the bubble's padding and now would show as a
            // strip of bubble colour along the bottom edge.
            className={frame}
            onError={reload}
          />
        ) : noPicture ? (
          // Still a button, and still opening the viewer: saving the file is
          // the only thing left that can be done with it, and the viewer is
          // where saving lives.
          <div
            className={`flex flex-col items-center justify-center gap-1.5 bg-base-content/5 text-base-content/60 ${
              fill ? 'w-full h-40' : 'w-40 h-40'
            }`}
          >
            <VideoOff className="w-5 h-5" />
            <span className="px-3 text-center text-[0.7rem] leading-tight">
              {t('media.unplayable')}
            </span>
          </div>
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
              className={`${frame} pointer-events-none`}
              onError={reload}
              onLoadedMetadata={(e) => {
                if (videoTrackIsUnsupported(e.currentTarget)) setNoPicture(true);
              }}
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
        <MediaLightbox
          messageId={messageId}
          url={url}
          path={path}
          type={type}
          // What the thumbnail already learned, so the viewer does not mount a
          // player that would start the soundtrack before finding out for
          // itself.
          noPicture={noPicture}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}
