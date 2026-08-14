import { describe, expect, it } from 'vitest';
import {
  classifyForwardError,
  describeForwardFailure,
  forwardMediaPath,
  forwardPayload,
  isForwardable,
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
    const row = forwardPayload(message({ text: 'hi' }), ME, BOB, null);
    expect(row.user_id).toBe(ME);
    expect(row.receiver_id).toBe(BOB);
  });

  it('marks the row as forwarded', () => {
    expect(forwardPayload(message({ text: 'hi' }), ME, BOB, null).forwarded).toBe(true);
  });

  it('drops the reply, which names a message in the other conversation', () => {
    const row = forwardPayload(message({ text: 'hi', reply_to_id: 'somewhere-else' }), ME, BOB, null);
    expect(row.reply_to_id).toBeNull();
  });

  it('points at the copied object, not the original', () => {
    const original = message({ media_path: 'a_b/old.jpg', media_type: 'image' });
    const row = forwardPayload(original, ME, BOB, 'c_d/new.jpg');
    expect(row.media_path).toBe('c_d/new.jpg');
    expect(row.media_type).toBe('image');
  });

  it('carries a voice note length across with its file', () => {
    const original = message({ media_path: 'a_b/v.webm', media_type: 'audio', media_duration_ms: 4200 });
    expect(forwardPayload(original, ME, BOB, 'c_d/v.webm').media_duration_ms).toBe(4200);
  });

  it('keeps no duration for a voice note whose file was not copied', () => {
    const original = message({ text: '🎤 voice message removed', media_duration_ms: 4200 });
    const row = forwardPayload(original, ME, BOB, null);
    expect(row.media_duration_ms).toBeNull();
    expect(row.media_type).toBeNull();
  });

  it('normalises an empty caption to null rather than an empty body', () => {
    expect(forwardPayload(message({ text: '' }), ME, BOB, 'c_d/p.jpg').text).toBeNull();
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
