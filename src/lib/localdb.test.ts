import { beforeEach, describe, expect, it } from 'vitest';
import { cacheMessage, cachedPreview, clearLocalDb, openLocalDb, searchCached } from './localdb';

const PEER = '22222222-2222-2222-2222-222222222222';
const ME = '11111111-1111-1111-1111-111111111111';
const OTHER_ACCOUNT = '33333333-3333-3333-3333-333333333333';

function msg(id: string, text: string, at: string) {
  return { id, peer_id: PEER, user_id: ME, text, created_at: at, expires_at: null };
}

describe('local store', () => {
  beforeEach(async () => {
    await openLocalDb(ME);
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

  describe('two accounts on one device', () => {
    it('does not show one account the decrypted text of another', async () => {
      // The mirror holds plaintext. A device-wide one would put the previous
      // account's messages into the next account's search results.
      await cacheMessage(msg('a', 'private to me', '2026-08-06T10:00:00Z'));
      await openLocalDb(OTHER_ACCOUNT);
      expect(await searchCached(PEER, 'private')).toHaveLength(0);
    });

    it('does not show one account the previews of another', async () => {
      await cacheMessage(msg('a', 'private to me', '2026-08-06T10:00:00Z'));
      await openLocalDb(OTHER_ACCOUNT);
      expect(await cachedPreview(PEER)).toBeNull();
    });

    it('keeps each account’s own messages across a switch back', async () => {
      await cacheMessage(msg('a', 'mine', '2026-08-06T10:00:00Z'));
      await openLocalDb(OTHER_ACCOUNT);
      await cacheMessage({ ...msg('b', 'theirs', '2026-08-06T10:00:00Z'), user_id: OTHER_ACCOUNT });
      await openLocalDb(ME);
      expect((await cachedPreview(PEER))?.text).toBe('mine');
    });

    it('clears only the account that signed out', async () => {
      await cacheMessage(msg('a', 'mine', '2026-08-06T10:00:00Z'));
      await openLocalDb(OTHER_ACCOUNT);
      await cacheMessage({ ...msg('b', 'theirs', '2026-08-06T10:00:00Z'), user_id: OTHER_ACCOUNT });
      await clearLocalDb();
      await openLocalDb(ME);
      expect((await cachedPreview(PEER))?.text).toBe('mine');
    });
  });
});

describe('purgeExpired', () => {
  it('removes only the rows whose expiry has passed', async () => {
    const { cacheMessage, cachedPreview, openLocalDb, purgeExpired } = await import('./localdb');
    await openLocalDb('user-sweep');

    const base = {
      peer_id: 'peer-1',
      user_id: 'user-sweep',
      created_at: '2026-08-08T11:00:00.000Z',
    };
    await cacheMessage({ ...base, id: 'gone', text: 'go', expires_at: '2026-08-08T11:30:00.000Z' });
    await cacheMessage({ ...base, id: 'stays', text: 'stay', expires_at: '2026-08-08T13:00:00.000Z' });
    await cacheMessage({ ...base, id: 'forever', text: 'keep', expires_at: null });

    const removed = await purgeExpired(Date.parse('2026-08-08T12:00:00.000Z'));
    expect(removed).toEqual(['gone']);

    const preview = await cachedPreview('peer-1');
    expect(preview?.id).not.toBe('gone');
  });

  it('removes nothing when nothing has expired', async () => {
    const { cacheMessage, openLocalDb, purgeExpired } = await import('./localdb');
    await openLocalDb('user-sweep-2');
    await cacheMessage({
      id: 'm1',
      peer_id: 'peer-1',
      user_id: 'user-sweep-2',
      text: 'hello',
      created_at: '2026-08-08T11:00:00.000Z',
      expires_at: null,
    });
    expect(await purgeExpired(Date.now())).toEqual([]);
  });
});
