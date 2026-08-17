/**
 * Reading and rewriting a still image's container, without decoding it.
 *
 * Two questions `compress.ts` cannot answer from a canvas, and both decide
 * whether a picture is safe to send as-is:
 *
 *   Is this an animation? A canvas keeps one frame, so re-encoding an animated
 *   file destroys it. GIF was excluded from the compressor by MIME for exactly
 *   that reason — but animated WebP and APNG arrive under `image/webp` and
 *   `image/png`, which are the two types it re-encodes most eagerly. The flag
 *   is in the container, so it can be read without a decoder.
 *
 *   What is the camera still saying about this photo? EXIF carries GPS
 *   coordinates, the device's serial and the capture time. A re-encode drops
 *   all of it as a side effect of drawing pixels onto a canvas — but every path
 *   that sends the *original* file (an animation, a format with no encoder, a
 *   re-encode that was not worth keeping) sends that metadata to the recipient
 *   with it. End-to-end encryption keeps it from the server; it does nothing to
 *   keep it from the person on the other end.
 *
 * Everything here works on bytes and returns bytes, so the node suite can
 * exercise it against real container shapes.
 */

/** EXIF orientation meaning "as stored" — no rotation to preserve. */
const UPRIGHT = 1;

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length; i += 1) {
    if (i >= bytes.length) return '';
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/** Big-endian u32. Built by multiplication rather than `<<`, which is signed
 *  and turns any size over 2 GB negative. */
function u32be(bytes: Uint8Array, at: number): number {
  return (
    bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
  );
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16) + bytes[at + 3] * 0x1000000
  );
}

function writeU32le(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

interface Chunk {
  type: string;
  /** Offset of the chunk's first byte, and one past its last. */
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
}

/**
 * The PNG chunk sequence. Stops at IEND, and stops silently on a truncated or
 * malformed chunk rather than throwing: every caller here treats "could not
 * read the structure" as "leave this file alone".
 */
function* pngChunks(bytes: Uint8Array): Generator<Chunk> {
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    // length + type + payload + crc
    const end = at + 12 + length;
    if (!type || end > bytes.length) return;
    yield { type, start: at, end, dataStart: at + 8, dataEnd: at + 8 + length };
    if (type === 'IEND') return;
    at = end;
  }
}

// ---------------------------------------------------------------------------
// RIFF / WebP
// ---------------------------------------------------------------------------

function isWebp(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
}

/**
 * RIFF chunks after the 12-byte file header. Payloads are padded to an even
 * length and the pad byte is not counted in the chunk's own size, which is the
 * detail that makes a hand-rolled walk get this wrong.
 */
function* riffChunks(bytes: Uint8Array): Generator<Chunk> {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const type = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    const padded = size + (size & 1);
    const end = at + 8 + padded;
    if (!type || end > bytes.length) return;
    yield { type, start: at, end, dataStart: at + 8, dataEnd: at + 8 + size };
    at = end;
  }
}

/** The VP8X feature-flag byte, or null when the file has no VP8X chunk — which
 *  is every simple (lossy or lossless, single frame, no metadata) WebP. */
function vp8xFlags(bytes: Uint8Array): number | null {
  if (ascii(bytes, 12, 4) !== 'VP8X') return null;
  return bytes.length > 20 ? bytes[20] : null;
}

/** VP8X feature bits, MSB first: `Rsv Rsv ICC Alpha EXIF XMP Anim Rsv`. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

interface Segment {
  marker: number;
  start: number;
  end: number;
  dataStart: number;
}

/**
 * JPEG marker segments, up to and including the start of scan.
 *
 * Compressed image data follows SOS and is not marker-structured, so the walk
 * reports SOS and stops; a caller rewriting the file copies from there to the
 * end verbatim.
 */
function* jpegSegments(bytes: Uint8Array): Generator<Segment> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return;
    // A run of 0xFF is legal padding before a marker.
    let markerAt = at + 1;
    while (bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) return;

    // Standalone markers: no length, no payload. Still reported, so that a
    // caller rebuilding the file copies them rather than leaving a hole where
    // they were.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      yield { marker, start: at, end: markerAt + 1, dataStart: markerAt + 1 };
      at = markerAt + 1;
      continue;
    }
    // SOS (start of scan) and EOI end the structured part of the file.
    if (marker === 0xda || marker === 0xd9) {
      yield { marker, start: at, end: bytes.length, dataStart: markerAt + 3 };
      return;
    }

    if (markerAt + 3 > bytes.length) return;
    const length = (bytes[markerAt + 1] << 8) | bytes[markerAt + 2];
    if (length < 2) return;
    const end = markerAt + 1 + length;
    if (end > bytes.length) return;
    yield { marker, start: at, end, dataStart: markerAt + 3 };
    at = end;
  }
}

