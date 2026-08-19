import { beforeEach, describe, expect, it } from 'vitest';
import { clearLocalDb, openLocalDb } from './localdb';
import {
  clearPinnedMedia,
  forgetPinIndex,
  loadPins,
  pinMedia,
  pinsSnapshot,
  subscribePins,
  unpinMedia,
} from './pins';
import { restorePinned } from './pin-restore';
import type { Message } from './types';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const PATH = `${ME}_${OTHER}/6f0d.jpg`;

// The web/test driver of `pins.ts` writes no file — `isMobileNative()` is
// false here — but the row it records is the part that has to survive, and it
// is the part a bubble reads to put a trimmed message back together.
const bytes = new Uint8Array([1, 2, 3]);

function trimmedRow(id: string): Message {
  return {
    id,
    user_id: OTHER,
    receiver_id: ME,
    ciphertext: 'c',
    nonce: 'n',
    // What the sender's device seals over the caption when it trims the object.
    text: '📎 media removed',
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
  };
}

describe('pins', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
    forgetPinIndex();
    await loadPins();
  });

  it('records what the message held, not just where the bytes went', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: 'the roof, before' });
    const pin = pinsSnapshot().get('m1');
    expect(pin).toMatchObject({
      media_path: PATH,
      media_type: 'image',
      caption: 'the roof, before',
    });
  });

  // The whole point: the sender's trim empties the row, and this device still
  // has everything it needs to draw the picture and the words under it.
  it('rebuilds a trimmed row from the pin, caption and all', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: 'the roof, before' });
    const [restored] = restorePinned([trimmedRow('m1')], pinsSnapshot());
    expect(restored.media_path).toBe(PATH);
    expect(restored.media_type).toBe('image');
    expect(restored.text).toBe('the roof, before');
    expect(restored.media_restored).toBe(true);
  });

  it('survives a reload from the store', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'video', caption: 'the last lap' });
    forgetPinIndex();
    expect(pinsSnapshot().size).toBe(0);
    await loadPins();
    expect(pinsSnapshot().get('m1')).toMatchObject({ media_type: 'video', caption: 'the last lap' });
  });

  it('publishes a fresh map so a subscriber sees the change', async () => {
    let notified = 0;
    const stop = subscribePins(() => (notified += 1));
    const before = pinsSnapshot();
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: '' });
    expect(notified).toBe(1);
    expect(pinsSnapshot()).not.toBe(before);
    stop();
  });

  it('drops the row and the index entry on unpin', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: '' });
    await unpinMedia('m1');
    expect(pinsSnapshot().has('m1')).toBe(false);
    await loadPins();
    expect(pinsSnapshot().has('m1')).toBe(false);
  });

  it('empties the index when every pin is cleared', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: '' });
    await pinMedia('m2', PATH, bytes, { mediaType: 'image', caption: '' });
    await clearPinnedMedia();
    expect(pinsSnapshot().size).toBe(0);
    await loadPins();
    expect(pinsSnapshot().size).toBe(0);
  });

  // A pin names the message, never the object: two forwards of one picture
  // share a path, and keying the file on the path would make unpinning either
  // one delete the other's bytes.
  it('keeps two pins of the same object apart', async () => {
    await pinMedia('m1', PATH, bytes, { mediaType: 'image', caption: 'first' });
    await pinMedia('m2', PATH, bytes, { mediaType: 'image', caption: 'second' });
    const files = [...pinsSnapshot().values()].map((p) => p.file_path);
    expect(new Set(files).size).toBe(2);
  });
});
