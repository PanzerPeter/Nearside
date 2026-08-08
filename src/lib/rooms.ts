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

/** A row as stored. `text` and `sender` are client-only, set by `openRoomRows`
 *  at the boundary, exactly as `openRows` does for peer messages. */
export interface RoomMessage {
  id: string;
  room_id: string;
  sender_id: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  created_at: string;
  /** Null when this device could not open the row. `sender` says why. */
  text?: string | null;
  /** How much this device can vouch for:
   *    'verified'   signature checks out against the sender's published key
   *    'unverified' signature does not check out. Rendered as a warning rather
   *                 than hidden, since hiding it conceals an attack in progress
   *    'unknown'    the sender has published no signing key to check against */
  sender?: 'verified' | 'unverified' | 'unknown';
}

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

/** Base64 public + signing keys for a set of accounts, in one query. */
async function publishedKeys(
  userIds: string[]
): Promise<Map<string, { public_key: string | null; signing_key: string | null }>> {
  const map = new Map<string, { public_key: string | null; signing_key: string | null }>();
  if (userIds.length === 0) return map;

  const { data } = await supabase
    .from('profiles')
    .select('id, public_key, signing_key')
    .in('id', userIds);

  for (const row of data ?? []) {
    map.set(row.id, { public_key: row.public_key, signing_key: row.signing_key });
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

/** Seals `text` under the room key and signs the sealed bytes. Exported for
 *  the test suite, which has no database to send to. */
export async function sealRoomMessage(
  roomKey: Uint8Array,
  identity: Identity,
  text: string
): Promise<Sealed & { signature: string }> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const sealed: Sealed = {
    ciphertext: sodium.to_base64(
      sodium.crypto_secretbox_easy(sodium.from_string(text), nonce, roomKey),
      sodium.base64_variants.ORIGINAL
    ),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
  return { ...sealed, signature: await signBytes(identity.signPrivate, signedPayload(sealed)) };
}

export async function sendRoomMessage(
  roomId: string,
  me: string,
  identity: Identity,
  roomKey: Uint8Array,
  text: string
): Promise<string> {
  const sealed = await sealRoomMessage(roomKey, identity, text);
  const id = crypto.randomUUID();
  const { error } = await supabase.from('room_messages').insert({
    id,
    room_id: roomId,
    sender_id: me,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    signature: sealed.signature,
  });
  if (error) throw error;
  return id;
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

      const ok = await verifyBytes(await fromBase64(signing), row.signature, signedPayload(row));
      if (!ok) return { ...row, text: null, sender: 'unverified' };

      try {
        const text = sodium.to_string(
          sodium.crypto_secretbox_open_easy(
            sodium.from_base64(row.ciphertext, sodium.base64_variants.ORIGINAL),
            sodium.from_base64(row.nonce, sodium.base64_variants.ORIGINAL),
            roomKey
          )
        );
        return { ...row, text, sender: 'verified' };
      } catch {
        // Signed by the right person but sealed under a key this device does
        // not hold, which is what a member who joined after a rotation sees.
        return { ...row, text: null, sender: 'verified' };
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
