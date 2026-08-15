import { describe, expect, it } from 'vitest';
import {
  imageMimeFromBytes,
  matchesLabel,
  nextSort,
  normalizeLabel,
  sortStickers,
  stickerPath,
  stickerRejection,
  STICKER_LABEL_MAX,
  STICKER_MAX_BYTES,
  type Sticker,
} from './stickers';

const sticker = (over: Partial<Sticker> = {}): Sticker => ({
  id: 'id',
  user_id: 'me',
  path: 'me/id',
  key_ciphertext: 'c',
  key_nonce: 'n',
  label_ciphertext: 'c',
  label_nonce: 'n',
  sort: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  label: '',
  key: null,
  ...over,
});

const file = (type: string, size: number): File =>
  ({ type, size, name: 'x' }) as unknown as File;

describe('stickerPath', () => {
  it('puts the owner id in the first folder segment', () => {
    // The storage policies read `(storage.foldername(name))[1]`, so this shape
    // is what makes the bucket owner-scoped at all.
    expect(stickerPath('user-1', 'abc')).toBe('user-1/abc');
    expect(stickerPath('user-1', 'abc').split('/')[0]).toBe('user-1');
  });
});

describe('normalizeLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeLabel('  happy   cat ')).toBe('happy cat');
  });

  it('collapses newlines and tabs too', () => {
    expect(normalizeLabel('happy\n\tcat')).toBe('happy cat');
  });

  it('truncates to the maximum', () => {
    expect(normalizeLabel('x'.repeat(200))).toHaveLength(STICKER_LABEL_MAX);
  });

  it('allows an empty label', () => {
    // A sticker with no name is legitimate — the picture is the point.
    expect(normalizeLabel('   ')).toBe('');
  });
});

describe('stickerRejection', () => {
  it('accepts the source types', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(stickerRejection(file(type, 1000))).toBeNull();
    }
  });

  it('rejects a video, a PDF and an unknown type', () => {
    expect(stickerRejection(file('video/mp4', 1000))).toMatch(/PNG/);
    expect(stickerRejection(file('application/pdf', 1000))).toMatch(/PNG/);
    expect(stickerRejection(file('', 1000))).toMatch(/PNG/);
  });

  it('rejects an absurdly large source before any decoding is attempted', () => {
    expect(stickerRejection(file('image/png', STICKER_MAX_BYTES * 9))).toMatch(/too large/);
  });

  it('accepts a large-but-shrinkable source', () => {
    // A phone photo is megabytes before compression and well under the limit
    // after it. Rejecting on the raw size would refuse most real pictures.
    expect(stickerRejection(file('image/png', STICKER_MAX_BYTES * 3))).toBeNull();
  });
});

describe('sortStickers', () => {
  it('orders by sort, then by age', () => {
    const list = [
      sticker({ id: 'c', sort: 2 }),
      sticker({ id: 'a', sort: 1, created_at: '2026-01-02T00:00:00.000Z' }),
      sticker({ id: 'b', sort: 1, created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortStickers(list).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('breaks a full tie on id rather than leaving order to chance', () => {
    const list = [sticker({ id: 'z' }), sticker({ id: 'a' })];
    expect(sortStickers(list).map((s) => s.id)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const list = [sticker({ id: 'z', sort: 2 }), sticker({ id: 'a', sort: 1 })];
    sortStickers(list);
    expect(list.map((s) => s.id)).toEqual(['z', 'a']);
  });
});

describe('nextSort', () => {
  it('lands a new sticker after everything already there', () => {
    expect(nextSort([{ sort: 1 }, { sort: 7 }, { sort: 3 }])).toBe(8);
  });

  it('starts at 1 for an empty library', () => {
    expect(nextSort([])).toBe(1);
  });

  it('is unaffected by negative values left by an older build', () => {
    expect(nextSort([{ sort: -5 }])).toBe(1);
  });
});

describe('matchesLabel', () => {
  it('matches a substring, case-insensitively', () => {
    expect(matchesLabel('Happy Cat', 'cat')).toBe(true);
    expect(matchesLabel('Happy Cat', 'HAP')).toBe(true);
  });

  it('ignores accents in either direction', () => {
    expect(matchesLabel('café', 'cafe')).toBe(true);
    expect(matchesLabel('cafe', 'café')).toBe(true);
  });

  it('matches everything on an empty or whitespace query', () => {
    expect(matchesLabel('anything', '')).toBe(true);
    expect(matchesLabel('anything', '   ')).toBe(true);
    expect(matchesLabel('', '')).toBe(true);
  });

  it('does not match an unrelated query', () => {
    expect(matchesLabel('Happy Cat', 'dog')).toBe(false);
  });

  it('never matches a non-empty query against an unnamed sticker', () => {
    expect(matchesLabel('', 'cat')).toBe(false);
  });
});

describe('imageMimeFromBytes', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  it('reads a PNG, a JPEG and a GIF', () => {
    expect(imageMimeFromBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d))).toBe('image/png');
    expect(imageMimeFromBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(imageMimeFromBytes(bytes(0x47, 0x49, 0x46, 0x38, 0x39))).toBe('image/gif');
  });

  it('reads a WebP across the four size bytes in the middle', () => {
    // RIFF, then a little-endian length, then WEBP. Matching it as one span is
    // the mistake this test exists to catch.
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x1a, 0x2b, 0x3c, 0x4d, 0x57, 0x45, 0x42, 0x50);
    expect(imageMimeFromBytes(webp)).toBe('image/webp');
  });

  it('does not mistake a bare RIFF container for a WebP', () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(imageMimeFromBytes(wav)).toBe('');
  });

  it('returns a blank type rather than a wrong one', () => {
    // An <img> sniffs its own bytes, so a blank type still renders. A confident
    // wrong answer is what breaks it.
    expect(imageMimeFromBytes(bytes(0x00, 0x01, 0x02, 0x03))).toBe('');
    expect(imageMimeFromBytes(bytes())).toBe('');
  });
});
