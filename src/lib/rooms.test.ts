import { beforeEach, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { generateMnemonic, seedFromMnemonic } from './crypto/mnemonic';
import { identityFromSeed, toBase64, type Identity } from './crypto/keys';
import {
  signBytes,
  signedPayload,
  signedPayloadV2,
  signedPayloadV3,
} from './crypto/seal';
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
import { cachedPreview, clearLocalDb, openLocalDb, searchCached } from './localdb';

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

/** A row as it was written between 0036 and 0044: signed over the v2 payload,
 *  which had no thumbnail column in it. */
async function aV2Row(
  roomKey: Uint8Array,
  sender: Identity,
  senderId: string,
  text: string
): Promise<RoomMessage> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const row = {
    ciphertext: sodium.to_base64(
      sodium.crypto_secretbox_easy(sodium.from_string(text), nonce, roomKey),
      sodium.base64_variants.ORIGINAL
    ),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    media_path: null,
    media_type: null,
    media_duration_ms: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    reply_to_id: null,
  };
  return {
    id: 'm2',
    room_id: 'r1',
    sender_id: senderId,
    created_at: '2026-08-07T00:00:00.000Z',
    ...row,
    signature: await signBytes(sender.signPrivate, signedPayloadV2(row)),
    sig_v: 2,
  };
}

/** A row as it was written between 0044 and 0046: signed over the v3 payload,
 *  which had no `forwarded` column in it. */
