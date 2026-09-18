import { describe, expect, it } from 'vitest';
import { isStrippableVideo, stripVideoMetadata } from './video-bytes';

/** A box: four bytes of big-endian length, four of type, then the payload. */
function box(type: string, ...payload: (Uint8Array | number[])[]): Uint8Array {
  const body = payload.flatMap((part) => [...part]);
  const size = 8 + body.length;
  const out = new Uint8Array(size);
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function text(value: string): number[] {
  return [...value].map((c) => c.charCodeAt(0));
}

/** `trak/mdia/hdlr` with the given four-character handler: a FullBox, so
 *  version and flags, then four reserved bytes, then the handler. */
function hdlr(handler: string): Uint8Array {
  return box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], text(handler), [0, 0, 0, 0]);
}

function trak(handler: string, ...extra: Uint8Array[]): Uint8Array {
  return box('trak', box('tkhd', [1, 2, 3, 4]), box('mdia', hdlr(handler)), ...extra);
}

const FTYP = box('ftyp', text('isom'), [0, 0, 0, 0x200]);
/** The coordinates a phone writes into `udta`. */
const XYZ = box('©xyz', text('+51.5074-000.1278/'));

function typeAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at + 4, at + 8));
}

function holds(bytes: Uint8Array, needle: string): boolean {
  return String.fromCharCode(...bytes).includes(needle);
}

describe('isStrippableVideo', () => {
  it('recognises the container types a phone records', () => {
    expect(isStrippableVideo('video/mp4')).toBe(true);
    expect(isStrippableVideo('VIDEO/QUICKTIME')).toBe(true);
    expect(isStrippableVideo('video/3gpp')).toBe(true);
  });

  it('leaves formats it cannot parse alone', () => {
    expect(isStrippableVideo('video/webm')).toBe(false);
    expect(isStrippableVideo('audio/mpeg')).toBe(false);
  });
});

