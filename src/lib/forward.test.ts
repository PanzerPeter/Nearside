import { describe, expect, it } from 'vitest';
import {
  classifyForwardError,
  describeForwardFailure,
  forwardMediaPath,
  forwardPayload,
  forwardRoomDraft,
  forwardRoomMediaPath,
  isForwardable,
  isRoomForwardable,
  peerSource,
  roomSource,
  matchesTarget,
  pathExtension,
} from './forward';
import { conversationKey } from './conversation';
import type { Message } from './types';

const ME = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const SOURCE = '33333333-3333-3333-3333-333333333333';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    user_id: SOURCE,
    receiver_id: ME,
    text: null,
    ciphertext: null,
    nonce: null,
    media_path: null,
    media_type: null,
    media_thumb_path: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_duration_ms: null,
    reply_to_id: null,
    forwarded: false,
    sealed_prompt: false,
    edited_at: null,
    deleted_at: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('pathExtension', () => {
  it('reads the extension of a storage object path', () => {
    expect(pathExtension('a_b/6f9d.jpg')).toBe('jpg');
  });

  it('lowercases, so one upload has one canonical form', () => {
    expect(pathExtension('a_b/6f9d.JPG')).toBe('jpg');
  });

  it('is empty when the name carries no extension', () => {
    expect(pathExtension('a_b/6f9d')).toBe('');
  });

  it('treats a leading dot as a hidden name, not an extension', () => {
    expect(pathExtension('a_b/.gitkeep')).toBe('');
  });
});

describe('forwardMediaPath', () => {
  it('lands the copy in the destination conversation folder', () => {
    const path = forwardMediaPath(ME, BOB, `${conversationKey(ME, SOURCE)}/old.mp4`, 'new');
    expect(path).toBe(`${conversationKey(ME, BOB)}/new.mp4`);
  });

  it('never reuses the source path — the destination could not read it', () => {
    const source = `${conversationKey(ME, SOURCE)}/old.mp4`;
    expect(forwardMediaPath(ME, BOB, source, 'new')).not.toBe(source);
  });

  it('keeps the two-segment folder shape for a forward into your own notes', () => {
    const path = forwardMediaPath(ME, ME, `${conversationKey(ME, BOB)}/clip.webm`, 'new');
    expect(path).toBe(`${ME}_${ME}/new.webm`);
  });

  it('omits the dot when the original had no extension', () => {
    expect(forwardMediaPath(ME, BOB, 'a_b/raw', 'new')).toBe(`${conversationKey(ME, BOB)}/new`);
  });
});

describe('forwardPayload', () => {
  it('addresses the message from the forwarder to the target', () => {
    const row = forwardPayload(peerSource(message({ text: 'hi' })), ME, BOB, null);
    expect(row.user_id).toBe(ME);
    expect(row.receiver_id).toBe(BOB);
  });

  it('marks the row as forwarded', () => {
    expect(forwardPayload(peerSource(message({ text: 'hi' })), ME, BOB, null).forwarded).toBe(true);
  });

  it('drops the reply, which names a message in the other conversation', () => {
    const row = forwardPayload(peerSource(message({ text: 'hi', reply_to_id: 'somewhere-else' })), ME, BOB, null);
    expect(row.reply_to_id).toBeNull();
  });

  it('points at the copied object, not the original', () => {
    const original = message({ media_path: 'a_b/old.jpg', media_type: 'image' });
    const row = forwardPayload(peerSource(original), ME, BOB, 'c_d/new.jpg');
    expect(row.media_path).toBe('c_d/new.jpg');
    expect(row.media_type).toBe('image');
  });

  it('points at the copied thumbnail, not the original', () => {
    const original = message({
      media_path: 'a_b/old.jpg',
      media_type: 'image',
      media_thumb_path: 'a_b/old-thumb.webp',
    });
    const row = forwardPayload(peerSource(original), ME, BOB, 'c_d/new.jpg', 'c_d/new-thumb.webp');
    expect(row.media_thumb_path).toBe('c_d/new-thumb.webp');
  });

  it('forwards without a thumbnail when the preview could not be copied', () => {
    const original = message({
      media_path: 'a_b/old.jpg',
      media_type: 'image',
      media_thumb_path: 'a_b/old-thumb.webp',
    });
    // The bubble falls back to the full object, which is what a pre-0044
    // message does. Losing the message over a missing preview would be worse.
    expect(forwardPayload(peerSource(original), ME, BOB, 'c_d/new.jpg', null).media_thumb_path).toBeNull();
  });

  it('never keeps a thumbnail when the attachment itself did not come across', () => {
    // The 0044 CHECK refuses that row, and a preview with nothing behind the
    // tap is a picture that cannot be opened.
    const original = message({
      media_path: 'a_b/old.jpg',
      media_type: 'image',
      media_thumb_path: 'a_b/old-thumb.webp',
    });
    expect(forwardPayload(peerSource(original), ME, BOB, null, 'c_d/new-thumb.webp').media_thumb_path).toBeNull();
  });

  it('carries a voice note length across with its file', () => {
    const original = message({ media_path: 'a_b/v.webm', media_type: 'audio', media_duration_ms: 4200 });
    expect(forwardPayload(peerSource(original), ME, BOB, 'c_d/v.webm').media_duration_ms).toBe(4200);
  });

  it('keeps no duration for a voice note whose file was not copied', () => {
    const original = message({ text: '🎤 voice message removed', media_duration_ms: 4200 });
    const row = forwardPayload(peerSource(original), ME, BOB, null);
    expect(row.media_duration_ms).toBeNull();
    expect(row.media_type).toBeNull();
  });

  it('normalises an empty caption to null rather than an empty body', () => {
    expect(forwardPayload(peerSource(message({ text: '' })), ME, BOB, 'c_d/p.jpg').text).toBeNull();
  });
});

