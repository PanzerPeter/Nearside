/**
 * Taking the camera's metadata off a video without re-encoding it.
 *
 * `lib/image-bytes.ts` does this for stills, and until now video was the
 * acknowledged hole: a phone records GPS coordinates, the device model and the
 * capture time into the MP4 container, and every one of those travelled to the
 * recipient intact. End-to-end encryption keeps them from the server. It does
 * nothing to keep them from the person on the other end, which for a video sent
 * from home is the one that matters.
 *
 * An MP4 is a tree of boxes: four bytes of length, four of type, then either
 * payload or more boxes. The metadata lives in a handful of optional ones —
 * `udta`, `meta`, vendor `uuid` — and in whole tracks whose media *is*
 * metadata, which is how an action camera records a GPS trace alongside the
 * picture.
 *
 * **Nothing here moves a byte.** A metadata box is overwritten in place with a
 * `free` box of exactly the same length, zeroed: `free` is the container's own
 * "skip this", understood by every demuxer since 2001. Deleting the bytes
 * instead would be the obvious implementation and would corrupt half the files
 * it touched — `stbl/stco` holds each chunk's *absolute file offset*, so
 * shortening anything that sits before `mdat` silently moves the picture out
 * from under the table pointing at it. Patching those tables is possible and is
 * where this would go wrong at three in the morning on somebody's holiday
 * footage. The file therefore stays exactly the size it was; what it no longer
 * holds is the coordinates.
 *
 * Works on bytes and returns bytes, so the node suite can drive it against real
 * container shapes.
 */

/** Box header: 4-byte size, 4-byte type. */
const HEADER = 8;
/** `size == 1` means the real length is a 64-bit value after the type. */
const LARGE_HEADER = 16;

interface Box {
  type: string;
  /** Offset of the box's first byte, and one past its last. */
  start: number;
  end: number;
  /** Offset of the first byte after the header — where children or payload
   *  begin. */
  dataStart: number;
}

