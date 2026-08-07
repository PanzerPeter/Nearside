import { describe, expect, it } from 'vitest';
import { keyToken, mimeForPath, MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from './media';
import { AUDIO_KEEP_LIMIT, MEDIA_KEEP_LIMIT } from './conversation';
import type { MediaType } from './types';

function rows(kind: MediaType, count: number, from = 0): MediaRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${kind}-${from + i}`,
    user_id: 'me',
    media_path: `convo/${kind}-${from + i}`,
    media_type: kind,
  }));
}

describe('selectStaleMedia', () => {
  it('keeps everything while both kinds are under their limits', () => {
    expect(selectStaleMedia([...rows('image', MEDIA_KEEP_LIMIT), ...rows('audio', 5)])).toEqual([]);
  });

  it('trims photos past the visual limit, oldest first', () => {
    const stale = selectStaleMedia(rows('image', MEDIA_KEEP_LIMIT + 3));
    expect(stale.map((r) => r.id)).toEqual([
      `image-${MEDIA_KEEP_LIMIT}`,
      `image-${MEDIA_KEEP_LIMIT + 1}`,
      `image-${MEDIA_KEEP_LIMIT + 2}`,
    ]);
  });

  it('counts photos and videos against the same budget', () => {
    const mixed = [...rows('image', MEDIA_KEEP_LIMIT), ...rows('video', 2)];
    expect(selectStaleMedia(mixed).map((r) => r.media_type)).toEqual(['video', 'video']);
  });

  it('gives voice notes their own budget, so a run of them evicts no photos', () => {
    const noisy = [...rows('audio', AUDIO_KEEP_LIMIT), ...rows('image', MEDIA_KEEP_LIMIT)];
    expect(selectStaleMedia(noisy)).toEqual([]);
  });

  it('trims voice notes only past the audio limit', () => {
    const stale = selectStaleMedia(rows('audio', AUDIO_KEEP_LIMIT + 2));
    expect(stale.map((r) => r.id)).toEqual([
      `audio-${AUDIO_KEEP_LIMIT}`,
      `audio-${AUDIO_KEEP_LIMIT + 1}`,
    ]);
  });

  it('ignores rows whose media has already been cleared', () => {
    const cleared: MediaRow[] = Array.from({ length: MEDIA_KEEP_LIMIT + 5 }, (_, i) => ({
      id: `cleared-${i}`,
      user_id: 'me',
      media_path: null,
      media_type: null,
    }));
    expect(selectStaleMedia([...cleared, ...rows('image', MEDIA_KEEP_LIMIT)])).toEqual([]);
  });

  it('scans far enough that a full pair of budgets can still be trimmed', () => {
    expect(MEDIA_SCAN_LIMIT).toBeGreaterThan(MEDIA_KEEP_LIMIT + AUDIO_KEEP_LIMIT);
  });
});

describe('mimeForPath', () => {
  // Storage serves every sealed object as application/octet-stream, so the
  // extension in the object name is the only surviving record of what the
  // bytes are. A decrypted blob built without this renders as a video with no
  // first frame and as an image that opens as a page of garbage text.
  it('names the common chat formats', () => {
    expect(mimeForPath('a/b/x.webp')).toBe('image/webp');
    expect(mimeForPath('a/b/x.jpg')).toBe('image/jpeg');
    expect(mimeForPath('a/b/x.jpeg')).toBe('image/jpeg');
    expect(mimeForPath('a/b/x.png')).toBe('image/png');
    expect(mimeForPath('a/b/x.mp4')).toBe('video/mp4');
    expect(mimeForPath('a/b/x.mov')).toBe('video/quicktime');
    expect(mimeForPath('a/b/x.m4a')).toBe('audio/mp4');
    expect(mimeForPath('a/b/x.ogg')).toBe('audio/ogg');
  });

  it('is case-insensitive, because a camera roll is not', () => {
    expect(mimeForPath('a/b/IMG_0001.JPG')).toBe('image/jpeg');
  });

  it('disambiguates webm by the message kind, which the extension cannot', () => {
    // A voice note and a video share the container. Guessing video for a
    // recording would leave the audio element unable to pick a decoder.
    expect(mimeForPath('a/b/x.webm', 'audio')).toBe('audio/webm');
    expect(mimeForPath('a/b/x.webm', 'video')).toBe('video/webm');
  });

  it('falls back to octet-stream rather than to a wrong type', () => {
    expect(mimeForPath('a/b/x.bin')).toBe('application/octet-stream');
    expect(mimeForPath('a/b/noextension')).toBe('application/octet-stream');
  });
});

describe('keyToken', () => {
  // openRows mints a fresh Uint8Array on every decrypt, and mergeMessages
  // replaces the newest row with a freshly-decrypted copy on every poll. A
  // hook keyed on the array's identity therefore re-downloaded and
  // re-decrypted its attachment every few seconds, blanking a playing video.
  it('is equal for equal bytes held in different arrays', () => {
    expect(keyToken(new Uint8Array([1, 2, 3]))).toBe(keyToken(new Uint8Array([1, 2, 3])));
  });

  it('differs for different bytes', () => {
    expect(keyToken(new Uint8Array([1, 2, 3]))).not.toBe(keyToken(new Uint8Array([1, 2, 4])));
  });

  it('does not confuse a boundary shift for the same key', () => {
    // A naive join on a delimiter-free encoding would make [1,23] and [12,3]
    // the same token.
    expect(keyToken(new Uint8Array([1, 23]))).not.toBe(keyToken(new Uint8Array([12, 3])));
  });

  it('has no token for no key', () => {
    expect(keyToken(null)).toBeNull();
    expect(keyToken(undefined)).toBeNull();
  });
});
