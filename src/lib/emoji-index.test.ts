import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMOJIS,
  categoriesFor,
  nativeFor,
  recentEmojiIds,
  recordEmojiUse,
  searchEmoji,
  storedSkinTone,
} from './emoji-index';

const all = categoriesFor(Infinity).flatMap((c) => c.emojis);

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  });
  return map;
}

afterEach(() => vi.unstubAllGlobals());

describe('categoriesFor', () => {
  it('drops emoji newer than the device can draw, and flags on request', () => {
    const v11 = categoriesFor(11).flatMap((c) => c.emojis);
    expect(v11.length).toBeLessThan(all.length);
    expect(v11.every((e) => e.version <= 11)).toBe(true);
    expect(categoriesFor(15, false).some((c) => c.id === 'flags')).toBe(false);
  });
});

describe('nativeFor', () => {
  it('applies a tone where one exists and falls back where none does', () => {
    expect(nativeFor(EMOJIS['+1'], 1)).toBe('👍');
    expect(nativeFor(EMOJIS['+1'], 6)).toBe('👍🏿');
    expect(nativeFor(EMOJIS.grinning, 6)).toBe('😀');
  });
});

describe('searchEmoji', () => {
  it('matches the start of a word, not the middle of one', () => {
    const ids = searchEmoji('smil', all).map((e) => e.id);
    expect(ids).toContain('smile');
    expect(searchEmoji('ile', all).map((e) => e.id)).not.toContain('smile');
  });

  it('needs every word, and ranks an exact id first', () => {
    expect(searchEmoji('heart', all)[0].id).toBe('heart');
    const both = searchEmoji('cat face', all);
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((e) => searchEmoji('cat', all).includes(e))).toBe(true);
  });

  it('finds emoticons and returns nothing for an empty query', () => {
    expect(searchEmoji(':d', all).map((e) => e.id)).toContain('grinning');
    expect(searchEmoji('  ', all)).toEqual([]);
  });
});

describe('recents', () => {
  it('starts from the starter row, every id of which exists', () => {
    memoryStorage();
    const ids = recentEmojiIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => EMOJIS[id])).toBe(true);
  });

  it('carries emoji-mart counts over, most used first', () => {
    memoryStorage({ 'emoji-mart.frequently': JSON.stringify({ joy: 2, fire: 9 }) });
    expect(recentEmojiIds()).toEqual(['fire', 'joy']);
  });

  it('moves a used emoji to the front without duplicating it', () => {
    memoryStorage({ 'nearside.emoji.recent': JSON.stringify(['joy', 'fire']) });
    recordEmojiUse('fire');
    expect(recentEmojiIds()).toEqual(['fire', 'joy']);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(recentEmojiIds().length).toBeGreaterThan(0);
    expect(() => recordEmojiUse('joy')).not.toThrow();
    expect(storedSkinTone()).toBe(1);
  });

  it('reads the legacy skin tone', () => {
    memoryStorage({ 'emoji-mart.skin': '4' });
    expect(storedSkinTone()).toBe(4);
  });
});
