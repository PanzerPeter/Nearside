import { describe, expect, it } from 'vitest';
import {
  compressImage,
  compressImageResult,
  imageDecodes,
  isCompressible,
  MIN_SAVING_RATIO,
  replaceExtension,
  shouldUseCompressed,
  targetDimensions,
} from './compress';

describe('isCompressible', () => {
  it('accepts the still formats a camera or screenshot produces', () => {
    expect(isCompressible('image/jpeg')).toBe(true);
    expect(isCompressible('image/png')).toBe(true);
    expect(isCompressible('image/webp')).toBe(true);
  });

  it('refuses GIF, whose animation a canvas would flatten away', () => {
    expect(isCompressible('image/gif')).toBe(false);
  });

  it('refuses anything that is not an image it can decode', () => {
    expect(isCompressible('video/mp4')).toBe(false);
    expect(isCompressible('application/pdf')).toBe(false);
    expect(isCompressible('')).toBe(false);
  });

  it('ignores mime casing', () => {
    expect(isCompressible('IMAGE/JPEG')).toBe(true);
  });
});

describe('targetDimensions', () => {
  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(targetDimensions(4000, 3000, 1920)).toEqual({ width: 1920, height: 1440, scaled: true });
  });

  it('caps by height when the image is portrait', () => {
    expect(targetDimensions(3000, 4000, 1920)).toEqual({ width: 1440, height: 1920, scaled: true });
  });

  it('leaves an image that already fits alone, and says so', () => {
    expect(targetDimensions(800, 600, 1920)).toEqual({ width: 800, height: 600, scaled: false });
  });

  it('never upscales an image exactly at the cap', () => {
    expect(targetDimensions(1920, 1080, 1920)).toEqual({
      width: 1920,
      height: 1080,
      scaled: false,
    });
  });

  it('keeps a sliver of an extreme panorama rather than rounding it to zero', () => {
    expect(targetDimensions(10000, 3, 1920).height).toBe(1);
  });

  it('passes degenerate sizes through untouched', () => {
    expect(targetDimensions(0, 0, 1920)).toEqual({ width: 0, height: 0, scaled: false });
  });
});

describe('shouldUseCompressed', () => {
  it('keeps a downscaled result whenever it is smaller at all', () => {
    expect(shouldUseCompressed(1000, 999, true)).toBe(true);
  });

  it('discards a downscaled result that somehow grew', () => {
    expect(shouldUseCompressed(1000, 1000, true)).toBe(false);
    expect(shouldUseCompressed(1000, 1200, true)).toBe(false);
  });

  it('demands a clear win from a same-size re-encode', () => {
    // A marginal saving is not worth a second generation of lossy encoding.
    expect(shouldUseCompressed(1000, 950, false)).toBe(false);
    expect(shouldUseCompressed(1000, 1000 * MIN_SAVING_RATIO - 1, false)).toBe(true);
  });

  it('rejects an empty encode result', () => {
    expect(shouldUseCompressed(1000, 0, true)).toBe(false);
  });
});

describe('replaceExtension', () => {
  it('swaps the extension', () => {
    expect(replaceExtension('holiday.JPG', 'webp')).toBe('holiday.webp');
  });

  it('adds one when the name has none', () => {
    expect(replaceExtension('scan', 'webp')).toBe('scan.webp');
  });

  it('only touches the last extension', () => {
    expect(replaceExtension('archive.tar.gz', 'webp')).toBe('archive.tar.webp');
  });

  it('leaves a dotfile as the stem rather than eating the name', () => {
    expect(replaceExtension('.profile', 'webp')).toBe('.profile.webp');
  });

  it('falls back to a usable name when there is none', () => {
    expect(replaceExtension('   ', 'webp')).toBe('image.webp');
  });
});

// Both of these run where there is no decoder at all, which is the branch that
// matters most: a platform that cannot be asked must never answer "broken".
// The decoding itself belongs to a browser and is not mocked here — a stub
// createImageBitmap would only be testing the stub.
describe('imageDecodes without a decoder', () => {
  it('says yes, so the element is still given its chance', async () => {
    expect(typeof createImageBitmap).not.toBe('function');
    await expect(imageDecodes(new Blob([new Uint8Array([1, 2, 3])]))).resolves.toBe(true);
  });
});

describe('compressImageResult without a decoder', () => {
  const file = (type: string) => new File([new Uint8Array(16)], `pic.${type.split('/')[1]}`, { type });

  it('hands the original back and claims nothing about it', async () => {
    const original = file('image/png');
    await expect(compressImageResult(original, { maxEdge: 1920 })).resolves.toEqual({
      file: original,
      bytes: new Uint8Array(16),
      undecodable: false,
    });
  });

  it('leaves a format it never re-encodes alone', async () => {
    // GIF is excluded on purpose — a canvas keeps only the first frame — so it
    // must not be run through the decode check either.
    const gif = file('image/gif');
    await expect(compressImageResult(gif, { maxEdge: 1920 })).resolves.toEqual({
      file: gif,
      bytes: new Uint8Array(16),
      undecodable: false,
    });
  });

  it('still takes the camera metadata off a file it is passing through', async () => {
    // The pass-through paths are exactly the ones the canvas cannot clean up
    // for free, so this is where a photo's GPS coordinates would otherwise
    // reach the recipient intact.
    const exif = [...'Exif'].map((c) => c.charCodeAt(0));
    const app1 = [0xff, 0xe1, 0x00, 0x20, ...exif, 0x00, 0x00, ...new Array(24).fill(0)];
    const withExif = new Uint8Array([
      0xff, 0xd8, ...app1,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x12, 0x34, 0xff, 0xd9,
    ]);
    const original = new File([withExif], 'photo.jpg', { type: 'image/jpeg' });

    const result = await compressImageResult(original, { maxEdge: 1920 });
    expect(result.bytes.length).toBe(withExif.length - app1.length);
    expect(result.file).not.toBe(original);
    expect(result.file.type).toBe('image/jpeg');
  });

  it('reports a file whose bytes cannot be read rather than sending nothing', async () => {
    const unreadable = new File([new Uint8Array(4)], 'gone.jpg', { type: 'image/jpeg' });
    Object.defineProperty(unreadable, 'arrayBuffer', {
      value: () => Promise.reject(new DOMException('permission', 'NotReadableError')),
    });
    await expect(compressImageResult(unreadable, { maxEdge: 1920 })).rejects.toThrow();
    // The avatar/background wrapper keeps its "never a gate" promise instead.
    await expect(compressImage(unreadable, { maxEdge: 512 })).resolves.toBe(unreadable);
  });
});
