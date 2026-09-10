import { describe, expect, it } from 'vitest';
import { parseSealedRow, sealedOnly } from './sealed-row';
import type { Message } from './types';

const opened: Message = {
  id: 'm1',
  user_id: 'u1',
  receiver_id: 'u2',
  ciphertext: 'sealed',
  nonce: 'n',
  text: 'the plaintext body',
  decrypt_failed: false,
  media_path: 'chat-media/u1/x.bin',
  media_type: 'image',
  media_thumb_path: null,
  media_key_ciphertext: 'k',
  media_key_nonce: 'kn',
  media_key: new Uint8Array([1, 2, 3]),
  media_restored: true,
  media_duration_ms: null,
  reply_to_id: null,
  forwarded: false,
  sealed_prompt: false,
  edited_at: null,
  deleted_at: null,
  expires_at: null,
  created_at: '2026-01-01T00:00:00Z',
};

describe('sealedOnly', () => {
  it('never carries the opened body or the opened file key', () => {
    const row = sealedOnly(opened) as Record<string, unknown>;
    expect(row.text).toBeUndefined();
    expect(row.media_key).toBeUndefined();
    expect(row.decrypt_failed).toBeUndefined();
    expect(row.media_restored).toBeUndefined();
  });

  it('keeps every column the thread needs to render the row again', () => {
    const row = sealedOnly(opened);
    expect(row.ciphertext).toBe('sealed');
    expect(row.media_path).toBe('chat-media/u1/x.bin');
    expect(row.media_key_ciphertext).toBe('k');
    expect(row.reply_to_id).toBeNull();
    expect(row.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('drops a client-only field added to Message later', () => {
    // The allow-list is the point: a delete-list would carry this through.
    const withNewField = { ...opened, some_future_opened_secret: 'oops' } as unknown as Message;
    expect(sealedOnly(withNewField)).not.toHaveProperty('some_future_opened_secret');
  });
});

describe('parseSealedRow', () => {
  it('reads back what sealedOnly wrote', () => {
    const round = parseSealedRow(JSON.stringify(sealedOnly(opened)));
    expect(round?.id).toBe('m1');
    expect(round?.ciphertext).toBe('sealed');
  });

  it('refuses a truncated or half-written row rather than rendering one', () => {
    expect(parseSealedRow('{"id":"m1",')).toBeNull();
    expect(parseSealedRow('{"id":"m1"}')).toBeNull();
    expect(parseSealedRow('null')).toBeNull();
    expect(parseSealedRow('[]')).toBeNull();
  });
});
