import type { Message } from './types';

/**
 * One-line stand-in for a message's body, for the places that *quote* a
 * message rather than render it: the composer's reply bar and the quote
 * inside a reply bubble. Media carries no text of its own when it has no
 * caption, so it is named by kind instead of quoted as an empty string.
 */
export function messageSnippet(
  msg: Pick<Message, 'text' | 'media_type' | 'media_path' | 'deleted_at'>
): string {
  if (msg.deleted_at) return 'Deleted message';
  if (msg.text) return msg.text;
  if (msg.media_type === 'audio') return '🎤 Voice message';
  if (msg.media_type === 'video') return '🎬 Video';
  if (msg.media_type === 'image') return '📷 Photo';
  if (msg.media_path) return '📎 Media';
  return '';
}

/** Deterministic folder/channel key for a 1:1 conversation (order-independent).
 *  For the self-chat both halves are the same id, which still yields the
 *  two-segment shape `isConversationFolder` and the storage policies expect. */
export function conversationKey(a: string, b: string): string {
  return [a, b].sort().join('_');
}

/**
 * The conversation with yourself: messages whose sender and receiver are both
 * you. It needs no friendship row (there is none — `no_self_friend` forbids it),
 * so it is recognised by this comparison alone, everywhere.
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
 *
 * A friend you have never messaged has a null timestamp and sorts to the
 * bottom, alphabetically among its peers. PostgREST timestamptz strings aren't
 * guaranteed to share one string shape (see the header of lib/receipts.ts), so
 * instants are compared via Date.parse rather than lexicographically. Tied
 * instants fall through to display_name so the comparator stays a total order — an
 * inconsistent one (returning -1 for both a<b and b<a) leaves ties in
 * Postgres's arbitrary row order, which reshuffles the list under the cursor.
 *
 * The self row is pinned rather than sorted so it is always in the same place:
 * a notes chat you use twice a year would otherwise sink out of sight, and
 * "where did my notes go" is a worse outcome than one row of lost recency.
 * Returns a new array; the caller's input is left alone.
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
 * in. Mirrors `isConversationFolder` in supabase/functions/delete-account/index.ts,
 * which cannot import from here (separate Deno runtime) — keep the two in
 * sync by hand. This copy exists so the predicate that gates account-deletion
 * storage access is actually exercised by the test suite, since the Deno
 * function itself is outside tsconfig/eslint/vitest.
 *
 * Whole-segment equality after splitting on `_`, with the two-segment shape
 * `conversationKey` produces required — never `folder.includes(uid)`, which
 * would widen the match to anything that merely embeds the id.
 */
export function isConversationFolder(folder: string, uid: string): boolean {
  const parts = folder.split('_');
  return parts.length === 2 && (parts[0] === uid || parts[1] === uid);
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
/** Voice-note containers. Which one a recording lands in is decided by the
 *  browser — see `pickAudioMime` — so all of them are accepted here and on the
 *  bucket. `audio/webm` also appears in VIDEO_TYPES' sibling namespace: the
 *  mime, not the container, is what separates a voice note from a video. */
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'];

export function classifyMedia(file: File): 'image' | 'video' | 'audio' | null {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (VIDEO_TYPES.includes(file.type)) return 'video';
  if (AUDIO_TYPES.includes(file.type)) return 'audio';
  return null;
}

export function fileExtension(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : '';
  if (fromName) return fromName.toLowerCase();
  return file.type.split('/')[1] ?? 'bin';
}

/**
 * The columns a soft delete writes.
 *
 * A tombstone has no body of any kind: no ciphertext, no attachment, and no
 * key that would open one. `has_body` exempts a deleted row precisely so it can
 * be stripped this far (see 0023).
 *
 * Named and exported so the payload can be *tested*, which is the whole reason
 * it left `useMessageEditing.deleteMessage`. That version still wrote `content: ''` as
 * the placeholder 0001's constraint used to demand — a column 0023 dropped, so
 * PostgREST rejected the whole update (PGRST204) and nothing could be deleted
 * at all. A patch built here cannot name a column that no longer exists without
 * `noDroppedColumns` in conversation.test.ts saying so.
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
    // A length describing a file that is no longer named is a fact about
    // something that is not there; the media trim nulls it for the same reason.
    media_duration_ms: null,
  };
}

/** Max characters in a message body or media caption. The server-side
 *  `content_length` CHECK went with the `content` column in 0023, so this is
 *  now the only limit — the sealed length is not something Postgres can judge. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Newest N photos/videos kept per conversation. */
export const MEDIA_KEEP_LIMIT = 20;
/** Voice notes are counted separately and kept longer: a minute of speech is
 *  ~180 KB against a photo's megabytes, and losing one loses something that
 *  was said rather than a re-sendable file. */
export const AUDIO_KEEP_LIMIT = 50;
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024; // 50 MB, matches chat-media bucket