function ascii(bytes: Uint8Array, at: number): string {
  let out = '';
  for (let i = at; i < at + 4; i += 1) {
    if (i >= bytes.length) return '';
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/** Big-endian u32, by multiplication rather than `<<`: the shift operator is
 *  signed, and a box over 2 GB — an `mdat` is routinely that — would come back
 *  negative. */
function u32be(bytes: Uint8Array, at: number): number {
  return bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

/**
 * The boxes directly inside `[from, to)`.
 *
 * Stops rather than guesses: a length that runs past the end of its parent, or
 * one too short to hold its own header, means the walk has desynced, and a
 * caller acting on a partial read would redact whatever happened to be at that
 * offset.
 */
function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + HEADER <= to) {
    const declared = u32be(bytes, at);
    const type = ascii(bytes, at + 4);
    let size = declared;
    let dataStart = at + HEADER;
    if (declared === 1) {
      if (at + LARGE_HEADER > to) return out;
      // 64-bit length. The high word is read but any file where it is non-zero
      // is over 4 GB and not something this app is uploading.
      if (u32be(bytes, at + HEADER) !== 0) return out;
      size = u32be(bytes, at + HEADER + 4);
      dataStart = at + LARGE_HEADER;
      if (size < LARGE_HEADER) return out;
    } else if (declared === 0) {
      // "To the end of the file", legal only for the last box.
      size = to - at;
    } else if (declared < HEADER) {
      return out;
    }
    const end = at + size;
    if (end > to || end <= at) return out;
    out.push({ type, start: at, end, dataStart });
    at = end;
  }
  return out;
}

/** Box types that exist to carry metadata and are optional to playback.
 *
 *  `udta` is where both Android and iOS write `©xyz`, the ISO-6109 latitude and
 *  longitude of wherever the recording was made. `meta` holds the iTunes-style
 *  list that carries the same coordinates again on iOS, plus the device model
 *  and software version. `uuid` is the vendor extension box, which in practice
 *  is XMP — the other place a GPS fix ends up. */
const METADATA_BOXES = new Set(['udta', 'meta', 'uuid']);

/** The handler of a track whose samples are themselves metadata: an action
 *  camera's continuous GPS trace, or the iPhone's `mebx` track. The picture
 *  does not reference it, so the whole track can go. */
const METADATA_HANDLER = 'meta';

function childBox(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return boxes(bytes, parent.dataStart, parent.end).find((b) => b.type === type) ?? null;
}

/**
 * The handler type of a `trak`, from `trak/mdia/hdlr`.
 *
 * `hdlr` is a FullBox: version and flags, then four reserved bytes, then the
 * four-character handler. Null when any step of the path is missing, which is
 * a malformed track and is left alone rather than guessed at.
 */
function trackHandler(bytes: Uint8Array, trak: Box): string | null {
  const mdia = childBox(bytes, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = childBox(bytes, mdia, 'hdlr');
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return null;
  return ascii(bytes, hdlr.dataStart + 8);
}

/** Every box in the file that should not reach the recipient, innermost first
 *  is irrelevant — none of them nest inside each other. */
function redactions(bytes: Uint8Array): Box[] {
  const top = boxes(bytes, 0, bytes.length);
  // Not an ISO base media file. `ftyp` is required to be first by every
  // profile; without it this is some other container and the offsets below
  // would be read out of arbitrary bytes.
  if (top[0]?.type !== 'ftyp') return [];

  const found: Box[] = [];
  for (const box of top) {
    if (box.type === 'uuid' || box.type === 'meta') {
      found.push(box);
      continue;
    }
    if (box.type !== 'moov') continue;

    for (const child of boxes(bytes, box.dataStart, box.end)) {
      if (METADATA_BOXES.has(child.type)) {
        found.push(child);
        continue;
      }
      if (child.type !== 'trak') continue;

      // A track that carries nothing but metadata goes whole. Its samples stay
      // in `mdat` — moving them is the byte-shifting this file exists to avoid
      // — but with the track gone nothing describes or can find them, and no
      // player will read them back.
      if (trackHandler(bytes, child) === METADATA_HANDLER) {
        found.push(child);
        continue;
      }
      // Per-track user data: the same `©xyz` again on some recorders.
      for (const grandchild of boxes(bytes, child.dataStart, child.end)) {
        if (METADATA_BOXES.has(grandchild.type)) found.push(grandchild);
      }
    }
  }
  return found;
}

/**
 * Overwrite one box with a `free` box of identical length.
 *
 * The length field is left exactly as it was — including the 64-bit form, where
 * the real length lives after the type and is kept — so the next box starts
 * where every table in the file still expects it to.
 */
function neutralize(out: Uint8Array, box: Box): void {
  out[box.start + 4] = 0x66; // f
  out[box.start + 5] = 0x72; // r
  out[box.start + 6] = 0x65; // e
  out[box.start + 7] = 0x65; // e
  out.fill(0, box.dataStart, box.end);
}

const VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
  'video/mpeg4',
]);

export function isStrippableVideo(type: string): boolean {
  return VIDEO_TYPES.has(type.toLowerCase());
}

/**
 * The file with its location, device and vendor metadata removed.
 *
 * Returns its input unchanged — the same object, so a caller can compare by
 * identity and skip rebuilding a `File` around bytes that did not move — when
 * the container is not one this understands, or when there was nothing in it to
 * take off. Never throws: a video that cannot be parsed is sent as it is, the
 * same way an unrecognised image is, because refusing to send somebody's video
 * is a worse answer than the one the file already had.
 *
 * `inPlace` redacts the caller's own buffer instead of copying it first, and is
 * only for a caller that owns those bytes outright. The send path is one: the
 * array came straight off `File.arrayBuffer()` one statement earlier and
 * nothing else has ever seen it. It matters because the copy this skips is a
 * whole video — 50 MB on the device least able to spare it, at the moment the
 * seal is about to ask for three more of them. `lib/media-crypto.ts` declines a
 * copy on this same path for this same reason; this was the one still being
 * made.
 */
export function stripVideoMetadata(
  bytes: Uint8Array,
  type: string,
  inPlace = false
): Uint8Array {
  if (!isStrippableVideo(type)) return bytes;
  let targets: Box[];
  try {
    targets = redactions(bytes);
  } catch {
    return bytes;
  }
  if (targets.length === 0) return bytes;

  const out = inPlace ? bytes : new Uint8Array(bytes);
  for (const box of targets) neutralize(out, box);
  return out;
}