describe('stripVideoMetadata', () => {
  it('takes the coordinates out of moov/udta', () => {
    const file = concat(FTYP, box('moov', box('mvhd', [0]), trak('vide'), box('udta', XYZ)), box('mdat', [9, 9, 9]));
    expect(holds(file, '+51.5074')).toBe(true);

    const out = stripVideoMetadata(file, 'video/mp4');
    expect(holds(out, '+51.5074')).toBe(false);
  });

  it('never moves a byte, so every chunk offset still points where it did', () => {
    const mdat = box('mdat', [1, 2, 3, 4, 5, 6]);
    const file = concat(FTYP, box('moov', box('udta', XYZ)), mdat);
    const mdatAt = file.length - mdat.length;

    const out = stripVideoMetadata(file, 'video/mp4');

    expect(out.length).toBe(file.length);
    expect(typeAt(out, mdatAt)).toBe('mdat');
    expect([...out.subarray(mdatAt, mdatAt + mdat.length)]).toEqual([...mdat]);
  });

  it('leaves a free box where the metadata was, so the next box still parses', () => {
    const udta = box('udta', XYZ);
    const file = concat(FTYP, box('moov', udta), box('mdat', [0]));
    const udtaAt = FTYP.length + 8;

    const out = stripVideoMetadata(file, 'video/mp4');

    expect(typeAt(out, udtaAt)).toBe('free');
    // The length field is untouched, which is what keeps the walk in step.
    expect([...out.subarray(udtaAt, udtaAt + 4)]).toEqual([...udta.subarray(0, 4)]);
    expect([...out.subarray(udtaAt + 8, udtaAt + udta.length)]).toEqual(
      new Array(udta.length - 8).fill(0)
    );
  });

  it('strips the iTunes-style list iOS writes the same coordinates into', () => {
    const ilst = box('ilst', box('©xyz', text('+51.5074-000.1278/')));
    const file = concat(FTYP, box('moov', box('meta', box('hdlr', [0]), ilst)), box('mdat', [0]));

    expect(holds(stripVideoMetadata(file, 'video/mp4'), '+51.5074')).toBe(false);
  });

  it('strips a vendor uuid box, including the uuid itself', () => {
    const xmp = box('uuid', new Uint8Array(16).fill(0xbe), text('<x:xmpmeta>51.5074</x:xmpmeta>'));
    const file = concat(FTYP, box('moov', box('mvhd', [0])), xmp, box('mdat', [0]));

    const out = stripVideoMetadata(file, 'video/mp4');
    expect(holds(out, 'xmpmeta')).toBe(false);
    expect(out.includes(0xbe)).toBe(false);
  });

  it('strips per-track user data as well as the movie’s', () => {
    const file = concat(
      FTYP,
      box('moov', trak('vide', box('udta', XYZ))),
      box('mdat', [0])
    );

    expect(holds(stripVideoMetadata(file, 'video/mp4'), '+51.5074')).toBe(false);
  });

  it('removes a whole track whose samples are a GPS trace', () => {
    const gps = trak('meta');
    const file = concat(FTYP, box('moov', trak('vide'), gps), box('mdat', [0]));
    const gpsAt = FTYP.length + 8 + trak('vide').length;

    const out = stripVideoMetadata(file, 'video/mp4');

    expect(typeAt(out, gpsAt)).toBe('free');
    // The picture's own track is untouched.
    expect(holds(out, 'vide')).toBe(true);
  });

  it('keeps the picture, the sound and everything that describes them', () => {
    const video = trak('vide');
    const audio = trak('soun');
    const file = concat(FTYP, box('moov', box('mvhd', [7, 7]), video, audio, box('udta', XYZ)), box('mdat', [4, 5]));

    const out = stripVideoMetadata(file, 'video/mp4');

    expect(holds(out, 'vide')).toBe(true);
    expect(holds(out, 'soun')).toBe(true);
    expect(holds(out, 'mvhd')).toBe(true);
    expect(holds(out, 'tkhd')).toBe(true);
  });

  it('hands back the very same array when there is nothing to take off', () => {
    const file = concat(FTYP, box('moov', trak('vide')), box('mdat', [1]));
    expect(stripVideoMetadata(file, 'video/mp4')).toBe(file);
  });

  it('leaves the caller\u2019s own array alone by default', () => {
    const file = concat(FTYP, box('moov', box('udta', XYZ)), box('mdat', [0]));
    const before = [...file];

    const out = stripVideoMetadata(file, 'video/mp4');

    expect(out).not.toBe(file);
    expect(holds(out, '+51.5074')).toBe(false);
    expect([...file]).toEqual(before);
  });

  it('redacts the caller\u2019s own array when asked to work in place', () => {
    // The send path's case: it owns the buffer outright, and the copy the
    // default makes is a whole video on a phone's heap.
    const file = concat(FTYP, box('moov', box('udta', XYZ)), box('mdat', [0]));

    const out = stripVideoMetadata(file, 'video/mp4', true);

    expect(out).toBe(file);
    expect(holds(file, '+51.5074')).toBe(false);
  });

  it('still hands back the input untouched in place when there is nothing to do', () => {
    const file = concat(FTYP, box('moov', trak('vide')), box('mdat', [1]));
    const before = [...file];

    expect(stripVideoMetadata(file, 'video/mp4', true)).toBe(file);
    expect([...file]).toEqual(before);
  });

  it('leaves a file that is not ISO base media alone', () => {
    // WebM's magic, in a file claiming to be an MP4.
    const file = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), box('udta', XYZ));
    expect(stripVideoMetadata(file, 'video/mp4')).toBe(file);
  });

  it('leaves a container it does not claim to understand alone', () => {
    const file = concat(FTYP, box('moov', box('udta', XYZ)));
    expect(stripVideoMetadata(file, 'video/webm')).toBe(file);
  });

  it('stops rather than guessing when a box length runs past its parent', () => {
    const file = concat(FTYP, box('moov', box('udta', XYZ)));
    // Claim the moov is far longer than the file.
    const moovAt = FTYP.length;
    const broken = new Uint8Array(file);
    broken[moovAt] = 0xff;
    expect(stripVideoMetadata(broken, 'video/mp4')).toBe(broken);
  });

  it('survives a truncated file without throwing', () => {
    const file = concat(FTYP, box('moov', box('udta', XYZ)), box('mdat', [1, 2, 3]));
    for (let cut = 1; cut < file.length; cut += 1) {
      expect(() => stripVideoMetadata(file.subarray(0, cut), 'video/mp4')).not.toThrow();
    }
  });

  it('reads a 64-bit box length without losing the length itself', () => {
    // size = 1, type, then the real length as a 64-bit big-endian value.
    const payload = XYZ;
    const size = 16 + payload.length;
    const large = new Uint8Array(size);
    large.set([0, 0, 0, 1], 0);
    large.set(text('udta'), 4);
    large.set([0, 0, 0, 0, 0, 0, (size >>> 8) & 0xff, size & 0xff], 8);
    large.set(payload, 16);

    const file = concat(FTYP, box('moov', large), box('mdat', [0]));
    const out = stripVideoMetadata(file, 'video/mp4');
    const at = FTYP.length + 8;

    expect(typeAt(out, at)).toBe('free');
    // The `size == 1` marker and the 64-bit length after the type both survive
    // — they are what tells the next reader where this box ends.
    expect([...out.subarray(at, at + 4)]).toEqual([0, 0, 0, 1]);
    expect([...out.subarray(at + 8, at + 16)]).toEqual([...large.subarray(8, 16)]);
    expect(holds(out, '+51.5074')).toBe(false);
  });
});
