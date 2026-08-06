import { describe, expect, it } from 'vitest';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { openBody, openMediaKey, sealBody, sealMediaKey } from './sealed-body';

const ME = '11111111-1111-1111-1111-111111111111';
const PEER = '22222222-2222-2222-2222-222222222222';

async function identity() {
  return identityFromSeed(await seedFromMnemonic(generateMnemonic()));
}

describe('sealed body', () => {
  it('encrypts the self-chat', async () => {
    const id = await identity();
    const cols = await sealBody(id, null, ME, ME, 'buy milk');
    expect(cols.ciphertext).toBeTruthy();
    expect(cols.nonce).toBeTruthy();
    expect(cols.ciphertext).not.toContain('buy milk');
  });

  it('round-trips a self-chat body', async () => {
    const id = await identity();
    const cols = await sealBody(id, null, ME, ME, 'buy milk');
    expect(await openBody(id, null, { ...cols, user_id: ME, receiver_id: ME })).toBe('buy milk');
  });

  it('encrypts peer messages', async () => {
    const me = await identity();
    const them = await identity();
    const cols = await sealBody(me, them.boxPublic, ME, PEER, 'hello');
    expect(cols.ciphertext).toBeTruthy();
    expect(cols.ciphertext).not.toContain('hello');
    expect(Object.keys(cols).sort()).toEqual(['ciphertext', 'nonce']);
  });

  it('round-trips a peer message to the recipient', async () => {
    const me = await identity();
    const them = await identity();
    const cols = await sealBody(me, them.boxPublic, ME, PEER, 'hello');
    const opened = await openBody(them, me.boxPublic, {
      ...cols,
      user_id: ME,
      receiver_id: PEER,
    });
    expect(opened).toBe('hello');
  });

  it('refuses to send a peer message when the peer has published no key', async () => {
    // Throwing is the point: the alternative is falling back to plaintext,
    // which is the exact failure this plan exists to make impossible.
    const me = await identity();
    await expect(sealBody(me, null, ME, PEER, 'hello')).rejects.toThrow();
  });

  it('returns null rather than throwing when a body cannot be opened', async () => {
    const mine = await identity();
    const theirs = await identity();
    const cols = await sealBody(theirs, null, ME, ME, 'secret');
    // Wrong key: the bubble must render an explicit failure, never a blank.
    expect(await openBody(mine, null, { ...cols, user_id: ME, receiver_id: ME })).toBeNull();
  });

  it('returns null for a row with no sealed body at all', async () => {
    // Legacy plaintext rows are deleted by 0023; until then they arrive with
    // null ciphertext and must render as a failure, not as a blank bubble.
    const id = await identity();
    const bare = { ciphertext: null, nonce: null, user_id: ME, receiver_id: PEER };
    expect(await openBody(id, null, bare)).toBeNull();
  });
});

describe('media keys', () => {
  it('round-trips a file key to the recipient', async () => {
    const me = await identity();
    const them = await identity();
    const fileKey = new Uint8Array(32).fill(7);
    const cols = await sealMediaKey(me, them.boxPublic, ME, PEER, fileKey);
    const opened = await openMediaKey(them, me.boxPublic, {
      ...cols,
      user_id: ME,
      receiver_id: PEER,
    });
    expect(Array.from(opened ?? [])).toEqual(Array.from(fileKey));
  });

  it('round-trips a file key in the vault', async () => {
    const me = await identity();
    const fileKey = new Uint8Array(32).fill(9);
    const cols = await sealMediaKey(me, null, ME, ME, fileKey);
    const opened = await openMediaKey(me, null, { ...cols, user_id: ME, receiver_id: ME });
    expect(Array.from(opened ?? [])).toEqual(Array.from(fileKey));
  });

  it('refuses a file key sealed to somebody else', async () => {
    // The forwarding trap: copying media_key_ciphertext across to a new
    // conversation instead of re-sealing gives the target a key it cannot use.
    const me = await identity();
    const them = await identity();
    const stranger = await identity();
    const cols = await sealMediaKey(me, them.boxPublic, ME, PEER, new Uint8Array(32).fill(1));
    expect(
      await openMediaKey(stranger, me.boxPublic, { ...cols, user_id: ME, receiver_id: PEER })
    ).toBeNull();
  });

  it('returns null when a row carries no key at all', async () => {
    const me = await identity();
    const bare = {
      media_key_ciphertext: null,
      media_key_nonce: null,
      user_id: ME,
      receiver_id: PEER,
    };
    expect(await openMediaKey(me, null, bare)).toBeNull();
  });
});
