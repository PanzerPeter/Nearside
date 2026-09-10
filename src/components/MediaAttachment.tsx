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
  /** The small sealed copy, when the sender's build made one. This is what the
   *  bubble draws; `path` is reserved for the viewer. Null on every message
   *  sent before 0044, on animations and on stickers, and null simply means the
   *  bubble draws the full object as it always did. */
  thumbPath?: string | null;
  /** The opened file key, from `openRows`. Without it the object is opaque. */
  mediaKey?: Uint8Array | null;
  /** Voice notes are not routed here — see `VoiceNote`. */
  type: VisualMediaType;
  /** The bubble's text, passed through to the viewer so pinning can keep it
   *  alongside the picture. */
  caption?: string | null;
  /** These media columns were put back from this device's pin, so the object
   *  they name is already gone — read the pinned copy and do not spend a
   *  signature and a failed download proving it. */
  restored?: boolean;
  /** The row's disappearing stamp, passed through to the viewer: an attachment
   *  with a timer on it is never kept on the device, whatever the retention
   *  setting says. */
  expiresAt?: string | null;
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
export function MediaAttachment({
  messageId,
  path,
  thumbPath,
  type,
  mediaKey,
  caption,
  restored,
  expiresAt,
  fill,
}: MediaAttachmentProps) {
  const t = useT();
  // The thumbnail when there is one, the full object when there is not. A
  // pinned copy is exempt: `restored` means the server object is gone and the
  // kept bytes are the only source, and this device pinned the full file.
  const drawPath = !restored && thumbPath ? thumbPath : path;
  // Deferred: the placeholder below reserves the slot at the right size, so
  // nothing jumps when the picture lands, and a page of thirty messages stops
  // downloading the twenty-five attachments that are nowhere near the screen.
  const { url, failure, reload, probeRef } = useSignedMediaUrl(
    drawPath,
    mediaKey,
    type,
    messageId,
    true,
    restored
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
      <div className="flex items-center gap-2 py-2 pl-3.5 pr-16 text-meta text-muted">
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
          fill ? 'w-full h-40' : 'mx-3.5 w-40 h-40 rounded-field'
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
            className={`flex flex-col items-center justify-center gap-1.5 bg-base-content/5 text-muted ${
              fill ? 'w-full h-40' : 'w-40 h-40'
            }`}
          >
            <VideoOff className="w-5 h-5" />
            <span className="px-3 text-center text-micro leading-tight">
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
        <FullSizeViewer
          messageId={messageId}
          path={path}
          mediaKey={mediaKey}
          type={type}
          caption={caption}
          restored={restored}
          expiresAt={expiresAt}
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

/**
 * Fetches the full-size object and hands it to the viewer.
 *
 * A separate component because it is a separate download, and it must not
 * start until somebody taps. The bubble above may be drawing a thumbnail — a
 * thirtieth of the pixels — and the whole point of that is that the file it
 * stands in for was never fetched. A hook here, mounted only while the viewer
 * is open, is what keeps "spend the bytes" tied to "asked to see it".
 *
 * When there is no thumbnail this costs nothing: the bubble already downloaded
 * and decrypted the same path, and `lib/media-cache.ts` hands back the blob it
 * is holding rather than signing a second URL for it.
 */
function FullSizeViewer({
  messageId,
  path,
  mediaKey,
  type,
  caption,
  restored,
  noPicture,
  expiresAt,
  onClose,
}: {
  messageId: string;
  path: string;
  mediaKey?: Uint8Array | null;
  type: VisualMediaType;
  caption?: string | null;
  restored?: boolean;
  noPicture: boolean;
  /** The row's disappearing stamp, so the retention setting can refuse to keep
   *  something that is meant to go. */
  expiresAt?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  // Not deferred: it is on screen by definition — the viewer only mounts
  // because somebody opened it.
  //
  // This is also where an attachment becomes worth keeping. The thread draws a
  // thumbnail, so nothing above this point holds the real file; opening one is
  // the moment the whole object exists on the device, and keeping it here costs
  // no download that was not already happening.
  const { url, failure } = useSignedMediaUrl(path, mediaKey, type, messageId, false, restored, {
    expiresAt: expiresAt ?? null,
    caption: caption ?? '',
  });

  if (failure) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center gap-2 bg-black/90 p-6 text-center text-body text-white/80"
        onClick={onClose}
      >
        <ImageOff className="h-5 w-5 shrink-0" />
        {mediaFailureNotice(failure, type)}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
        onClick={onClose}
        aria-label={t('common.loading')}
      >
        <span className="loading loading-spinner text-white" />
      </div>
    );
  }

  return (
    <MediaLightbox
      messageId={messageId}
      url={url}
      path={path}
      type={type}
      caption={caption}
      noPicture={noPicture}
      onClose={onClose}
    />
  );
}
