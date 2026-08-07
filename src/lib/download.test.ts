import { describe, expect, it } from 'vitest';
import { downloadName, stripExtension } from './download';

describe('downloadName', () => {
  it('takes the object name from the path', () => {
    expect(downloadName('a_b/2f8c.webp', 'image')).toBe('2f8c.webp');
  });

  it('replaces characters a filesystem would refuse', () => {
    expect(downloadName('a_b/we ird:name?.mp4', 'video')).toBe('we_ird_name_.mp4');
  });

  it('falls back when there is no usable name', () => {
    expect(downloadName('a_b/', 'image')).toBe('image');
    expect(downloadName('', 'image')).toBe('image');
  });
});

describe('stripExtension', () => {
  it('drops the extension the gallery plugin will add back', () => {
    expect(stripExtension('2f8c.webp')).toBe('2f8c');
  });

  it('keeps a name that has no extension', () => {
    expect(stripExtension('image')).toBe('image');
  });

  it('leaves a leading dot alone', () => {
    // ".webp" is a name, not an extension, and slicing at index 0 would leave
    // the plugin copying to a file called nothing at all.
    expect(stripExtension('.webp')).toBe('.webp');
  });

  it('cuts at the last dot only', () => {
    expect(stripExtension('holiday.2026.mp4')).toBe('holiday.2026');
  });
});