describe('isForwardable', () => {
  it('accepts a message with a body', () => {
    expect(isForwardable(message({ text: 'hi' }))).toBe(true);
  });

  it('accepts media with no caption', () => {
    expect(isForwardable(message({ media_path: 'a_b/p.jpg' }))).toBe(true);
  });

  it('refuses a deleted message, whose body has been stripped', () => {
    expect(isForwardable(message({ text: 'hi', deleted_at: new Date().toISOString() }))).toBe(
      false
    );
  });

  it('refuses a body that is only whitespace', () => {
    expect(isForwardable(message({ text: '   ' }))).toBe(false);
  });
});

describe('reading a source off either kind of message', () => {
  it('narrows a one-to-one message to what travels', () => {
    const source = peerSource(
      message({
        text: 'hello',
        media_path: 'a_b/p.jpg',
        media_type: 'image',
        media_thumb_path: 'a_b/p-thumb.webp',
        media_key: new Uint8Array([1, 2, 3]),
      })
    );
    expect(source.text).toBe('hello');
    expect(source.mediaPath).toBe('a_b/p.jpg');
    expect(source.mediaThumbPath).toBe('a_b/p-thumb.webp');
    expect(source.fileKey).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('narrows a group message to the same shape', () => {
    const source = roomSource({
      id: 'rm1',
      room_id: 'r1',
      sender_id: SOURCE,
      ciphertext: 'ct',
      nonce: 'nn',
      signature: 'sig',
      created_at: new Date().toISOString(),
      text: 'hello',
      media_path: 'r1/p.jpg',
      media_type: 'image',
      media_thumb_path: 'r1/p-thumb.webp',
      mediaKey: new Uint8Array([4, 5, 6]),
      sender: 'verified',
    });
    expect(source.text).toBe('hello');
    expect(source.mediaPath).toBe('r1/p.jpg');
    expect(source.fileKey).toEqual(new Uint8Array([4, 5, 6]));
  });

  // The signature describes the row it is on. Copied onto a new row it would
  // verify against nothing, so it must not be part of what travels.
  it('leaves the group signature behind', () => {
    const source = roomSource({
      id: 'rm1',
      room_id: 'r1',
      sender_id: SOURCE,
      ciphertext: 'ct',
      nonce: 'nn',
      signature: 'a-signature-over-the-old-row',
      created_at: new Date().toISOString(),
      text: 'hello',
      sender: 'verified',
    });
    expect(JSON.stringify(source)).not.toContain('a-signature-over-the-old-row');
  });
});

describe('forwardRoomMediaPath', () => {
  it('lands in the destination room folder with a fresh name', () => {
    expect(forwardRoomMediaPath('r-9', 'a_b/old.jpg', 'fresh')).toBe('r-9/fresh.jpg');
  });

  it('keeps a path with no extension usable', () => {
    expect(forwardRoomMediaPath('r-9', 'a_b/old', 'fresh')).toBe('r-9/fresh');
  });

  // The `chat-media` policies key access off the folder name, so a forward that
  // kept the source path would arrive unreadable to the group.
  it('never reuses the source folder', () => {
    expect(forwardRoomMediaPath('r-9', 'a_b/old.jpg', 'fresh').startsWith('a_b/')).toBe(false);
  });
});

describe('forwardRoomDraft', () => {
  const source = { mediaType: 'image' as const, mediaDurationMs: null };
  const key = { ciphertext: 'ct', nonce: 'nn' };

  it('is null when there is nothing to attach', () => {
    expect(forwardRoomDraft(source, null, null, null)).toBeNull();
  });

  it('is null when the file key could not be sealed for the room', () => {
    expect(forwardRoomDraft(source, 'r-9/f.jpg', null, null)).toBeNull();
  });

  it('carries the destination paths, never the source ones', () => {
    const draft = forwardRoomDraft(source, 'r-9/f.jpg', 'r-9/f-thumb.webp', key);
    expect(draft?.path).toBe('r-9/f.jpg');
    expect(draft?.thumbPath).toBe('r-9/f-thumb.webp');
    expect(draft?.key).toEqual(key);
  });

  // A length describing a file the row no longer carries, or one that was
  // never a voice note, is a bubble claiming a duration for a photo.
  it('keeps a duration only on a voice note', () => {
    expect(
      forwardRoomDraft({ mediaType: 'audio', mediaDurationMs: 4200 }, 'r-9/v.webm', null, key)
        ?.durationMs
    ).toBe(4200);
    expect(
      forwardRoomDraft({ mediaType: 'image', mediaDurationMs: 4200 }, 'r-9/p.jpg', null, key)
        ?.durationMs
    ).toBeNull();
  });
});

describe('isRoomForwardable', () => {
  const verified = { text: 'hi', media_path: null, deleted_at: null, sender: 'verified' as const };

  it('accepts a verified message with a body', () => {
    expect(isRoomForwardable(verified)).toBe(true);
  });

  // Forwarding a forgery would re-seal and re-sign it as yours: it arrives in
  // the destination verified, with the warning the source showed removed.
  it('refuses a message whose signature did not check out', () => {
    expect(isRoomForwardable({ ...verified, sender: 'unverified' })).toBe(false);
  });

  // The same bet with no warning at all — this device could not check.
  it('refuses a message from a sender with no published signing key', () => {
    expect(isRoomForwardable({ ...verified, sender: 'unknown' })).toBe(false);
  });

  it('refuses a tombstone', () => {
    expect(isRoomForwardable({ ...verified, deleted_at: new Date().toISOString() })).toBe(false);
  });

  it('accepts a verified attachment with no caption', () => {
    expect(isRoomForwardable({ ...verified, text: null, media_path: 'r1/p.jpg' })).toBe(true);
  });
});

describe('classifyForwardError', () => {
  it('names an unmigrated server, so the message can say so', () => {
    expect(classifyForwardError({ code: 'PGRST204' })).toBe('not-set-up');
  });

  it('recognises the rate limit by its constraint name', () => {
    expect(classifyForwardError({ message: 'rate_limited_messages' })).toBe('rate-limited');
  });

  it('falls through to a generic failure for anything else', () => {
    expect(classifyForwardError({ code: '42501', message: 'permission denied' })).toBe('failed');
    expect(classifyForwardError(null)).toBe('failed');
  });
});

describe('describeForwardFailure', () => {
  it('names the target only where the target is what went wrong', () => {
    expect(describeForwardFailure('failed', 'Bobby')).toContain('Bobby');
    expect(describeForwardFailure('rate-limited', 'Bobby')).not.toContain('Bobby');
  });
});

describe('matchesTarget', () => {
  it('matches everything while the filter is empty', () => {
    expect(matchesTarget('Bobby', 'bob', '')).toBe(true);
    expect(matchesTarget('Bobby', 'bob', '   ')).toBe(true);
  });

  it('finds a renamed friend by the handle you first knew them as', () => {
    expect(matchesTarget('Bobby', 'bob', 'bob')).toBe(true);
  });

  it('finds them by the name you gave them', () => {
    expect(matchesTarget('Bobby', 'xy12', 'bobby')).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(matchesTarget('Note to self', 'me', '  NOTE ')).toBe(true);
  });

  it('rejects a conversation that matches neither name', () => {
    expect(matchesTarget('Bobby', 'bob', 'alice')).toBe(false);
  });
});
