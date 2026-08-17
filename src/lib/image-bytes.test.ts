import { describe, expect, it } from 'vitest';
import { imageOrientation, isAnimatedImage, stripImageMetadata } from './image-bytes';

// ---------------------------------------------------------------------------
// Container builders. Real shapes rather than fixtures: the whole module reads
// structure, so a test that fed it something structurally wrong would prove
// nothing about the files it will actually meet.
// ---------------------------------------------------------------------------

const chars = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** A little-endian TIFF block carrying exactly one Orientation tag. */
function tiff(orientation: number): number[] {
  return [
    ...chars('II'), 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, // one entry
    0x12, 0x01, // tag 0x0112, Orientation
    0x03, 0x00, // SHORT
    0x01, 0x00, 0x00, 0x00, // count 1
    orientation, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const SCAN = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00];
const ENTROPY = [0x9a, 0xbc, 0xde, 0xf0];

function jpeg(segments: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), ...SCAN, ...ENTROPY, 0xff, 0xd9]);
}

const exifApp1 = (orientation = 1) =>
  segment(0xe1, [...chars('Exif'), 0x00, 0x00, ...tiff(orientation)]);
const iccApp2 = () => segment(0xe2, [...chars('ICC_PROFILE'), 0x00, 0x01, 0x02]);
const mpfApp2 = () => segment(0xe2, [...chars('MPF'), 0x00, 0xaa, 0xbb, 0xcc]);
/** A quantisation table: structural, and must survive everything. */
const dqt = () => segment(0xdb, [0x00, 0x10, 0x20, 0x30]);

function pngChunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff,
    ...chars(type),
    ...data,
    0x00, 0x00, 0x00, 0x00, // CRC, never checked here
  ];
}

function png(chunks: number[][]): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...chunks.flat(),
    ...pngChunk('IEND', []),
  ]);
}

function riffChunk(type: string, data: number[]): number[] {
  const length = data.length;
  const padded = length % 2 === 1 ? [...data, 0x00] : data;
  return [
    ...chars(type),
    length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff,
    ...padded,
  ];
}

/** `flags` is the VP8X feature byte: 0x08 EXIF, 0x04 XMP, 0x02 animation. */
const vp8x = (flags: number) =>
  riffChunk('VP8X', [flags, 0, 0, 0, 0x0f, 0x00, 0x00, 0x0f, 0x00, 0x00]);

function webp(chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  const size = body.length + 4; // 'WEBP' plus the chunks
  return new Uint8Array([
    ...chars('RIFF'),
    size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff,
    ...chars('WEBP'),
    ...body,
  ]);
}

const riffSize = (bytes: Uint8Array) =>
  bytes[4] + (bytes[5] << 8) + (bytes[6] << 16) + bytes[7] * 0x1000000;

const has = (bytes: Uint8Array, text: string) =>
  [...bytes].join(',').includes(chars(text).join(','));

// ---------------------------------------------------------------------------

describe('isAnimatedImage', () => {
  it('reads the animation flag on an extended WebP', () => {
    const animated = webp([vp8x(0x02), riffChunk('ANMF', [1, 2, 3, 4])]);
    expect(isAnimatedImage(animated, 'image/webp')).toBe(true);
  });

  it('calls a simple WebP a still', () => {
    // No VP8X at all, which is what a canvas re-encode produces.
    expect(isAnimatedImage(webp([riffChunk('VP8L', [1, 2, 3])]), 'image/webp')).toBe(false);
  });

  it('calls an extended WebP with other features a still', () => {
    // ICC and alpha set, animation clear — the bit test has to be a mask, not
    // a check for a non-zero flags byte.
    expect(isAnimatedImage(webp([vp8x(0x20 | 0x10)]), 'image/webp')).toBe(false);
  });

  it('finds the APNG control chunk', () => {
    const apng = png([pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]), pngChunk('IDAT', [1, 2])]);
    expect(isAnimatedImage(apng, 'image/png')).toBe(true);
  });

  it('calls an ordinary PNG a still', () => {
    expect(isAnimatedImage(png([pngChunk('IDAT', [1, 2])]), 'image/png')).toBe(false);
  });

  it('stops looking at the first IDAT', () => {
    // acTL after the image data is not an APNG — the spec requires it before.
    const odd = png([pngChunk('IDAT', [1, 2]), pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])]);
    expect(isAnimatedImage(odd, 'image/png')).toBe(false);
  });

  it('treats a format it cannot read as a still', () => {
    expect(isAnimatedImage(new Uint8Array([1, 2, 3]), 'image/png')).toBe(false);
    expect(isAnimatedImage(new Uint8Array([]), 'image/webp')).toBe(false);
    expect(isAnimatedImage(jpeg([dqt()]), 'image/jpeg')).toBe(false);
  });
});

