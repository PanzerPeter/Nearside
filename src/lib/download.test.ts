import { describe, expect, it } from 'vitest';
import { downloadName } from './download';

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
