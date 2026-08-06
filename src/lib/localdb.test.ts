import { beforeEach, describe, expect, it } from 'vitest';
import { cacheMessage, cachedPreview, clearLocalDb, openLocalDb, searchCached } from './localdb';

const PEER = '22222222-2222-2222-2222-222222222222';
const ME = '11111111-1111-1111-1111-111111111111';

function msg(id: string, text: string, at: string) {
  return { id, peer_id: PEER, user_id: ME, text, created_at: at };
}

describe('local store', () => {
  beforeEach(async () => {
    await openLocalDb();
    await clearLocalDb();
  });

  it('returns no preview for an unknown conversation', async () => {
    expect(await cachedPreview(PEER)).toBeNull();
  });

  it('returns the newest message as the preview', async () => {
    await cacheMessage(msg('a', 'first', '2026-08-06T10:00:00Z'));
    await cacheMessage(msg('b', 'second', '2026-08-06T11:00:00Z'));
    expect((await cachedPreview(PEER))?.text).toBe('second');
  });

  it('is idempotent on re-cache', async () => {
    await cacheMessage(msg('a', 'first', '2026-08-06T10:00:00Z'));
    await cacheMessage(msg('a', 'first', '2026-08-06T10:00:00Z'));
    expect(await searchCached(PEER, 'first')).toHaveLength(1);
  });

  it('finds messages by substring, case-insensitively', async () => {
    await cacheMessage(msg('a', 'Buy Milk tomorrow', '2026-08-06T10:00:00Z'));
    expect(await searchCached(PEER, 'milk')).toHaveLength(1);
    expect(await searchCached(PEER, 'bread')).toHaveLength(0);
  });

  it('treats % and _ as literal characters', async () => {
    // The server-side search this replaces escaped these deliberately
    // (0010's header explains why); the local one must not regress it.
    await cacheMessage(msg('a', '50% off', '2026-08-06T10:00:00Z'));
    await cacheMessage(msg('b', '50X off', '2026-08-06T11:00:00Z'));
    expect(await searchCached(PEER, '50% off')).toHaveLength(1);
  });

  it('scopes search to one conversation', async () => {
    await cacheMessage(msg('a', 'shared word', '2026-08-06T10:00:00Z'));
    await cacheMessage({ ...msg('b', 'shared word', '2026-08-06T10:00:00Z'), peer_id: 'other' });
    expect(await searchCached(PEER, 'shared')).toHaveLength(1);
  });
});
