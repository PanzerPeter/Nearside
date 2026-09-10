import { describe, expect, it } from 'vitest';
import {
  shouldMakeThumbnail,
  thumbDimensions,
  THUMB_MAX_EDGE,
  THUMB_MIN_SOURCE_BYTES,
  worthUploading,
} from './thumbnail';

const BIG = THUMB_MIN_SOURCE_BYTES * 4;

describe('shouldMakeThumbnail', () => {
  it('makes one for a photograph', () => {
    expect(shouldMakeThumbnail('image', BIG, false)).toBe(true);
  });

  it('makes one for a video, which is where the bytes actually are', () => {
    expect(shouldMakeThumbnail('video', BIG, false)).toBe(true);
  });

  it('never makes one for a voice note', () => {
    expect(shouldMakeThumbnail('audio', BIG, false)).toBe(false);
  });

  it('never makes one for a sticker, which is the message rather than a preview', () => {
    expect(shouldMakeThumbnail('sticker', BIG, false)).toBe(false);
  });

  it('refuses an animation, whose thumbnail would be it not playing', () => {
    expect(shouldMakeThumbnail('image', BIG, true)).toBe(false);
  });

  it('skips a file already smaller than the thumbnail would be worth', () => {
    expect(shouldMakeThumbnail('image', THUMB_MIN_SOURCE_BYTES - 1, false)).toBe(false);
  });
});

describe('thumbDimensions', () => {
  it('caps the long edge and keeps the aspect ratio', () => {
    expect(thumbDimensions(1920, 1080)).toEqual({ width: 360, height: 203 });
  });

  it('caps the long edge of a portrait picture too', () => {
    const { width, height } = thumbDimensions(1080, 1920);
    expect(height).toBe(THUMB_MAX_EDGE);
    expect(width).toBe(203);
  });

  it('leaves a picture that already fits alone rather than upscaling it', () => {
    expect(thumbDimensions(200, 100)).toEqual({ width: 200, height: 100 });
  });

  it('never rounds an edge away to nothing', () => {
    const { width, height } = thumbDimensions(4000, 1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe('worthUploading', () => {
  it('accepts a thumbnail that is a fraction of the original', () => {
    expect(worthUploading(400_000, 12_000)).toBe(true);
  });

  it('refuses one that barely saves anything, since it is a second object', () => {
    expect(worthUploading(100_000, 90_000)).toBe(false);
  });

  it('refuses an empty encode', () => {
    expect(worthUploading(100_000, 0)).toBe(false);
  });

  it('takes exactly half', () => {
    expect(worthUploading(100_000, 50_000)).toBe(true);
    expect(worthUploading(100_000, 50_001)).toBe(false);
  });
});
