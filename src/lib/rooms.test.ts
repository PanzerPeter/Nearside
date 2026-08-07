import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { identityFromSeed, toBase64, type Identity } from './crypto/keys';
import { ROOM_COLOURS, openRoomRows, roomColour, sealRoomMessage, type RoomMessage } from './rooms';

async function anIdentity(): Promise<Identity> {
  return identityFromSeed(await seedFromMnemonic(generateMnemonic()));
}

async function aRoomKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_secretbox_keygen();
}

/** A row as the database would hand it back. */
async function aRow(
  roomKey: Uint8Array,
  sender: Identity,
  senderId: string,
  text: string
): Promise<RoomMessage> {
  const sealed = await sealRoomMessage(roomKey, sender, text);
  return {
    id: 'm1',
    room_id: 'r1',
    sender_id: senderId,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    signature: sealed.signature,
    created_at: '2026-08-07T00:00:00.000Z',
  };
}

describe('room colours', () => {
  it('is stable for an index', () => {
    expect(roomColour(2)).toBe(roomColour(2));
  });

  it('wraps rather than falling off the end', () => {
    expect(roomColour(ROOM_COLOURS.length)).toBe(roomColour(0));
    expect(roomColour(ROOM_COLOURS.length * 3 + 1)).toBe(roomColour(1));
  });

  it('handles a negative index without producing undefined', () => {
    expect(ROOM_COLOURS).toContain(roomColour(-1));
  });
});

describe('room messages', () => {
  it('round-trips a message for a member who holds the key', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'meet at six');

    const [opened] = await openRoomRows(
      [row],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.text).toBe('meet at six');
    expect(opened.sender).toBe('verified');
  });

  it('never puts plaintext on the row the server sees', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'meet at six');
    expect(JSON.stringify(row)).not.toContain('meet at six');
  });

  it('flags a message signed by a different member and refuses to open it', async () => {
    // The whole reason room_messages carries a signature: Mallory holds the
    // room key too, so she can seal a message that decrypts perfectly while
    // claiming to be Alice.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const mallory = await anIdentity();
    const forged = await aRow(roomKey, mallory, 'alice', 'transfer the money');

    const [opened] = await openRoomRows(
      [forged],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
    expect(opened.text).toBeNull();
  });

  it('flags a tampered nonce, not just a tampered ciphertext', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'meet at six');
    const tampered = { ...row, nonce: await toBase64(new Uint8Array(24).fill(7)) };

    const [opened] = await openRoomRows(
      [tampered],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
  });

  it('reports a sender with no published signing key as unknown', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'hello');

    const [opened] = await openRoomRows([row], roomKey, new Map([['alice', null]]));
    expect(opened.sender).toBe('unknown');
    expect(opened.text).toBeNull();
  });

  it('keeps a correctly signed message this device cannot decrypt', async () => {
    // What a member who joined after a key rotation sees: authorship is
    // established, content is not available. Dropping it would hide history
    // that demonstrably exists.
    const alice = await anIdentity();
    const row = await aRow(await aRoomKey(), alice, 'alice', 'before your time');

    const [opened] = await openRoomRows(
      [row],
      await aRoomKey(),
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
    expect(opened.text).toBeNull();
  });

  it('opens a batch without letting one bad row take the others down', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const mallory = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);

    const good = await aRow(roomKey, alice, 'alice', 'fine');
    const bad = { ...(await aRow(roomKey, mallory, 'alice', 'forged')), id: 'm2' };

    const opened = await openRoomRows([good, bad], roomKey, signing);
    expect(opened.map((r) => r.sender)).toEqual(['verified', 'unverified']);
    expect(opened[0].text).toBe('fine');
  });

  it('uses a fresh nonce for every message', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const a = await sealRoomMessage(roomKey, alice, 'same text');
    const b = await sealRoomMessage(roomKey, alice, 'same text');
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
});
