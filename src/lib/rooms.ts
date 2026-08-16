// Encrypted group rooms.
//
// One symmetric key per room, sealed once to each member's published public
// key. The server distributes a key it cannot open, and adding a member is one
// row rather than a re-encryption of the history.
//
// Every message carries an Ed25519 signature over its sealed bytes, checked
// BEFORE the message is opened. `secretbox` gives confidentiality, not
// authorship: every member holds the room key, so without a signature any of
// them could compose a message under any `sender_id` they liked. Verifying
// after decryption would render something whose author was not established.
import sodium from 'libsodium-wrappers';
import { fromBase64, type Identity } from './crypto/keys';
import {
  openBytesFrom,
  sealBytesFor,
  signBytes,
  signedPayload,
  signedPayloadV2,
  verifyBytes,
  type Sealed,
} from './crypto/seal';
import { supabase } from './supabase';

export interface RoomSummary {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
  member_count: number;
  last_at: string | null;
}

export interface RoomParticipant {
  room_id: string;
  user_id: string;
  colour_index: number;
  joined_at: string;
}

export type RoomMediaType = 'image' | 'video' | 'audio' | 'sticker';

/** A row as stored. `text` and `sender` are client-only, set by `openRoomRows`
 *  at the boundary, exactly as `openRows` does for peer messages. */
export interface RoomMessage {
  id: string;
  room_id: string;
  sender_id: string;
  /** Null on an attachment with no caption, and on a tombstone. */
  ciphertext: string | null;
  nonce: string | null;
  signature: string;
  media_path?: string | null;
  media_type?: RoomMediaType | null;
  media_duration_ms?: number | null;
  /** The per-file key, sealed under the ROOM key rather than to one member. */
  media_key_ciphertext?: string | null;
  media_key_nonce?: string | null;
  reply_to_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  /** Which payload the signature covers. Absent means a row written before the
   *  column existed, which is v1 by definition. */
  sig_v?: number;
  created_at: string;
  /** Null when this device could not open the row. `sender` says why. */
  text?: string | null;
  /** The opened per-file key, set by `openRoomRows` alongside the body. The
   *  attachment components take it as bytes; the row carries it sealed. */
  mediaKey?: Uint8Array | null;
  /** How much this device can vouch for:
   *    'verified'   signature checks out against the sender's published key
   *    'unverified' signature does not check out. Rendered as a warning rather
   *                 than hidden, since hiding it conceals an attack in progress
   *    'unknown'    the sender has published no signing key to check against */
  sender?: 'verified' | 'unverified' | 'unknown';
}

/** Every column a room message read has to select. One constant, because a
 *  select that forgets `sig_v` verifies every new row under the old payload
 *  and reports the whole room as forged. */
export const ROOM_MESSAGE_COLUMNS =
  'id, room_id, sender_id, ciphertext, nonce, signature, media_path, media_type, ' +
  'media_duration_ms, media_key_ciphertext, media_key_nonce, reply_to_id, edited_at, ' +
  'deleted_at, sig_v, created_at';

/** Stable per-speaker colours, by index rather than a hash of the user id. A
 *  hash collides silently and two members share a colour mid-conversation. */
export const ROOM_COLOURS = [
  'text-primary',
  'text-secondary',
  'text-accent',
  'text-info',
  'text-success',
  'text-warning',
] as const;

export function roomColour(index: number): string {
  return ROOM_COLOURS[((index % ROOM_COLOURS.length) + ROOM_COLOURS.length) % ROOM_COLOURS.length];
}

interface PublishedKeys {
  public_key: string | null;
  signing_key: string | null;
}

/**
 * Published keys already read this session, by user id.
 *
 * The same cache `lib/peer-keys.ts` keeps, for the same reason: keys change
 * rarely and every room message read verifies a signature against one. Without
 * it `roomSigningKeys` re-read every sender's profile on each pass, which is
 * once per message with the subscription below.
 *
 * A row that came back with a null key is *not* cached — that is a key still
 * publishing, and remembering it would keep a member unreachable for the rest
 * of the session.
 */
const publishedKeyCache = new Map<string, PublishedKeys>();

/** Drop the cache. Per-account like every other one in the app — a session that
 *  ends must not leave the next account reading the previous one's answers. */
export function forgetAllPublishedKeys(): void {
  publishedKeyCache.clear();
}

