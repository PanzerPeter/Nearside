// Passing a message you already have along to another conversation.
//
// A forward is an ordinary new message rather than a reference to the old one,
// because `messages_select_participant` (0001) means the recipient cannot read
// the thread it came from. The body is copied, media is duplicated into the
// destination's storage folder, and only the `forwarded` flag travels with it.
//
// Four directions, one path. A one-to-one conversation and a group are
// different tables sealed under different keys, so the source is read into one
// neutral shape (`ForwardSource`) and the destination decides how it is sealed.
// Splitting them into two functions would mean two copies of the storage copy,
// the orphan cleanup and the failure mapping — and the first fix to either one
// would land in only one of them.
//
// Deliberately left behind:
//   - `reply_to_id`, which names a message in the source conversation that
//     `useReplyTargets` cannot resolve from the destination. It would render
//     "Message unavailable" forever.
//   - anything identifying the original sender. See 0018's header.
//   - reactions, which would attribute other people's responses to a message
//     they have never seen.

import { supabase } from './supabase';
import { mediaPath } from './conversation';
import { sealBody, sealMediaKey } from './sealed-body';
import { peerPublicKey } from './peer-keys';
import { notifyReceiver, notifyRoom } from './push';
import {
  roomKeyFor,
  roomMediaPath,
  sealRoomFileKey,
  sendRoomMessage,
  type RoomMediaType,
  type RoomMessage,
} from './rooms';
import type { Identity } from './crypto/keys';
import type { MediaType, Message } from './types';
import { t } from './i18n';

/** Why a forward did not happen, in the shape the UI needs to explain it. */
export type ForwardFailure =
  | 'media-missing'
  | 'not-set-up'
  | 'rate-limited'
  | 'no-room-key'
  | 'failed';

export type ForwardResult = { ok: true; id: string } | { ok: false; reason: ForwardFailure };

/** The extension of a storage object path (`a_b/uuid.jpg` → `jpg`), or '' when
 *  it has none. Lowercased, so a `.JPG` upload keeps one canonical form. */
