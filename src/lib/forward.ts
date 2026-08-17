// Passing a message you already have along to another conversation.
//
// A forward is an ordinary new message rather than a reference to the old one,
// because `messages_select_participant` (0001) means the recipient cannot read
// the thread it came from. The body is copied, media is duplicated into the
// destination's storage folder, and only the `forwarded` flag travels with it.
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
import type { Identity } from './crypto/keys';
import type { Message } from './types';
import { t } from './i18n';

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
 * The row a forward inserts. Pure, so what travels with a forwarded message is
 * stated (and tested) in one place rather than spread through the async
 * function below.
 *
 * `mediaPath` is the *already copied* destination path, or null for a
 * text-only forward, including one whose attachment has been trimmed away.
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

/** Is there anything left to forward? A deleted message has had its body and
 *  media stripped. The UI never offers the action for one; this is the belt to
 *  that braces. */
export function isForwardable(msg: Pick<Message, 'text' | 'media_path' | 'deleted_at'>): boolean {
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
    default:
      return t('forward.failed', { name: label });
  }
}

/**
 * Copy one message into another conversation.
 *
 * Media is duplicated server-side with `storage.copy` rather than downloaded
 * and re-uploaded: the caller participates in both conversations, so the copy
 * passes the `chat-media` policies at both ends and a 50 MB video never
 * touches the device. A copy whose row insert then fails is cleaned up, as in
 * `useMediaSend.send`, or a rejected forward orphans an object.
 */
export async function forwardMessage(
  me: string,
  msg: Message,
  targetId: string,
  identity: Identity
): Promise<ForwardResult> {
  if (!isForwardable(msg)) return { ok: false, reason: 'failed' };

  // An attachment this device could not open would copy fine and arrive
  // unopenable, so it reads as unavailable, which is what it is.
  if (msg.media_path && !msg.media_key) return { ok: false, reason: 'media-missing' };

  let copiedPath: string | null = null;
  if (msg.media_path) {
    const destination = forwardMediaPath(me, targetId, msg.media_path);
    const { error: copyError } = await supabase.storage
      .from('chat-media')
      .copy(msg.media_path, destination);
    // Almost always the object is gone, trimmed by the per-conversation
    // retention cap, which removes the file and leaves the row naming it. The
    // user can act on "it is not there any more"; they cannot act on a denied
    // policy for a bucket they demonstrably participate in.
    if (copyError) return { ok: false, reason: 'media-missing' };
    copiedPath = destination;
  }

  // Sealing is layered over the pure payload, because a message forwarded into
  // the vault must land sealed like anything else sent there. `text` is
  // destructured out rather than spread: it is the one payload field with no
  // column behind it, and reaching `.insert()` it would fail today and put a
  // plaintext body back on the server if it ever stopped failing.
  const { text, ...columns } = forwardPayload(msg, me, targetId, copiedPath);
  const targetKey = await peerPublicKey(targetId);
  const body = text
    ? await sealBody(identity, targetKey, me, targetId, text)
    : { ciphertext: null, nonce: null };

  // The copy is the same sealed bytes under the same file key, so the key is
  // re-sealed to whoever receives it now. Carrying the original
  // `media_key_ciphertext` across would hand the target a key sealed to
  // somebody else, and the attachment would arrive looking corrupt.
  const mediaKey =
    copiedPath && msg.media_key
      ? await sealMediaKey(identity, targetKey, me, targetId, msg.media_key)
      : { media_key_ciphertext: null, media_key_nonce: null };

  const { data, error } = await supabase
    .from('messages')
    .insert({ ...columns, ...body, ...mediaKey })
    .select('id')
    .single();

  if (error || !data) {
    if (copiedPath) await supabase.storage.from('chat-media').remove([copiedPath]);
    return { ok: false, reason: classifyForwardError(error) };
  }

  // Same fire-and-forget push as an ordinary send, and the same exemption:
  // a message forwarded into your own notes has nobody to notify.
  if (targetId !== me) {
    supabase.functions.invoke('send-push', { body: { message_id: data.id } }).catch(() => {});
  }

  return { ok: true, id: data.id as string };
}
