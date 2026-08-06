// Passing a message you already have along to another conversation.
//
// A forward is an ordinary new message, not a reference to the old one: the
// recipient must be able to read it without being able to read the thread it
// came from, and `messages_select_participant` (0001) guarantees they cannot.
// So the body is copied, media is duplicated into the destination's own storage
// folder, and the only thing carried across from the original is the
// `forwarded` flag that tells the bubble to say so.
//
// What is deliberately NOT carried across:
//   - `reply_to_id`. It names a message in the source conversation, which
//     `useReplyTargets` scopes its lookups to — quoted in the destination it
//     would resolve to nothing and render "Message unavailable" forever.
//   - anything identifying the original sender. See 0018's header.
//   - reactions. They belong to the message they were left on, and re-creating
//     them here would attribute other people's reactions to a message they
//     have never seen.

import { supabase } from './supabase';
import { mediaPath } from './conversation';
import { sealBody } from './sealed-body';
import { peerPublicKey } from './peer-keys';
import type { Identity } from './crypto/keys';
import type { Message } from './types';

/** Why a forward did not happen, in the shape the UI needs to explain it. */
export type ForwardFailure = 'media-missing' | 'not-set-up' | 'rate-limited' | 'failed';

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
 * Where a forwarded attachment lands: a fresh name in the *destination*
 * conversation's folder.
 *
 * It has to be a real second object rather than a second row pointing at the
 * first. The `chat-media` policies key access off the folder name
 * (`{sortedA}_{sortedB}`), so the destination's participant could not read a
 * path in the source's folder — the attachment would arrive as "Media no longer
 * available". Reusing the source's *filename* is avoided for the same reason
 * `sendMedia` mints a uuid: two conversations trimming their media caps
 * independently must never be able to collide on one object.
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
 * The row a forward inserts. Pure, so what does and does not travel with a
 * forwarded message is stated in one readable place (and tested) rather than
 * spread through the async function below.
 *
 * `mediaPath` is the *already copied* destination path, or null for a
 * text-only forward — including the case where the original's attachment has
 * since been trimmed away and only its placeholder text remains.
 */
export function forwardPayload(
  msg: Pick<Message, 'text' | 'media_type' | 'media_duration_ms'>,
  me: string,
  targetId: string,
  mediaPath: string | null
) {
  return {
    user_id: me,
    receiver_id: targetId,
    text: msg.text || null,
    media_path: mediaPath,
    media_type: mediaPath ? msg.media_type : null,
    // Only meaningful alongside a voice note; a forward that lost its media
    // must not keep a length describing a file it no longer carries.
    media_duration_ms: mediaPath && msg.media_type === 'audio' ? msg.media_duration_ms : null,
    reply_to_id: null,
    forwarded: true,
  };
}

/** Is there anything in this message to forward at all? A deleted message has
 *  had its body and media stripped, and the UI never offers the action for
 *  one — this is the belt to that braces. */
export function isForwardable(msg: Pick<Message, 'text' | 'media_path' | 'deleted_at'>): boolean {
  return !msg.deleted_at && (!!msg.text?.trim() || !!msg.media_path);
}

/**
 * Does a conversation match what has been typed into the picker's filter?
 *
 * Both the displayed name and the raw handle are searched, because they can
 * differ: a friend you have renamed "Bobby" is still findable by typing "bob",
 * which is the name you would reach for if you had forgotten the nickname was
 * yours. Case- and whitespace-insensitive; an empty query matches everything.
 */
export function matchesTarget(label: string, username: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return label.toLowerCase().includes(needle) || username.toLowerCase().includes(needle);
}

/** The shape of a PostgREST error, narrowed to what the mapping below reads. */
interface WriteError {
  code?: string;
  message?: string;
}

/**
 * Why an insert was refused, in the same spirit as `describeNicknameError`: a
 * server that has not been migrated yet and a server that is throttling you are
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
      return 'That attachment is no longer available to forward.';
    case 'not-set-up':
      return 'Forwarding is not set up on the server yet.';
    case 'rate-limited':
      return "You're sending messages too quickly — give it a moment.";
    default:
      return `Could not forward to ${label}.`;
  }
}

/**
 * Copy one message into another conversation.
 *
 * Media is duplicated server-side (`storage.copy`) rather than downloaded and
 * re-uploaded: the caller is a participant of both conversations, so the copy
 * passes the `chat-media` policies at both ends, and a 50 MB video never
 * touches the device. A copy that succeeds but whose row insert then fails is
 * cleaned up, mirroring `ChatRoom.sendMedia` — otherwise a rejected forward
 * would leave an orphaned object against the destination's storage.
 */
export async function forwardMessage(
  me: string,
  msg: Message,
  targetId: string,
  identity: Identity
): Promise<ForwardResult> {
  if (!isForwardable(msg)) return { ok: false, reason: 'failed' };

  let copiedPath: string | null = null;
  if (msg.media_path) {
    const destination = forwardMediaPath(me, targetId, msg.media_path);
    const { error: copyError } = await supabase.storage
      .from('chat-media')
      .copy(msg.media_path, destination);
    // Overwhelmingly this means the object is gone — trimmed by the per-
    // conversation retention cap, which removes the file while leaving the row
    // that names it. Reported as such rather than as a generic failure, since
    // "it is not there any more" is something the user can understand and the
    // alternatives (a denied policy on a bucket they are demonstrably a
    // participant of) are not things they can act on differently.
    if (copyError) return { ok: false, reason: 'media-missing' };
    copiedPath = destination;
  }

  // The payload stays pure and testable; sealing is layered over it, because
  // a message forwarded INTO the vault must land sealed like anything else
  // sent there — otherwise the one conversation that claims to be unreadable
  // has a plaintext way in.
  // `text` is destructured out rather than spread: it is the one field of the
  // payload with no column behind it, and letting it reach `.insert()` would
  // both fail and — worse, if it ever stopped failing — put a plaintext body
  // back on the server.
  const { text, ...columns } = forwardPayload(msg, me, targetId, copiedPath);
  const body = text
    ? await sealBody(identity, await peerPublicKey(targetId), me, targetId, text)
    : { ciphertext: null, nonce: null };

  const { data, error } = await supabase
    .from('messages')
    .insert({ ...columns, ...body })
    .select('id')
    .single();

  if (error || !data) {
    if (copiedPath) await supabase.storage.from('chat-media').remove([copiedPath]);
    return { ok: false, reason: classifyForwardError(error) };
  }

  // Same fire-and-forget push as an ordinary send, and the same exemption: a
  // message forwarded into your own notes has nobody to notify.
  if (targetId !== me) {
    supabase.functions.invoke('send-push', { body: { message_id: data.id } }).catch(() => {});
  }

  return { ok: true, id: data.id as string };
}
