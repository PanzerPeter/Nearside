import { describe, expect, it } from 'vitest';
import { mergeMessages, pendingAsMessage } from './message-queries';
import type { Message, PendingMessage } from './types';

const ME = '00000000-0000-0000-0000-00000000000a';
const PEER = '00000000-0000-0000-0000-00000000000b';

function msg(id: string, created_at: string): Message {
  return {
    id,
    user_id: ME,
    receiver_id: PEER,
    ciphertext: null,
    nonce: null,
    text: id,
    media_path: null,
    media_type: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_duration_ms: null,
    reply_to_id: null,
    forwarded: false,
    edited_at: null,
    deleted_at: null,
    created_at,
  };
}

const T1 = '2026-07-20T10:00:00.000Z';
const T2 = '2026-07-20T10:00:05.000Z';
const T3 = '2026-07-20T10:00:10.000Z';

describe('mergeMessages', () => {
  it('returns the previous array unchanged when nothing arrives', () => {
    const prev = [msg('a', T1)];
    expect(mergeMessages(prev, [])).toBe(prev);
  });

  it('orders the result oldest first regardless of the input order', () => {
    const merged = mergeMessages([msg('c', T3)], [msg('a', T1), msg('b', T2)]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a shared timestamp on id, so a page boundary is stable', () => {
    const merged = mergeMessages([], [msg('b', T1), msg('a', T1)]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('lets an incoming row replace the one it shares an id with', () => {
    const edited = { ...msg('a', T1), text: 'edited' };
    const merged = mergeMessages([msg('a', T1)], [edited]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('edited');
  });

  it('de-duplicates a row that arrives twice', () => {
    const merged = mergeMessages([msg('a', T1), msg('b', T2)], [msg('b', T2), msg('c', T3)]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('pendingAsMessage', () => {
  const queued: PendingMessage = {
    id: 'q1',
    user_id: ME,
    receiver_id: PEER,
    text: 'hello',
    reply_to_id: null,
    created_at: T1,
    attempts: 0,
  };

  it('carries the local text through as the bubble body', () => {
    expect(pendingAsMessage(queued).text).toBe('hello');
  });

  it('leaves the sealed columns empty — an optimistic bubble was never sealed', () => {
    const row = pendingAsMessage(queued);
    expect(row.ciphertext).toBeNull();
    expect(row.nonce).toBeNull();
    expect(row.media_key_ciphertext).toBeNull();
  });

  it('keeps the queued id, so the server row can be paired with it by id', () => {
    expect(pendingAsMessage(queued).id).toBe('q1');
  });
});
