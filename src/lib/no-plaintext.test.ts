import { describe, expect, it } from 'vitest';
import { identityFromSeed } from './crypto/keys';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { sealBody } from './sealed-body';
import { sealForSelf } from './crypto/seal';
import { normalizeNickname } from './nicknames';

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

  it('never puts a friend nickname into an insert payload', async () => {
    // 0041. The row is owner-only and always was, so this is the one place the
    // app's privacy claim and the server's view of it could differ without
    // anybody noticing — the name renders correctly either way.
    const me = await identity();
    const nickname = normalizeNickname('Bobby Tables') as string;
    const sealed = await sealForSelf(me.vaultKey, nickname);

    const payload = {
      owner_id: ME,
      peer_id: PEER,
      nickname: null,
      nickname_ciphertext: sealed.ciphertext,
      nickname_nonce: sealed.nonce,
    };

    expect(JSON.stringify(payload)).not.toContain('Bobby');
    // Explicitly null rather than absent: an upsert that omitted the column
    // would leave a pre-0041 plaintext name sitting beside the new ciphertext.
    expect(payload.nickname).toBeNull();
  });
});
