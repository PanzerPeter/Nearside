import { classifyMedia, mediaPath } from './conversation';

/**
 * Chat background helpers. Each user has their own background per conversation;
 * the two participants' choices are independent rows and independent objects.
 *
 * The image shares the conversation's `chat-media` folder, so the existing
 * participant-scoped storage policies cover it and no new bucket is involved.
 * The `bg-` prefix is descriptive only; the authoritative pointer is the
 * `media_path` column on `chat_backgrounds`. The media cap in `useMediaSend`
 * trims by walking `messages` rows rather than listing the folder, so a
 * background is never mistaken for an old attachment.
 *
 * Sharing that folder is also why the image is sealed (migration 0039). The
 * storage policy was written for attachments the two participants share, so it
 * lets either of them list and read anything in there — and a background is
 * usually a photo of something personal. It now goes up like every other
 * attachment: a random per-file key from `lib/media-crypto.ts`, sealed under
 * the owner's *vault* key, since the picture is chosen by one person and shown
 * to nobody else. What the peer can still read is ciphertext, and the key is on
 * a row their RLS policy has never let them see.
 *
 * Backgrounds set before 0039 are plaintext objects with no key on the row.
 * They keep rendering exactly as they did; deleting somebody's wallpaper to
 * tidy a schema is not a fix. Each is replaced the next time its owner sets one.
 */

/** Max background upload size. Well under the bucket's 50 MB video ceiling: a
 *  background is decoded and painted behind every thread render. */
export const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;

/** Storage object path for a background image. */
export function backgroundPath(me: string, other: string, ext: string): string {
  return mediaPath(me, other, `bg-${crypto.randomUUID()}.${ext}`);
}

/**
 * Why `file` cannot be used as a chat background, or null if it can.
 * Videos are rejected even though the bucket accepts them: an autoplaying
 * backdrop behind a message thread is a battery and legibility problem.
 */
export function validateBackgroundFile(file: File): string | null {
  if (classifyMedia(file) !== 'image') {
    return 'Background must be an image (PNG, JPEG, WebP or GIF).';
  }
  if (file.size > MAX_BACKGROUND_BYTES) {
    const mb = Math.round(MAX_BACKGROUND_BYTES / (1024 * 1024));
    return `Background must be smaller than ${mb} MB.`;
  }
  return null;
}

/**
 * Backgrounds already fetched, by object path.
 *
 * Re-reading one on every conversation open is what this exists to stop:
 * switching back and forth between two chats used to re-download both images
 * every time — a megabyte a tap for a picture that had not changed. A signed
 * URL cannot be leaned on for that, because a signature carries a fresh JWT in
 * its query string, so no two signatures of the same object are the same string
 * and the HTTP cache never hits.
 *
 * A sealed background has to be decrypted before it can be painted anyway, so
 * what is held is the object URL for the decrypted bytes — the same shape as
 * `lib/media-cache.ts`, and in memory for the same reason: these are decrypted
 * images, and a copy on disk would outlive the account that chose it.
 */
const backgroundUrls = new Map<string, string>();

/** The held URL for `path`, or null. */
export function reusableBackgroundUrl(path: string): string | null {
  return backgroundUrls.get(path) ?? null;
}

/** Hold the URL for a background just fetched. Replacing an entry revokes the
 *  one it supersedes; leaving it would leak the blob for the session. */
export function rememberBackgroundUrl(path: string, url: string): void {
  const previous = backgroundUrls.get(path);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  backgroundUrls.set(path, url);
}

/** Drop one — after the object behind it is replaced or removed, when the URL
 *  points at bytes that are gone. */
export function forgetBackgroundUrl(path: string): void {
  const held = backgroundUrls.get(path);
  if (held) URL.revokeObjectURL(held);
  backgroundUrls.delete(path);
}

/** Drop everything. Belongs in the account teardown with the other caches. */
export function forgetAllBackgroundUrls(): void {
  for (const url of backgroundUrls.values()) URL.revokeObjectURL(url);
  backgroundUrls.clear();
}

/** The shape of a PostgREST error, narrowed to what the message depends on. */
export interface WriteError {
  code?: string;
  message?: string;
}

/**
 * A user-facing message for a failed background write.
 *
 * A generic "could not set the background" makes a setup problem and a
 * permission problem read identically, so neither can be acted on. Codes with
 * an unambiguous cause get a specific message; everything else falls through
 * to the server's own text rather than a guess.
 */
export function describeWriteError(error: WriteError | null | undefined): string {
  if (!error) return 'Could not save the background.';
  switch (error.code) {
    // Table missing from PostgREST's schema cache: 0012 has not been run, or
    // has not been picked up yet.
    case 'PGRST205':
      return 'Chat backgrounds are not set up on the server yet.';
    // Postgres "permission denied": the role lacks table privileges. Distinct
    // from an RLS denial, which returns 0 rows or a 42501 from the policy.
    case '42501':
      return 'No permission to change this chat background.';
    // No row satisfied the policy — the usual cause is no longer being friends.
    case 'PGRST116':
      return 'Could not change the background for this chat.';
    default:
      return error.message?.trim() || 'Could not save the background.';
  }
}
