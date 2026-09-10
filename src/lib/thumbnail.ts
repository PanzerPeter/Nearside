// The small copy of an attachment that the conversation actually draws.
//
// A bubble in the thread is about two hundred CSS pixels wide. It used to be
// painted by downloading, decrypting and decoding the full attachment — a
// 1920px WebP, or, for a video, the whole video, because that is what an
// element needs before it can show you its first frame. On a good connection
// nobody notices; on a weak one, scrolling a conversation of photographs
// spends megabytes drawing postage stamps and the thread stalls behind
// attachments nobody has opened.
//
// So a send makes a second, much smaller object and the row points at it
// (`media_thumb_path`, migration 0044). Sealed under the *same* per-file key,
// so the people who can open the picture are exactly the people who can open
// its thumbnail and nobody has a second key to manage.
//
// Everything here is best-effort by design. A thumbnail that cannot be made is
// not a failed send: the column stays null and the bubble draws the full
// object, which is what every row written before 0044 does anyway. That
// fallback is what makes this safe to attempt on formats nobody has tested.

import { isAnimatedImage } from './image-bytes';
import type { MediaType } from './types';

/**
 * Long edge of a thumbnail, in pixels.
 *
 * 360 rather than the ~200 a bubble paints: the same object is drawn on a 3x
 * phone screen, and a thumbnail that is exactly bubble-sized is visibly soft on
 * every device made this decade. Still around a thirtieth of the pixels of the
 * full-size copy.
 */
export const THUMB_MAX_EDGE = 360;

/**
 * Quality of the thumbnail's WebP encode.
 *
 * Lower than the 0.82 the full-size copy gets, and it should be: this is a
 * picture the reader is deciding whether to open, not one they are looking at.
 * The artefacts that would be obvious at full size are invisible at a third of
 * the width, and the byte count is what the whole feature is for.
 */
export const THUMB_QUALITY = 0.5;

/**
 * Below this there is nothing to save.
 *
 * A thumbnail is a second object: a second upload, a second row in the bucket,
 * a second signature and a second download. For a file already smaller than a
 * thumbnail would be, all of that buys a bigger transfer. Stickers are the case
 * this is really about — they are small by construction and are the message
 * rather than a preview of one.
 */
export const THUMB_MIN_SOURCE_BYTES = 48 * 1024;

/**
 * Whether an attachment should get one, given what is known before any pixels
 * are touched.
 *
 * Pure, and separated from the drawing for the reason everything in this
 * codebase's `lib/` is: the policy is the part worth pinning down in a test,
 * and a canvas is not something a node suite can hold.
 *
 * - `audio` never: a voice note has no picture, and its own player draws it.
 * - `sticker` never: small already, frequently animated, and it IS the message
 *   — see `lib/stickers.ts` on why a sticker gets no cheaper path than a photo.
 * - animated images never: a canvas keeps frame one and throws the rest away,
 *   so the "thumbnail" of an animation is the animation not playing.
 */
export function shouldMakeThumbnail(
  kind: MediaType,
  sourceBytes: number,
  animated: boolean
): boolean {
  if (kind === 'audio' || kind === 'sticker') return false;
  if (animated) return false;
  return sourceBytes >= THUMB_MIN_SOURCE_BYTES;
}

/** Output size for a source capped to `THUMB_MAX_EDGE`, preserving aspect. A
 *  source already smaller is left at its own size rather than upscaled — there
 *  are no extra pixels to invent and the encode alone still shrinks it. */
export function thumbDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= THUMB_MAX_EDGE) return { width, height };
  const ratio = THUMB_MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Whether the thumbnail earned its place.
 *
 * A second object is only worth uploading if it is meaningfully smaller than
 * the thing it stands in for. Half is the bar — below that the download the
 * reader avoids is not much smaller than the one they were making, and the
 * bucket has gained an object for nothing.
 */
export function worthUploading(sourceBytes: number, thumbBytes: number): boolean {
  return thumbBytes > 0 && thumbBytes * 2 <= sourceBytes;
}

/** How far into a video to grab the still. Not frame zero: a great many videos
 *  open on a black or blurred frame, which makes every one of them look like a
 *  broken thumbnail. A second in is past the fade and still inside the
 *  shortest clips anybody sends. */
const POSTER_SEEK_SECONDS = 1;

/** Give up on a video that will not decode or seek. Some containers never fire
 *  `seeked` at all, and a send must not hang on a preview. */
const POSTER_TIMEOUT_MS = 5_000;

/**
 * A thumbnail for an already-compressed image, or null if one cannot be made.
 *
 * `bytes` is the compressed file's contents, which the send path is holding
 * anyway — see `CompressResult.bytes`. Passing them in keeps this from being a
 * second full read of the picture off the device.
 */
export async function imageThumbnail(file: File, bytes: Uint8Array): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  // Checked here as well as in `shouldMakeThumbnail`, because the compressor
  // may have handed back the original animation untouched.
  if (isAnimatedImage(bytes, file.type)) return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (bitmap.width === 0 || bitmap.height === 0) return null;
    return drawToWebp(bitmap, thumbDimensions(bitmap.width, bitmap.height));
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * A still frame from a video, or null if one cannot be grabbed.
 *
 * This is the larger win of the two. A video bubble had no poster at all, so
 * the element fetched the video to show one frame of it — the full file, over
 * whatever connection the reader is on, for a picture they may never tap.
 *
 * Every exit path revokes the object URL and detaches the element. A `<video>`
 * left holding a blob URL keeps the decoder and the bytes alive for the life of
 * the page, and a send is the moment there is a whole video in memory already.
 */
export async function videoPoster(file: File): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  // Some engines refuse to decode a frame for a video that was never allowed
  // to play; both of these are what make the seek work without one appearing.
  video.playsInline = true;
  video.src = url;

  const cleanup = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    const frame = await new Promise<Blob | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), POSTER_TIMEOUT_MS);
      const done = (blob: Blob | null) => {
        clearTimeout(timer);
        resolve(blob);
      };

      video.onerror = () => done(null);
      video.onloadedmetadata = () => {
        if (!video.videoWidth || !video.videoHeight) return done(null);
        // Clamped, because a clip shorter than the seek point would otherwise
        // be asked for a time it does not have and never fire `seeked`.
        video.currentTime = Math.min(POSTER_SEEK_SECONDS, Math.max(0, video.duration - 0.1) || 0);
      };
      video.onseeked = () => {
        void (async () => {
          try {
            done(
              await drawToWebp(video, thumbDimensions(video.videoWidth, video.videoHeight))
            );
          } catch {
            done(null);
          }
        })();
      };
    });
    return frame;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/** One canvas encode, shared by both sources. Returns null unless the engine
 *  produced actual WebP: a browser without the encoder quietly hands back a
 *  PNG, which for a photograph is larger than what it was made from. */
async function drawToWebp(
  source: CanvasImageSource,
  size: { width: number; height: number }
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', THUMB_QUALITY)
  );
  return blob && blob.type === 'image/webp' ? blob : null;
}