/** Base64 public + signing keys for a set of accounts, in one query. */
async function publishedKeys(userIds: string[]): Promise<Map<string, PublishedKeys>> {
  const map = new Map<string, PublishedKeys>();
  if (userIds.length === 0) return map;

  const missing: string[] = [];
  for (const id of userIds) {
    const hit = publishedKeyCache.get(id);
    if (hit) map.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return map;

  const { data } = await supabase
    .from('profiles')
    .select('id, public_key, signing_key')
    .in('id', missing);

  for (const row of data ?? []) {
    const keys = { public_key: row.public_key, signing_key: row.signing_key };
    map.set(row.id, keys);
    if (keys.public_key && keys.signing_key) publishedKeyCache.set(row.id, keys);
  }
  return map;
}

/** Members who cannot be sealed to. Surfaced at create time rather than
 *  dropped, because a room quietly missing someone is the worse failure. */
export async function unreachableMembers(userIds: string[]): Promise<string[]> {
  const keys = await publishedKeys(userIds);
  return userIds.filter((id) => !keys.get(id)?.public_key);
}

export interface CreateRoomResult {
  roomId: string;
  /** Members the room could not be sealed to. Empty on the happy path. */
  skipped: string[];
}

/**
 * Creates a room and seals its key to every member, including the creator.
 *
 * The room id is generated here rather than by the database because
 * `rooms_select_member` gates SELECT on membership — an `insert().select()`
 * would come back empty on the very statement that created the row, since the
 * creator's participant row does not exist yet.
 */
export async function createRoom(
  me: string,
  identity: Identity,
  title: string,
  memberIds: string[]
): Promise<CreateRoomResult> {
  await sodium.ready;

  const members = [...new Set([me, ...memberIds])];
  const keys = await publishedKeys(members);
  const reachable = members.filter((id) => keys.get(id)?.public_key);
  const skipped = members.filter((id) => !keys.get(id)?.public_key);

  if (!keys.get(me)?.public_key) {
    throw new Error('Your key has not finished publishing yet. Try again in a moment.');
  }

  const roomId = crypto.randomUUID();
  const roomKey = sodium.crypto_secretbox_keygen();

  const { error: roomError } = await supabase
    .from('rooms')
    .insert({ id: roomId, title: title.trim(), created_by: me });
  if (roomError) throw roomError;

  // Participants before keys: `keys_insert_sealer` checks room ownership, and
  // `participants_insert_creator` checks the same, so both depend on the room
  // row existing and neither depends on the other.
  const { error: partError } = await supabase.from('room_participants').insert(
    reachable.map((id, i) => ({
      room_id: roomId,
      user_id: id,
      colour_index: i % ROOM_COLOURS.length,
    }))
  );
  if (partError) throw partError;

  const sealedKeys = await Promise.all(
    reachable.map(async (id) => {
      const theirPublic = await fromBase64(keys.get(id)!.public_key!);
      const sealed = await sealBytesFor(identity.boxPrivate, theirPublic, roomKey);
      return {
        room_id: roomId,
        user_id: id,
        key_ciphertext: sealed.ciphertext,
        key_nonce: sealed.nonce,
        sealed_by: me,
      };
    })
  );

  const { error: keyError } = await supabase.from('room_keys').insert(sealedKeys);
  if (keyError) throw keyError;

  return { roomId, skipped };
}

/** Opened room keys, cached for the session. Opening one is two round trips
 *  and a box operation, and every message in a room needs it. */
const keyCache = new Map<string, Uint8Array>();

function forgetRoomKey(roomId: string): void {
  keyCache.delete(roomId);
}

/** Drop every opened room key, on sign-out. These are plaintext symmetric keys
 *  for whole conversations; they must not outlive the account allowed to open
 *  them, least of all on a phone somebody else is about to sign into. */
export function forgetAllRoomKeys(): void {
  keyCache.clear();
}

/**
 * This account's copy of the room key, or null when no row exists: they are
 * not a member, or were removed. The UI must render null as the error it is,
 * because an empty room would be a lie.
 */
export async function roomKeyFor(roomId: string, identity: Identity): Promise<Uint8Array | null> {
  const hit = keyCache.get(roomId);
  if (hit) return hit;

  const { data } = await supabase
    .from('room_keys')
    .select('key_ciphertext, key_nonce, sealed_by')
    .eq('room_id', roomId)
    .maybeSingle();
  if (!data) return null;

  const sealers = await publishedKeys([data.sealed_by]);
  const sealerPublic = sealers.get(data.sealed_by)?.public_key;
  if (!sealerPublic) return null;

  try {
    const key = await openBytesFrom(identity.boxPrivate, await fromBase64(sealerPublic), {
      ciphertext: data.key_ciphertext,
      nonce: data.key_nonce,
    });
    keyCache.set(roomId, key);
    return key;
  } catch {
    // The sealer rotated their key after sealing, or the row was tampered
    // with. Either way this device cannot read the room, and saying so beats
    // rendering an empty one.
    return null;
  }
}

/**
 * The per-file key, sealed for the room.
 *
 * `crypto_secretbox` under the room key rather than `crypto_box` to a
 * recipient: a room has no single recipient, and sealing the key once per
 * member would be a column per member on every row carrying a file.
 *
 * The note on `removeMember` applies here unchanged — a member who leaves
 * keeps whatever they already downloaded, and nothing can change that.
 */
export async function sealRoomFileKey(roomKey: Uint8Array, fileKey: Uint8Array): Promise<Sealed> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return {
    ciphertext: sodium.to_base64(
      sodium.crypto_secretbox_easy(fileKey, nonce, roomKey),
      sodium.base64_variants.ORIGINAL
    ),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

/** Throws when the key does not open the row — a caller holding the wrong room
 *  key has nothing to render, and a null return would be mistaken for "no
 *  attachment". */
export async function openRoomFileKey(roomKey: Uint8Array, sealed: Sealed): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_secretbox_open_easy(
    sodium.from_base64(sealed.ciphertext, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(sealed.nonce, sodium.base64_variants.ORIGINAL),
    roomKey
  );
}

/**
 * Where a room's attachments live in `chat-media`.
 *
 * One folder per room, not the `{uidA}_{uidB}` folder a conversation uses:
 * membership of a room is not a pair, so the storage policy asks
 * `is_room_member()` about the folder name instead of matching it against the
 * two ids inside. A room id is a uuid and a conversation folder always
 * contains an underscore, so the two shapes cannot be confused for each other.
 */
export function roomMediaPath(roomId: string, filename: string): string {
  return `${roomId}/${filename}`;
}

/** An attachment on a room message. `key` is the per-file key already sealed
 *  under the room key — see `sealRoomFileKey`. */
export interface RoomMediaDraft {
  path: string;
  type: RoomMediaType;
  durationMs?: number | null;
  key: Sealed;
}

export interface RoomDraft {
  media?: RoomMediaDraft | null;
  replyToId?: string | null;
}

/** Everything the sender writes to a row, signature included. Spread straight
 *  into the insert, so what is signed and what is stored cannot drift. */
export interface SealedRoomRow {
  ciphertext: string | null;
  nonce: string | null;
  media_path: string | null;
  media_type: RoomMediaType | null;
  media_duration_ms: number | null;
  media_key_ciphertext: string | null;
  media_key_nonce: string | null;
  reply_to_id: string | null;
  signature: string;
  sig_v: 2;
}

/**
 * Seals `text` under the room key and signs every column a client renders.
 *
 * `text` may be null: an attachment with no caption has no body, and sealing
 * an empty string instead would put a known plaintext under every one of them.
 *
 * Always signs v2, text-only messages included. A version picked per row from
 * what the row happens to contain would be a version an attacker gets to pick
 * — strip the media columns, claim v1, and the shorter payload still checks.
 *
 * Exported for the test suite, which has no database to send to.
 */
export async function sealRoomMessage(
  roomKey: Uint8Array,
  identity: Identity,
  text: string | null,
  draft: RoomDraft = {}
): Promise<SealedRoomRow> {
  await sodium.ready;

  let sealed: Sealed | null = null;
  if (text !== null && text !== '') {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    sealed = {
      ciphertext: sodium.to_base64(
        sodium.crypto_secretbox_easy(sodium.from_string(text), nonce, roomKey),
        sodium.base64_variants.ORIGINAL
      ),
      nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    };
  }

  const media = draft.media ?? null;
  const row = {
    ciphertext: sealed?.ciphertext ?? null,
    nonce: sealed?.nonce ?? null,
    media_path: media?.path ?? null,
    media_type: media?.type ?? null,
    media_duration_ms: media?.durationMs ?? null,
    media_key_ciphertext: media?.key.ciphertext ?? null,
    media_key_nonce: media?.key.nonce ?? null,
    reply_to_id: draft.replyToId ?? null,
  };

  return {
    ...row,
    signature: await signBytes(identity.signPrivate, signedPayloadV2(row)),
    sig_v: 2,
  };
}

/**
 * Seal, sign and insert, returning the row the server wrote.
 *
 * The row comes back rather than just its id so the sender can paint its own
 * bubble from it. `created_at` is the column the thread orders on and it is
 * stamped by the database; a locally invented timestamp would put the message
 * in the wrong place for anyone whose clock is off. `room_messages_select_
 * member` is what makes the RETURNING legal, and we are a member by the time
 * this runs or the insert itself would have been refused.
 */
export async function sendRoomMessage(
  roomId: string,
  me: string,
  identity: Identity,
  roomKey: Uint8Array,
  text: string | null,
  draft: RoomDraft = {}
): Promise<RoomMessage> {
  const sealed = await sealRoomMessage(roomKey, identity, text, draft);
  const id = crypto.randomUUID();
  const { data, error } = await supabase
    .from('room_messages')
    .insert({ id, room_id: roomId, sender_id: me, ...sealed })
    .select(ROOM_MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as RoomMessage;
}

/**
 * Verifies, then opens.
 *
 * A row whose signature fails comes back as `sender: 'unverified'` with no
 * text, never dropped. A dropped message is an attack the user never learns
 * about; a flagged one is an attack they can see.
 */
export async function openRoomRows(
  rows: RoomMessage[],
  roomKey: Uint8Array,
  signingKeys: Map<string, string | null>
): Promise<RoomMessage[]> {
  await sodium.ready;

  return Promise.all(
    rows.map(async (row): Promise<RoomMessage> => {
      const signing = signingKeys.get(row.sender_id);
      if (!signing) return { ...row, text: null, sender: 'unknown' };

      // The row states which payload it was signed under. Absent means it
      // predates the column, which is v1 by definition. A version this build
      // has no builder for is refused rather than guessed at: guessing would
      // mean trying the shorter payload, which is the downgrade the version
      // exists to prevent.
      const version = row.sig_v ?? 1;
      if (version !== 1 && version !== 2) return { ...row, text: null, sender: 'unverified' };
      const payload =
        version === 1
          ? signedPayload({ nonce: row.nonce ?? '', ciphertext: row.ciphertext ?? '' })
          : signedPayloadV2(row);

      const ok = await verifyBytes(await fromBase64(signing), row.signature, payload);
      if (!ok) return { ...row, text: null, sender: 'unverified' };

      // Opened here, beside the body, because this is the one layer holding
      // the room key. A failure is null rather than a throw: the attachment
      // component already draws "no longer available" for a file it cannot
      // open, and one unreadable file must not take the caption with it.
      let mediaKey: Uint8Array | null = null;
      if (row.media_key_ciphertext && row.media_key_nonce) {
        try {
          mediaKey = await openRoomFileKey(roomKey, {
            ciphertext: row.media_key_ciphertext,
            nonce: row.media_key_nonce,
          });
        } catch {
          mediaKey = null;
        }
      }

      // A tombstone and a caption-less attachment both arrive with no body.
      // Neither is a failure to open, so neither is flagged as one.
      if (row.ciphertext === null || row.nonce === null) {
        return { ...row, text: null, mediaKey, sender: 'verified' };
      }

      try {
        const text = sodium.to_string(
          sodium.crypto_secretbox_open_easy(
            sodium.from_base64(row.ciphertext, sodium.base64_variants.ORIGINAL),
            sodium.from_base64(row.nonce, sodium.base64_variants.ORIGINAL),
            roomKey
          )
        );
        return { ...row, text, mediaKey, sender: 'verified' };
      } catch {
        // Signed by the right person but sealed under a key this device does
        // not hold, which is what a member who joined after a rotation sees.
        return { ...row, text: null, mediaKey, sender: 'verified' };
      }
    })
  );
}

/** Signing keys for every sender in a room, in one query. */
export async function roomSigningKeys(userIds: string[]): Promise<Map<string, string | null>> {
  const keys = await publishedKeys(userIds);
  return new Map([...keys].map(([id, k]) => [id, k.signing_key]));
}

export async function listRooms(): Promise<RoomSummary[]> {
  const { data, error } = await supabase.rpc('rooms_for_me');
  if (error) throw error;
  return (data as RoomSummary[] | null) ?? [];
}

export async function roomMembers(roomId: string): Promise<RoomParticipant[]> {
  const { data } = await supabase
    .from('room_participants')
    .select('room_id, user_id, colour_index, joined_at')
    .eq('room_id', roomId)
    .order('joined_at');
  return (data as RoomParticipant[] | null) ?? [];
}

/**
 * Removes a member and deletes their key copy.
 *
 * The participant row is what row-level security checks, so they stop reading
 * new messages. The key row is their stored copy, so a fresh install cannot
 * recover it.
 *
 * It cannot claw back what they already hold, and nothing can: a session that
 * opened the key keeps it in memory until it closes, and their downloads are
 * on their phone. The members panel says so before the removal happens.
 *
 * It also does not reseal a fresh key to everyone who stays. That sounds
 * stricter and is worse. The whole history is sealed under the current key,
 * which lives only in memory, so replacing it would make every past message
 * unreadable to every remaining member.
 */
export async function removeMember(roomId: string, userId: string): Promise<void> {
  const { error: keyError } = await supabase
    .from('room_keys')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId);
  if (keyError) throw keyError;

  const { error } = await supabase
    .from('room_participants')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId);
  if (error) throw error;
}

export async function leaveRoom(roomId: string, me: string): Promise<void> {
  forgetRoomKey(roomId);
  const { error } = await supabase
    .from('room_participants')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', me);
  if (error) throw error;
}

export async function deleteRoom(roomId: string): Promise<void> {
  forgetRoomKey(roomId);
  const { error } = await supabase.from('rooms').delete().eq('id', roomId);
  if (error) throw error;
}