/** The EXIF payload inside an APP1 segment starts with this and two nulls. */
function isExifApp1(bytes: Uint8Array, segment: Segment): boolean {
  return segment.marker === 0xe1 && ascii(bytes, segment.dataStart, 4) === 'Exif';
}

// ---------------------------------------------------------------------------
// TIFF (the container EXIF itself is written in)
// ---------------------------------------------------------------------------

/**
 * The Orientation tag from a TIFF header spanning `[start, end)`, or 1 when
 * there is none and when anything about the structure does not read.
 *
 * Only IFD0 is walked. Orientation is defined there; a copy in the Exif
 * sub-IFD is not what a decoder honours.
 */
function tiffOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < 8) return UPRIGHT;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!little && !big) return UPRIGHT;

  const u16 = (at: number) =>
    little ? bytes[at] + (bytes[at + 1] << 8) : (bytes[at] << 8) + bytes[at + 1];
  const u32 = (at: number) => (little ? u32le(bytes, at) : u32be(bytes, at));

  if (u16(start + 2) !== 42) return UPRIGHT;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end || ifd < start) return UPRIGHT;

  const entries = u16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : UPRIGHT;
    }
  }
  return UPRIGHT;
}

// ---------------------------------------------------------------------------
// The three questions
// ---------------------------------------------------------------------------

/**
 * Whether `bytes` holds more than one frame.
 *
 * Answered from the container, never from a decoder: `createImageBitmap`
 * happily returns frame one of an animation and reports nothing about the rest,
 * which is exactly how an animated file gets flattened by a re-encode that
 * believed it was a still.
 *
 * GIF is not asked about — it never reaches the compressor — and a format this
 * does not recognise is reported as a still, which only ever means "the
 * ordinary path applies".
 */
export function isAnimatedImage(bytes: Uint8Array, type: string): boolean {
  const mime = type.toLowerCase();

  if (mime === 'image/webp' && isWebp(bytes)) {
    // An animated WebP is required to be the extended (VP8X) form, so the flag
    // is the whole answer — no need to hunt for ANMF chunks.
    const flags = vp8xFlags(bytes);
    return flags !== null && (flags & VP8X_ANIMATION) !== 0;
  }

  if (mime === 'image/png' && isPng(bytes)) {
    // APNG: an animation control chunk, which the spec requires before the
    // first IDAT. Anything at or past IDAT means an ordinary PNG.
    for (const chunk of pngChunks(bytes)) {
      if (chunk.type === 'acTL') return true;
      if (chunk.type === 'IDAT') return false;
    }
    return false;
  }

  if (mime === 'image/gif') {
    // Not on the compressor's path, but answered honestly for any other caller:
    // more than one image descriptor (0x2C) means more than one frame.
    let frames = 0;
    for (let i = 0; i < bytes.length && frames < 2; i += 1) {
      if (bytes[i] === 0x2c) frames += 1;
    }
    return frames > 1;
  }

  return false;
}

/**
 * The EXIF orientation `bytes` carries, or 1 when it carries none.
 *
 * Read so that metadata can be removed without silently rotating somebody's
 * photo: the tag is metadata, but a viewer applies it, so stripping it from a
 * file whose pixels are *not* being re-encoded lands the picture on its side.
 */
export function imageOrientation(bytes: Uint8Array, type: string): number {
  const mime = type.toLowerCase();

  if (mime === 'image/jpeg') {
    for (const segment of jpegSegments(bytes)) {
      if (segment.marker === 0xda) break;
      if (isExifApp1(bytes, segment)) {
        // "Exif\0\0" precedes the TIFF header.
        return tiffOrientation(bytes, segment.dataStart + 6, segment.end);
      }
    }
    return UPRIGHT;
  }

  if (mime === 'image/png' && isPng(bytes)) {
    for (const chunk of pngChunks(bytes)) {
      if (chunk.type === 'eXIf') return tiffOrientation(bytes, chunk.dataStart, chunk.dataEnd);
      if (chunk.type === 'IDAT') break;
    }
    return UPRIGHT;
  }

  if (mime === 'image/webp' && isWebp(bytes)) {
    for (const chunk of riffChunks(bytes)) {
      if (chunk.type === 'EXIF') return tiffOrientation(bytes, chunk.dataStart, chunk.dataEnd);
    }
    return UPRIGHT;
  }

  return UPRIGHT;
}

/**
 * `bytes` with the camera's metadata removed, or `bytes` itself when there is
 * nothing to remove or removing it would not be safe.
 *
 * The identity return is deliberate and load-bearing: a caller compares by
 * reference to decide whether it has to rebuild a `File` at all.
 *
 * What comes out, per format:
 *
 *   JPEG — every APPn except APP0 (JFIF), APP2 carrying an ICC profile, and
 *   APP14 (the Adobe colour transform, without which a CMYK file inverts), plus
 *   COM. That takes EXIF and XMP, IPTC, vendor blocks, and the MPF segment,
 *   which on several phones embeds a *second complete copy* of the photo.
 *   Nothing that affects how the pixels decode is touched.
 *
 *   PNG — eXIf and the text chunks. APNG control chunks are kept, so an
 *   animation survives.
 *
 *   WebP — the EXIF and XMP chunks, with the VP8X feature bits and the RIFF
 *   length rewritten to match. A WebP this app encoded has neither; one that
 *   arrived as an animation and is being sent untouched may.
 *
 * Refuses, and returns the input, whenever the file declares an orientation
 * other than upright. The pixels are not being re-encoded on this path, so the
 * tag is the only thing keeping the picture the right way up.
 */
