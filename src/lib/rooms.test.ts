import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { identityFromSeed, toBase64, type Identity } from './crypto/keys';
import { signBytes, signedPayload } from './crypto/seal';
import {
  ROOM_COLOURS,
  openRoomFileKey,
  openRoomRows,
  roomColour,
  roomMediaPath,
  sealRoomFileKey,
  sealRoomMessage,
  type RoomDraft,
  type RoomMessage,
} from './rooms';

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
  text: string,
  draft: RoomDraft = {}
): Promise<RoomMessage> {
  const sealed = await sealRoomMessage(roomKey, sender, text, draft);
  return {
    id: 'm1',
    room_id: 'r1',
    sender_id: senderId,
    created_at: '2026-08-07T00:00:00.000Z',
    ...sealed,
  };
}

/** A row as it was written before migration 0036: signed over
 *  `nonce.ciphertext` and carrying no version column at all. */
async function aLegacyRow(
  roomKey: Uint8Array,
  sender: Identity,
  senderId: string,
  text: string
): Promise<RoomMessage> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const sealed = {
    ciphertext: sodium.to_base64(
      sodium.crypto_secretbox_easy(sodium.from_string(text), nonce, roomKey),
      sodium.base64_variants.ORIGINAL
    ),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
  return {
    id: 'm0',
    room_id: 'r1',
    sender_id: senderId,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    signature: await signBytes(sender.signPrivate, signedPayload(sealed)),
    sig_v: 1,
    created_at: '2026-08-01T00:00:00.000Z',
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

describe('room signature v2', () => {
  const media = {
    path: 'r1/a1.bin',
    type: 'image' as const,
    key: { ciphertext: 'ct', nonce: 'nn' },
  };

  it('covers the media columns, so swapping an attachment breaks the signature', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'here', { media });

    const [opened] = await openRoomRows([{ ...row, media_path: 'r1/a2.bin' }], roomKey, signing);
    expect(opened.sender).toBe('unverified');
    expect(opened.text).toBeNull();
  });

  it('covers the sealed file key, so the bytes cannot be swapped either', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'here', { media });

    const [opened] = await openRoomRows(
      [{ ...row, media_key_ciphertext: 'elsewhere' }],
      roomKey,
      signing
    );
    expect(opened.sender).toBe('unverified');
  });

  it('covers reply_to_id, so a quote cannot be re-pointed', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'agreed', { replyToId: 'm-a' });

    const [opened] = await openRoomRows([{ ...row, reply_to_id: 'm-b' }], roomKey, signing);
    expect(opened.sender).toBe('unverified');
  });

  // Rooms that predate 0036 still have to open, or the migration reads as data
  // loss to everyone who already had a group.
  it('still verifies a v1 row under the v1 payload', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const legacy = await aLegacyRow(roomKey, alice, 'alice', 'older message');

    const [opened] = await openRoomRows(
      [legacy],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.text).toBe('older message');
    expect(opened.sender).toBe('verified');
  });

  // A row with no version column is a row from before the column existed.
  it('treats a missing sig_v as v1', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const legacy = await aLegacyRow(roomKey, alice, 'alice', 'older still');
    delete legacy.sig_v;

    const [opened] = await openRoomRows(
      [legacy],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
  });

  // A per-row choice of payload version is a downgrade an attacker gets to
  // make: strip the media columns, claim v1, and the old payload still checks.
  it('always writes sig_v 2 on send, text-only included', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    expect((await sealRoomMessage(roomKey, alice, 'plain')).sig_v).toBe(2);
    expect((await sealRoomMessage(roomKey, alice, null, { media })).sig_v).toBe(2);
  });

  it('refuses a v2 row that was signed as v1', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const legacy = await aLegacyRow(roomKey, alice, 'alice', 'older message');

    const [opened] = await openRoomRows(
      [{ ...legacy, sig_v: 2 }],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
  });

  // A caption is a body, and a body never reaches an insert payload in
  // plaintext. lib/no-plaintext.test.ts makes the same check for `messages`.
  it('never puts a caption on the row the server sees', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'secret caption', { media });
    expect(JSON.stringify(row)).not.toContain('secret caption');
  });

  it('leaves the body columns null when an attachment has no caption', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const sealed = await sealRoomMessage(roomKey, alice, '', { media });
    // Not an empty ciphertext: sealing '' would put a known plaintext under
    // every caption-less attachment in every room.
    expect(sealed.ciphertext).toBeNull();
    expect(sealed.nonce).toBeNull();
    expect(sealed.media_path).toBe(media.path);
  });

  it('opens a caption-less attachment as verified rather than unreadable', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', '', { media });

    const [opened] = await openRoomRows(
      [row],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
    expect(opened.text).toBeNull();
  });
});

describe('room file keys', () => {
  it('seals under the room key, so every member can open it and nobody else', async () => {
    await sodium.ready;
    const roomKey = await aRoomKey();
    const fileKey = sodium.crypto_secretbox_keygen();

    const sealed = await sealRoomFileKey(roomKey, fileKey);
    expect(await openRoomFileKey(roomKey, sealed)).toEqual(fileKey);
    // The whole point of the room key existing: another room's members hold a
    // different one and get nothing.
    await expect(openRoomFileKey(await aRoomKey(), sealed)).rejects.toThrow();
  });

  it('uses a fresh nonce per file', async () => {
    await sodium.ready;
    const roomKey = await aRoomKey();
    const fileKey = sodium.crypto_secretbox_keygen();
    const a = await sealRoomFileKey(roomKey, fileKey);
    const b = await sealRoomFileKey(roomKey, fileKey);
    expect(a.nonce).not.toEqual(b.nonce);
  });

  it('puts room attachments in a folder named for the room', () => {
    // Not the two-uid folder a conversation uses: membership of a room is not
    // a pair, and the storage policy has to ask `is_room_member` instead.
    expect(roomMediaPath('r-1', 'a.bin')).toBe('r-1/a.bin');
  });
});
