/**
 * Voice-message recording constants and container/codec negotiation.
 *
 * Browsers disagree on what `MediaRecorder` will produce: Chrome and Firefox
 * do Opus in WebM, Safari only does AAC in MP4. So the format is negotiated at
 * record time rather than assumed, and the chosen container's extension rides
 * along on the uploaded object name.
 */

/** Hard cap on one recording. Also the DB's `media_duration_range` ceiling. */
export const MAX_VOICE_MS = 120_000;

/** Anything shorter is treated as an accidental tap and discarded. */
export const MIN_VOICE_MS = 1_000;

/** Mono speech at 24 kbps ≈ 180 KB/minute — transparent for voice, tiny. */
export const VOICE_BITRATE = 24_000;

/**
 * Preference order. Opus first (best quality per byte at speech bitrates),
 * then Safari's MP4/AAC. Every entry's base type must be allowed on the
 * `chat-media` bucket — see supabase/storage-setup.sql.
 */
const CANDIDATE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
];

export type MimeSupportCheck = (mime: string) => boolean;

function browserSupports(mime: string): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
}

/** The best recording mime this browser accepts, or null if it accepts none. */
export function pickAudioMime(isSupported: MimeSupportCheck = browserSupports): string | null {
  return CANDIDATE_MIMES.find((mime) => isSupported(mime)) ?? null;
}

/** A mime without its codec parameters: `audio/webm;codecs=opus` → `audio/webm`.
 *  Storage matches uploads against the bucket's allow-list by base type, so the
 *  parameters have to come off before the object is sent. */
export function baseMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

/** Container extension for a recorder mime, used in the storage object name. */
export function audioExtension(mime: string): string {
  switch (baseMime(mime)) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return 'webm';
  }
}

/** Whether this browser can record voice at all; gates the mic button. */
export function voiceRecordingSupported(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  return pickAudioMime() !== null;
}

/** `m:ss`, for both the live recording timer and playback position. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