async function aV3Row(
  roomKey: Uint8Array,
  sender: Identity,
  senderId: string,
  text: string
): Promise<RoomMessage> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const row = {
    ciphertext: sodium.to_base64(
      sodium.crypto_secretbox_easy(sodium.from_string(text), nonce, roomKey),
      sodium.base64_variants.ORIGINAL
    ),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    media_path: null,
    media_type: null,
    media_duration_ms: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    media_thumb_path: null,
    reply_to_id: null,
  };
  return {
    id: 'm3',
    room_id: 'r1',
    sender_id: senderId,
    created_at: '2026-09-01T00:00:00.000Z',
    ...row,
    signature: await signBytes(sender.signPrivate, signedPayloadV3(row)),
    sig_v: 3,
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
  it('always writes the current sig_v on send, text-only included', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    expect((await sealRoomMessage(roomKey, alice, 'plain')).sig_v).toBe(4);
    expect((await sealRoomMessage(roomKey, alice, null, { media })).sig_v).toBe(4);
  });

  // The thumbnail is the picture a reader actually looks at, so it is the one
  // a repointed column would substitute most effectively. v3 exists for this.
  it('covers the thumbnail, so the picture in the bubble cannot be swapped', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'here', {
      media: { ...media, thumbPath: 'r1/a1-thumb.bin' },
    });

    const [opened] = await openRoomRows(
      [{ ...row, media_thumb_path: 'r1/somebody-elses-thumb.bin' }],
      roomKey,
      signing
    );
    expect(opened.sender).toBe('unverified');
    expect(opened.text).toBeNull();
  });

  // Rooms that were live before 0044 keep working, and their signatures keep
  // meaning what they meant: v3 appends rather than reorders.
  it('still verifies a v2 row under the v2 payload', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const v2 = await aV2Row(roomKey, alice, 'alice', 'sent last week');

    const [opened] = await openRoomRows(
      [v2],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.text).toBe('sent last week');
    expect(opened.sender).toBe('verified');
  });

  it('refuses a v3 row that was signed as v2', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const v2 = await aV2Row(roomKey, alice, 'alice', 'sent last week');

    const [opened] = await openRoomRows(
      [{ ...v2, sig_v: 3 }],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
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

describe('room signature v4', () => {
  // The flag is the difference between somebody's own words and somebody
  // passing along another conversation's. Outside the payload it is a claim
  // the server gets to make on anybody's message.
  it('covers forwarded, so the notice cannot be added to somebody else', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'my own words');

    const [opened] = await openRoomRows([{ ...row, forwarded: true }], roomKey, signing);
    expect(opened.sender).toBe('unverified');
    expect(opened.text).toBeNull();
  });

  it('covers forwarded, so the notice cannot be stripped off a forward', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'passed along', { forwarded: true });

    const [opened] = await openRoomRows([{ ...row, forwarded: false }], roomKey, signing);
    expect(opened.sender).toBe('unverified');
  });

  it('carries the flag onto the row and opens it', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'passed along', { forwarded: true });
    expect(row.forwarded).toBe(true);

    const [opened] = await openRoomRows(
      [row],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
    expect(opened.text).toBe('passed along');
  });

  it('defaults to false, and an ordinary message is not marked', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    expect((await sealRoomMessage(roomKey, alice, 'plain')).forwarded).toBe(false);
  });

  // The column is NOT NULL DEFAULT false, so a select that omitted it and a row
  // carrying false are the same fact — and a signature made over one has to
  // verify against the other.
  it('treats an absent forwarded as false', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'plain');
    const stripped = { ...row };
    delete stripped.forwarded;

    const [opened] = await openRoomRows(
      [stripped],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
    expect(opened.text).toBe('plain');
  });

  // Groups that were live before 0046 keep working, and their signatures keep
  // meaning what they meant: v4 appends rather than reorders.
  it('still verifies a v3 row under the v3 payload', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const v3 = await aV3Row(roomKey, alice, 'alice', 'sent before the flag existed');

    const [opened] = await openRoomRows(
      [v3],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.text).toBe('sent before the flag existed');
    expect(opened.sender).toBe('verified');
  });

  it('refuses a v4 row that was signed as v3', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const v3 = await aV3Row(roomKey, alice, 'alice', 'sent before the flag existed');

    const [opened] = await openRoomRows(
      [{ ...v3, sig_v: 4 }],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
  });

  // Guessing at a shorter payload is exactly the downgrade the version column
  // exists to refuse, so an unknown version is refused rather than tried.
  it('refuses a version this build has no builder for', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'from the future');

    const [opened] = await openRoomRows(
      [{ ...row, sig_v: 5 }],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
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

describe('deleting a group message', () => {
  /** The tombstone as `deleteRoomMessage` writes it: every body column nulled,
   *  and the signature recomputed over what is left. */
  async function aTombstone(sender: Identity, senderId: string, replyToId: string | null) {
    await sodium.ready;
    const emptied = {
      ciphertext: null,
      nonce: null,
      media_path: null,
      media_type: null,
      media_duration_ms: null,
      media_key_ciphertext: null,
      media_key_nonce: null,
      media_thumb_path: null,
      reply_to_id: replyToId,
    };
    return {
      id: 'm-del',
      room_id: 'r1',
      sender_id: senderId,
      created_at: '2026-08-07T00:00:00.000Z',
      deleted_at: '2026-08-07T01:00:00.000Z',
      ...emptied,
      signature: await signBytes(sender.signPrivate, signedPayloadV3(emptied)),
      sig_v: 3,
    } as RoomMessage;
  }

  it('reads as a verified tombstone, not as an attack', async () => {
    // `openRoomRows` verifies before it looks at `deleted_at`. A delete that
    // nulled the body and left the old signature in place would therefore
    // render the sender's own deletion to the whole group as `unverified` —
    // the badge that exists to mean somebody is forging messages.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const tomb = await aTombstone(alice, 'alice', null);

    const [opened] = await openRoomRows(
      [tomb],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
    expect(opened.text).toBeNull();
    expect(opened.deleted_at).toBe('2026-08-07T01:00:00.000Z');
  });

  it('keeps the reply target inside what was signed', async () => {
    // `reply_to_id` is frozen by a trigger, so the tombstone's signature has to
    // describe the row the server will actually hold. Signing it as null while
    // the column keeps its value is a signature over a row that never existed.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const tomb = await aTombstone(alice, 'alice', 'm-parent');

    const [opened] = await openRoomRows(
      [tomb],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('verified');
  });

  it('still refuses a tombstone signed by somebody else', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const mallory = await anIdentity();
    const forged = await aTombstone(mallory, 'alice', null);

    const [opened] = await openRoomRows(
      [forged],
      roomKey,
      new Map([['alice', await toBase64(alice.signPublic)]])
    );
    expect(opened.sender).toBe('unverified');
  });
});

describe('the local mirror of a group', () => {
  beforeEach(async () => {
    await openLocalDb('me');
    await clearLocalDb();
  });

  it('keeps what this device decrypted, so a group is searchable', async () => {
    // The server dropped message bodies in 0023, so the mirror is the only
    // copy of a group's plaintext there is — without this write a group was
    // unsearchable on every device, not merely on one that never loaded it.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const row = await aRow(roomKey, alice, 'alice', 'meet at the pier');

    await openRoomRows([row], roomKey, new Map([['alice', await toBase64(alice.signPublic)]]));

    const hits = await searchCached('r1', 'pier');
    expect(hits).toHaveLength(1);
    expect(hits[0].user_id).toBe('alice');
  });

  it('keys the mirror on the group, not on the sender', async () => {
    // A group is one conversation however many people are in it. Keyed by
    // sender, a search in the group would answer for whoever spoke last.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const bob = await anIdentity();
    const signing = new Map([
      ['alice', await toBase64(alice.signPublic)],
      ['bob', await toBase64(bob.signPublic)],
    ]);
    const first = await aRow(roomKey, alice, 'alice', 'first light');
    const second = { ...(await aRow(roomKey, bob, 'bob', 'second light')), id: 'm2' };

    await openRoomRows([first, second], roomKey, signing);

    expect(await searchCached('r1', 'light')).toHaveLength(2);
    expect(await searchCached('alice', 'light')).toHaveLength(0);
  });

  it('never mirrors a row it could not verify', async () => {
    // An unverified row is a claim, not a message. Mirroring it would make a
    // forgery searchable on this device long after the bubble warning about it
    // scrolled away.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const mallory = await anIdentity();
    const row = await aRow(roomKey, mallory, 'alice', 'trust me');

    await openRoomRows([row], roomKey, new Map([['alice', await toBase64(alice.signPublic)]]));

    expect(await searchCached('r1', 'trust me')).toHaveLength(0);
  });

  it('drops a deleted group message from the mirror', async () => {
    // "Delete" that leaves the body findable in search and previewed in the
    // list is the one place the word would visibly not mean what it says.
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    const row = await aRow(roomKey, alice, 'alice', 'forget this');
    await openRoomRows([row], roomKey, signing);
    expect(await searchCached('r1', 'forget this')).toHaveLength(1);

    const emptied = {
      ciphertext: null,
      nonce: null,
      media_path: null,
      media_type: null,
      media_duration_ms: null,
      media_key_ciphertext: null,
      media_key_nonce: null,
      media_thumb_path: null,
      reply_to_id: null,
    };
    await openRoomRows(
      [
        {
          ...row,
          ...emptied,
          deleted_at: '2026-08-07T01:00:00.000Z',
          signature: await signBytes(alice.signPrivate, signedPayloadV3(emptied)),
          sig_v: 3,
        } as RoomMessage,
      ],
      roomKey,
      signing
    );

    expect(await searchCached('r1', 'forget this')).toHaveLength(0);
    expect(await cachedPreview('r1')).toBeNull();
  });

  it('mirrors an edit over the words it replaced', async () => {
    const roomKey = await aRoomKey();
    const alice = await anIdentity();
    const signing = new Map([['alice', await toBase64(alice.signPublic)]]);
    await openRoomRows([await aRow(roomKey, alice, 'alice', 'six oclock')], roomKey, signing);

    const corrected = await aRow(roomKey, alice, 'alice', 'seven oclock');
    await openRoomRows([{ ...corrected, edited_at: '2026-08-07T01:00:00.000Z' }], roomKey, signing);

    expect(await searchCached('r1', 'six')).toHaveLength(0);
    expect((await cachedPreview('r1'))?.text).toBe('seven oclock');
  });
});
