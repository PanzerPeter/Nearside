/**
 * Client-side image compression, applied to every image this app uploads:
 * chat attachments, avatars and chat backgrounds.
 *
 * A phone camera produces 3–8 MB JPEGs at a resolution nothing in this UI ever
 * shows — the largest an attachment is painted at is a few hundred CSS pixels.
 * Re-encoding to WebP at a capped long edge takes a typical photo down by
 * roughly 90% with no visible difference, which is the difference between a
 * conversation's media costing tens of megabytes and costing a couple.
 *
 * Every failure path here returns the original file. Compression is an
 * optimisation, never a gate on sending: if decoding, canvas, or the WebP
 * encoder is unavailable, the upload proceeds untouched.
 *
 * "Untouched" means the pixels. A file that is sent as-is still has its
 * metadata taken off (`lib/image-bytes.ts`) — the re-encode drops EXIF as a
 * side effect of drawing onto a canvas, and every path that skips the re-encode
 * would otherwise hand the recipient the sender's GPS coordinates.
 */

import { isAnimatedImage, stripImageMetadata } from './image-bytes';

/** Long-edge caps, chosen per surface from how large each is ever painted. */
export const CHAT_IMAGE_MAX_EDGE = 1920;
export const BACKGROUND_MAX_EDGE = 1920;
export const AVATAR_MAX_EDGE = 512;

const DEFAULT_QUALITY = 0.82;

export interface CompressOptions {
  /** Longest edge of the output in pixels; the short edge scales with it. */
  maxEdge: number;
  /** WebP quality, 0..1. */
  quality?: number;
}

export interface Dimensions {
  width: number;
  height: number;
  /** False when the source already fit inside `maxEdge`. */
  scaled: boolean;
}

/**
 * Formats that get re-encoded. GIF is deliberately excluded: a canvas keeps
 * only the first frame, so "compressing" an animation would silently destroy
 * it. Anything else (SVG, HEIC the browser can't decode, …) falls through
 * untouched.
 *
 * Excluding GIF *by MIME* is not on its own enough, and used not to be: an
 * animated WebP — which is what every exported sticker pack and most saved
 * "GIFs" on Android actually are — and an APNG arrive under the two types this
 * list is most eager to re-encode, and a single frame of one is always far
 * smaller than the whole animation, so `shouldUseCompressed` kept it every
 * time. The container is asked directly instead; see `isAnimatedImage`.
 */
const COMPRESSIBLE = ['image/jpeg', 'image/png', 'image/webp'];

export function isCompressible(type: string): boolean {
  return COMPRESSIBLE.includes(type.toLowerCase());
}

/**
 * Output size for a `width`x`height` source capped to `maxEdge`, preserving
 * aspect ratio. Never upscales — a small image is only ever re-encoded at its
 * own size, since inventing pixels would add bytes for nothing.
 */
export function targetDimensions(width: number, height: number, maxEdge: number): Dimensions {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width, height, scaled: false };
  if (longest <= maxEdge) return { width, height, scaled: false };

  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * How much smaller a same-size re-encode must be to be worth keeping. A
 * re-encode that saves nothing (an already-optimised WebP, a photo at a
 * quality floor) costs a generation of quality for no benefit, so it is
 * discarded unless it wins by a clear margin. A *downscaled* result is judged
 * only on being smaller — the resolution cap is the point there.
 */
export const MIN_SAVING_RATIO = 0.9;

export function shouldUseCompressed(
  originalBytes: number,
  candidateBytes: number,
  scaled: boolean
): boolean {
  if (candidateBytes <= 0) return false;
  return scaled
    ? candidateBytes < originalBytes
    : candidateBytes < originalBytes * MIN_SAVING_RATIO;
}

