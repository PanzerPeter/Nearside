// Keeping an attachment on this device after the server has let it go.
//
// The server's copy is bounded: `selectStaleMedia` trims a conversation back to
// MEDIA_KEEP_LIMIT photos and videos and AUDIO_KEEP_LIMIT voice notes, and the
// sender's device deletes its own objects and relabels the rows. That bound
// exists because a Supabase bucket is finite — not because the user's own
// history is supposed to be.
//
// A phone has room the bucket does not, so this is the opt-out: an attachment
// this device has already downloaded and decrypted is written into app-private
// storage, and the kept copy outlives the trim. It reuses `lib/pins.ts`
// wholesale, because a kept file and a pinned file are the same thing on disk
// and only differ in who asked for it.
//
// Two rules are not settings, and must not become ones:
//
//   A disappearing message is never kept. The timer is the one promise in the
//   app that both people agreed to, and a device quietly keeping a local copy
//   of what was supposed to vanish would break it silently, on the side that
//   never consented. This is checked before anything else.
//
//   Nothing is downloaded in order to keep it. Every keep runs off bytes a
//   bubble has already opened, so turning this on costs storage and never
//   bandwidth.
import type { MediaType } from './types';

/**
 * What this device keeps of its own accord.
 *
 * Video is its own rung rather than folded into `all`, because it is the whole
 * of the storage question: a minute of speech is ~180 KB and a minute of video
 * is tens of megabytes. Somebody who wants their voice notes and photographs
 * back should not have to accept a filling phone to get them.
 */
export type KeepPolicy = 'off' | 'light' | 'all';

export const DEFAULT_KEEP_POLICY: KeepPolicy = 'light';

export function isKeepPolicy(value: unknown): value is KeepPolicy {
  return value === 'off' || value === 'light' || value === 'all';
}

export interface KeepCandidate {
  mediaType: MediaType | null;
  /** The row's disappearing-message stamp. Anything but null means this file is
   *  meant to go, and no policy overrides that. */
  expiresAt?: string | null;
}

/**
 * Whether this device should keep its own copy of an attachment it has just
 * opened.
 *
 * Stickers are excluded at every setting. A sticker is re-uploaded on every
 * send by design (see `lib/stickers.ts`), so keeping the received copies would
 * accumulate one file per send of a picture the sender already holds in their
 * library — the one media type where a local archive is pure duplication.
 */
export function shouldKeep(candidate: KeepCandidate, policy: KeepPolicy): boolean {
  // First, and deliberately not last: a disappearing message is not kept at any
  // setting, and no later condition can reach past this.
  if (candidate.expiresAt) return false;
  if (policy === 'off') return false;

  switch (candidate.mediaType) {
    case 'image':
      return true;
    case 'audio':
      return true;
    case 'video':
      return policy === 'all';
    // A sticker, or a row with no attachment at all.
    default:
      return false;
  }
}

/**
 * The subset of a trim batch worth keeping before the objects go.
 *
 * The trimming device is about to delete files it uploaded, and it is the last
 * moment anybody can rescue them — so this runs there as well as on the view
 * path. Rows already kept are skipped by the caller, which holds the index.
 */
export function keepableFromTrim<T extends { media_type?: MediaType | null; expires_at?: string | null }>(
  rows: readonly T[],
  policy: KeepPolicy
): T[] {
  return rows.filter((row) =>
    shouldKeep({ mediaType: row.media_type ?? null, expiresAt: row.expires_at ?? null }, policy)
  );
}

/**
 * The setting, in localStorage.
 *
 * Per device, like every other storage decision in the app: how much room this
 * phone has is not a fact about the account, and syncing it would let a tablet
 * with 512 GB decide what a phone with 32 GB keeps.
 */
const KEEP_POLICY_KEY = 'nearside.media.keep';

export function keepPolicy(): KeepPolicy {
  try {
    const stored = localStorage.getItem(KEEP_POLICY_KEY);
    return isKeepPolicy(stored) ? stored : DEFAULT_KEEP_POLICY;
  } catch {
    // Private mode, or storage denied. The default is the safe answer here:
    // it keeps the small things and leaves video alone.
    return DEFAULT_KEEP_POLICY;
  }
}

export function setKeepPolicy(policy: KeepPolicy): void {
  try {
    localStorage.setItem(KEEP_POLICY_KEY, policy);
  } catch {
    // The setting applies for this run and is forgotten; nothing else breaks.
  }
}
