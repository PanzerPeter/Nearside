import type { Message } from './types';

/**
 * One-line stand-in for a body, for the places that *quote* a message rather
 * than render it: the composer's reply bar and the quote inside a reply
 * bubble. Uncaptioned media is named by kind rather than quoted as an empty
 * string.
 */
export function messageSnippet(
  msg: Pick<Message, 'text' | 'media_type' | 'media_path' | 'deleted_at'>
): string {
  if (msg.deleted_at) return 'Deleted message';
  if (msg.text) return msg.text;
  if (msg.media_type === 'audio') return '🎤 Voice message';
  if (msg.media_type === 'video') return '🎬 Video';
  if (msg.media_type === 'image') return '📷 Photo';
  if (msg.media_type === 'sticker') return '🩷 Sticker';
  if (msg.media_path) return '📎 Media';
  return '';
}

/**
 * Whether this message's body is one the sender can still rewrite.
 *
 * A caption is body text like any other — it is sealed by the same `sealBody`
 * and lives in the same two columns — so a photo sent with the wrong word
 * under it was editable everywhere except in the menu, which used to require
 * the row to carry no attachment at all. A voice note counts too: the words
 * under it are the only part of it that can be corrected without recording
 * again.
 *
 * A bare sticker is the exception, and not an arbitrary one: it renders with
 * no bubble around it (see `MessageBubble`'s `stickerAlone`), so there is no
 * surface for a caption to sit on. One sent with something written under it
 * already has that surface and edits like anything else.
 */
export function canEditBody(
  msg: Pick<Message, 'text' | 'media_path' | 'media_type' | 'deleted_at'>
): boolean {
  if (msg.deleted_at) return false;
  if (msg.text) return true;
  return !!msg.media_path && msg.media_type !== 'sticker';
}

/**
 * Whether saving an empty body is a change rather than an accident.
 *
 * Only when something else in the row survives it: an attachment stands on its
 * own, and clearing the caption is how a caption is taken back. Emptying a text
 * message would leave a bubble with nothing in it, which is what deleting is
 * for — so the save control stays inert there instead.
 */
export function isBodyOptional(msg: Pick<Message, 'media_path'>): boolean {
  return !!msg.media_path;
}

/** Deterministic folder/channel key for a 1:1 conversation (order-independent).
 *  For the self-chat both halves are the same id, which still yields the
 *  two-segment shape `isConversationFolder` and the storage policies expect. */
export function conversationKey(a: string, b: string): string {
  return [a, b].sort().join('_');
}

/**
 * The conversation with yourself: sender and receiver are both you. It has no
 * friendship row, since `no_self_friend` forbids one, so this comparison is
 * how it is recognised everywhere.
 */
export function isSelfChat(me: string, peerId: string | null | undefined): boolean {
  return !!peerId && peerId === me;
}

/** Default name for the self-chat, when the user has not given it their own
 *  (a nickname on the self row overrides it — see lib/nicknames.ts). */
export const SELF_CHAT_LABEL = 'Your vault';

/** The minimum of a sidebar row that ordering depends on. */
interface Orderable {
  peer_id: string;
  display_name: string;
  last_at: string | null;
}

/**
 * Sidebar order: your own notes pinned to the top, then newest activity first.
 * Returns a new array.
 *
 * A friend you have never messaged has a null timestamp and sorts to the
 * bottom, alphabetically. PostgREST timestamptz strings do not share one
 * string shape (see the header of lib/receipts.ts), so instants go through
 * Date.parse rather than being compared lexicographically. Ties fall through
 * to display_name to keep the comparator a total order: an inconsistent one
 * leaves ties in Postgres's arbitrary row order, reshuffling the list under
 * the cursor.
 *
 * The self row is pinned rather than sorted, so a notes chat used twice a year
 * stays where the user left it instead of sinking out of sight.
 */
export function sortConversations<T extends Orderable>(rows: T[], me: string): T[] {
  return [...rows].sort((a, b) => {
    const aSelf = isSelfChat(me, a.peer_id);
    const bSelf = isSelfChat(me, b.peer_id);
    if (aSelf !== bSelf) return aSelf ? -1 : 1;
    if (a.last_at && b.last_at) {
      const diff = Date.parse(b.last_at) - Date.parse(a.last_at);
      if (diff !== 0) return diff;
      return a.display_name.localeCompare(b.display_name);
    }
    if (a.last_at) return -1;
    if (b.last_at) return 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

/** PostgREST `.or()` filter matching messages in either direction of a DM. */
export function conversationFilter(me: string, other: string): string {
  return (
    `and(user_id.eq.${me},receiver_id.eq.${other}),` +
    `and(user_id.eq.${other},receiver_id.eq.${me})`
  );
}

/** Storage object path for a piece of chat media. */
export function mediaPath(me: string, other: string, filename: string): string {
  return `${conversationKey(me, other)}/${filename}`;
}

/**
 * Whether a `chat-media` top-level folder belongs to a conversation `uid` is
 * in. Mirrors `isConversationFolder` in
 * supabase/functions/delete-account/index.ts, which runs under Deno and cannot
 * import from here, so keep the two in sync by hand. This copy is what lets
 * vitest exercise the predicate gating account-deletion storage access.
 *
 * Whole-segment equality on the two-segment shape `conversationKey` produces,
 * never `folder.includes(uid)`, which would match anything embedding the id.
 */
export function isConversationFolder(folder: string, uid: string): boolean {
  const parts = folder.split('_');
  return parts.length === 2 && (parts[0] === uid || parts[1] === uid);
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
/** Voice-note containers. The browser picks which one a recording lands in
 *  (see `pickAudioMime`), so all are accepted here and on the bucket. The mime
 *  rather than the container is what separates a voice note from a video. */
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'];

export function classifyMedia(file: File): 'image' | 'video' | 'audio' | null {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (VIDEO_TYPES.includes(file.type)) return 'video';
  if (AUDIO_TYPES.includes(file.type)) return 'audio';
  return null;
}

/**
 * The columns a soft delete writes.
 *
 * A tombstone has no body of any kind: no ciphertext, no attachment, no key
 * that would open one. `has_body` exempts a deleted row so it can be stripped
 * this far (see 0023).
 *
 * Exported so the payload can be tested. `noDroppedColumns` in
 * conversation.test.ts fails if this ever names a column that no longer
 * exists, which PostgREST rejects with PGRST204, taking delete with it.
 */
export function tombstonePatch(now: string = new Date().toISOString()) {
  return {
    deleted_at: now,
    ciphertext: null,
    nonce: null,
    media_path: null,
    media_type: null,
    media_key_ciphertext: null,
    media_key_nonce: null,
    // A length describing a file the row no longer names. The media trim nulls
    // it for the same reason.
    media_duration_ms: null,
  };
}

/** Max characters in a message body or media caption. The server-side
 *  `content_length` CHECK went with the `content` column in 0023, and Postgres
 *  cannot judge a sealed length, so this is the only limit left. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Newest N photos/videos kept per conversation. */
export const MEDIA_KEEP_LIMIT = 20;
/** Voice notes are counted separately and kept longer. A minute of speech is
 *  ~180 KB against a photo's megabytes, and losing one loses something that
 *  was said rather than a file that can be sent again. */
export const AUDIO_KEEP_LIMIT = 50;
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024; // 50 MB, matches chat-media bucket
/** How many files one pick may stage. Held well under `MEDIA_KEEP_LIMIT`: a
 *  batch that filled the keep limit would evict the conversation's whole photo
 *  history in a single send, which is not what picking ten photos asks for. */
export const MEDIA_BATCH_LIMIT = 10;
