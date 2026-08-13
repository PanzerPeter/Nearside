// What the composer is holding before Send: a queue of files, not one file.
//
// A batch is a queue rather than a single slot because a phone's picker returns
// several photos at once. It stays a *queue* rather than an album: each entry
// becomes its own message row, so nothing downstream — bubbles, pins,
// forwarding, the media trim — has to learn a second shape.

import { classifyMedia, MEDIA_BATCH_LIMIT, MEDIA_MAX_BYTES } from './conversation';

export interface StagedMedia {
  /** Stable key for the preview strip. The same photo can be picked twice, so
   *  name and size do not identify an entry. */
  id: string;
  file: File;
  /** Set only for a recording: a MediaRecorder blob carries no duration. */
  durationMs: number | null;
}

export interface StageResult {
  staged: StagedMedia[];
  /** What was refused, phrased for a toast — null when everything went in. */
  error: string | null;
}

function isAudio(file: File): boolean {
  return classifyMedia(file) === 'audio';
}

/** True when the queue is a voice note, which owns the composer alone. */
export function stagedIsRecording(staged: readonly StagedMedia[]): boolean {
  return staged.length === 1 && isAudio(staged[0].file);
}

/**
 * Add `incoming` to `staged`, refusing what cannot be sent.
 *
 * Rejections are per file and never lose the rest of a pick: choosing eight
 * photos and one PDF sends the eight. The reasons are collected into one
 * message because nine toasts for one pick is not feedback.
 */
export function stageFiles(
  staged: readonly StagedMedia[],
  incoming: readonly File[],
  durationMs?: number
): StageResult {
  if (!incoming.length) return { staged: [...staged], error: null };

  // A recording arrives alone and takes the composer: it is the message, and
  // captioning a photo does not describe it.
  if (incoming.some(isAudio)) {
    const recording = incoming.find(isAudio)!;
    return {
      staged: [{ id: crypto.randomUUID(), file: recording, durationMs: durationMs ?? null }],
      error: null,
    };
  }

  if (stagedIsRecording(staged)) {
    return {
      staged: [...staged],
      error: 'Send or discard the voice message first.',
    };
  }

  const next = [...staged];
  const unsupported: string[] = [];
  const tooLarge: string[] = [];
  let overflowed = false;

  for (const file of incoming) {
    if (!classifyMedia(file)) {
      unsupported.push(file.name);
      continue;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      tooLarge.push(file.name);
      continue;
    }
    if (next.length >= MEDIA_BATCH_LIMIT) {
      overflowed = true;
      continue;
    }
    // Durations belong to recordings only. A picked video has one too, but the
    // player reads it off the file; this field exists for the blob that has no
    // container to read.
    next.push({ id: crypto.randomUUID(), file, durationMs: null });
  }

  const reasons: string[] = [];
  if (unsupported.length) reasons.push(`${list(unsupported)} is not an image or video`);
  if (tooLarge.length) reasons.push(`${list(tooLarge)} is over 50 MB`);
  if (overflowed) reasons.push(`only ${MEDIA_BATCH_LIMIT} files can go at once`);

  return { staged: next, error: reasons.length ? `Skipped: ${reasons.join('; ')}.` : null };
}

/** Names for a toast: all of them while there are few, a count past that. */
function list(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.length} files`;
}