export function pathExtension(objectPath: string): string {
  const name = objectPath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  // `> 0`, not `>= 0`: a leading dot is a hidden file, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Everything a forward carries, read off either kind of message.
 *
 * Deliberately not the row itself. A `Message` and a `RoomMessage` name the
 * same things differently (`media_key` against `mediaKey`) and carry columns
 * that must NOT travel — a room row's signature describes the row it is on and
 * would verify against nothing once copied. Narrowing to this shape at the
 * boundary is what stops one of those columns being spread into an insert by
 * accident.
 *
 * `fileKey` is the OPENED per-file key, not the sealed column: the destination
 * seals it again, to a peer or under a room key, and the sealed form the source
 * carries is readable by the wrong people.
 */
export interface ForwardSource {
  text: string | null;
  mediaPath: string | null;
  mediaType: MediaType | null;
  mediaDurationMs: number | null;
  mediaThumbPath: string | null;
  fileKey: Uint8Array | null;
}

/** A one-to-one message, narrowed to what travels. */
export function peerSource(msg: Message): ForwardSource {
  return {
    text: msg.text,
    mediaPath: msg.media_path,
    mediaType: msg.media_type,
    mediaDurationMs: msg.media_duration_ms,
    mediaThumbPath: msg.media_thumb_path,
    fileKey: msg.media_key ?? null,
  };
}

/** A group message, narrowed to what travels. */
export function roomSource(msg: RoomMessage): ForwardSource {
  return {
    text: msg.text ?? null,
    mediaPath: msg.media_path ?? null,
    mediaType: msg.media_type ?? null,
    mediaDurationMs: msg.media_duration_ms ?? null,
    mediaThumbPath: msg.media_thumb_path ?? null,
    fileKey: msg.mediaKey ?? null,
  };
}

/** Where a forward is going. A room carries no key here: it is resolved at send
 *  time, so the picker does not have to fetch one per group to draw a list. */
export type ForwardTarget = { kind: 'peer'; peerId: string } | { kind: 'room'; roomId: string };

/** What `room_messages_media_type_check` will accept. Stated here so a kind
 *  added to `messages` alone cannot be forwarded into a row the group table's
 *  CHECK then refuses — which would fail after the object had been copied. */
const ROOM_MEDIA_TYPES: ReadonlySet<string> = new Set<RoomMediaType>([
  'image',
  'video',
  'audio',
  'sticker',
]);

/**
 * Where a forwarded attachment lands: a fresh name in the *destination*
 * conversation's folder.
 *
 * It has to be a real second object. The `chat-media` policies key access off
 * the folder name (`{sortedA}_{sortedB}`), so the destination's participant
 * cannot read a path in the source's folder and the attachment would arrive as
 * "Media no longer available". The filename is a new uuid for the reason
 * `sendMedia` mints one: two conversations trimming their media caps
 * independently must never collide on a single object.
 *
 * `filename` is a parameter only so tests can pin it; callers pass nothing.
 */
export function forwardMediaPath(
  me: string,
  targetId: string,
  sourcePath: string,
  filename: string = crypto.randomUUID()
): string {
  const ext = pathExtension(sourcePath);
  return mediaPath(me, targetId, ext ? `${filename}.${ext}` : filename);
}

/**
 * The same, for a group: a fresh name in the destination room's folder.
 *
 * Room objects live under `<roomId>/` and peer objects under
 * `{sortedA}_{sortedB}/`, and the `chat-media` policies key access off exactly
 * that folder name. Both are in one bucket, which is what lets the copy happen
 * server-side in every direction — the forwarder is a member at both ends, so
 * a 50 MB video never touches the device on its way between them.
 */
export function forwardRoomMediaPath(
  roomId: string,
  sourcePath: string,
  filename: string = crypto.randomUUID()
): string {
  const ext = pathExtension(sourcePath);
  return roomMediaPath(roomId, ext ? `${filename}.${ext}` : filename);
}

/**
 * The row a forward inserts. Pure, so what travels with a forwarded message is
 * stated (and tested) in one place rather than spread through the async
 * function below.
 *
 * `mediaPath` is the *already copied* destination path, or null for a
 * text-only forward, including one whose attachment has been trimmed away.
 */
export function forwardPayload(
  source: Pick<ForwardSource, 'text' | 'mediaType' | 'mediaDurationMs'>,
  me: string,
  targetId: string,
  mediaPath: string | null,
  /** The copied thumbnail, or null. Its own argument rather than something
   *  read off `source`, for the same reason `mediaPath` is: what goes on the
   *  row is the destination path this forward created, never the source's. */
  thumbPath: string | null = null
) {
  return {
    user_id: me,
    receiver_id: targetId,
    text: source.text || null,
    media_path: mediaPath,
    media_type: mediaPath ? source.mediaType : null,
    // Never without the attachment it previews: the 0044 CHECK refuses that
    // row, and a thumbnail alone is a picture with nothing behind the tap.
    media_thumb_path: mediaPath ? thumbPath : null,
    // Only meaningful alongside a voice note; a forward that lost its media
    // must not keep a length describing a file it no longer carries.
    media_duration_ms:
      mediaPath && source.mediaType === 'audio' ? source.mediaDurationMs : null,
    reply_to_id: null,
    forwarded: true,
  };
}

/**
 * The media draft a forward into a group sends, or null when there is nothing
 * to attach. Pure for the same reason `forwardPayload` is.
 *
 * `sealedKey` is the file key already sealed under the DESTINATION room's key —
 * sealing needs libsodium, and keeping it out of here is what leaves this
 * testable in the node suite.
 */
export function forwardRoomDraft(
  source: Pick<ForwardSource, 'mediaType' | 'mediaDurationMs'>,
  mediaPath: string | null,
  thumbPath: string | null,
  sealedKey: { ciphertext: string; nonce: string } | null
) {
  if (!mediaPath || !sealedKey || !source.mediaType) return null;
  return {
    path: mediaPath,
    // Every `MediaType` a room accepts is one of these; the caller has already
    // refused anything else (see `forwardMessage`).
    type: source.mediaType as RoomMediaType,
    thumbPath,
    durationMs: source.mediaType === 'audio' ? source.mediaDurationMs : null,
    key: sealedKey,
  };
}

/** Is there anything left to forward? A deleted message has had its body and
 *  media stripped. The UI never offers the action for one; this is the belt to
 *  that braces. */
export function isForwardable(msg: Pick<Message, 'text' | 'media_path' | 'deleted_at'>): boolean {
  return !msg.deleted_at && (!!msg.text?.trim() || !!msg.media_path);
}

/**
 * The same question for a group message, plus one the one-to-one side does not
 * have to ask: can this device vouch for who wrote it?
 *
 * Only a `verified` row may be passed on. Forwarding an `unverified` one would
 * launder a forgery — it arrives in the destination signed by *you*, freshly
 * sealed, and verifies there — and an `unknown` one is a row this build could
 * not check at all, which is the same bet with the warning removed.
 */
export function isRoomForwardable(
  msg: Pick<RoomMessage, 'text' | 'media_path' | 'deleted_at' | 'sender'>
): boolean {
  if (msg.sender !== 'verified') return false;
  return !msg.deleted_at && (!!msg.text?.trim() || !!msg.media_path);
}

/**
 * Does a conversation match the picker's filter? Both the displayed name and
 * the raw handle are searched, so a friend renamed "Bobby" is still findable
 * by typing "bob". Case- and whitespace-insensitive; empty matches everything.
 */
export function matchesTarget(label: string, display_name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return label.toLowerCase().includes(needle) || display_name.toLowerCase().includes(needle);
}

/** The shape of a PostgREST error, narrowed to what the mapping below reads. */
interface WriteError {
  code?: string;
  message?: string;
}

/**
 * Why an insert was refused. An unmigrated server and a throttling server are
 * different problems and must not read identically.
 */
export function classifyForwardError(error: WriteError | null | undefined): ForwardFailure {
  if (!error) return 'failed';
  // PostgREST does not know the `forwarded` column: 0018 has not been run, or
  // its schema cache has not picked it up yet.
  if (error.code === 'PGRST204' || /forwarded/.test(error.message ?? '')) return 'not-set-up';
  if (/rate_limited_messages/.test(error.message ?? '')) return 'rate-limited';
  return 'failed';
}

/** One line explaining a failure, ready to toast. `label` names the target. */
export function describeForwardFailure(reason: ForwardFailure, label: string): string {
  switch (reason) {
    case 'media-missing':
      return t('forward.mediaMissing');
    case 'not-set-up':
      return t('forward.notSetUp');
    case 'rate-limited':
      return t('media.rateLimited');
    case 'no-room-key':
      return t('forward.noRoomKey', { name: label });
    default:
      return t('forward.failed', { name: label });
  }
}

/**
 * Copy one message into another conversation, of either kind.
 *
 * Media is duplicated server-side with `storage.copy` rather than downloaded
 * and re-uploaded: the caller participates in both conversations, so the copy
 * passes the `chat-media` policies at both ends and a 50 MB video never
 * touches the device. A copy whose row insert then fails is cleaned up, as in
 * `useMediaSend.send`, or a rejected forward orphans an object.
 *
 * The key is always re-sealed for the destination, never carried across. A
 * peer's copy is sealed to that peer; a group's is sealed under the room key,
 * because every member holds it and a key sealed to one of them is a key the
 * rest cannot use.
 */
export async function forwardMessage(
  me: string,
  source: ForwardSource,
  target: ForwardTarget,
  identity: Identity
): Promise<ForwardResult> {
  if (!source.text?.trim() && !source.mediaPath) return { ok: false, reason: 'failed' };

  // An attachment this device could not open would copy fine and arrive
  // unopenable, so it reads as unavailable, which is what it is.
  if (source.mediaPath && !source.fileKey) return { ok: false, reason: 'media-missing' };

  // Resolved before anything is copied: a group this device holds no key for
  // cannot be sealed into, and finding that out after the storage copy would
  // leave an orphan behind for nothing. It is resolved here rather than in the
  // picker so drawing the list costs no network at all.
  let roomKey: Uint8Array | null = null;
  if (target.kind === 'room') {
    try {
      roomKey = await roomKeyFor(target.roomId, identity);
    } catch {
      roomKey = null;
    }
    if (!roomKey) return { ok: false, reason: 'no-room-key' };
    // `room_messages_media_type_check` knows four kinds and `messages` knows
    // the same four today; a fifth added on one side must not silently insert
    // a row the other side's CHECK refuses.
    if (source.mediaPath && !ROOM_MEDIA_TYPES.has(source.mediaType ?? '')) {
      return { ok: false, reason: 'media-missing' };
    }
  }

  const destinationPath = (sourcePath: string) =>
    target.kind === 'peer'
      ? forwardMediaPath(me, target.peerId, sourcePath)
      : forwardRoomMediaPath(target.roomId, sourcePath);

  let copiedPath: string | null = null;
  let copiedThumbPath: string | null = null;
  if (source.mediaPath) {
    const destination = destinationPath(source.mediaPath);
    const { error: copyError } = await supabase.storage
      .from('chat-media')
      .copy(source.mediaPath, destination);
    // Almost always the object is gone, trimmed by the per-conversation
    // retention cap, which removes the file and leaves the row naming it. The
    // user can act on "it is not there any more"; they cannot act on a denied
    // policy for a bucket they demonstrably participate in.
    if (copyError) return { ok: false, reason: 'media-missing' };
    copiedPath = destination;

    // The preview is copied too, and its failure is survivable: a forward that
    // arrives without one draws the full object, which is what every message
    // sent before 0044 does. Losing the message over a missing preview would
    // not be.
    if (source.mediaThumbPath) {
      const thumbDestination = destinationPath(source.mediaThumbPath);
      const { error: thumbError } = await supabase.storage
        .from('chat-media')
        .copy(source.mediaThumbPath, thumbDestination);
      if (!thumbError) copiedThumbPath = thumbDestination;
    }
  }

  const orphans = () => [copiedPath, copiedThumbPath].filter((p): p is string => !!p);

  if (target.kind === 'room') {
    // Non-null by construction: the resolution above returns `no-room-key`
    // before anything is copied. Narrowing only.
    if (!roomKey) return { ok: false, reason: 'no-room-key' };
    try {
      const sealedKey =
        copiedPath && source.fileKey ? await sealRoomFileKey(roomKey, source.fileKey) : null;
      const media = forwardRoomDraft(source, copiedPath, copiedThumbPath, sealedKey);
      // `forwarded: true` goes into the signature, not just onto the row — see
      // `signedPayloadV4`. The caption is sealed under the room key by
      // `sendRoomMessage`, exactly as a typed one is.
      const row = await sendRoomMessage(target.roomId, me, identity, roomKey, source.text || null, {
        media,
        forwarded: true,
      });
      // The same fire-and-forget push an ordinary group message gets.
      notifyRoom(row.id);
      return { ok: true, id: row.id };
    } catch (error) {
      const left = orphans();
      if (left.length) await supabase.storage.from('chat-media').remove(left);
      return { ok: false, reason: classifyForwardError(error as WriteError) };
    }
  }

  // Sealing is layered over the pure payload, because a message forwarded into
  // the vault must land sealed like anything else sent there. `text` is
  // destructured out rather than spread: it is the one payload field with no
  // column behind it, and reaching `.insert()` it would fail today and put a
  // plaintext body back on the server if it ever stopped failing.
  const targetId = target.peerId;
  const { text, ...columns } = forwardPayload(source, me, targetId, copiedPath, copiedThumbPath);
  const targetKey = await peerPublicKey(targetId);
  const body = text
    ? await sealBody(identity, targetKey, me, targetId, text)
    : { ciphertext: null, nonce: null };

  // The copy is the same sealed bytes under the same file key, so the key is
  // re-sealed to whoever receives it now. Carrying the original
  // `media_key_ciphertext` across would hand the target a key sealed to
  // somebody else, and the attachment would arrive looking corrupt.
  const mediaKey =
    copiedPath && source.fileKey
      ? await sealMediaKey(identity, targetKey, me, targetId, source.fileKey)
      : { media_key_ciphertext: null, media_key_nonce: null };

  const { data, error } = await supabase
    .from('messages')
    .insert({ ...columns, ...body, ...mediaKey })
    .select('id')
    .single();

  if (error || !data) {
    const left = orphans();
    if (left.length) await supabase.storage.from('chat-media').remove(left);
    return { ok: false, reason: classifyForwardError(error) };
  }

  // Same fire-and-forget push as an ordinary send, and the same exemption:
  // a message forwarded into your own notes has nobody to notify.
  notifyReceiver(data.id as string, targetId === me);

  return { ok: true, id: data.id as string };
}
