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
 * The storage folder is per conversation rather than per user. The peer cannot
 * discover your background, since the row naming it is unreadable to them, but
 * the bucket policy would let them read the object if they listed the folder.
 * Closing that needs new `chat-media` policies; see the README.
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
