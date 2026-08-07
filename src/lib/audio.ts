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

/**
 * The loudest sample in one analyser window, as an absolute amplitude.
 *
 * Peak rather than RMS: the question this answers is "did anything at all
 * reach the microphone", and a single word in an otherwise quiet room barely
 * moves an RMS average over a 20 ms window.
 */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

/**
 * Below this peak, nothing was recorded.
 *
 * A microphone that is muted, missing, or (as on an emulator started with
 * `-no-audio`) simply not wired to anything still produces a valid stream, a
 * valid Opus file and a valid duration. The only thing that distinguishes it
 * from a working recording is the amplitude, so that is what gets checked. A
 * dead input measures around 1e-4; ordinary speech, even quiet and far from the
 * phone, is two orders of magnitude above this.
 */
export const SILENT_PEAK = 0.005;

/** Whether a recording's loudest moment never rose above the noise floor. */
export function capturedSilence(peak: number): boolean {
  return !(peak > SILENT_PEAK);
}

/**
 * A 0..1 meter position for a peak amplitude.
 *
 * Cube root rather than linear, because loudness is not: a normal speaking
 * voice peaks somewhere around 0.05 to 0.2, which a linear bar would paint as
 * almost nothing and which would make a working microphone look broken.
 */
export function meterLevel(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0;
  return Math.min(1, Math.cbrt(Math.min(peak, 1)));
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