export function stripImageMetadata(bytes: Uint8Array, type: string): Uint8Array {
  const mime = type.toLowerCase();
  if (imageOrientation(bytes, mime) !== UPRIGHT) return bytes;

  if (mime === 'image/jpeg') return stripJpeg(bytes);
  if (mime === 'image/png' && isPng(bytes)) return stripPng(bytes);
  if (mime === 'image/webp' && isWebp(bytes)) return stripWebp(bytes);
  return bytes;
}

/** APPn segments worth keeping, by marker. */
function jpegSegmentSurvives(bytes: Uint8Array, segment: Segment): boolean {
  const { marker } = segment;
  if (marker === 0xfe) return false; // COM
  if (marker < 0xe0 || marker > 0xef) return true; // not an APPn: structural
  if (marker === 0xe0) return true; // APP0, JFIF
  if (marker === 0xee) return true; // APP14, Adobe colour transform
  // APP2 is ICC (keep) or MPF, which carries an embedded second image (drop).
  if (marker === 0xe2) return ascii(bytes, segment.dataStart, 11) === 'ICC_PROFILE';
  return false;
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const keep: Segment[] = [];
  let scan: Segment | null = null;
  let dropped = 0;

  for (const segment of jpegSegments(bytes)) {
    if (segment.marker === 0xda || segment.marker === 0xd9) {
      scan = segment;
      break;
    }
    if (jpegSegmentSurvives(bytes, segment)) keep.push(segment);
    else dropped += segment.end - segment.start;
  }
  // No scan found means the walk desynced before the end of the file. Rebuilding
  // from a partial read would truncate the image.
  if (!scan || !dropped) return bytes;

  const out = new Uint8Array(bytes.length - dropped);
  out.set(bytes.subarray(0, 2), 0); // SOI
  let at = 2;
  for (const segment of keep) {
    out.set(bytes.subarray(segment.start, segment.end), at);
    at += segment.end - segment.start;
  }
  // Everything from the start of scan is entropy-coded data with no marker
  // structure, and is copied whole.
  out.set(bytes.subarray(scan.start), at);
  return out;
}

const PNG_STRIPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function stripPng(bytes: Uint8Array): Uint8Array {
  const keep: Chunk[] = [];
  let sawEnd = false;
  let dropped = 0;

  for (const chunk of pngChunks(bytes)) {
    if (PNG_STRIPPED.has(chunk.type)) {
      dropped += chunk.end - chunk.start;
      continue;
    }
    keep.push(chunk);
    if (chunk.type === 'IEND') sawEnd = true;
  }
  if (!sawEnd || !dropped) return bytes;

  const out = new Uint8Array(bytes.length - dropped);
  out.set(bytes.subarray(0, 8), 0);
  let at = 8;
  for (const chunk of keep) {
    out.set(bytes.subarray(chunk.start, chunk.end), at);
    at += chunk.end - chunk.start;
  }
  return out.subarray(0, at);
}

const WEBP_STRIPPED = new Set(['EXIF', 'XMP ']);

function stripWebp(bytes: Uint8Array): Uint8Array {
  const keep: Chunk[] = [];
  let dropped = 0;
  let read = 12;

  for (const chunk of riffChunks(bytes)) {
    read = chunk.end;
    if (WEBP_STRIPPED.has(chunk.type)) {
      dropped += chunk.end - chunk.start;
      continue;
    }
    keep.push(chunk);
  }
  // The walk stopping short of the end means a chunk header did not read.
  // Rebuilding from what was understood would silently truncate the file.
  if (!dropped || read !== bytes.length) return bytes;

  const out = new Uint8Array(bytes.length - dropped);
  out.set(bytes.subarray(0, 12), 0);
  let at = 12;
  for (const chunk of keep) {
    out.set(bytes.subarray(chunk.start, chunk.end), at);
    at += chunk.end - chunk.start;
  }
  const trimmed = out.subarray(0, at);

  // The RIFF length counts everything after itself, and the VP8X flags still
  // advertise chunks that are no longer there. A decoder that trusts either
  // reads past the end of the file.
  writeU32le(trimmed, 4, at - 8);
  const flags = vp8xFlags(trimmed);
  if (flags !== null) trimmed[20] = flags & ~VP8X_EXIF & ~VP8X_XMP;
  return trimmed;
}
