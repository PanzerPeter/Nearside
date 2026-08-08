import { AUDIO_KEEP_LIMIT, MEDIA_KEEP_LIMIT } from './conversation';
import type { MediaType } from './types';

/** How many over-limit rows one cleanup pass will trim. */
const MEDIA_TRIM_BATCH = 20;

/**
 * Rows one cleanup pass fetches. Bounded on purpose: only rows past a keep
 * limit can ever be trimmed, so pulling a conversation's whole media history
 * on every send would be pure waste. One extra batch keeps the trim
 * incremental — a backlog is worked off a batch at a time.
 */
export const MEDIA_SCAN_LIMIT = MEDIA_KEEP_LIMIT + AUDIO_KEEP_LIMIT + MEDIA_TRIM_BATCH;

/**
 * The content type of a sealed attachment, recovered from its object name.
 *
 * Every object in `chat-media` uploads as `application/octet-stream`, which is
 * the point of sealing it, so nothing downstream can ask Storage what a file
 * is. The extension `0024`'s upload path kept on the object name is the only
 * surviving answer, and a decrypted blob built without it is a `<video>` with
 * no first frame and an `<img>` that opens as a page of garbage text.
 *
 * `kind` disambiguates WebM, which is a container both a voice note and a
 * video arrive in and which the extension alone cannot separate.
 */
export function mimeForPath(path: string, kind?: MediaType | null): string {
  const name = path.split('/').pop() ?? '';
  if (!name.includes('.')) return 'application/octet-stream';
  const ext = (name.split('.').pop() ?? '').toLowerCase();

  switch (ext) {
    case 'webp':
      return 'image/webp';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return kind === 'audio' ? 'audio/mp4' : 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'm4a':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
      return 'audio/mpeg';
    case 'webm':
      return kind === 'audio' ? 'audio/webm' : 'video/webm';
    default:
      // Deliberately not a guess. A wrong type is worse than none: the element
      // commits to a decoder and fails, where an unknown type at least lets it
      // sniff.
      return 'application/octet-stream';
  }
}

/**
 * A stable string standing in for a file key's *value*.
 *
 * `openRows` mints a fresh `Uint8Array` on every decrypt and `mergeMessages`
 * replaces the newest row on every poll tick, so anything keyed on the array's
 * identity sees a new key every few seconds for a key that never changed. That
 * blanks a playing video and re-downloads its bytes on a loop.
 *
 * Comma-delimited rather than concatenated: without a separator `[1, 23]` and
 * `[12, 3]` produce the same token.
 */
export function keyToken(key: Uint8Array | null | undefined): string | null {
  return key ? key.join(',') : null;
}

export interface MediaRow {
  id: string;
  user_id: string;
  media_path: string | null;
  media_type: MediaType | null;
}

/**
 * Which of `rows` are past their keep limit, given newest-first input.
 *
 * Photos and videos are counted against a separate limit from voice notes, so
 * a run of voice notes cannot evict a photo sent an hour earlier.
 *
 * A pinned item is skipped outright: not counted, not trimmed. Counting it
 * would let a handful of pins push unpinned media off the end early, turning
 * pinning into a way of losing other people's photos.
 *
 * Pruning exists because Supabase storage is finite, not because storage is a
 * product. Pinning is free, and this parameter is what makes that true.
 */
export function selectStaleMedia<T extends MediaRow>(
  rows: readonly T[],
  pinned: ReadonlySet<string> = new Set()
): T[] {
  let visual = 0;
  let audio = 0;
  const stale: T[] = [];

  for (const row of rows) {
    if (!row.media_path) continue;
    if (pinned.has(row.id)) continue;
    const isAudio = row.media_type === 'audio';
    const seen = isAudio ? ++audio : ++visual;
    if (seen > (isAudio ? AUDIO_KEEP_LIMIT : MEDIA_KEEP_LIMIT)) stale.push(row);
  }

  return stale;
}
