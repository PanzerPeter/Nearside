import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetStickerRecents,
  promoteRecent,
  recentStickerIds,
  recordStickerUse,
  resolveRecents,
  RECENT_LIMIT,
} from './sticker-recents';

const ME = 'user-a';
const OTHER = 'user-b';

/** The node suite has no DOM, so the store is stubbed rather than mocked away:
 *  the guards in `sticker-recents.ts` are there for a storage that throws, and
 *  a test that never provides one proves nothing about the happy path. */
function installStorage() {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe('promoteRecent', () => {
  it('puts the newest use at the front', () => {
    expect(promoteRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('moves a sticker already in the list rather than repeating it', () => {
    expect(promoteRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('drops the oldest once the shelf is full', () => {
    const full = Array.from({ length: RECENT_LIMIT }, (_, i) => `s${i}`);
    const next = promoteRecent(full, 'new');
    expect(next).toHaveLength(RECENT_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`s${RECENT_LIMIT - 1}`);
  });

  it('starts a list from nothing', () => {
    expect(promoteRecent([], 'a')).toEqual(['a']);
  });
});

describe('stored recents', () => {
  beforeEach(installStorage);

  it('remembers across reads', () => {
    recordStickerUse(ME, 'a');
    recordStickerUse(ME, 'b');
    expect(recentStickerIds(ME)).toEqual(['b', 'a']);
  });

  it('keeps one account’s habits out of another’s picker', () => {
    recordStickerUse(ME, 'a');
    expect(recentStickerIds(OTHER)).toEqual([]);
  });

  it('has nothing to say without an account', () => {
    expect(recentStickerIds(null)).toEqual([]);
    expect(recordStickerUse(null, 'a')).toEqual([]);
  });

  it('is emptied by forgetting', () => {
    recordStickerUse(ME, 'a');
    forgetStickerRecents(ME);
    expect(recentStickerIds(ME)).toEqual([]);
  });

  it('ignores a stored value that is not a list of ids', () => {
    localStorage.setItem('nearside.stickers.recent.' + ME, '{"not":"a list"}');
    expect(recentStickerIds(ME)).toEqual([]);
  });

  it('ignores non-string entries somebody else wrote', () => {
    localStorage.setItem('nearside.stickers.recent.' + ME, '["a",7,null,"b"]');
    expect(recentStickerIds(ME)).toEqual(['a', 'b']);
  });

  it('survives a storage that refuses to answer', () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(recentStickerIds(ME)).toEqual([]);
    expect(() => recordStickerUse(ME, 'a')).not.toThrow();
    expect(() => forgetStickerRecents(ME)).not.toThrow();
  });
});

describe('resolveRecents', () => {
  const library = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns the stickers in recency order, not library order', () => {
    expect(resolveRecents(['c', 'a'], library)).toEqual([{ id: 'c' }, { id: 'a' }]);
  });

  it('drops an id whose sticker is gone rather than leaving a hole', () => {
    expect(resolveRecents(['a', 'deleted', 'b'], library)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('has nothing to show against an empty library', () => {
    expect(resolveRecents(['a'], [])).toEqual([]);
  });
});
