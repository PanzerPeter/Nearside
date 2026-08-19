import { describe, expect, it } from 'vitest';
import { restorePinned, type RestorablePin } from './pin-restore';
import type { Message } from './types';

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    user_id: 'them',
    receiver_id: 'me',
    ciphertext: 'c',
    nonce: 'n',
    text: null,
    media_path: null,
    media_type: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_duration_ms: null,
    reply_to_id: null,
    forwarded: false,
    sealed_prompt: false,
    edited_at: null,
    deleted_at: null,
    expires_at: null,
    created_at: '2026-08-19T10:00:00Z',
    ...over,
  };
}

function pin(over: Partial<RestorablePin> = {}): RestorablePin {
  return { media_path: 'a_b/photo.jpg', media_type: 'image', caption: '', ...over };
}

const NO_PINS = new Map<string, RestorablePin>();

describe('restorePinned', () => {
  it('leaves the array alone when nothing is pinned', () => {
    const rows = [message()];
    expect(restorePinned(rows, NO_PINS)).toBe(rows);
  });

  // The trim nulls the media columns and seals "📎 media removed" over the
  // caption. The bytes are on this phone; the row is what went missing.
  it('puts the path and kind back on a trimmed row this device pinned', () => {
    const rows = [message({ text: '📎 media removed' })];
    const [restored] = restorePinned(rows, new Map([['m1', pin()]]));
    expect(restored.media_path).toBe('a_b/photo.jpg');
    expect(restored.media_type).toBe('image');
    expect(restored.media_restored).toBe(true);
  });

  // The whole point of the caption travelling with the pin: a picture pinned
  // with something written under it comes back with it, not with the
  // placeholder that replaced it.
  it('restores the caption the message was pinned with', () => {
    const rows = [message({ text: '📎 media removed' })];
    const pins = new Map([['m1', pin({ caption: 'the roof, before' })]]);
    expect(restorePinned(rows, pins)[0].text).toBe('the roof, before');
  });

  it('leaves a pinned picture that never had a caption with no body', () => {
    const rows = [message({ text: '📎 media removed' })];
    expect(restorePinned(rows, new Map([['m1', pin({ caption: '' })]]))[0].text).toBeNull();
  });

  // Pins written before this build know nothing about the body, and inventing
  // one would be worse than the placeholder.
  it('leaves the body alone for a pin that recorded no caption', () => {
    const rows = [message({ text: '📎 media removed' })];
    const pins = new Map([['m1', pin({ caption: null })]]);
    expect(restorePinned(rows, pins)[0].text).toBe('📎 media removed');
  });

  // The key described the server object, which is exactly what is gone. The
  // restored row reads the pinned plaintext instead.
  it('does not invent a file key', () => {
    const rows = [message({ text: '📎 media removed' })];
    const [restored] = restorePinned(rows, new Map([['m1', pin()]]));
    expect(restored.media_key_ciphertext).toBeNull();
    expect(restored.media_key).toBeUndefined();
  });

  it('leaves a row that still has its media untouched', () => {
    const rows = [message({ media_path: 'a_b/live.jpg', media_type: 'image', text: 'now' })];
    const out = restorePinned(rows, new Map([['m1', pin({ caption: 'then' })]]));
    expect(out).toBe(rows);
    expect(out[0].text).toBe('now');
  });

  // A delete-for-everyone is the sender asking for the message to be gone. A
  // pin keeps a file past pruning, not past a deletion.
  it('does not resurrect a deleted message', () => {
    const rows = [message({ deleted_at: '2026-08-19T11:00:00Z' })];
    expect(restorePinned(rows, new Map([['m1', pin()]]))).toBe(rows);
  });

  it('keeps the identity of rows it did not touch', () => {
    const kept = message({ id: 'other', text: 'hello' });
    const rows = [kept, message({ text: '📎 media removed' })];
    const out = restorePinned(rows, new Map([['m1', pin()]]));
    expect(out).not.toBe(rows);
    expect(out[0]).toBe(kept);
  });

  it('ignores a pin whose row never recorded what it held', () => {
    const rows = [message({ text: '📎 media removed' })];
    const pins = new Map([['m1', pin({ media_path: null, media_type: null })]]);
    expect(restorePinned(rows, pins)).toBe(rows);
  });
});
