import { describe, expect, it } from 'vitest';
import { MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from './media';
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
