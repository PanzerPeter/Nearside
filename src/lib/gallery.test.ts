import { describe, expect, it } from 'vitest';
import { galleryIndexOf, galleryItems, stepGallery, type GalleryItem } from './gallery';
import type { Message } from './types';

function row(over: Partial<Message> & { id: string }): Message {
  return {
    sender_id: 'a',
    receiver_id: 'b',
    user_id: 'a',
    created_at: '2026-01-01T00:00:00Z',
    ciphertext: null,
    nonce: null,
    text: null,
    media_path: null,
    media_type: null,
    media_thumb_path: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_key: null,
    expires_at: null,
    deleted_at: null,
    ...over,
  } as Message;
}

function image(id: string, over: Partial<Message> = {}): Message {
  return row({ id, media_path: `${id}.bin`, media_type: 'image', ...over });
}

describe('galleryItems', () => {
  it('keeps the order it was given', () => {
    const items = galleryItems([image('one'), image('two'), image('three')]);
    expect(items.map((i) => i.messageId)).toEqual(['one', 'two', 'three']);
  });

  it('takes only the media that has a full-size view', () => {
    const items = galleryItems([
      image('photo'),
      row({ id: 'clip', media_path: 'clip.bin', media_type: 'video' }),
      row({ id: 'voice', media_path: 'voice.bin', media_type: 'audio' }),
      row({ id: 'sticker', media_path: 'sticker.bin', media_type: 'sticker' }),
      row({ id: 'words', text: 'hello' }),
    ]);
    expect(items.map((i) => i.messageId)).toEqual(['photo', 'clip']);
  });

  it('skips a deleted message whose columns this device is still holding', () => {
    const items = galleryItems([image('kept'), image('gone', { deleted_at: '2026-01-02T00:00:00Z' })]);
    expect(items.map((i) => i.messageId)).toEqual(['kept']);
  });

  it('skips a row with a type but no object to draw', () => {
    expect(galleryItems([row({ id: 'x', media_type: 'image' })])).toEqual([]);
  });

  it('carries the caption, the key and the timer through', () => {
    const key = new Uint8Array([1, 2, 3]);
    const [item] = galleryItems([
      image('p', { text: 'at the pier', media_key: key, expires_at: '2026-02-01T00:00:00Z' }),
    ]);
    expect(item.caption).toBe('at the pier');
    expect(item.mediaKey).toBe(key);
    expect(item.expiresAt).toBe('2026-02-01T00:00:00Z');
  });
});

describe('galleryIndexOf', () => {
  const items = galleryItems([image('one'), image('two')]);

  it('finds a message by id', () => {
    expect(galleryIndexOf(items, 'two')).toBe(1);
  });

  it('tells two sends of the same file apart', () => {
    const twice = galleryItems([
      row({ id: 'first', media_path: 'same.bin', media_type: 'image' }),
      row({ id: 'again', media_path: 'same.bin', media_type: 'image' }),
    ]);
    expect(galleryIndexOf(twice, 'again')).toBe(1);
  });

  it('reports -1 for a message that is not in the list', () => {
    expect(galleryIndexOf(items, 'three')).toBe(-1);
  });
});

describe('stepGallery', () => {
  const items = [{}, {}, {}] as GalleryItem[];

  it('moves by one in either direction', () => {
    expect(stepGallery(items, 1, 1)).toBe(2);
    expect(stepGallery(items, 1, -1)).toBe(0);
  });

  it('stops at the ends rather than wrapping round', () => {
    expect(stepGallery(items, 2, 1)).toBe(2);
    expect(stepGallery(items, 0, -1)).toBe(0);
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepGallery([], 0, 1)).toBe(-1);
  });
});
