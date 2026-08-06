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
    const cols = await sealBody(id, ME, ME, 'buy milk');
    expect(cols.content).toBeNull();
    expect(cols.ciphertext).toBeTruthy();
    expect(cols.nonce).toBeTruthy();
    expect(cols.ciphertext).not.toContain('buy milk');
  });

  it('round-trips a self-chat body', async () => {
    const id = await identity();
    const cols = await sealBody(id, ME, ME, 'buy milk');
    expect(await openBody(id, { ...cols, user_id: ME, receiver_id: ME })).toBe('buy milk');
  });

  it('leaves peer messages in plaintext for now', async () => {
    // Deleted in Plan 3. Asserted here so the seam is visible rather than
    // discovered by someone wondering why a peer message is readable.
    const id = await identity();
    const cols = await sealBody(id, ME, PEER, 'hello');
    expect(cols.content).toBe('hello');
    expect(cols.ciphertext).toBeNull();
  });

  it('reads a legacy plaintext row unchanged', async () => {
    const id = await identity();
    const legacy = { content: 'old message', ciphertext: null, nonce: null, user_id: ME, receiver_id: PEER };
    expect(await openBody(id, legacy)).toBe('old message');
  });

  it('returns null rather than throwing when a body cannot be opened', async () => {
    const mine = await identity();
    const theirs = await identity();
    const cols = await sealBody(theirs, ME, ME, 'secret');
    // Wrong key: the bubble must render an explicit failure, never a blank.
    expect(await openBody(mine, { ...cols, user_id: ME, receiver_id: ME })).toBeNull();
  });
});
