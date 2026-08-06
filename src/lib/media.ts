import { AUDIO_KEEP_LIMIT, MEDIA_KEEP_LIMIT } from './conversation';
import type { MediaType } from './types';

/** How many over-limit rows one cleanup pass will trim. */
export const MEDIA_TRIM_BATCH = 20;

/**
 * Rows one cleanup pass fetches. Bounded on purpose: only rows past a keep
 * limit can ever be trimmed, so pulling a conversation's whole media history
 * on every send would be pure waste. One extra batch keeps the trim
 * incremental — a backlog is worked off a batch at a time.
 */
export const MEDIA_SCAN_LIMIT = MEDIA_KEEP_LIMIT + AUDIO_KEEP_LIMIT + MEDIA_TRIM_BATCH;

export interface MediaRow {
  id: string;
  user_id: string;
  media_path: string | null;
  media_type: MediaType | null;
}

/**
 * Which of `rows` are past their keep limit, given newest-first input.
 *
 * Photos/videos and voice notes are counted against separate limits rather
 * than one shared budget: a run of voice notes should not evict the photo
 * someone sent an hour earlier, and vice versa.
 */
export function selectStaleMedia<T extends MediaRow>(rows: readonly T[]): T[] {
  let visual = 0;
  let audio = 0;
  const stale: T[] = [];

  for (const row of rows) {
    if (!row.media_path) continue;
    const isAudio = row.media_type === 'audio';
    const seen = isAudio ? ++audio : ++visual;
    if (seen > (isAudio ? AUDIO_KEEP_LIMIT : MEDIA_KEEP_LIMIT)) stale.push(row);
  }

  return stale;
}