/** `photo.jpg` → `photo.webp`; a name without an extension gains one. */
export function replaceExtension(name: string, extension: string): string {
  const trimmed = name.trim() || 'image';
  const dot = trimmed.lastIndexOf('.');
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem}.${extension}`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export interface CompressResult {
  /** What to send: the re-encode when it was worth keeping, else the original
   *  with its metadata taken off. */
  file: File;
  /**
   * Exactly what `file` holds, already in memory.
   *
   * Handed back rather than left to the caller's own `arrayBuffer()`: reading
   * the file is the one step of a send that fails for reasons the sender can
   * act on (a gallery item that is a cloud placeholder, a content URI whose
   * permission did not survive the picker), and it has already happened here —
   * both the animation check and the metadata strip need the bytes. Reading a
   * 50 MB video's worth of photo twice is the alternative.
   */
  bytes: Uint8Array;
  /**
   * The image could not be decoded here at all — which is a different answer
   * from "not worth re-encoding", and the reason this type exists.
   *
   * A file's MIME and its bytes can disagree: a phone that saves HEIC under a
   * `.png` name is the common one. Nothing downstream can draw what no decoder
   * on this device can read, so an upload of it is a message that will show
   * "this photo's format can't be shown here" to everyone, including the
   * sender — who is the one person still holding the original and able to do
   * something about it.
   */
  undecodable: boolean;
}

/**
 * Whether this build can turn `blob` into a picture.
 *
 * The only definitive answer to "can this be shown", and the reason it is
 * asked rather than inferred: counting failed `<img>` loads cannot tell a file
 * with no decoder from a blob URL that was revoked under a live element, which
 * the media cache does on every eviction.
 *
 * True when there is nothing to ask with. A platform without
 * `createImageBitmap` has to fall back to letting the element try, never to
 * calling every picture broken.
 */
export async function imageDecodes(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== 'function') return true;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    // A decoder that returns a 0×0 frame has not decoded anything, and an
    // <img> given one fires `error` exactly as it would for garbage.
    return bitmap.width > 0 && bitmap.height > 0;
  } catch {
    return false;
  } finally {
    bitmap?.close();
  }
}

/**
 * Re-encode `file` as WebP, capped to `opts.maxEdge`, and say whether it could
 * be read at all. Returns the original file — with its metadata removed —
 * whenever the result would not be an improvement, when the picture is an
 * animation, or when anything in the pipeline is unavailable or throws.
 *
 * Throws only if the file's bytes cannot be read off the device at all, which
 * is a failed send and not a skipped optimisation. `compressImage` is the
 * wrapper for callers that would rather have the file back.
 */
export async function compressImageResult(
  file: File,
  opts: CompressOptions
): Promise<CompressResult> {
  const raw = new Uint8Array(await file.arrayBuffer());

  /** Send the original. `stripImageMetadata` returns its input unchanged when
   *  there was nothing to take off, which is what keeps this from rebuilding a
   *  `File` around identical bytes on the common path. */
  const keep = (undecodable = false): CompressResult => {
    const stripped = stripImageMetadata(raw, file.type);
    if (stripped === raw) return { file, bytes: raw, undecodable };
    return {
      // Cast for the same reason as `sealFile`'s: `Uint8Array` widens to
      // `ArrayBufferLike`, which TypeScript declines as a `BlobPart`.
      file: new File([stripped as BlobPart], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      }),
      bytes: stripped,
      undecodable,
    };
  };

  if (!isCompressible(file.type)) return keep();
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return keep();

  // Decoding is its own step with its own failure, and is deliberately not
  // inside the try below: everything after it is the re-encode, which is an
  // optimisation and is allowed to fail quietly. Reading the picture is not.
  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF orientation phone cameras rely on; without
    // it a portrait photo would be re-encoded on its side, and the rotation
    // metadata dropped along with it.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return keep(true);
  }
  if (bitmap.width === 0 || bitmap.height === 0) {
    bitmap.close();
    return keep(true);
  }

  // Asked after the decode, not before it, so an animation still gets the
  // "can this be shown at all" answer that the refusal in `useMediaSend`
  // depends on. A canvas would keep frame one and throw the rest away.
  if (isAnimatedImage(raw, file.type)) {
    bitmap.close();
    return keep();
  }

  try {
    const { width, height, scaled } = targetDimensions(bitmap.width, bitmap.height, opts.maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return keep();
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, 'image/webp', opts.quality ?? DEFAULT_QUALITY);
    // A browser without a WebP encoder silently hands back a PNG, which for a
    // photo is far larger than the JPEG we started with.
    if (!blob || blob.type !== 'image/webp') return keep();
    if (!shouldUseCompressed(file.size, blob.size, scaled)) return keep();

    return {
      file: new File([blob], replaceExtension(file.name, 'webp'), {
        type: 'image/webp',
        lastModified: file.lastModified,
      }),
      // A canvas encodes pixels and nothing else, so this carries no metadata
      // to take off.
      bytes: new Uint8Array(await blob.arrayBuffer()),
      undecodable: false,
    };
  } catch {
    return keep();
  } finally {
    bitmap.close();
  }
}

/**
 * `compressImageResult`'s file alone, for the surfaces that have nothing to do
 * with a picture they cannot read — an avatar and a chat background are both
 * chosen by the person who will see the result.
 *
 * Swallows the unreadable-file throw as well, which keeps the promise the
 * header makes: on these surfaces this step is an optimisation and never a gate.
 * The upload that follows fails on its own if the bytes really are unreachable,
 * and reports it in the caller's own words.
 */
export async function compressImage(file: File, opts: CompressOptions): Promise<File> {
  try {
    return (await compressImageResult(file, opts)).file;
  } catch {
    return file;
  }
}
