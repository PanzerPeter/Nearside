import { describe, expect, it } from 'vitest';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { sealBody } from './sealed-body';

const ME = '11111111-1111-1111-1111-111111111111';
const PEER = '22222222-2222-2222-2222-222222222222';
const SECRET = 'the quick brown fox jumps over the lazy dog';

async function identity() {
  return identityFromSeed(await seedFromMnemonic(generateMnemonic()));
}

describe('no plaintext on the wire', () => {
  // Spec §13: if this passes, the product's headline claim is true. If someone
  // breaks it later, CI says so rather than a security researcher.
  it('never puts a message body into an insert payload', async () => {
    const me = await identity();
    const them = await identity();

    for (const [peer, key] of [
      [PEER, them.boxPublic],
      [ME, null],
    ] as const) {
      const columns = await sealBody(me, key, ME, peer, SECRET);
      const serialized = JSON.stringify(columns);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('quick brown');
      expect(Object.keys(columns).sort()).toEqual(['ciphertext', 'nonce']);
    }
  });
});
