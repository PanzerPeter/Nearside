// The on-device copy of a conversation, as the store sees it. `sealed-row.ts`
// covers the projection; this covers what the store does with it — scoping,
// pruning, expiry, and which of the two "clear" buttons takes it away.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedConversationList,
  cachedSealedRows,
  clearCachedMessages,
  clearConversation,
  clearLocalDb,
  openLocalDb,
  purgeExpired,
  putConversationList,
  putSealedRows,
  SEALED_KEEP,
  sealedNewestByPeer,
} from './localdb';
import type { ConversationSummary, Message } from './types';

const ME = '11111111-1111-1111-1111-111111111111';
const PEER = '22222222-2222-2222-2222-222222222222';
const OTHER_PEER = '44444444-4444-4444-4444-444444444444';
const OTHER_ACCOUNT = '33333333-3333-3333-3333-333333333333';

function row(id: string, at: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    user_id: ME,
    receiver_id: PEER,
    ciphertext: `sealed-${id}`,
    nonce: 'n',
    text: `opened ${id}`,
    media_path: null,
    media_type: null,
    media_thumb_path: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_key: new Uint8Array([9, 9, 9]),
    media_duration_ms: null,
    reply_to_id: null,
    forwarded: false,
    sealed_prompt: false,
    edited_at: null,
    deleted_at: null,
    expires_at: null,
    created_at: at,
    ...extra,
  };
}

const summary = (peer: string, at: string | null): ConversationSummary => ({
  peer_id: peer,
  display_name: peer,
  avatar_url: null,
  last_media_type: null,
  last_sender_id: ME,
  last_at: at,
  last_seen_at: null,
});

describe('the sealed page', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  it('reads back newest first, the order the thread fetches in', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z'), row('b', '2026-08-06T11:00:00Z')]);
    expect((await cachedSealedRows(PEER)).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('stores what the server sent, never what open() added to it', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    const [stored] = (await cachedSealedRows(PEER)) as unknown as Record<string, unknown>[];
    expect(stored.ciphertext).toBe('sealed-a');
    expect(stored.text).toBeUndefined();
    expect(stored.media_key).toBeUndefined();
  });

  it('replaces a row that was edited rather than keeping both', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await putSealedRows(PEER, [
      row('a', '2026-08-06T10:00:00Z', { edited_at: '2026-08-06T12:00:00Z' }),
    ]);
    const rows = await cachedSealedRows(PEER);
    expect(rows).toHaveLength(1);
    expect(rows[0].edited_at).toBe('2026-08-06T12:00:00Z');
  });

  it('scopes to one conversation', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await putSealedRows(OTHER_PEER, [row('b', '2026-08-06T11:00:00Z')]);
    expect((await cachedSealedRows(PEER)).map((r) => r.id)).toEqual(['a']);
  });

  it('keeps a bound per conversation, so one busy chat cannot evict the rest', async () => {
    const many = Array.from({ length: SEALED_KEEP + 10 }, (_, i) =>
      row(`m${String(i).padStart(3, '0')}`, `2026-08-06T${String(i).padStart(2, '0')}:00:00Z`)
    );
    await putSealedRows(PEER, many);
    await putSealedRows(OTHER_PEER, [row('kept', '2026-08-06T10:00:00Z')]);
    expect(await cachedSealedRows(PEER)).toHaveLength(SEALED_KEEP);
    expect(await cachedSealedRows(OTHER_PEER)).toHaveLength(1);
  });

  it('drops the oldest when it prunes, never the newest', async () => {
    const many = Array.from({ length: SEALED_KEEP + 5 }, (_, i) =>
      row(`m${String(i).padStart(3, '0')}`, `2026-08-06T${String(i).padStart(2, '0')}:00:00Z`)
    );
    await putSealedRows(PEER, many);
    const kept = (await cachedSealedRows(PEER)).map((r) => r.id);
    expect(kept[0]).toBe(`m${String(SEALED_KEEP + 4).padStart(3, '0')}`);
    expect(kept).not.toContain('m000');
  });

  it('does not show one account another account’s conversation', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await openLocalDb(OTHER_ACCOUNT);
    expect(await cachedSealedRows(PEER)).toEqual([]);
  });

  it('sweeps a disappearing message the thread never opened', async () => {
    await putSealedRows(PEER, [
      row('gone', '2026-08-06T10:00:00Z', { expires_at: '2026-08-06T10:01:00Z' }),
      row('stays', '2026-08-06T10:00:00Z'),
    ]);
    await purgeExpired(Date.parse('2026-08-06T11:00:00Z'));
    expect((await cachedSealedRows(PEER)).map((r) => r.id)).toEqual(['stays']);
  });

  it('goes when the conversation is removed with the contact', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await clearConversation(PEER);
    expect(await cachedSealedRows(PEER)).toEqual([]);
  });

  it('reports the newest row per conversation in one read', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z'), row('b', '2026-08-06T11:00:00Z')]);
    await putSealedRows(OTHER_PEER, [row('c', '2026-08-06T09:00:00Z')]);
    const newest = await sealedNewestByPeer();
    expect(newest.get(PEER)).toBe('2026-08-06T11:00:00Z');
    expect(newest.get(OTHER_PEER)).toBe('2026-08-06T09:00:00Z');
  });
});

describe('the cached conversation list', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  it('reads back in the order it was written', async () => {
    await putConversationList([
      summary(PEER, '2026-08-06T11:00:00Z'),
      summary(OTHER_PEER, '2026-08-06T10:00:00Z'),
    ]);
    expect((await cachedConversationList()).map((r) => r.peer_id)).toEqual([PEER, OTHER_PEER]);
  });

  it('replaces the list wholesale, so a removed conversation does not linger', async () => {
    await putConversationList([summary(PEER, null), summary(OTHER_PEER, null)]);
    await putConversationList([summary(PEER, null)]);
    expect((await cachedConversationList()).map((r) => r.peer_id)).toEqual([PEER]);
  });

  it('does not show one account another account’s sidebar', async () => {
    await putConversationList([summary(PEER, null)]);
    await openLocalDb(OTHER_ACCOUNT);
    expect(await cachedConversationList()).toEqual([]);
  });
});

describe('clearing the offline copy', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  it('takes the sealed page with the mirrored bodies', async () => {
    // Both are the same messages; a "clear" that left the thread painting from
    // disk would be the button not doing what it says.
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await clearCachedMessages();
    expect(await cachedSealedRows(PEER)).toEqual([]);
  });

  it('leaves the sidebar, which is names and times rather than bodies', async () => {
    await putConversationList([summary(PEER, '2026-08-06T10:00:00Z')]);
    await clearCachedMessages();
    expect(await cachedConversationList()).toHaveLength(1);
  });

  it('takes everything on sign-out', async () => {
    await putSealedRows(PEER, [row('a', '2026-08-06T10:00:00Z')]);
    await putConversationList([summary(PEER, null)]);
    await clearLocalDb();
    expect(await cachedSealedRows(PEER)).toEqual([]);
    expect(await cachedConversationList()).toEqual([]);
  });
});
