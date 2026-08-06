import { describe, expect, it } from 'vitest';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { openBody, sealBody } from './sealed-body';

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
