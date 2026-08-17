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

/*
  What a sealed object's name says about it.

  Every object in `chat-media` uploads as `application/octet-stream`, which is
  the point of sealing it, so nothing downstream can ask Storage what a file is.
  The extension the upload path keeps on the object name is the only surviving
  answer, and a decrypted blob built without it is a `<video>` with no first
  frame and an `<img>` that opens as a page of garbage text.

  So the two directions below — the extension a send writes, and the type a
  reader recovers from it — are one mapping, and `media.test.ts` proves they
  agree for every type the picker accepts. They did not always: `fileExtension`
  used to take the MIME's subtype whole, which turns `video/quicktime` into
  `.quicktime` and `audio/mpeg` into `.mpeg`, neither of which anything mapped
  back. The result was a file that would never play again, decided at upload
  time, unfixable afterwards, and invisible until somebody tapped it.
*/

/** The type a reader recovers from an extension. `mp4` and `webm` are absent
 *  because a container alone cannot separate a voice note from a video; they
 *  are resolved from `kind` in `mimeForPath`. */
const MIME_FOR_EXTENSION: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  // Written by the old subtype-scraping `fileExtension`. Objects named this way
  // are already in the bucket and cannot be renamed, so reading them is the
  // only repair available. `quicktim` is not a typo: the scrape truncated to
  // eight characters, so `video/quicktime` came out a letter short.
  quicktim: 'video/quicktime',
  mpeg: 'audio/mpeg',
};

/** The extension a send writes, per accepted MIME type. */
const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
};

/** Whether `mimeForPath` can make anything of this extension. */
function readableExtension(ext: string): boolean {
  return ext === 'mp4' || ext === 'webm' || ext in MIME_FOR_EXTENSION;
}

/**
 * The leading run of letters and digits, lowercased, and short.
 *
 * The result is pasted straight into a Storage object key, and Storage refuses
 * a key holding a character outside its own set. A photo saved as
 * `shot.jpg (1)` — which is what a second download of the same name looks like
 * on Android — would take `jpg (1)` as its extension and fail to upload, for a
 * reason the sender can do nothing about. A recording's `audio/webm;codecs=opus`
 * is the same problem arriving from the MIME side.
 */
function leadingWord(raw: string | undefined): string {
  return (raw ?? '').toLowerCase().match(/^[a-z0-9]+/)?.[0]?.slice(0, 8) ?? '';
}

/**
 * The extension to give a file being uploaded.
 *
 * The name's own extension wins when this app can read it back, so a file
 * arrives at the other end called what the sender called it. When it cannot —
 * an extension that means nothing here, or no extension at all — the file's
 * type decides, because the name is about to become the only record of it.
 */
export function fileExtension(file: File): string {
  const fromName = leadingWord(file.name.includes('.') ? file.name.split('.').pop() : '');
  if (fromName && readableExtension(fromName)) return fromName;

  const canonical = EXTENSION_FOR_MIME[file.type.split(';')[0].trim().toLowerCase()];
  if (canonical) return canonical;

  // Neither says anything this app understands. The subtype is still a better
  // label than nothing for a format nobody here has to open.
  return fromName || leadingWord(file.type.split('/')[1]) || 'bin';
}

/**
 * The content type of a sealed attachment, recovered from its object name.
 *
 * `kind` disambiguates WebM and MP4, both containers that a voice note and a
 * video arrive in and which the extension alone cannot separate.
 */
export function mimeForPath(path: string, kind?: MediaType | null): string {
  const name = path.split('/').pop() ?? '';
  if (!name.includes('.')) return 'application/octet-stream';
  const ext = (name.split('.').pop() ?? '').toLowerCase();

  if (ext === 'mp4') return kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  if (ext === 'webm') return kind === 'audio' ? 'audio/webm' : 'video/webm';
  // Deliberately not a guess. A wrong type is worse than none: the element
  // commits to a decoder and fails, where an unknown type at least lets it
  // sniff.
  return MIME_FOR_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Why an attachment could not be shown.
 *
 * Three unrelated problems used to arrive as one sentence — "no longer
 * available" — which is only true of the first of them. It told somebody a file
 * had been deleted while the bytes sat in the bucket intact, and it sent the
 * only person who could act on it looking in the wrong place.
 */
export type MediaFailure =
  /** Not in the bucket, or this account may not read it. The one case the old
   *  wording was right about. */
  | 'gone'
  /** No key on this row for this device — a pre-0024 attachment, or a room key
   *  this device never received — or a key that did not open it. Nothing to
   *  decrypt, and nothing the sender can do about it either. */
  | 'sealed'
  /** Downloaded and decrypted, and the platform still refused to render it. An
   *  HEIC photo in a WebView that has no decoder for one. The file is fine and
   *  is worth saving; this build just cannot paint it. */
  | 'undecodable';

/** What each kind of attachment is called in a sentence. */
const MEDIA_NOUN: Record<MediaType, string> = {
  image: 'photo',
  video: 'video',
  audio: 'voice message',
  sticker: 'sticker',
};

/**
 * The sentence shown in place of an attachment that will not load.
 *
 * Lives here rather than in the three components that draw it so the wording is
 * one thing and can be tested: the same failure must read the same way whether
 * it happened to a photo in the thread, a sticker, or a voice note.
 */
export function mediaFailureNotice(failure: MediaFailure, kind?: MediaType | null): string {
  const noun = MEDIA_NOUN[kind ?? 'image'] ?? 'file';

  switch (failure) {
    case 'gone':
      return `This ${noun} is no longer available`;
    case 'sealed':
      return `This device has no key for this ${noun}`;
    case 'undecodable':
      // Named as a limit of this build, and phrased so the answer — save it,
      // open it elsewhere — is implied rather than a dead end.
      return `This ${noun}'s format can't be ${
        kind === 'audio' || kind === 'video' ? 'played' : 'shown'
      } here`;
  }
}

/**
 * Whether a `<video>` that has read its metadata got no picture out of it.
 *
 * Phones record in HEVC by default, and an HEVC track fails differently
 * depending on where it is opened. The Android WebView hands it to the
 * platform decoder and it plays. Electron's Chromium is built without HEVC and
 * *does not error*: it demuxes the file, keeps the AAC track, drops the video
 * track, and reports `readyState: HAVE_ENOUGH_DATA` with the right duration
 * and a 0×0 frame. What the user gets is a grey thumbnail and, on tapping it,
 * two minutes of audio from a video — with no `error` event, so the reload
 * path this component has for expired signatures never fires either.
 *
 * A decoded frame is the only thing that separates the two, so this is the
 * test: metadata arrived, and there is still nothing to draw.
 *
 * `readyState` is checked rather than assumed from the event, because
 * `loadedmetadata` is not the only place a caller might ask.
 */
export function videoTrackIsUnsupported(el: {
  videoWidth: number;
  readyState: number;
}): boolean {
  // HTMLMediaElement.HAVE_METADATA. Named by value because this module is
  // node-tested and has no DOM to read the constant off.
  const HAVE_METADATA = 1;
  return el.readyState >= HAVE_METADATA && el.videoWidth === 0;
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