describe('imageOrientation', () => {
  it('reads the tag out of a JPEG', () => {
    expect(imageOrientation(jpeg([exifApp1(6)]), 'image/jpeg')).toBe(6);
  });

  it('reads the tag out of a PNG eXIf chunk', () => {
    expect(imageOrientation(png([pngChunk('eXIf', tiff(8))]), 'image/png')).toBe(8);
  });

  it('reads the tag out of a WebP EXIF chunk', () => {
    expect(imageOrientation(webp([vp8x(0x08), riffChunk('EXIF', tiff(3))]), 'image/webp')).toBe(3);
  });

  it('is upright when there is no metadata at all', () => {
    expect(imageOrientation(jpeg([dqt()]), 'image/jpeg')).toBe(1);
    expect(imageOrientation(png([pngChunk('IDAT', [1])]), 'image/png')).toBe(1);
  });

  it('is upright rather than throwing on nonsense', () => {
    expect(imageOrientation(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toBe(1);
    expect(imageOrientation(new Uint8Array(0), 'image/jpeg')).toBe(1);
  });
});

describe('stripImageMetadata', () => {
  it('takes EXIF off an upright JPEG and leaves the picture', () => {
    const original = jpeg([exifApp1(1), dqt()]);
    const stripped = stripImageMetadata(original, 'image/jpeg');

    expect(has(original, 'Exif')).toBe(true);
    expect(has(stripped, 'Exif')).toBe(false);
    expect(stripped.length).toBe(original.length - exifApp1(1).length);
    // Structure intact: SOI, the quantisation table, the scan and its data.
    expect([...stripped.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(has(stripped, String.fromCharCode(0xff, 0xdb))).toBe(true);
    expect([...stripped.subarray(-6)]).toEqual([...ENTROPY, 0xff, 0xd9]);
  });

  it('refuses to strip a JPEG that is not upright', () => {
    // The pixels are not being re-encoded here, so the tag is the only thing
    // keeping the photo the right way up.
    const rotated = jpeg([exifApp1(6), dqt()]);
    expect(stripImageMetadata(rotated, 'image/jpeg')).toBe(rotated);
  });

  it('keeps an ICC profile and drops an embedded second image', () => {
    const original = jpeg([iccApp2(), mpfApp2(), dqt()]);
    const stripped = stripImageMetadata(original, 'image/jpeg');

    expect(has(stripped, 'ICC_PROFILE')).toBe(true);
    expect(has(stripped, 'MPF')).toBe(false);
  });

  it('hands back the same array when there is nothing to take off', () => {
    const clean = jpeg([dqt()]);
    expect(stripImageMetadata(clean, 'image/jpeg')).toBe(clean);
  });

  it('drops PNG text and EXIF chunks, keeping the animation', () => {
    const original = png([
      pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]),
      pngChunk('tEXt', chars('Software\0Camera')),
      pngChunk('eXIf', tiff(1)),
      pngChunk('fcTL', [1, 2, 3]),
      pngChunk('IDAT', [4, 5, 6]),
    ]);
    const stripped = stripImageMetadata(original, 'image/png');

    expect(has(stripped, 'tEXt')).toBe(false);
    expect(has(stripped, 'eXIf')).toBe(false);
    expect(has(stripped, 'acTL')).toBe(true);
    expect(has(stripped, 'fcTL')).toBe(true);
    expect(has(stripped, 'IDAT')).toBe(true);
    expect(has(stripped, 'IEND')).toBe(true);
    expect(isAnimatedImage(stripped, 'image/png')).toBe(true);
  });

  it('drops a WebP EXIF chunk and repairs the header', () => {
    const original = webp([
      vp8x(0x08 | 0x02),
      riffChunk('ANMF', [1, 2, 3, 4]),
      riffChunk('EXIF', tiff(1)),
    ]);
    const stripped = stripImageMetadata(original, 'image/webp');

    expect(has(stripped, 'EXIF')).toBe(false);
    expect(has(stripped, 'ANMF')).toBe(true);
    // The declared length and the feature bits both have to follow the bytes,
    // or a decoder reads past the end of the file looking for a chunk that is
    // no longer there.
    expect(riffSize(stripped)).toBe(stripped.length - 8);
    expect(stripped[20] & 0x08).toBe(0);
    expect(stripped[20] & 0x02).toBe(0x02);
    expect(isAnimatedImage(stripped, 'image/webp')).toBe(true);
  });

  it('leaves a truncated file alone rather than rebuilding a shorter one', () => {
    const truncated = jpeg([exifApp1(1), dqt()]).subarray(0, 12);
    expect(stripImageMetadata(truncated, 'image/jpeg')).toBe(truncated);

    const cutWebp = webp([vp8x(0x08), riffChunk('EXIF', tiff(1))]).subarray(0, 30);
    expect(stripImageMetadata(cutWebp, 'image/webp')).toBe(cutWebp);
  });

  it('leaves formats it does not rewrite alone', () => {
    const gif = new Uint8Array(chars('GIF89a'));
    expect(stripImageMetadata(gif, 'image/gif')).toBe(gif);
  });
});
