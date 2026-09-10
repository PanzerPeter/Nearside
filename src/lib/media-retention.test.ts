import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_POLICY,
  isKeepPolicy,
  keepableFromTrim,
  shouldKeep,
  type KeepPolicy,
} from './media-retention';

const POLICIES: KeepPolicy[] = ['off', 'light', 'all'];

describe('a disappearing message is never kept', () => {
  // The load-bearing test in this file. The timer is the one promise both
  // people agreed to, and a device quietly archiving what was meant to vanish
  // would break it on the side that never consented — silently, and only
  // discoverable by reading this code.
  it('refuses at every setting, for every kind of attachment', () => {
    for (const policy of POLICIES) {
      for (const mediaType of ['image', 'video', 'audio'] as const) {
        expect(
          shouldKeep({ mediaType, expiresAt: '2026-09-10T00:00:00Z' }, policy),
          `${mediaType} under ${policy}`
        ).toBe(false);
      }
    }
  });

  it('is filtered out of a trim batch too, not only off the view path', () => {
    const rows = [
      { id: 'keep', media_type: 'image' as const, expires_at: null },
      { id: 'vanishing', media_type: 'image' as const, expires_at: '2026-09-10T00:00:00Z' },
    ];
    expect(keepableFromTrim(rows, 'all').map((r) => r.id)).toEqual(['keep']);
  });
});

describe('shouldKeep', () => {
  it('keeps nothing when it is off', () => {
    for (const mediaType of ['image', 'video', 'audio'] as const) {
      expect(shouldKeep({ mediaType }, 'off')).toBe(false);
    }
  });

  it('keeps photos and voice notes on the light setting', () => {
    expect(shouldKeep({ mediaType: 'image' }, 'light')).toBe(true);
    expect(shouldKeep({ mediaType: 'audio' }, 'light')).toBe(true);
  });

  it('leaves video alone until asked, since video is the whole storage question', () => {
    expect(shouldKeep({ mediaType: 'video' }, 'light')).toBe(false);
    expect(shouldKeep({ mediaType: 'video' }, 'all')).toBe(true);
  });

  it('never keeps a sticker', () => {
    // A sticker is re-uploaded on every send by design, so keeping received
    // copies accumulates one file per send of a picture the sender already
    // has in their own library.
    for (const policy of POLICIES) {
      expect(shouldKeep({ mediaType: 'sticker' }, policy)).toBe(false);
    }
  });

  it('has nothing to keep for a text message', () => {
    expect(shouldKeep({ mediaType: null }, 'all')).toBe(false);
  });
});

describe('isKeepPolicy', () => {
  it('accepts the three settings', () => {
    for (const policy of POLICIES) expect(isKeepPolicy(policy)).toBe(true);
  });

  it('rejects anything else, so a corrupted preference falls back', () => {
    // The value comes back from localStorage, where any string can appear —
    // including one written by a future build and then downgraded.
    expect(isKeepPolicy('everything')).toBe(false);
    expect(isKeepPolicy(null)).toBe(false);
    expect(isKeepPolicy(undefined)).toBe(false);
  });

  it('has a default that is itself a valid setting', () => {
    expect(isKeepPolicy(DEFAULT_KEEP_POLICY)).toBe(true);
  });
});
